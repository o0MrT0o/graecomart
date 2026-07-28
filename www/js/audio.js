'use strict';

/**
 * audio.js
 * ------------------------------------------------------------------------
 * Dźwięki gry (CC0, Kenney Audio pack - UI/Digital/RPG/Jingle sounds).
 * AudioManager wczytuje wszystkie efekty raz na starcie i odtwarza je
 * w reakcji na zdarzenia z Bus - żaden inny moduł nie musi wiedzieć,
 * że dźwięk w ogóle istnieje (ten sam wzorzec co gamefeel.js dla cząsteczek).
 *
 * Throttling: zdarzenia typu ITEM_PICKUP czy MACHINE_RECEIVED mogą odpalać
 * się kilka razy na sekundę przy aktywnej grze - bez ograniczenia dźwięk
 * zamieniłby się w nieprzyjemny szum. AUDIO_MIN_INTERVAL pilnuje minimalnego
 * odstępu MIĘDZY DŹWIĘKAMI TEGO SAMEGO TYPU (nie globalnie - różne dźwięki
 * mogą brzmieć jednocześnie).
 *
 * Każdy efekt to osobny plik audio, ale odtwarzany przez KLON węzła Audio
 * (cloneNode), nie oryginał - inaczej szybkie powtórzenia (np. seria
 * pickupów) ucinałyby się nawzajem zamiast nakładać naturalnie.
 *
 * Zależności globalne (muszą być załadowane przed tym plikiem):
 *   - window.Bus / window.Events (m.in. ITEM_PICKUP, MACHINE_RECEIVED,
 *      MACHINE_OUTPUT, MONEY_COLLECTED, UPGRADE_BOUGHT, SHIP_MODULE_COMPLETED,
 *      GAME_WON, FOOTSTEP, ZONE_HAZARD_WARNING)
 *
 * Użycie w main.js:
 *   window.audioManager = new AudioManager();
 *   (NIE trzeba rejestrować przez game.registerModule() - AudioManager nie
 *   ma update()/draw(), działa wyłącznie na zdarzeniach)
 */

const AUDIO_SRC = {
  pickup: 'assets/audio/pickup.mp3',
  machine_feed: 'assets/audio/machine_feed.mp3',
  machine_complete: 'assets/audio/machine_complete.mp3',
  coin: 'assets/audio/coin.mp3',
  purchase: 'assets/audio/purchase.mp3',
  ui_click: 'assets/audio/ui_click.mp3',
  hazard: 'assets/audio/hazard.mp3',
  module_complete: 'assets/audio/module_complete.mp3',
  victory: 'assets/audio/victory.mp3',
  footstep0: 'assets/audio/footstep0.mp3',
  footstep1: 'assets/audio/footstep1.mp3',
  footstep2: 'assets/audio/footstep2.mp3',
  footstep3: 'assets/audio/footstep3.mp3',
  // Kroki per NAWIERZCHNIA - osobno wyrenderowane pliki (patrz
  // AUDIO_STEP_FILES niżej), po 2 warianty na podłoże.
  step_grass0: 'assets/audio/step_grass0.wav',
  step_grass1: 'assets/audio/step_grass1.wav',
  step_swamp0: 'assets/audio/step_swamp0.wav',
  step_swamp1: 'assets/audio/step_swamp1.wav',
  step_ash0: 'assets/audio/step_ash0.wav',
  step_ash1: 'assets/audio/step_ash1.wav',
  step_crystal0: 'assets/audio/step_crystal0.wav',
  step_crystal1: 'assets/audio/step_crystal1.wav'
};

// Głośność per dźwięk (0..1). Częste/drobne (pickup, feed, kroki) wyraźnie
// ciszej niż rzadkie/ważne (jingle ukończenia modułu, wygrana) - żeby seria
// szybkich zdarzeń nie zagłuszała wszystkiego innego.
const AUDIO_VOLUME = {
  pickup: 0.32,
  machine_feed: 0.38,
  machine_complete: 0.5,
  coin: 0.42,
  purchase: 0.48,
  ui_click: 0.35,
  hazard: 0.42,
  module_complete: 0.65,
  victory: 0.75,
  footstep0: 0.14,
  footstep1: 0.14,
  footstep2: 0.14,
  footstep3: 0.14
};

