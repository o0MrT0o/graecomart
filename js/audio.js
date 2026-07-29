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
 *      GAME_WON, FOOTSTEP, ZONE_HAZARD_WARNING, ACHIEVEMENT_UNLOCKED, ITEM_LOST)
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
  // Tomek wgrał do repo pełne paczki Kenney (nie same PNG jak wcześniej -
  // "Sounds"/"Bonus" foldery wewnątrz kilku z nich mają gotowe efekty CC0).
  // ui_click/module_complete PODMIENIONE (te same klucze, nowe pliki - zero
  // zmian w miejscach wołających play()): ui_click na 'tap-a' z tego samego
  // Kenney UI Pack, którego teksturami są już przyciski (style.css .ui-btn) -
  // dźwięk i wygląd przycisków wreszcie z jednego zestawu. module_complete
  // na 'sfx_shieldUp' z Space Shooter Remastered - "tarcza w górze" czyta się
  // dużo bardziej jako "moduł statku naprawiony/zasilony" niż ogólny jingle.
  ui_click: 'assets/audio/ui_click.ogg',
  hazard: 'assets/audio/hazard.mp3',
  module_complete: 'assets/audio/module_complete.ogg',
  victory: 'assets/audio/victory.mp3',
  // NOWE klucze (uzupełniają zdarzenia, które wcześniej nie miały ŻADNEGO
  // dźwięku - nie podmiana, tylko brakujący efekt):
  //   ui_switch    - 'switch-a' (Kenney UI Pack) - WYŁĄCZNIE przycisk Dźwięk
  //                  w Menu (patrz UIButton sound param, ui.js) - jedyny
  //                  przycisk w grze będący faktycznym przełącznikiem.
  //   achievement  - 'sfx_magic' (Kenney New Platformer Pack) -
  //                  Events.ACHIEVEMENT_UNLOCKED nie miało wcześniej ŻADNEGO
  //                  dźwięku (audio.js go nawet nie subskrybował).
  //   item_lost    - 'sfx_lose' (Kenney Space Shooter Remastered) - utrata
  //                  przedmiotu w strefie hazardu (Events.ITEM_LOST, nowy
  //                  event - patrz player.js/eventbus.js) miała dotąd tylko
  //                  wstrząs ekranu + popup, żadnego dźwięku.
  ui_switch: 'assets/audio/ui_switch.ogg',
  achievement: 'assets/audio/achievement.ogg',
  item_lost: 'assets/audio/item_lost.ogg',
  footstep0: 'assets/audio/footstep0.mp3',
  footstep1: 'assets/audio/footstep1.mp3',
  footstep2: 'assets/audio/footstep2.mp3',
  footstep3: 'assets/audio/footstep3.mp3',
  // Kroki per NAWIERZCHNIA - dotąd własna synteza wyrenderowana do .wav
  // (patrz komentarz przy AUDIO_STEP_SURFACE niżej - synteza ZOSTAJE jako
  // awaryjna ścieżka), teraz prawdziwe nagrania z Kenney "Impact Sounds"
  // (Tomek: "podmień kroki na prawdziwe, dopasuj do regionu"), po 3
  // warianty na podłoże zamiast 2 - mniej słyszalne powtórzenie przy
  // szybkim marszu. Dobór per strefa (żadna z 5 dostępnych faktur w paczce
  // nie nazywa się dosłownie "bagno" ani "kryształ", więc dopasowanie po
  // BRZMIENIU, nie po nazwie pliku):
  //   A trawa    - footstep_grass - jedyne dokładne 1:1 trafienie.
  //   B bagno    - footstep_carpet - najbardziej stłumiona/miękka z
  //                dostępnych (bez chrzęstu, bez dzwonienia) - najbliższy
  //                odpowiednik dawnego "mokrego mlaśnięcia" (concrete/wood/
  //                snow wszystkie brzmią zbyt twardo/sucho na bagno).
  //   C popiół   - footstep_snow - chrzęszcząca faktura śniegu czyta się
  //                bliżej "chrzęstu kruszywa" niż twarde concrete/wood.
  //   D kryształ - impactGlass_light (NIE footstep_*) - szklany, jasny
  //                impakt pasuje do "szklanego, dzwoniącego stąpnięcia"
  //                dużo lepiej niż jakikolwiek footstep w tej paczce.
  step_grass0: 'assets/audio/step_grass0.ogg',
  step_grass1: 'assets/audio/step_grass1.ogg',
  step_grass2: 'assets/audio/step_grass2.ogg',
  step_swamp0: 'assets/audio/step_swamp0.ogg',
  step_swamp1: 'assets/audio/step_swamp1.ogg',
  step_swamp2: 'assets/audio/step_swamp2.ogg',
  step_ash0: 'assets/audio/step_ash0.ogg',
  step_ash1: 'assets/audio/step_ash1.ogg',
  step_ash2: 'assets/audio/step_ash2.ogg',
  step_crystal0: 'assets/audio/step_crystal0.ogg',
  step_crystal1: 'assets/audio/step_crystal1.ogg',
  step_crystal2: 'assets/audio/step_crystal2.ogg'
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
  ui_switch: 0.4,
  hazard: 0.42,
  module_complete: 0.65,
  victory: 0.75,
  achievement: 0.55,
  item_lost: 0.4,
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