// Minimalny odstęp (ms) między kolejnymi odtworzeniami TEGO SAMEGO dźwięku.
const AUDIO_MIN_INTERVAL = {
  pickup: 70,
  machine_feed: 90,
  coin: 60,
  // BUGFIX ("kroki mają pasować do częstotliwości chodzenia"): było 220ms,
  // czyli DOKŁADNIE na granicy najszybszego realnego kroku. Cykl chodu przy
  // bazowej prędkości daje krok co ~390ms, ale z ulepszeniami prędkości
  // (do ~1.75x) schodzi do ~225ms - próg 220ms zaczynał więc WYCINAĆ co
  // drugi krok przy szybkim marszu i dźwięk rozjeżdżał się z nogami. Teraz
  // 90ms: nadal chroni przed patologicznym spamem, ale nie odrzuca żadnego
  // prawdziwego kroku (najszybszy możliwy to ~180ms).
  footstep: 90
};
const AUDIO_DEFAULT_MIN_INTERVAL = 150;

// --- Kroki: SYNTEZA per PODŁOŻE (Web Audio) ----------------------------------
// Każda nawierzchnia to osobno ZSYNTEZOWANY dźwięk, nie ta sama próbka
// przestrojona wysokością (tak było wcześniej - brzmiało jak jedna stopa na
// czterech taśmach puszczonych z różną prędkością). Budulcem jest krótki
// impuls białego szumu przepuszczony przez filtr i obwiednię - klasyczna
// synteza perkusyjna. Zmieniając typ/częstotliwość filtra, długość obwiedni i
// liczbę "ziaren" dostajemy realnie różne materiały z zera assetów.
//
// Parametry:
//   grains  - ile mikro-impulsów składa się na jeden krok (żwir = kilka
//             chrupnięć, trawa = jedno miękkie szurnięcie)
//   dur     - długość pojedynczego ziarna (s)
//   type    - typ filtra
//   freq    - częstotliwość filtra (Hz)
//   q       - rezonans filtra (wyższe = bardziej "dzwoniące")
//   sweep   - docelowa częstotliwość filtra na koniec dźwięku (null = bez
//             przemiatania). Opadające przemiatanie daje efekt "mlaśnięcia".
//   vol     - głośność względna
//   ring    - opcjonalny dzwoniący ton (Hz) dodany do szumu (kryształ)
const AUDIO_STEP_SURFACE = {
  // Trawa: jedno miękkie, ciemne szurnięcie - bez chrupania, bez dzwonienia.
  A: { grains: 1, dur: 0.13, type: 'lowpass',  freq: 1700, q: 1.2, sweep: null, vol: 0.85, ring: null },
  // Bagno: opadające przemiatanie filtra = charakterystyczne mokre "mlaśnięcie",
  // najdłuższe i najciemniejsze ze wszystkich.
  B: { grains: 1, dur: 0.26, type: 'lowpass',  freq: 1100, q: 6,   sweep: 260, vol: 1.0,  ring: null },
  // Popiół/żwir: KILKA krótkich, jasnych ziaren pod rząd - to właśnie daje
  // chrzęst kruszywa zamiast jednego plaśnięcia.
  C: { grains: 4, dur: 0.045, type: 'bandpass', freq: 3200, q: 2.5, sweep: null, vol: 0.9,  ring: null },
  // Kryształ: bardzo krótki jasny impuls + wysoki dzwoniący ton - szklane,
  // rezonujące stąpnięcie.
  // BALANS: vol było 0.7 - ale dzwoniący ton DODAJE się do ziaren szumu, więc
  // zmierzony szczyt wychodził 0.92 przy ~0.4 pozostałych nawierzchni (ryzyko
  // przesterowania w miksie z muzyką i po prostu za głośno). Obniżone tak, by
  // kryształ mieścił się w tym samym zakresie co reszta.
  D: { grains: 2, dur: 0.05, type: 'highpass', freq: 2600, q: 3,   sweep: null, vol: 0.34, ring: 2100 }
};
// Głośność szyny kroków (patrz _ensureAudioContext). Podobny poziom co dawne
// próbki (0.14), żeby kroki nie zaczęły nagle dominować nad resztą gry.
const AUDIO_STEP_VOLUME = 0.16;

// Gotowe PLIKI kroków per strefa (=nawierzchnia). Wyrenderowane z tej samej
// syntezy co AUDIO_STEP_SURFACE wyżej, ale zapisane jako .wav - dzięki temu
// nie trzeba liczyć DSP przy każdym kroku (2-3 razy na sekundę na telefonie)
// ani zależeć od Web Audio. Po 2 warianty na podłoże, wybierane naprzemiennie,
// żeby kolejne kroki nie brzmiały identycznie.
// Synteza w _playSynthFootstep zostaje jako awaryjna ścieżka, gdyby któryś
// plik się nie wczytał.
const AUDIO_STEP_FILES = {
  A: ['step_grass0', 'step_grass1'],
  B: ['step_swamp0', 'step_swamp1'],
  C: ['step_ash0', 'step_ash1'],
  D: ['step_crystal0', 'step_crystal1']
};
// Głośność plików kroków (te same proporcje między nawierzchniami co miała
// synteza - patrz vol w AUDIO_STEP_SURFACE; poziom bazowy jak reszta efektów).
const AUDIO_STEP_FILE_VOLUME = 0.3;

// Klucz w localStorage do zapamiętania preferencji wyciszenia między sesjami.
const AUDIO_MUTE_STORAGE_KEY = 'ecomart_muted';

// --- Muzyka w tle (proceduralna - patrz startMusic) --------------------------
// Wyraźnie ciszej niż JAKIKOLWIEK efekt (najcichszy to krok, 0.14) - to ma być
// tło, którego się nie zauważa, a nie drugi plan konkurujący z dźwiękami gry.
const AUDIO_MUSIC_VOLUME = 0.075;
// Skala pentatoniczna (A-moll: A C D E G) w dwóch oktawach. Pentatonika NIE
// zawiera półtonów ani trytonu, więc DOWOLNE dwie nuty z tej listy brzmią
// razem zgodnie - dzięki temu można losować nuty bez ryzyka dysonansu i bez
// pisania prawdziwej harmonii/progresji akordów.
const AUDIO_MUSIC_SCALE = [
  110.00, 130.81, 146.83, 164.81, 196.00, // A2 C3 D3 E3 G3
  220.00, 261.63, 293.66, 329.63, 392.00  // A3 C4 D4 E4 G4
];

// Losowe wahnięcie wysokości dźwięku (playbackRate) przy KAŻDYM odtworzeniu -
// bez tego częste dźwięki (pickup/machine_feed/kroki, kilka razy na sekundę
// przy aktywnej grze) brzmią identycznie w kółko i szybko męczą ucho.
// Drobna, niesłyszalna jako "przesterowanie" wariancja (0.94-1.06) wystarcza,
// żeby seria tych samych dźwięków brzmiała żywiej - klasyczny trik game feel,
// zero nowych plików audio.
const AUDIO_PITCH_VARIATION = 0.06;

class AudioManager {
  constructor() {
    this._elements = {};
    this._lastPlayedAt = {};
    this._footstepIndex = 0;
    this.muted = this._loadMutePreference();

    // Muzyka w tle (proceduralna) - tworzone leniwie w startMusic(), patrz
    // komentarz tam (autoplay policy przeglądarek).
    this._audioCtx = null;
    this._musicGain = null;
    this._musicTimer = null;
    // Szyna + bufor szumu dla SYNTEZOWANYCH kroków (patrz AUDIO_STEP_SURFACE).
    this._sfxGain = null;
    this._noiseBuffer = null;

    Object.keys(AUDIO_SRC).forEach((key) => {
      const el = new Audio();
      el.preload = 'auto';
      el.src = AUDIO_SRC[key];
      el.volume = AUDIO_VOLUME[key] ?? 0.5;
      el.onerror = () => console.warn(`[AudioManager] Nie udało się wczytać dźwięku "${key}" (${AUDIO_SRC[key]}).`);
      this._elements[key] = el;
    });

    this._onItemPickup = () => this.play('pickup');
    this._onMachineReceived = () => this.play('machine_feed');
    this._onMachineOutput = () => this.play('machine_complete');
    this._onMoneyCollected = (data) => {
      // Tylko FAKTYCZNIE zarobione pieniądze (amount > 0) - EconomyManager
      // publikuje ten sam event z amount:0 też przy wydawaniu (np. wpłata
      // na moduł statku), żeby UI się odświeżyło. Bez tego sprawdzenia
      // wydawanie pieniędzy brzmiałoby tak samo jak ich zarabianie.
      if (data && data.amount > 0) this.play('coin');
    };
    this._onUpgradeBought = () => this.play('purchase');
    this._onShipModuleCompleted = () => this.play('module_complete');
    this._onGameWon = () => this.play('victory');
    // Przekazujemy dane eventu dalej - jest w nich strefa (=podłoże), po
    // której _playFootstep dobiera brzmienie kroku.
    this._onFootstep = (data) => this._playFootstep(data);
    this._onZoneHazardWarning = () => this.play('hazard');

    Bus.subscribe(Events.ITEM_PICKUP, this._onItemPickup);
    Bus.subscribe(Events.MACHINE_RECEIVED, this._onMachineReceived);
    Bus.subscribe(Events.MACHINE_OUTPUT, this._onMachineOutput);
    Bus.subscribe(Events.MONEY_COLLECTED, this._onMoneyCollected);
    Bus.subscribe(Events.UPGRADE_BOUGHT, this._onUpgradeBought);
    if (Events.SHIP_MODULE_COMPLETED) Bus.subscribe(Events.SHIP_MODULE_COMPLETED, this._onShipModuleCompleted);
    if (Events.GAME_WON) Bus.subscribe(Events.GAME_WON, this._onGameWon);
    if (Events.FOOTSTEP) Bus.subscribe(Events.FOOTSTEP, this._onFootstep);
    if (Events.ZONE_HAZARD_WARNING) Bus.subscribe(Events.ZONE_HAZARD_WARNING, this._onZoneHazardWarning);
  }