// Gotowe PLIKI kroków per strefa (=nawierzchnia) - prawdziwe nagrania
// (Kenney "Impact Sounds", patrz AUDIO_SRC), nie trzeba liczyć DSP przy
// każdym kroku (2-3 razy na sekundę na telefonie) ani zależeć od Web Audio.
// Po 3 warianty na podłoże (było 2), wybierane po kolei (patrz
// _playSurfaceFile - footstepIndex % keys.length), żeby kolejne kroki nie
// brzmiały identycznie nawet przy dłuższym marszu w jedną stronę.
// Synteza w _playSynthFootstep zostaje jako awaryjna ścieżka, gdyby któryś
// plik się nie wczytał.
const AUDIO_STEP_FILES = {
  A: ['step_grass0', 'step_grass1', 'step_grass2'],
  B: ['step_swamp0', 'step_swamp1', 'step_swamp2'],
  C: ['step_ash0', 'step_ash1', 'step_ash2'],
  D: ['step_crystal0', 'step_crystal1', 'step_crystal2']
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

// --- Muzyka: kilka "nastrojów" grających NA ZMIANĘ ---------------------------
// PIERWSZA wersja tego pomysłu wiązała brzmienie ze strefą, w której akurat
// stoi gracz (biom = nastrój) - zmienione na prośbę: nastroje mają rotować
// OGÓLNIE, w tle, niezależnie od tego, gdzie gracz akurat jest, zamiast
// przełączać się przy każdym przekroczeniu granicy strefy.
//
// Ten sam generator nut (pentatonika, zero ryzyka dysonansu) gra kolejno
// "utwory" z AUDIO_MUSIC_TRACKS - każdy to inne nastrojenie: który rejestr
// skali (scaleFrom/scaleTo, indeksy w AUDIO_MUSIC_SCALE), jak jasno/matowo
// brzmi (filterFreq - niżej = bardziej stłumione), jak gęsto/rzadko lecą
// nuty (gapMin/gapMax) i jak głośno (peak). Rotacja co AUDIO_MUSIC_TRACK_*
// nut (patrz _scheduleNextNote), NIE co event z Bus - żaden inny moduł nie
// musi o tym wiedzieć.
//
// Track 0 to DOKŁADNIE dotychczasowe wartości (scaleFrom:0, scaleTo:10,
// filterFreq:900, dur 2.6-4.8, gap 1400-3000, peak 0.9) - zerowa zmiana
// brzmienia w pierwszej fazie rotacji, żeby nic, co już działało, się nie
// zepsuło.
const AUDIO_MUSIC_TRACKS = [
  // 0: spokojny (dotychczasowe brzmienie, bez zmian).
  { scaleFrom: 0, scaleTo: 10, filterFreq: 900, durMin: 2.6, durMax: 4.8, gapMin: 1400, gapMax: 3000, peak: 0.9 },
  // 1: mroczny/przytłumiony - tylko DOLNA oktawa (indeksy 0-4), mocno
  // stłumiony filtr, wolniej i ciszej - ten sam charakter co bagno
  // (najdłuższy/najciemniejszy krok, AUDIO_STEP_SURFACE.B).
  { scaleFrom: 0, scaleTo: 5, filterFreq: 480, durMin: 3.4, durMax: 6.2, gapMin: 2000, gapMax: 3800, peak: 0.75 },
  // 2: niespokojny - PEŁNY rejestr, ale szybciej/gęściej i odrobinę
  // głośniej - napięcie zamiast spokoju, bez łamania pentatoniki.
  { scaleFrom: 0, scaleTo: 10, filterFreq: 700, durMin: 1.6, durMax: 3.0, gapMin: 850, gapMax: 1700, peak: 1.0 },
  // 3: jasny/eteryczny - tylko GÓRNA oktawa (indeksy 5-9), jasny filtr +
  // shimmer (patrz _maybePlayShimmer) - "szklane" brzmienie zgodne z
  // dzwoniącym tonem kroku Kryształowej Grani (AUDIO_STEP_SURFACE.D.ring).
  { scaleFrom: 5, scaleTo: 10, filterFreq: 1700, durMin: 2.2, durMax: 4.0, gapMin: 1200, gapMax: 2600, peak: 0.85, shimmer: true }
];
// Po ilu nutach (losowo w tym zakresie) rotujemy na kolejny utwór z listy -
// "fraza muzyczna", nie sztywna liczba, żeby przejścia nie wypadały w
// przewidywalnym rytmie.
const AUDIO_MUSIC_TRACK_NOTES_MIN = 5;
const AUDIO_MUSIC_TRACK_NOTES_MAX = 9;
// Szansa na dodatkowy "błysk" (wysoki, szybko gasnący sinus - jak
// _playSynthFootstep's ring) NAŁOŻONY na główną nutę, TYLKO gdy bieżący
// utwór ma shimmer:true (patrz AUDIO_MUSIC_TRACKS[3]).
const AUDIO_MUSIC_SHIMMER_CHANCE = 0.4;

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
    // Rotacja "utworów" (patrz AUDIO_MUSIC_TRACKS) - zaczynamy od 0 (dawne,
    // niezmienione brzmienie), _musicTrackNotesLeft losowany dopiero przy
    // starcie muzyki (patrz startMusic/_scheduleNextNote), żeby pierwsza
    // fraza też miała losową długość, nie zawsze tę samą.
    this._musicTrackIndex = 0;
    this._musicTrackNotesLeft = null;
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
    // Szlifiernia Kryształów (machines.js) - JEDYNA maszyna z WŁASNYM
    // dźwiękiem ukończenia zamiast wspólnego 'machine_complete' - najdroższy
    // produkt w grze (patrz MARKET_BASE_PRICES.crystal_gem) zasługuje na
    // wyraźnie inny, bardziej "specjalny" sygnał niż reszta maszyn.
    this._onMachineOutput = (data) => {
      if (data && data.machineId === 'crystal_polisher') this._playCrystalChime();
      else this.play('machine_complete');
    };
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
    this._onAchievementUnlocked = () => this.play('achievement');
    this._onItemLost = () => this.play('item_lost');

    Bus.subscribe(Events.ITEM_PICKUP, this._onItemPickup);
    Bus.subscribe(Events.MACHINE_RECEIVED, this._onMachineReceived);
    Bus.subscribe(Events.MACHINE_OUTPUT, this._onMachineOutput);
    Bus.subscribe(Events.MONEY_COLLECTED, this._onMoneyCollected);
    Bus.subscribe(Events.UPGRADE_BOUGHT, this._onUpgradeBought);
    if (Events.SHIP_MODULE_COMPLETED) Bus.subscribe(Events.SHIP_MODULE_COMPLETED, this._onShipModuleCompleted);
    if (Events.GAME_WON) Bus.subscribe(Events.GAME_WON, this._onGameWon);
    if (Events.FOOTSTEP) Bus.subscribe(Events.FOOTSTEP, this._onFootstep);
    if (Events.ZONE_HAZARD_WARNING) Bus.subscribe(Events.ZONE_HAZARD_WARNING, this._onZoneHazardWarning);
    if (Events.ACHIEVEMENT_UNLOCKED) Bus.subscribe(Events.ACHIEVEMENT_UNLOCKED, this._onAchievementUnlocked);
    if (Events.ITEM_LOST) Bus.subscribe(Events.ITEM_LOST, this._onItemLost);
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
   * odstęp jest losowy, więc frazy nie wpadają w słyszalny, mechaniczny rytm.
   * Co AUDIO_MUSIC_TRACK_NOTES_MIN..MAX nut rotuje na kolejny "utwór" z
   * AUDIO_MUSIC_TRACKS (patrz komentarz tam) - NIEZALEŻNIE od tego, gdzie
   * akurat jest gracz, w przeciwieństwie do pierwszej wersji tego pomysłu. */
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

    const track = AUDIO_MUSIC_TRACKS[this._musicTrackIndex];

    if (!this.muted) {
      const scaleSlice = AUDIO_MUSIC_SCALE.slice(track.scaleFrom, track.scaleTo);
      const freq = scaleSlice[Math.floor(Math.random() * scaleSlice.length)];
      const now = ctx.currentTime;
      const dur = track.durMin + Math.random() * (track.durMax - track.durMin);

      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = freq;

      // Filtr ścina ostre górne harmoniczne - bez niego trójkąt brzmi
      // "elektronicznie/piskliwie", z nim miękko, jak pad. Częstotliwość
      // zależy od bieżącego utworu (track.filterFreq) - niżej = bardziej
      // stłumione/matowe, wyżej = jaśniejsze/dzwoniące.
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = track.filterFreq;

      // Obwiednia: powolne narastanie i długie wybrzmienie (żadnych
      // słyszalnych "klików" na starcie/końcu nuty).
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(track.peak, now + dur * 0.35);
      gain.gain.linearRampToValueAtTime(0, now + dur);

      osc.connect(filter);
      filter.connect(gain);
      gain.connect(this._musicGain);
      osc.start(now);
      osc.stop(now + dur);

      if (track.shimmer) this._maybePlayShimmer(now);
    }

    // Rotacja utworów - odliczana NIEZALEŻNIE od this.muted (cichy gracz
    // wraca do dźwięku dokładnie w tym samym miejscu rotacji, w którym by
    // był, gdyby nie wyciszał), więc tylko SAMO odtworzenie jest pominięte
    // wyżej, nie licznik frazy.
    if (this._musicTrackNotesLeft === null) {
      this._musicTrackNotesLeft = AUDIO_MUSIC_TRACK_NOTES_MIN
        + Math.floor(Math.random() * (AUDIO_MUSIC_TRACK_NOTES_MAX - AUDIO_MUSIC_TRACK_NOTES_MIN + 1));
    }
    this._musicTrackNotesLeft--;
    if (this._musicTrackNotesLeft <= 0) {
      this._musicTrackIndex = (this._musicTrackIndex + 1) % AUDIO_MUSIC_TRACKS.length;
      this._musicTrackNotesLeft = AUDIO_MUSIC_TRACK_NOTES_MIN
        + Math.floor(Math.random() * (AUDIO_MUSIC_TRACK_NOTES_MAX - AUDIO_MUSIC_TRACK_NOTES_MIN + 1));
    }

    // Kolejna nuta zachodzi na poprzednią (krótszy odstęp niż czas trwania) -
    // stąd wrażenie ciągłego, nakładającego się padu zamiast pojedynczych,
    // odseparowanych dźwięków. Odstęp też zależy od bieżącego utworu.
    this._musicTimer = setTimeout(() => this._scheduleNextNote(), track.gapMin + Math.random() * (track.gapMax - track.gapMin));
  }

  /**
   * "Błysk" - krótki, cichy, wysoki sinus nałożony NA GŁÓWNĄ nutę, tylko gdy
   * bieżący utwór ma shimmer:true (patrz AUDIO_MUSIC_TRACKS[3]) - ten sam
   * duch co dzwoniący ton kroku Kryształowej Grani (_playSynthFootstep,
   * AUDIO_STEP_SURFACE.D.ring), tylko wpleciony w podkład muzyczny zamiast
   * w krok. Oktawa WYŻEJ niż najwyższa nuta skali (×2 częstotliwości) - ma
   * brzmieć jak odległy brzęk szkła/kryształu, nie jak kolejna nuta melodii.
   */
  _maybePlayShimmer(now) {
    if (Math.random() > AUDIO_MUSIC_SHIMMER_CHANCE) return;
    const ctx = this._audioCtx;
    const base = AUDIO_MUSIC_SCALE[5 + Math.floor(Math.random() * 5)]; // górna oktawa
    const delay = Math.random() * 0.6; // nie zawsze dokładnie razem z nutą

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = base * 2;

    const gain = ctx.createGain();
    const dur = 0.9 + Math.random() * 0.6;
    const t0 = now + delay;
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(0.22, t0 + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.0008, t0 + dur);

    osc.connect(gain);
    gain.connect(this._musicGain);
    osc.start(t0);
    osc.stop(t0 + dur);
  }

  /**
   * "Fanfara" ukończenia Szlifierni Kryształów (machines.js) - trzy szybkie,
   * wznoszące sinusy z górnej oktawy skali (ten sam budulec co
   * _maybePlayShimmer, tylko trzy nuty pod rząd zamiast jednej) zamiast
   * wspólnego 'machine_complete' reszty maszyn - najdroższy produkt w grze
   * (patrz MARKET_BASE_PRICES.crystal_gem) ma się wyraźnie wyróżniać na
   * ucho. Gra na _sfxGain (SFX, nie muzyka w tle), więc respektuje ten sam
   * mute co _playFootstep/play(), niezależnie od stanu podkładu muzycznego.
   */
  _playCrystalChime() {
    if (this.muted) return;
    if (!this._ensureAudioContext()) return;
    const ctx = this._audioCtx;
    const now = ctx.currentTime;
    const notes = [7, 8, 9]; // górna oktawa, wznoszące (indeksy w AUDIO_MUSIC_SCALE)

    notes.forEach((idx, i) => {
      const t0 = now + i * 0.09;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = AUDIO_MUSIC_SCALE[idx] * 2; // oktawa wyżej niż skala bazowa

      const gain = ctx.createGain();
      const dur = 0.5;
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(0.3, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0008, t0 + dur);

      osc.connect(gain);
      gain.connect(this._sfxGain);
      osc.start(t0);
      osc.stop(t0 + dur);
    });
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
    if (Events.ACHIEVEMENT_UNLOCKED) Bus.unsubscribe(Events.ACHIEVEMENT_UNLOCKED, this._onAchievementUnlocked);
    if (Events.ITEM_LOST) Bus.unsubscribe(Events.ITEM_LOST, this._onItemLost);

    this.stopMusic();
    if (this._audioCtx && typeof this._audioCtx.close === 'function') {
      this._audioCtx.close();
      this._audioCtx = null;
    }
  }
}

window.AudioManager = AudioManager;