  /**
   * Odtwarza dźwięk o danym kluczu, o ile minął minimalny odstęp od
   * poprzedniego odtworzenia TEGO SAMEGO dźwięku i gra nie jest wyciszona.
   * Klonuje węzeł Audio przed odtworzeniem, żeby nakładające się (np. dwa
   * szybkie pickupy) dźwięki grały RÓWNOLEGLE, nie ucinały się nawzajem.
   */
  play(key) {
    if (this.muted) return;
    const el = this._elements[key];
    if (!el) return;

    const now = Date.now();
    const minInterval = AUDIO_MIN_INTERVAL[key] ?? AUDIO_DEFAULT_MIN_INTERVAL;
    if (now - (this._lastPlayedAt[key] || 0) < minInterval) return;
    this._lastPlayedAt[key] = now;

    // cloneNode zamiast bezpośredniego play() na oryginale - pozwala
    // kolejnym wywołaniom nakładać się dźwiękowo zamiast przerywać
    // poprzednie odtwarzanie tego samego elementu.
    const clone = el.cloneNode(true);
    clone.volume = el.volume;
    clone.playbackRate = this._randomPitch();
    clone.play().catch(() => {
      // Przeglądarka może odrzucić play() przed pierwszą interakcją
      // użytkownika (autoplay policy) - to nie błąd wart logowania,
      // po prostu dźwięk nie zagra do pierwszego tapnięcia/kliknięcia.
    });
  }

  /** Patrz AUDIO_PITCH_VARIATION - losowa wysokość w wąskim, niesłyszalnym
   * jako "przesterowanie" zakresie, żeby powtarzające się dźwięki nie
   * brzmiały jak plyta z zarysowaniem. */
  _randomPitch() {
    return 1 + (Math.random() * 2 - 1) * AUDIO_PITCH_VARIATION;
  }

  /**
   * Krok - ZSYNTEZOWANY pod aktualne podłoże (patrz AUDIO_STEP_SURFACE).
   * Fallback: gdy Web Audio jest niedostępne, gramy stare próbki footstep0-3
   * (_playSampleFootstep), żeby gra nigdy nie została całkiem bez kroków.
   * @param {{zone?: string}} data - z Events.FOOTSTEP (player.js publikuje strefę)
   */
  _playFootstep(data) {
    if (this.muted) return;
    const now = Date.now();
    if (now - (this._lastPlayedAt.footstep || 0) < AUDIO_MIN_INTERVAL.footstep) return;
    this._lastPlayedAt.footstep = now;

    const zone = (data && data.zone) || 'A';
    // Kolejność: gotowy PLIK dla tej nawierzchni -> synteza -> stare próbki.
    // Plik jest najtańszy (zero DSP w czasie gry), synteza ratuje sytuację gdy
    // plik się nie wczytał, a stare footstep0-3 gdy nie ma nawet Web Audio.
    if (this._playSurfaceFile(zone)) return;
    if (this._playSynthFootstep(zone)) return;
    this._playSampleFootstep();
  }

  /**
   * Gra gotowy plik kroku dla danej nawierzchni (patrz AUDIO_STEP_FILES).
   * @returns {boolean} czy udało się zagrać (false => plik niewczytany)
   */
  _playSurfaceFile(zone) {
    const keys = AUDIO_STEP_FILES[zone] || AUDIO_STEP_FILES.A;
    if (!keys) return false;
    const key = keys[this._footstepIndex % keys.length];
    const el = this._elements[key];
    // readyState < 2 => metadane jeszcze nie gotowe, plik może nie istnieć.
    if (!el || el.readyState < 2) return false;
    this._footstepIndex++;

    const clone = el.cloneNode(true);
    clone.volume = AUDIO_STEP_FILE_VOLUME;
    // Drobna wariancja wysokości - te same 2 pliki na nawierzchnię nie mogą
    // brzmieć jak zapętlona próbka przy szybkim marszu.
    clone.playbackRate = this._randomPitch();
    clone.play().catch(() => {});
    return true;
  }

  /**
   * Syntezuje krok dla danej strefy: impuls(y) białego szumu przez filtr z
   * obwiednią (klasyczna synteza perkusyjna), opcjonalnie z dzwoniącym tonem.
   * Wszystkie węzły są jednorazowe - Web Audio sam je zwalnia po zakończeniu
   * odtwarzania, więc nie ma czego sprzątać ręcznie.
   * @returns {boolean} czy udało się zagrać (false => brak Web Audio)
   */
  _playSynthFootstep(zone) {
    if (!this._ensureAudioContext()) return false;
    const ctx = this._audioCtx;
    const s = AUDIO_STEP_SURFACE[zone] || AUDIO_STEP_SURFACE.A;
    const now = ctx.currentTime;

    // Drobna losowa wariancja na KAŻDY krok - bez niej te same 4 nawierzchnie
    // brzmiałyby jak zapętlona próbka (dokładnie ten problem, który
    // rozwiązywał _randomPitch przy starych samplach).
    const vary = () => 1 + (Math.random() * 2 - 1) * 0.12;

    for (let g = 0; g < s.grains; g++) {
      // Ziarna rozłożone w czasie - dla żwiru daje to chrzęst kilku
      // następujących po sobie chrupnięć zamiast jednego plaśnięcia.
      const t0 = now + g * s.dur * 0.55;
      const dur = s.dur * vary();

      const src = ctx.createBufferSource();
      src.buffer = this._noiseBuffer;
      // Losowy punkt startu w buforze szumu = inny materiał źródłowy co krok.
      const offset = Math.random() * (this._noiseBuffer.duration - dur - 0.01);

      const filter = ctx.createBiquadFilter();
      filter.type = s.type;
      filter.Q.value = s.q;
      const f0 = s.freq * vary();
      filter.frequency.setValueAtTime(f0, t0);
      if (s.sweep) {
        // Opadające przemiatanie = "mlaśnięcie" (bagno).
        filter.frequency.exponentialRampToValueAtTime(Math.max(40, s.sweep), t0 + dur);
      }

      const gain = ctx.createGain();
      // Ostry atak, wykładnicze wybrzmienie - tak zachowuje się uderzenie.
      // Kolejne ziarna coraz ciszej, żeby chrzęst naturalnie opadał.
      const peak = s.vol * (1 - g * 0.18);
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(peak, t0 + dur * 0.08);
      gain.gain.exponentialRampToValueAtTime(0.0008, t0 + dur);

      src.connect(filter);
      filter.connect(gain);
      gain.connect(this._sfxGain);
      src.start(t0, offset, dur + 0.02);
      src.stop(t0 + dur + 0.02);
    }

    // Dzwoniący ton - tylko kryształ. Krótki, wysoki, szybko gasnący, żeby
    // czytał się jako szkło, a nie jako nuta muzyki.
    if (s.ring) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = s.ring * vary();
      const rg = ctx.createGain();
      const rd = 0.28;
      rg.gain.setValueAtTime(0, now);
      rg.gain.linearRampToValueAtTime(s.vol * 0.5, now + 0.008);
      rg.gain.exponentialRampToValueAtTime(0.0008, now + rd);
      osc.connect(rg);
      rg.connect(this._sfxGain);
      osc.start(now);
      osc.stop(now + rd);
    }

    return true;
  }

  /** Stara ścieżka na próbkach footstep0-3 - używana TYLKO gdy Web Audio jest
   * niedostępne (patrz _playFootstep). */
  _playSampleFootstep() {
    const key = `footstep${this._footstepIndex % 4}`;
    this._footstepIndex++;
    const el = this._elements[key];
    if (!el) return;
    const clone = el.cloneNode(true);
    clone.volume = el.volume;
    clone.playbackRate = this._randomPitch();
    clone.play().catch(() => {});
  }

  // --- Muzyka w tle (proceduralna, Web Audio API) --------------------------
  // ŻADNEGO pliku audio - w projekcie nie ma podkładu muzycznego, a
  // wygenerować gotowego utworu nie da się w kodzie. Zamiast tego generatywny,
  // spokojny ambient: kilka oscylatorów grających długie, nakładające się nuty
  // z jednej skali (pentatonika - nie da się nią zagrać dysonansu, więc losowe
  // nuty ZAWSZE brzmią zgodnie). Ten sam duch co proceduralna Oczyszczalnia/
  // teren Grani - robimy z kodu to, na co nie mamy assetu.
  //
  // Świadomy kompromis: to nie jest skomponowany utwór i nim nie będzie -
  // to nastrojowe tło, które nie męczy przy długiej grze i nie zapętla się
  // słyszalnie (nuty losowane, więc nie ma "tej samej pętli w kółko").
  //
  // AudioContext tworzymy DOPIERO przy pierwszym starcie muzyki, nie w
  // konstruktorze - przeglądarki blokują audio przed pierwszą interakcją
  // użytkownika (autoplay policy), a kontekst utworzony za wcześnie zostaje
  // w stanie 'suspended' i trzeba go i tak wznawiać.
  /**
   * Tworzy (raz) AudioContext + węzły wzmocnienia. Wspólne dla muzyki I
   * syntezowanych kroków - stąd osobna metoda zamiast kodu w startMusic().
   * @returns {boolean} czy Web Audio jest dostępne i gotowe
   */
  _ensureAudioContext() {
    if (this._audioCtx) {
      if (this._audioCtx.state === 'suspended') this._audioCtx.resume();
      return true;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return false; // brak Web Audio - gra działa dalej, po prostu ciszej
    this._audioCtx = new Ctx();

    this._musicGain = this._audioCtx.createGain();
    this._musicGain.gain.value = this.muted ? 0 : AUDIO_MUSIC_VOLUME;
    this._musicGain.connect(this._audioCtx.destination);

    // Osobna szyna dla syntezowanych kroków - własna głośność, niezależna
    // od muzyki (kroki mają być słyszalne PONAD podkładem).
    this._sfxGain = this._audioCtx.createGain();
    this._sfxGain.gain.value = AUDIO_STEP_VOLUME;
    this._sfxGain.connect(this._audioCtx.destination);

    // Bufor białego szumu - budulec WSZYSTKICH kroków. Tworzony RAZ i
    // odtwarzany od losowego miejsca przy każdym kroku (patrz
    // _playSynthFootstep), więc żaden krok nie brzmi identycznie, a nie
    // generujemy szumu od nowa 2-3 razy na sekundę.
    const sr = this._audioCtx.sampleRate;
    const noise = this._audioCtx.createBuffer(1, Math.floor(sr * 0.5), sr);
    const ch = noise.getChannelData(0);
    for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
    this._noiseBuffer = noise;

    return true;
  }

  startMusic() {
    if (this._musicTimer) return; // już gra
    try {
      if (!this._ensureAudioContext()) return;
      this._scheduleNextNote();
    } catch (e) {
      console.warn('[AudioManager] Nie udało się uruchomić muzyki:', e);
    }
  }

  stopMusic() {
    if (this._musicTimer) {
      clearTimeout(this._musicTimer);
      this._musicTimer = null;
    }
  }

  /** Gra JEDNĄ nutę (miękki trójkąt + filtr dolnoprzepustowy, długi atak i
   * wybrzmienie) i planuje kolejną. Rekurencyjny setTimeout zamiast setInterval -
   * odstęp jest losowy, więc frazy nie wpadają w słyszalny, mechaniczny rytm. */
  _scheduleNextNote() {
    const ctx = this._audioCtx;
    if (!ctx) return;

    // Gramy tylko gdy karta jest widoczna - bez tego przeglądarka i tak
    // dławi timery w tle, a nuty zbierałyby się i wystrzeliły naraz po
    // powrocie do gry.
    if (typeof document !== 'undefined' && document.hidden) {
      this._musicTimer = setTimeout(() => this._scheduleNextNote(), 1000);
      return;
    }

    if (!this.muted) {
      const freq = AUDIO_MUSIC_SCALE[Math.floor(Math.random() * AUDIO_MUSIC_SCALE.length)];
      const now = ctx.currentTime;
      const dur = 2.6 + Math.random() * 2.2;

      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = freq;

      // Filtr ścina ostre górne harmoniczne - bez niego trójkąt brzmi
      // "elektronicznie/piskliwie", z nim miękko, jak pad.
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 900;

      // Obwiednia: powolne narastanie i długie wybrzmienie (żadnych
      // słyszalnych "klików" na starcie/końcu nuty).
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.9, now + dur * 0.35);
      gain.gain.linearRampToValueAtTime(0, now + dur);

      osc.connect(filter);
      filter.connect(gain);
      gain.connect(this._musicGain);
      osc.start(now);
      osc.stop(now + dur);
    }

    // Kolejna nuta zachodzi na poprzednią (krótszy odstęp niż czas trwania) -
    // stąd wrażenie ciągłego, nakładającego się padu zamiast pojedynczych,
    // odseparowanych dźwięków.
    this._musicTimer = setTimeout(() => this._scheduleNextNote(), 1400 + Math.random() * 1600);
  }

  toggleMute() {
    this.setMuted(!this.muted);
  }

  setMuted(muted) {
    this.muted = muted;
    this._saveMutePreference(muted);
    // Wyciszenie musi łapać też muzykę - efekty sprawdzają this.muted przy
    // każdym play(), ale muzyka leci przez własny węzeł wzmocnienia.
    if (this._musicGain && this._audioCtx) {
      this._musicGain.gain.setTargetAtTime(
        muted ? 0 : AUDIO_MUSIC_VOLUME,
        this._audioCtx.currentTime,
        0.05
      );
    }
  }

  _loadMutePreference() {
    try {
      return localStorage.getItem(AUDIO_MUTE_STORAGE_KEY) === '1';
    } catch (e) {
      return false;
    }
  }

  _saveMutePreference(muted) {
    try {
      localStorage.setItem(AUDIO_MUTE_STORAGE_KEY, muted ? '1' : '0');
    } catch (e) {
      // localStorage niedostepny (np. tryb prywatny) - cicho ignorujemy,
      // wyciszenie po prostu nie przetrwa do nastepnej sesji.
    }
  }

  /**
   * Usuwa subskrypcje z Bus. Przydatne przy restarcie gry / tworzeniu nowej
   * instancji, analogicznie do destroy() w innych modułach projektu.
   */
  destroy() {
    Bus.unsubscribe(Events.ITEM_PICKUP, this._onItemPickup);
    Bus.unsubscribe(Events.MACHINE_RECEIVED, this._onMachineReceived);
    Bus.unsubscribe(Events.MACHINE_OUTPUT, this._onMachineOutput);
    Bus.unsubscribe(Events.MONEY_COLLECTED, this._onMoneyCollected);
    Bus.unsubscribe(Events.UPGRADE_BOUGHT, this._onUpgradeBought);
    if (Events.SHIP_MODULE_COMPLETED) Bus.unsubscribe(Events.SHIP_MODULE_COMPLETED, this._onShipModuleCompleted);
    if (Events.GAME_WON) Bus.unsubscribe(Events.GAME_WON, this._onGameWon);
    if (Events.FOOTSTEP) Bus.unsubscribe(Events.FOOTSTEP, this._onFootstep);
    if (Events.ZONE_HAZARD_WARNING) Bus.unsubscribe(Events.ZONE_HAZARD_WARNING, this._onZoneHazardWarning);

    this.stopMusic();
    if (this._audioCtx && typeof this._audioCtx.close === 'function') {
      this._audioCtx.close();
      this._audioCtx = null;
    }
  }
}

window.AudioManager = AudioManager;
