'use strict';

/**
 * player.js
 * ------------------------------------------------------------------------
 * Kontroler gracza - ruch (wirtualny joystick + WSAD/strzałki), animacja
 * (squash & stretch, bujanie przy chodzeniu) oraz rysowanie postaci.
 *
 * Postać rysowana jest jako prawdziwy sprite (assets/player.png - CC0,
 * Kenney Platformer Pack). Dopóki obrazek się nie wczyta (albo gdyby się
 * nie udało - zły XHR, offline itp.) rysowany jest DOKŁADNIE ten sam
 * proceduralny zastępnik co wcześniej (_drawProcedural), więc gra nigdy
 * nie zostaje bez postaci na ekranie.
 *
 * PlayerController NIE zna żadnego innego modułu (StackController,
 * MachineManager, ItemManager, itd.) - komunikuje się wyłącznie
 * przez Bus/Events (Events.PLAYER_MOVED).
 *
 * Zależności globalne (muszą być załadowane przed tym plikiem):
 *   - window.Bus     (EventBus: subscribe(name, cb) / publish(name, data))
 *   - window.Events  (m.in. Events.PLAYER_MOVED)
 *
 * Użycie w main.js:
 *   const gameplayCanvas = document.getElementById('layer-gameplay');
 *   const player = new PlayerController(gameplayCanvas);
 *   game.registerModule(player);
 *
 * Joystick (#joystick-base / #joystick-knob) jest wykrywany w HTML,
 * a jeśli go tam nie ma - tworzony automatycznie (patrz
 * _ensureJoystickElements). Działa jednocześnie na dotyk i mysz.
 */

const JOYSTICK_KNOB_DIAMETER = 56; // px - wygląd wewnętrznego "drążka" (musi się zgadzać z #joystick-knob w style.css)
const JOYSTICK_Z_INDEX = 9999; // ponad warstwami gry

// Bazowa prędkość PRZED jakimkolwiek upgrade'em (musi zgadzać się z
// domyślnym this.speed w konstruktorze i ECONOMY_DEFAULT_SPEED w economy.js -
// własna kopia zgodnie z konwencją projektu) - używana do wyliczenia
// intensywności smugi prędkości (_drawSpeedTrail), zero bez upgrade'u.
const PLAYER_BASE_SPEED = 180;

// --- Zdolności z modułów statku (patrz SHIP_MODULE_PERKS w economy.js) ------
// Silnik: mnożnik prędkości, stosowany W MIEJSCU UŻYCIA razem z hazardMult -
// NIGDY jako trwała zmiana this.speed (dokładnie ten sam powód co przy
// ZONE_HAZARD_SPEED_MULT wyżej: to pole należy do ulepszenia ze sklepu,
// trwałe mnożenie by je psuło i podwajało się przy każdym wczytaniu zapisu).
const SHIP_PERK_SPEED_MULT = 1.25;
// Podtrzymywanie Życia: mnożnik czasu łaski, zanim hazard odbierze przedmiot
// (ZONE_HAZARD_ITEM_LOSS_MS × to). Nie daje odporności - tylko więcej czasu
// na wypad po surowiec i ucieczkę. Pełną odporność daje dopiero moduł Osłon.
const SHIP_PERK_HAZARD_GRACE_MULT = 2;

// --- Częściowa ochrona ze sklepu (tańsza, WCZEŚNIEJSZA niż pełne stroje) ----
// "Kask z Latarką"/"Robocze Buty" (economy.js) łagodzą karę hazardu, ale NIE
// dają pełnej odporności jak Filtr Toksyn/Kombinezon Radiacyjny - naturalny
// pośredni stopień progresji, patrz _getHazardSpeedMult/_getHazardLossThreshold.
const HEADLAMP_HAZARD_SPEED_MULT = 0.7;
const BOOTS_HAZARD_GRACE_MULT = 1.5;

// Ścieżka do sprite'a postaci (CC0, Kenney Platformer Pack - wariant niebieski):
// assets/player.png. Spritesheet animacji chodzenia (ta sama postać, 11
// klatek w poziomym pasku, każda klatka to jednolity "stage" 71x95 -
// wyrównany tak, żeby stopy nie skakały przy zmianie klatek): assets/player_walk.png.
//
// BUGFIX (Tomek: "martwe 404 przy starcie gry" - lista poprawek): OBA miały
// dwie kandydatury (goła nazwa w katalogu głównym najpierw, assets/... jako
// fallback) z czasów, gdy dokładny układ plików na dysku był niepewny -
// zmierzone wprost (`ls`): pliki leżą WYŁĄCZNIE w assets/, goła nazwa w
// katalogu głównym nigdy nie istniała, więc generowała gwarantowane 404 przy
// KAŻDYM starcie gry, zanim _loadImageWithFallbacks (niżej) trafił w drugą,
// działającą ścieżkę. Skrócone do jednej.
const PLAYER_SPRITE_CANDIDATES = ['assets/player.png'];
const PLAYER_WALK_SPRITE_CANDIDATES = ['assets/player_walk.png'];
const PLAYER_WALK_FRAME_COUNT = 11;

// --- Ciała skinów (Kenney "Platformer Art Extended" - Alien sprites) -------
// Trzy kolory PRAWDZIWIE innej sylwetki (nie tylko przebarwienie tego
// samego sprite'a) - patrz PLAYER_SKINS w economy.js (pole `body`). Ten sam
// rozmiar/rodzina co assets/player.png (66x92, "alien w hełmie") - Blue z tej
// paczki to praktycznie już domyślny wygląd gracza, więc NIE dublujemy go
// jako osobny skin, tylko wykorzystujemy pozostałe kolory. Statyczna klatka
// (idle) i 2-klatkowy pasek chodu (walk1/walk2, bez precyzyjnej 11-klatkowej
// animacji nóg jak przy domyślnym ciele - patrz PLAYER_ALIEN_WALK_FRAME_COUNT
// i _drawBoots) - wystarczające "poruszanie się", bez konieczności ręcznego
// mierzenia pozycji stóp w KAŻDEJ klatce dla dodatkowych sylwetek.
//
// BUGFIX (Tomek: "żółty jest za mały usuń go"): był tu też 'yellow' - jego
// źródłowa klatka miała inną wysokość niż pink/green/beige, a łatka z
// poprzedniej sesji (dopchanie pustego marginesu do wspólnego rozmiaru
// płótna) naprawiła TYLKO pozycję stóp, nie samą skalę - drawImage()
// skaluje całe płótno do jednego stałego rozmiaru niezależnie od tego, ile
// z niego jest nieprzezroczyste, więc postać i tak wychodziła ~11% za mała
// (mniej "prawdziwej" grafiki w tym samym płótnie = mniejsza narysowana
// sylwetka po przeskalowaniu). Zamiast kolejnej łatki na tym samym, kruchym
// assetcie - usunięty; 'gold' (jedyny skin, który go używał) wrócił do
// domyślnego ciała z tintem (patrz PLAYER_SKINS w economy.js).
const PLAYER_ALIEN_BODY_IDS = ['beige', 'green', 'pink'];
const PLAYER_ALIEN_SPRITE_SRC = {
  beige: 'assets/player/alien_beige.png',
  green: 'assets/player/alien_green.png',
  pink: 'assets/player/alien_pink.png'
};
const PLAYER_ALIEN_WALK_SPRITE_SRC = {
  beige: 'assets/player/alien_beige_walk.png',
  green: 'assets/player/alien_green_walk.png',
  pink: 'assets/player/alien_pink_walk.png'
};
const PLAYER_ALIEN_WALK_FRAME_COUNT = 2;
/**
 * Dokładna pozycja stóp (lewa/prawa noga, jako ułamek szerokości/wysokości
 * KLATKI 71x95) w KAŻDEJ z 11 klatek assets/player_walk.png - zmierzone
 * wprost z pikseli (getImageData, próg alfa>20, dolne ~12% wysokości klatki
 * podzielone na połówkę lewą/prawą, środek ciężkości nieprzezroczystych
 * pikseli w każdej połówce). Nogi w spritesheecie NAPRAWDĘ się rozstawiają/
 * zbiegają i unoszą między klatkami (naturalny chód) - stały rozstaw
 * (spread=const) użyty w pierwszej wersji _drawBoots nie mógł więc trafić w
 * stopy w każdej klatce, stąd "buty poza stopami". footFrac to najniższy
 * nieprzezroczysty piksel danej klatki (ułamek wysokości) - niżej = noga
 * bardziej "postawiona", wyżej = noga w powietrzu w trakcie kroku.
 */
const PLAYER_WALK_LEG_FRAMES = [
  { leftFrac: 0.358, rightFrac: 0.620, footFrac: 0.989 },
  { leftFrac: 0.377, rightFrac: 0.599, footFrac: 0.989 },
  { leftFrac: 0.435, rightFrac: 0.551, footFrac: 0.968 },
  { leftFrac: 0.445, rightFrac: 0.542, footFrac: 0.958 },
  { leftFrac: 0.425, rightFrac: 0.562, footFrac: 0.947 },
  { leftFrac: 0.314, rightFrac: 0.677, footFrac: 0.937 },
  { leftFrac: 0.342, rightFrac: 0.652, footFrac: 0.947 },
  { leftFrac: 0.411, rightFrac: 0.586, footFrac: 0.958 },
  { leftFrac: 0.446, rightFrac: 0.546, footFrac: 0.979 },
  { leftFrac: 0.438, rightFrac: 0.554, footFrac: 0.989 },
  { leftFrac: 0.358, rightFrac: 0.620, footFrac: 0.989 }
];

/**
 * BUGFIX (Tomek: "na alien body skin to jest w ogóle wszystko nie tak z
 * tych ulepszeń"): _drawBoots (gałąź bezruchu) i _drawHazmatTrim liczyły
 * pozycję/szerokość z ułamkami zmierzonymi WYŁĄCZNIE na assets/player.png
 * (domyślne ciało) i zakładały (błędnie), że alien body ma "niemal
 * identyczny zarys w tym samym płótnie". Sprawdzone bezpośrednio pikselami:
 * pink/green/beige są identyczne między sobą (yellow to ten sam kształt,
 * tylko przesunięty przez wcześniejszy pad_top fix), ale RÓŻNIĄ SIĘ mocno
 * od domyślnego ciała - ręce zwisają WZDŁUŻ tułowia (nie sterczą na boki na
 * wysokości pasa jak u domyślnej postaci), więc i szerokość "samego tułowia"
 * i pozycja nóg wypadają gdzie indziej. Zmierzone wprost na
 * assets/player/alien_pink.png (reprezentatywne dla całej rodziny):
 * - nogi (rzędy w pełni rozdzielone, y=84-91): środek lewej ~0.215,
 *   prawej ~0.674, najniższy piksel ~0.989 wysokości.
 * - tułów BEZ rąk (rzędy y=74-82, ręce już się skończyły, nogi jeszcze się
 *   nie rozdzieliły): szerokość ~0.586 pełnej szerokości sprite'a.
 */
const PLAYER_ALIEN_BOOT_LEFT_FRAC = 0.215;
const PLAYER_ALIEN_BOOT_RIGHT_FRAC = 0.674;
const PLAYER_ALIEN_BOOT_FOOT_FRAC = 0.989;
const PLAYER_ALIEN_TORSO_WIDTH_FRAC = 0.586;

// Docelowa wysokość rysowanego sprite'a (px) - szerokość liczona proporcjonalnie
// z naturalnych wymiarów obrazka, żeby nie zniekształcić postaci.
const PLAYER_SPRITE_HEIGHT = 84;
// Maksymalny przechył (rad) przy ruchu w bok - subtelny "lean" zamiast
// przerzucania sprite'a w lustrzane odbicie (front-facing postać i tak
// wygląda tak samo odwrócona).
const PLAYER_LEAN_MAX = 0.12;
const PLAYER_LEAN_FACTOR = 0.0007;

// Tempo cyklu chodu przy PLAYER_BASE_SPEED (rad/ms, stała zadeklarowana na
// górze pliku). Pół cyklu (PI) = jeden krok, czyli przy bazowej prędkości
// ~2.5 kroku/s. Odniesieniem jest STAŁA bazowa, nie this.speed - to ostatnie
// podbijają ulepszenia, a właśnie o to chodzi, żeby szybszy marsz dawał
// szybszy przebieg nóg/kroków (normalizacja przez this.speed dałaby zawsze 1).
const PLAYER_WALK_CYCLE_RATE = 0.008;
// Granice mnożnika tempa - żeby przy ekstremalnym spowolnieniu nogi nie
// zamarły w bezruchu, a przy maksymalnych ulepszeniach nie zaczęły wirować.
const PLAYER_WALK_CYCLE_MIN_MULT = 0.45;
const PLAYER_WALK_CYCLE_MAX_MULT = 2.2;

// --- Świat (Faza 2b: mapa większa niż ekran) --------------------------------
// Te same wartości co w game.js (kamera) / items.js / ambient.js - świat NIE
// zależy od rozmiaru okna, w przeciwieństwie do canvas.width/height. 1750,
// było 1400 - patrz obszerny komentarz przy GAME_ZONE_CORE_WIDTH w game.js
// (poszerzenie mapy pod NIEZALEŻNY pas Strefy D).
const PLAYER_WORLD_WIDTH = 1750;
const PLAYER_WORLD_HEIGHT = 2000;

// --- Strefy mapy (Faza 2) ---------------------------------------------------
// Te same progi co w items.js (spawn surowców) i game.js (mgła/popiół) -
// każdy plik ma własną kopię (konwencja projektu: brak współdzielonych
// utili, tylko komunikacja przez Bus). Liczone teraz względem ŚWIATA.
const PLAYER_ZONE_C_TOP_RATIO = 0.32; // Strefa C (Atomowa) - górny pas całej szerokości
const PLAYER_ZONE_B_RIGHT_RATIO = 0.62; // Strefa B (Toksyczna) - prawy pas, poniżej pasa C
// Strefa D (Kryształowa Grań) - NIEZALEŻNY pas na pełnej wysokości, na prawo
// od "rdzenia" (patrz obszerny komentarz przy GAME_ZONE_CORE_WIDTH w
// game.js). PLAYER_ZONE_CORE_WIDTH to STARA szerokość świata (1400, sprzed
// poszerzenia pod Grań) - A/B/C nadal liczą się względem NIEJ, nie
// PLAYER_WORLD_WIDTH, więc szerszy świat ich nie rusza.
const PLAYER_ZONE_CORE_WIDTH = 1400;
// Bez odpowiedniego sprzętu: połowa prędkości + okresowe potrząsanie ekranem
// (symulacja duszenia się) - liczone jako MNOŻNIK stosowany przy każdym
// ruchu, NIGDY jako trwała zmiana this.speed (to samo pole podbija
// ulepszenie prędkości ze sklepu - trwałe dzielenie by je psuło).
const ZONE_HAZARD_SPEED_MULT = 0.5;
const ZONE_HAZARD_SHAKE_INTERVAL_MS = 1000;
const ZONE_HAZARD_SHAKE_INTENSITY = 3;
const ZONE_HAZARD_SHAKE_DURATION_MS = 150;

// --- Hazard: utrata przedmiotu w czasie (Faza 4) ----------------------------
// Gra nie ma paska życia/HP, więc "obrażenia" bez odpowiedniego stroju
// wyrażają się w czasie: po tylu ms ciągłego przebywania w hazardzie gracz
// traci JEDEN losowy przedmiot z plecaka (patrz _loseRandomItem). Licznik
// zeruje się przy KAŻDYM wyjściu ze strefy - krótki wypad po surowiec i
// ucieczka zanim upłynie ten czas jest w pełni bezpieczna.
const ZONE_HAZARD_ITEM_LOSS_MS = 3000;
// Silniejszy wstrząs niż ambientowe "dyszenie" (ZONE_HAZARD_SHAKE_*) -
// wyraźnie inny w odczuciu moment faktycznej straty.
const ZONE_HAZARD_LOSS_SHAKE_INTENSITY = 9;
const ZONE_HAZARD_LOSS_SHAKE_DURATION_MS = 260;
// Pasek ostrzegawczy nad głową gracza - widoczny TYLKO w hazardzie, napełnia
// się w stronę utraty przedmiotu, żeby dać graczowi czytelny sygnał "jeszcze
// tyle czasu i coś stracisz", a nie tylko okresowe potrząsanie ekranem.
const ZONE_HAZARD_BAR_WIDTH = 46;
const ZONE_HAZARD_BAR_HEIGHT = 6;
const ZONE_HAZARD_BAR_OFFSET_Y = -78;

// --- Fala granicy biomów (Faza 2c) -------------------------------------------
// Dokładnie ta sama matematyka co _edgeWaveC/_edgeWaveB w game.js (własna
// kopia - konwencja projektu, brak współdzielonych utili). Bez tego hazard
// (i teraz też pasek ostrzegawczy) włączałby się na starej PROSTEJ linii
// PLAYER_ZONE_*_RATIO, która od czasu pofalowanych/wtapianych granic w
// game.js leży do ~20px w głąb jednego z biomów - gracz widziałby się na
// trawie, a i tak dostawał ostrzeżenie o bagnie/popiele (albo odwrotnie).
const PLAYER_BIOME_EDGE_AMPLITUDE = 20;

class PlayerController {
  constructor(canvas) {
    this.canvas = canvas;
    // Start na środku RDZENIA mapy (PLAYER_ZONE_CORE_WIDTH, NIE
    // PLAYER_WORLD_WIDTH) - Wypada w Strefie A (bezpiecznej), bo obie
    // granice stref zajmują pasy od góry/prawej, a środek rdzenia jest
    // zawsze w pozostałej części. BUGFIX: środek PEŁNEGO (poszerzonego o
    // pas D) świata leżałby tuż za granicą Strefy B (868px) - gracz
    // startowałby w hazardzie.
    this.x = PLAYER_ZONE_CORE_WIDTH / 2;
    this.y = PLAYER_WORLD_HEIGHT / 2;
    this.radius = 22;
    this.speed = PLAYER_BASE_SPEED; // px/sek, modyfikowalny przez ulepszenia
    this.vx = 0;
    this.vy = 0; // aktualny wektor ruchu

    // --- Joystick ---------------------------------------------------------
    this.joystickActive = false;
    this.joystickStartX = 0;
    this.joystickStartY = 0;
    this.joystickDirX = 0;
    this.joystickDirY = 0;
    this.joystickRadius = 60; // max odchylenie
    this._activeTouchId = null; // sledzimy jeden palec, ignorujemy reszte

    // Wizualny joystick (div elementy w HTML) - zapewniamy ich istnienie.
    this.joystickBaseEl = null;
    this.joystickKnobEl = null;
    this._ensureJoystickElements();

    // --- Animacja gracza ----------------------------------------------------
    this.facing = 1; // 1 = prawo, -1 = lewo
    this.walkCycle = 0; // timer animacji chodzenia
    this.isMoving = false;
    this._lastStepPhase = 0; // do wykrywania "kroku" (pyl spod stop)
    this.bodySquash = 1; // squash & stretch Y
    this.bobOffset = 0; // gora/dol bujanie

    // --- Strefy / hazard (Faza 2) --------------------------------------------
    this.currentZone = 'A';
    this._hazardShakeTimer = 0;
    this._hazardWarnedZone = null; // zeby ostrzezenie pokazac raz na wejscie, nie co klatke
    // Faza 4: czas do utraty przedmiotu (patrz ZONE_HAZARD_ITEM_LOSS_MS) oraz
    // flaga czytana przez draw() do (nie)rysowania paska ostrzegawczego -
    // update() zawsze wykonuje sie przed draw() w tej samej klatce (patrz
    // Game.loop w game.js), wiec draw() zawsze widzi swiezy stan.
    this._hazardDamageTimer = 0;
    this._inHazard = false;

    // --- Sprite postaci (z bezpiecznym fallbackiem na rysowanie proceduralne) --
    // spritesReady - rozwiązuje się gdy WSZYSTKIE obrazki (domyślne ciało +
    // 4 alternatywne ciała skinów, patrz PLAYER_ALIEN_BODY_IDS) skończą próby
    // wczytania (sukces LUB ostateczna porażka - i tak mamy fallback
    // proceduralny), czytane przez main.js do ukrycia ekranu ładowania
    // (patrz game.assetsReady). Ciała skinów wchodzą w TĘ SAMĄ blokującą
    // obietnicę co domyślny sprite (nie osobno w tle) - to małe pliki (kilka
    // KB), a bez tego wybór skina z jeszcze niegotowym ciałem pokazałby na
    // chwilę pusty/domyślny sprite zamiast wybranego.
    const readyPromises = [];
    let resolveSpriteReady, resolveWalkReady;
    readyPromises.push(new Promise((resolve) => { resolveSpriteReady = resolve; }));
    readyPromises.push(new Promise((resolve) => { resolveWalkReady = resolve; }));

    this._spriteImg = new Image();
    this._spriteLoaded = false;
    this._loadImageWithFallbacks(this._spriteImg, PLAYER_SPRITE_CANDIDATES, () => {
      this._spriteLoaded = true;
      resolveSpriteReady();
    }, () => {
      console.warn('[PlayerController] Nie udało się wczytać żadnej z: ' + PLAYER_SPRITE_CANDIDATES.join(', ') + ' - rysuję postać proceduralnie.');
      resolveSpriteReady();
    });

    // --- Spritesheet chodzenia (opcjonalny - bez niego zostaje statyczny sprite) --
    this._walkImg = new Image();
    this._walkLoaded = false;
    this._loadImageWithFallbacks(this._walkImg, PLAYER_WALK_SPRITE_CANDIDATES, () => {
      this._walkLoaded = true;
      resolveWalkReady();
    }, () => {
      console.warn('[PlayerController] Nie udało się wczytać żadnej z: ' + PLAYER_WALK_SPRITE_CANDIDATES.join(', ') + ' - przy ruchu zostaje statyczny sprite.');
      resolveWalkReady();
    });

    // --- Alternatywne ciała skinów (patrz PLAYER_ALIEN_BODY_IDS wyżej) -------
    this._alienBodies = {}; // { bodyId: { staticImg, walkImg, staticLoaded, walkLoaded } }
    PLAYER_ALIEN_BODY_IDS.forEach((bodyId) => {
      const entry = { staticImg: new Image(), walkImg: new Image(), staticLoaded: false, walkLoaded: false };
      this._alienBodies[bodyId] = entry;

      let resolveBodyStatic, resolveBodyWalk;
      readyPromises.push(new Promise((resolve) => { resolveBodyStatic = resolve; }));
      readyPromises.push(new Promise((resolve) => { resolveBodyWalk = resolve; }));

      this._loadImageWithFallbacks(entry.staticImg, [PLAYER_ALIEN_SPRITE_SRC[bodyId]], () => {
        entry.staticLoaded = true;
        resolveBodyStatic();
      }, () => {
        console.warn('[PlayerController] Nie udało się wczytać ciała skina: ' + PLAYER_ALIEN_SPRITE_SRC[bodyId]);
        resolveBodyStatic();
      });
      this._loadImageWithFallbacks(entry.walkImg, [PLAYER_ALIEN_WALK_SPRITE_SRC[bodyId]], () => {
        entry.walkLoaded = true;
        resolveBodyWalk();
      }, () => {
        console.warn('[PlayerController] Nie udało się wczytać chodu ciała skina: ' + PLAYER_ALIEN_WALK_SPRITE_SRC[bodyId]);
        resolveBodyWalk();
      });
    });

    this.spritesReady = Promise.all(readyPromises);

    // --- Skiny postaci (economy.js: PLAYER_SKINS/selectedSkin) - obrazek
    // (surowe ciało, opcjonalnie przebarwione) upieczony RAZ na skin, dopiero
    // gdy oryginalne obrazki skończą się wczytywać (patrz _bakeSkinTints) -
    // ten sam duch "upiecz raz, blituj wiele razy" co
    // _bakeWorldBackground/_bakeCloudTexture w game.js.
    this._tintedSprites = {}; // { skinId: { static, walk, frameCount } }
    this.spritesReady.then(() => this._bakeSkinTints());

    // --- WSAD / strzalki - fallback do testu w przegladarce desktopowej -----
    this._keys = { up: false, down: false, left: false, right: false };
    this._setupKeyboard();

    this._setupInput();

    // Uwaga: brak nasłuchiwania Events.RESIZE celowo - granice ruchu gracza
    // to teraz PLAYER_WORLD_WIDTH/HEIGHT (stałe), nie canvas.width/height (zmienne
    // przy zmianie rozmiaru okna), więc resize okna nie wymaga już
    // przeliczania pozycji gracza. Samo przybliżenie/oddalenie widoku
    // (ile świata widać naraz) obsługuje kamera w game.js.
  }

  /**
   * Próbuje kolejnych ścieżek z listy dla JEDNEGO obrazka, aż któraś się
   * wczyta - albo żadna. Rozwiązuje "czy pliki leżą płasko obok index.html,
   * czy w assets/" bez zgadywania z góry: działa dla obu układów naraz,
   * bez potrzeby ręcznego sprawdzania struktury folderów za każdym razem.
   * Ten sam wzorzec co SpriteLoader._loadWithFallbacks w sprites.js -
   * duplikacja zgodna z konwencją projektu (brak współdzielonych utili).
   */
  _loadImageWithFallbacks(img, candidates, onSuccess, onAllFailed) {
    let i = 0;
    img.onload = () => onSuccess();
    img.onerror = () => {
      i++;
      if (i >= candidates.length) {
        onAllFailed();
        return;
      }
      img.src = candidates[i];
    };
    img.src = candidates[0];
  }

  /**
   * Sprawdza czy #joystick-base / #joystick-knob istnieją w HTML.
   * Jeśli nie - tworzy je dynamicznie. Domyślny wygląd (rozmiar, kolor,
   * zaokrąglenie) nakładamy TYLKO na elementy utworzone od zera - jeśli Tom
   * już zdefiniował własny CSS dla tych ID, jego wygląd nie jest nadpisywany.
   * Style funkcjonalne (position, z-index, pointer-events) ustawiamy zawsze,
   * bo bez nich joystick nie zadziała poprawnie niezależnie od stylowania.
   */
  _ensureJoystickElements() {
    let base = document.getElementById('joystick-base');
    let knob = document.getElementById('joystick-knob');
    const createdBase = !base;
    const createdKnob = !knob;

    if (!base) {
      base = document.createElement('div');
      base.id = 'joystick-base';
    }
    if (!knob) {
      knob = document.createElement('div');
      knob.id = 'joystick-knob';
    }
    if (knob.parentNode !== base) {
      base.appendChild(knob);
    }
    if (!base.parentNode) {
      document.body.appendChild(base);
    }

    Object.assign(base.style, {
      position: 'fixed',
      display: 'none',
      pointerEvents: 'none',
      zIndex: String(JOYSTICK_Z_INDEX)
    });
    Object.assign(knob.style, {
      position: 'absolute',
      left: '50%',
      top: '50%',
      pointerEvents: 'none'
    });

    // BUGFIX/UPGRADE: dawniej ustawiał TU wprost background/border (płaskie
    // białe kółka) - inline style zawsze wygrywa ze stylesheetem, więc
    // nadpisywał wygląd z assets/ui/joystick_base.png/joystick_knob.png
    // (Kenney UI Pack, patrz #joystick-base/#joystick-knob w style.css) tym
    // samym płaskim CSS, mimo wymiany tekstur. Tylko GEOMETRIA (rozmiar/
    // wyśrodkowanie) zostaje ustawiana z JS (zależy od joystickRadius,
    // konfigurowalnego pola instancji) - kolor/tekstura to wyłącznie
    // stylesheet.
    if (createdBase) {
      const baseDiameter = this.joystickRadius * 2;
      Object.assign(base.style, {
        width: `${baseDiameter}px`,
        height: `${baseDiameter}px`,
        marginLeft: `${-baseDiameter / 2}px`,
        marginTop: `${-baseDiameter / 2}px`
      });
    }
    if (createdKnob) {
      Object.assign(knob.style, {
        width: `${JOYSTICK_KNOB_DIAMETER}px`,
        height: `${JOYSTICK_KNOB_DIAMETER}px`,
        marginLeft: `${-JOYSTICK_KNOB_DIAMETER / 2}px`,
        marginTop: `${-JOYSTICK_KNOB_DIAMETER / 2}px`
      });
    }

    this.joystickBaseEl = base;
    this.joystickKnobEl = knob;
  }

  /**
   * Obsługa joysticka - jednocześnie dotyk i mysz. Nasłuchiwacze move/end
   * są podpięte pod window (nie canvas), żeby przeciąganie działało
   * poprawnie nawet gdy palec/kursor wyjdzie poza obszar canvasu.
   */
  _setupInput() {
    const onDragStart = (clientX, clientY) => {
      this.joystickActive = true;
      this.joystickStartX = clientX;
      this.joystickStartY = clientY;
      this.joystickDirX = 0;
      this.joystickDirY = 0;
      this._showJoystickBase(clientX, clientY);
      this._setJoystickKnobOffset(0, 0);
    };

    const onDragMove = (clientX, clientY) => {
      if (!this.joystickActive) return;

      const dx = clientX - this.joystickStartX;
      const dy = clientY - this.joystickStartY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const clampedDist = Math.min(dist, this.joystickRadius);

      if (dist > 0) {
        this.joystickDirX = dx / dist;
        this.joystickDirY = dy / dist;
      } else {
        this.joystickDirX = 0;
        this.joystickDirY = 0;
      }

      this._setJoystickKnobOffset(this.joystickDirX * clampedDist, this.joystickDirY * clampedDist);
    };

    const onDragEnd = () => {
      this.joystickActive = false;
      this.joystickDirX = 0;
      this.joystickDirY = 0;
      this._hideJoystickBase();
    };

    // --- Mysz (test desktopowy) ---
    this._onMouseDown = (e) => {
      onDragStart(e.clientX, e.clientY);
      e.preventDefault();
    };
    this._onMouseMove = (e) => onDragMove(e.clientX, e.clientY);
    this._onMouseUp = () => onDragEnd();

    // --- Dotyk (urzadzenia mobilne) ---
    // Sledzimy identyfikator jednego palca, zeby przypadkowy drugi dotyk
    // nie mieszal aktywnego joysticka.
    this._onTouchStart = (e) => {
      if (this._activeTouchId !== null) return;
      const touch = e.changedTouches[0];
      this._activeTouchId = touch.identifier;
      onDragStart(touch.clientX, touch.clientY);
      e.preventDefault();
    };
    this._onTouchMove = (e) => {
      const touch = this._findActiveTouch(e.touches);
      if (!touch) return;
      onDragMove(touch.clientX, touch.clientY);
      e.preventDefault();
    };
    this._onTouchEnd = (e) => {
      const touch = this._findActiveTouch(e.changedTouches);
      if (!touch) return;
      this._activeTouchId = null;
      onDragEnd();
    };

    // Wylacza natywny scroll/zoom przegladarki na canvasie (kluczowe na mobile).
    this.canvas.style.touchAction = 'none';

    this.canvas.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('mouseup', this._onMouseUp);

    this.canvas.addEventListener('touchstart', this._onTouchStart, { passive: false });
    window.addEventListener('touchmove', this._onTouchMove, { passive: false });
    window.addEventListener('touchend', this._onTouchEnd);
    window.addEventListener('touchcancel', this._onTouchEnd);
  }

  /**
   * WSAD + strzałki - fallback ruchu do testowania w przeglądarce
   * desktopowej, używany gdy joystick nie jest aktywny.
   */
  _setupKeyboard() {
    const keyMap = {
      KeyW: 'up', ArrowUp: 'up',
      KeyS: 'down', ArrowDown: 'down',
      KeyA: 'left', ArrowLeft: 'left',
      KeyD: 'right', ArrowRight: 'right'
    };

    this._onKeyDown = (e) => {
      const dir = keyMap[e.code];
      if (dir) this._keys[dir] = true;
    };
    this._onKeyUp = (e) => {
      const dir = keyMap[e.code];
      if (dir) this._keys[dir] = false;
    };

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
  }

  /** Znajduje w liście touchy ten, który odpowiada aktywnemu _activeTouchId. */
  _findActiveTouch(touchList) {
    for (let i = 0; i < touchList.length; i++) {
      if (touchList[i].identifier === this._activeTouchId) {
        return touchList[i];
      }
    }
    return null;
  }

  _showJoystickBase(clientX, clientY) {
    if (!this.joystickBaseEl) return;
    this.joystickBaseEl.style.left = `${clientX}px`;
    this.joystickBaseEl.style.top = `${clientY}px`;
    this.joystickBaseEl.style.display = 'block';
  }

  _hideJoystickBase() {
    if (!this.joystickBaseEl) return;
    this.joystickBaseEl.style.display = 'none';
  }

  _setJoystickKnobOffset(dx, dy) {
    if (!this.joystickKnobEl) return;
    this.joystickKnobEl.style.transform = `translate(${dx}px, ${dy}px)`;
  }

  update(delta) {
    const sec = delta / 1000;

    // Strefa gracza PRZED ruchem w tej klatce - decyduje o mnożniku kary.
    this.currentZone = this._getZoneAt(this.x, this.y);

    const hasGear = this._hasGearForZone(this.currentZone);
    const inHazard = this.currentZone !== 'A' && !hasGear;

    this._inHazard = inHazard;

    if (inHazard) {
      if (this._hazardWarnedZone !== this.currentZone) {
        this._hazardWarnedZone = this.currentZone;
        // BUGFIX (Tomek: "strefy niech mają swoje własne nazwy"): Strefa B
        // miała TRZY różne nazwy w grze naraz - "Strefa Bagienna" w
        // toaście odblokowania (economy.js PROGRESSION_UNLOCKS), ale
        // "Strefa Skażenia" tutaj I w opisie Filtra Toksyn (economy.js
        // SHOP_UPGRADES) - gracz widział jedną nazwę przy odblokowaniu, a
        // zupełnie inną przy wejściu bez sprzętu. Ujednolicone na "Strefa
        // Bagienna" wszędzie (to ona pojawia się PIERWSZA, przy odblokowaniu).
        const zoneWarnings = {
          B: I18n.t('player.zoneWarning.B'),
          C: I18n.t('player.zoneWarning.C'),
          D: I18n.t('player.zoneWarning.D')
        };
        // BUGFIX: brak jawnego x/y powodował, że popup renderował się w
        // stałym punkcie ŚWIATA (fallback w gamefeel.js), a nie nad graczem
        // - w praktyce gdziekolwiek ten punkt akurat wypadał względem
        // kamery, kompletnie niezależnie od tego, w której strefie i nad
        // jakim biomem gracz faktycznie stał. Stąd wrażenie "Strefa Skażenia
        // wyświetla się nad ash" - tekst i tak nie miał związku z pozycją
        // gracza. y - 70, żeby popup wystartował nad głową, nie na twarzy.
        Bus.publish(Events.FX_POPUP, {
          text: zoneWarnings[this.currentZone] || I18n.t('player.zoneWarning.default'),
          // Trójkąt ostrzegawczy rysowany PROCEDURALNIE nad popupem (patrz
          // _drawPopupIcon w gamefeel.js) zamiast dawnego ⚠️ wtopionego w text.
          icon: 'warning',
          x: this.x,
          y: this.y - 70,
          duration: 2200,
          color: '#EF5350'
        });
        if (Events.ZONE_HAZARD_WARNING) {
          Bus.publish(Events.ZONE_HAZARD_WARNING, { zone: this.currentZone });
        }
      }
      this._hazardShakeTimer += delta;
      if (this._hazardShakeTimer >= ZONE_HAZARD_SHAKE_INTERVAL_MS) {
        this._hazardShakeTimer = 0;
        Bus.publish(Events.FX_SHAKE, {
          intensity: ZONE_HAZARD_SHAKE_INTENSITY,
          duration: ZONE_HAZARD_SHAKE_DURATION_MS
        });
      }

      // Faza 4: po ZONE_HAZARD_ITEM_LOSS_MS ciągłej ekspozycji (bez sprzętu)
      // gracz traci jeden losowy przedmiot z plecaka. Wyjście ze strefy w
      // MIĘDZYCZASIE w pełni zeruje ten licznik (patrz branch "else" -
      // ucieczka anuluje zagrożenie, nie tylko je "pauzuje").
      // Moduł Podtrzymywania Życia (statek) wydłuża ten czas - liczone tutaj
      // na bieżąco, a nie przez trwałą zmianę stałej, żeby prestiż (który
      // czyści moduły) automatycznie cofał efekt bez żadnej dodatkowej logiki.
      this._hazardDamageTimer += delta;
      if (this._hazardDamageTimer >= this._getHazardLossThreshold()) {
        this._hazardDamageTimer = 0;
        this._loseRandomItem();
      }
    } else {
      this._hazardShakeTimer = 0;
      this._hazardDamageTimer = 0;
      if (this.currentZone === 'A') this._hazardWarnedZone = null;
    }

    // Oba mnożniki stosowane W MIEJSCU UŻYCIA (nie na this.speed - patrz
    // ostrzeżenie przy ZONE_HAZARD_SPEED_MULT na górze pliku). Mnożą się:
    // Silnik przyspiesza także wtedy, gdy hazard spowalnia.
    const hazardMult = inHazard ? this._getHazardSpeedMult() : 1;
    const moveMult = hazardMult * this._getShipSpeedMult();

    // Ruch.
    if (this.joystickActive) {
      this.vx = this.joystickDirX * this.speed * moveMult;
      this.vy = this.joystickDirY * this.speed * moveMult;
    } else {
      const keyDirX = (this._keys.right ? 1 : 0) - (this._keys.left ? 1 : 0);
      const keyDirY = (this._keys.down ? 1 : 0) - (this._keys.up ? 1 : 0);

      if (keyDirX !== 0 || keyDirY !== 0) {
        // Normalizacja, zeby ruch po skosie nie byl szybszy.
        const len = Math.sqrt(keyDirX * keyDirX + keyDirY * keyDirY);
        this.vx = (keyDirX / len) * this.speed * moveMult;
        this.vy = (keyDirY / len) * this.speed * moveMult;
      } else {
        // WSAD dla testu w przegladarce desktopowej - brak wejscia.
        this.vx *= 0.85; // wytracanie predkosci
        this.vy *= 0.85;
      }
    }

    this.x += this.vx * sec;
    this.y += this.vy * sec;

    // Granice ŚWIATA (nie ekranu - świat jest większy, gracz może wyjść
    // poza to, co aktualnie widać, kamera w game.js za nim nadąży).
    const margin = this.radius + 5;
    this.x = Math.max(margin, Math.min(PLAYER_WORLD_WIDTH - margin, this.x));
    this.y = Math.max(margin, Math.min(PLAYER_WORLD_HEIGHT - margin, this.y));

    // Animacja.
    const moving = Math.abs(this.vx) + Math.abs(this.vy) > 5;
    this.isMoving = moving;

    // BUGFIX ("kroki mają pasować do częstotliwości chodzenia"): tempo cyklu
    // było STAŁE (delta * 0.008), niezależne od tego, jak szybko postać
    // FAKTYCZNIE się porusza. Efekt: z ulepszeniami prędkości (+15% za poziom,
    // do 4 poziomów) albo modułem Silnika postać sunęła po ekranie coraz
    // szybciej, a nogi przebierały w tym samym tempie (klasyczne "łyżwy"), a w
    // strefie hazardu na odwrót - pełzła o połowie prędkości, młócąc nogami
    // normalnie. Cykl liczy się teraz z REALNEJ prędkości, więc nogi, pyłek
    // spod stóp ORAZ dźwięk kroków (wszystkie trzy wychodzą z walkCycle -
    // patrz niżej i _drawBoots/_currentWalkFrameIndex) same się zgadzają.
    const speedNow = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
    const cycleMult = Math.max(
      PLAYER_WALK_CYCLE_MIN_MULT,
      Math.min(PLAYER_WALK_CYCLE_MAX_MULT, speedNow / PLAYER_BASE_SPEED)
    );
    this.walkCycle += moving ? delta * PLAYER_WALK_CYCLE_RATE * cycleMult : 0;
    this.bobOffset = moving ? Math.sin(this.walkCycle) * 4 : 0;

    // Squash & Stretch - lekkie przy ruchu.
    this.bodySquash = 1 + (moving ? Math.abs(Math.sin(this.walkCycle)) * 0.12 : 0);

    // Pyłek spod stóp przy każdym "kroku" - wykrywamy przejście przez granicę
    // pół-cyklu chodzenia (dwa razy na pełny cykl = dwa kroki), nie osobnym
    // timerem, żeby było zsynchronizowane z samą animacją nóg. Subtelny,
    // przygaszony kolor (nie jaskrawy jak przy zbieraniu przedmiotów).
    if (moving) {
      const stepPhase = this.walkCycle % Math.PI;
      if (stepPhase < this._lastStepPhase) {
        Bus.publish(Events.FX_PARTICLES, {
          x: this.x + (Math.random() - 0.5) * 12,
          y: this.y + this.radius * 0.75,
          color: '#C4B89C',
          count: 2
        });
        // Strefa = PODŁOŻE pod stopami - audio.js dobiera po niej brzmienie
        // kroku (patrz AUDIO_FOOTSTEP_SURFACE tam), żeby trawa, bagno, popiół
        // i kryształ nie brzmiały identycznie. currentZone jest ustawiane
        // wyżej w tym samym update(), więc jest już świeże na tę klatkę.
        if (Events.FOOTSTEP) Bus.publish(Events.FOOTSTEP, { zone: this.currentZone });
      }
      this._lastStepPhase = stepPhase;
    }

    if (Math.abs(this.vx) > 5) this.facing = this.vx > 0 ? 1 : -1;

    // Publish pozycje co update (dla collision detection innych modulow).
    const speed = Math.sqrt(this.vx ** 2 + this.vy ** 2);
    Bus.publish(Events.PLAYER_MOVED, {
      x: this.x,
      y: this.y,
      vx: this.vx,
      vy: this.vy,
      speed,
      facing: this.facing
    });
  }

  /**
   * Wywoływane, gdy pasek zagrożenia (ZONE_HAZARD_ITEM_LOSS_MS) się zapełni -
   * gracz traci JEDEN losowy przedmiot z plecaka (nie zawsze wierzch stosu,
   * żeby "coś odpadło" nie zawsze było tym, co gracz akurat podniósł).
   *
   * Wywołuje window.stackController.removeAt() BEZPOŚREDNIO, nie przez Bus -
   * to jedyne miejsce w tym pliku łamiące zasadę "PlayerController nie zna
   * żadnego innego modułu" z nagłówka, ale mirroruje dokładnie ten sam wzorzec,
   * którego już używają machines.js/market.js/ship.js (też wołają
   * window.stackController.removeAt() wprost). Tworzenie osobnego zdarzenia
   * Bus tylko po to, żeby stackController sam siebie wywołał przez
   * subskrypcję, byłoby zbędną warstwą pośrednią.
   *
   * Pusty plecak = nie ma czego stracić; kara ogranicza się wtedy do już
   * istniejącego spowolnienia (ZONE_HAZARD_SPEED_MULT) + potrząsania ekranem.
   */
  _loseRandomItem() {
    const stack = window.stackController;
    if (!stack || stack.isEmpty() || !Array.isArray(stack.items) || stack.items.length === 0) return;

    const idx = Math.floor(Math.random() * stack.items.length);
    const item = stack.removeAt(idx);
    if (!item) return;

    // ItemRenderer (items.js) ładuje się przed player.js - patrz kolejność
    // <script> w index.html - więc jego statyczne metody są tu bezpieczne
    // do użycia (ten sam wzorzec co StackController.draw() w stacking.js).
    const meta = (typeof ItemRenderer !== 'undefined') ? ItemRenderer.getTypeMeta(item.typeId) : null;
    const niceName = (meta && meta.name) || I18n.t('player.genericItem');

    Bus.publish(Events.FX_SHAKE, {
      intensity: ZONE_HAZARD_LOSS_SHAKE_INTENSITY,
      duration: ZONE_HAZARD_LOSS_SHAKE_DURATION_MS
    });
    Bus.publish(Events.FX_PARTICLES, {
      x: this.x,
      y: this.y,
      color: item.color || '#EF5350',
      count: 10
    });
    if (Events.ITEM_LOST) Bus.publish(Events.ITEM_LOST, { typeId: item.typeId });
    Bus.publish(Events.FX_POPUP, {
      text: I18n.t('player.itemLostToast', { name: niceName }),
      // X rysowany PROCEDURALNIE nad popupem (patrz _drawPopupIcon w
      // gamefeel.js) zamiast dawnego 💢 wtopionego w text. item.label (emoji
      // per typ z ITEM_TYPES) też usunięty z treści - nazwa (niceName) już
      // mówi co to za surowiec, bez potrzeby glifu w środku zdania.
      icon: 'lost',
      x: this.x,
      y: this.y - 50,
      duration: 1800,
      color: '#EF5350'
    });
  }

  draw(ctxBg, ctx, ctxUI) {
    const ctx2 = ctx; // rysujemy na warstwie gameplay

    ctx2.save();
    ctx2.translate(this.x, this.y + this.bobOffset);

    // Cien - zawsze rysowany proceduralnie, niezaleznie od tego, czy sprite
    // sie wczytal (nie ma sensu robic z tego osobnego obrazka).
    ctx2.fillStyle = 'rgba(0, 0, 0, 0.18)';
    ctx2.beginPath();
    ctx2.ellipse(0, this.radius * 0.9, this.radius * 0.7, this.radius * 0.2, 0, 0, Math.PI * 2);
    ctx2.fill();

    // Widoczne efekty ulepszeń (Faza: "widoczne ulepszenia") - PRZED
    // postacią, żeby czytały się jako tło/otoczenie gracza, nie zasłaniały
    // samej postaci. Zero wpływu na rozgrywkę - to tylko "pokazanie" tego,
    // co upgrade i tak już robi liczbowo. Poza wspólnym blokiem lean/flip
    // niżej CELOWO: pierścień magnesu to pełne koło (obrót/odbicie i tak nic
    // by nie zmieniły), a smuga prędkości sama liczy kierunek wprost z
    // this.vx/vy (już poprawny względem świata) - owinięcie jej w
    // dodatkowe scale(facing,1) przekręciłoby ją w złą stronę przy biegu w lewo.
    this._drawPickupRing(ctx2);
    this._drawSpeedTrail(ctx2);

    // BUGFIX ("gear nie rusza się jak postać"): _drawSprite miał WŁASNY,
    // odizolowany rotate(lean)/scale(facing,1), a _drawGearOverlays (kask/
    // maska/pasy/plecak/buty) rysował się PO NIM, już poza tym blokiem - więc
    // przy przechyle w biegu albo odwróceniu w lewo (facing=-1) ciało się
    // przechylało/odbijało, a cały gear zostawał sztywno w miejscu, jakby
    // był przyklejony do świata, nie do postaci. Teraz JEDEN wspólny blok
    // lean/flip obejmuje sylwetkę I gear razem - poruszają się jak jedna bryła.
    const lean = this._getLean();
    ctx2.save();
    ctx2.rotate(lean);
    ctx2.scale(this.facing, 1);

    // Plecak PRZED sylwetką (Tomek: "damy go bardziej na plecy") - postać
    // rysowana zaraz potem zasłania środek plecaka, więc widać tylko
    // wystający fragment zza ramienia, jak coś NOSZONEGO na plecach, a nie
    // doczepiony z boku pakunek (patrz komentarz przy _drawBackpack o
    // wcześniejszym x-offsecie).
    const eco = window.economyManager;
    if (eco && eco.upgradeLevels && eco.upgradeLevels.capacity > 0) {
      this._drawBackpack(ctx2, this._getBodyPointY(0.62), eco.upgradeLevels.capacity);
    }

    if (this._spriteLoaded) {
      this._drawSprite(ctx2);
    } else {
      this._drawProcedural(ctx2);
    }

    // Sprzęt ochronny NA WIERZCHU postaci (maska/pasy kombinezonu) - kupiony
    // Filtr Toksyn / Kombinezon Radiacyjny teraz faktycznie WIDAĆ na graczu,
    // nie tylko w liczbach sklepu. economyManager.hasUpgrade() już istniało
    // (player.js i tak z niego korzysta do sprawdzania ochrony w hazardzie),
    // więc to czysto odczyt istniejącego stanu, zero nowego przesyłania danych.
    this._drawGearOverlays(ctx2);

    ctx2.restore();

    // Faza 4: pasek ostrzegawczy przed utratą przedmiotu - poza rotate/scale
    // sprite'u (ten blok kończy się przed _drawHazardBar), więc pasek
    // zawsze zostaje poziomy niezależnie od kierunku patrzenia/przechyłu.
    if (this._inHazard) {
      this._drawHazardBar(ctx2);
    }

    ctx2.restore();
  }

  /**
   * Cienki, przerywany pierścień na promieniu magnesu - widoczny TYLKO gdy
   * kupiono chociaż jeden poziom "Magnesu" (upgradeLevels.pickup > 0).
   * Celowo bardzo subtelny (niska alpha, powolne pulsowanie) - to
   * potwierdzenie zasięgu, nie coś, co ma zasłaniać przedmioty na mapie.
   */
  _drawPickupRing(ctx2) {
    const eco = window.economyManager;
    if (!eco || !eco.upgradeLevels || !eco.upgradeLevels.pickup) return;

    const radius = (window.itemManager && window.itemManager.pickupRadius) || 55;
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 900);

    ctx2.save();
    ctx2.globalAlpha = 0.1 + pulse * 0.07;
    ctx2.strokeStyle = '#CE93D8';
    ctx2.lineWidth = 2;
    ctx2.setLineDash([5, 7]);
    ctx2.beginPath();
    ctx2.arc(0, 0, radius, 0, Math.PI * 2);
    ctx2.stroke();
    ctx2.restore();
  }

  /**
   * Smuga ruchu za graczem - widoczna TYLKO gdy prędkość jest ponad bazową
   * (czyli chociaż jeden poziom "Prędkości" kupiony) I gracz faktycznie się
   * porusza. Intensywność (alpha/rozciągnięcie) rośnie z poziomem upgrade'u -
   * im szybszy gracz, tym wyraźniejsza smuga, bez potrzeby osobnego licznika
   * poziomu (this.speed już to niesie).
   */
  _drawSpeedTrail(ctx2) {
    // BUGFIX: liczyło samo this.speed / PLAYER_BASE_SPEED, ale mnożnik z
    // modułu Silnika NIE dotyka this.speed (jest stosowany w miejscu użycia,
    // patrz _getShipSpeedMult) - więc gracz z Silnikiem, ale bez ulepszenia
    // prędkości ze sklepu, biegałby o 25% szybciej z ratio = 1.0, czyli BEZ
    // smugi. Efektywna prędkość musi liczyć oba źródła, tak samo jak robi to
    // faktyczny ruch w update().
    const effectiveSpeed = this.speed * this._getShipSpeedMult();
    const speedRatio = effectiveSpeed / PLAYER_BASE_SPEED;
    if (speedRatio <= 1.02) return;

    const moving = Math.abs(this.vx) + Math.abs(this.vy) > 20;
    if (!moving) return;

    const len = Math.sqrt(this.vx * this.vx + this.vy * this.vy) || 1;
    const nx = -this.vx / len;
    const ny = -this.vy / len;
    const intensity = Math.min(1, (speedRatio - 1) / 1.2);

    ctx2.save();
    for (let i = 1; i <= 3; i++) {
      const dist = i * (8 + intensity * 6);
      ctx2.globalAlpha = 0.22 * intensity * (1 - i / 4);
      ctx2.fillStyle = '#81D4FA';
      ctx2.beginPath();
      ctx2.ellipse(nx * dist, ny * dist, this.radius * 0.55, this.radius * 0.32, 0, 0, Math.PI * 2);
      ctx2.fill();
    }
    ctx2.restore();
  }

  /**
   * Punkt lokalny (do translate/pozycjonowania) na wysokości `fraction`
   * WZDŁUŻ CAŁEJ SYLWETKI - 0 = sam czubek głowy/sprite'a, 1 = stopy
   * (footY). Wspólna skala dla WSZYSTKICH elementów gearu (maska/pasy/
   * kask/plecak/buty), żeby każdy siedział we WŁAŚCIWYM miejscu na ciele,
   * niezależnie od tego, czy aktywny jest sprite czy fallback proceduralny.
   *
   * BUGFIX ("filtr na czole", "kombinezon na oczach"): poprzednia wersja
   * (_getHeadY) liczyła punkt tylko jako ułamek WYSOKOŚCI sprite'a, bez
   * uwzględnienia footY (gdzie faktycznie stoją stopy w lokalnym układzie
   * współrzędnych) - w efekcie "headY" wypadało dużo wyżej niż zamierzone
   * (~17% w dół od czubka głowy, czyli czoło), a doliczane do niego stałe
   * przesunięcia (np. +radius*0.7 dla pasów) wciąż nie schodziły niżej niż
   * okolice oczu. Sprawdzone wprost na assets/player.png (66x92): oczy
   * siedzą w ~27% wysokości, kołnierz/początek tułowia w ~50%, korpus w
   * ~60%+ - te ułamki są teraz przekazywane jawnie przy każdym wywołaniu
   * (patrz _drawGearOverlays), nie zaszyte niejawnie w jednej stałej.
   */
  /**
   * Który kadr chodu jest teraz pokazywany - ta sama faza co bujanie
   * (Math.sin(this.walkCycle) w update()), znormalizowana do 0..1 na pełnym
   * okresie 2*PI i zmapowana na klatki. Wspólne dla _drawSprite (który kadr
   * narysować) i _drawBoots (gdzie dokładnie leżą stopy W TYM kadrze, patrz
   * PLAYER_WALK_LEG_FRAMES) - muszą zawsze wskazywać na TEN SAM kadr, inaczej
   * buty znowu rozjadą się z nogami. frameCount jest parametrem (nie zawsze
   * PLAYER_WALK_FRAME_COUNT=11) - skiny na alternatywnym ciele (patrz
   * PLAYER_ALIEN_BODY_IDS) mają tylko 2 klatki chodu (_activeWalkFrameCount()).
   */
  _currentWalkFrameIndex(frameCount = PLAYER_WALK_FRAME_COUNT) {
    const phase = (this.walkCycle % (Math.PI * 2)) / (Math.PI * 2);
    return Math.floor(phase * frameCount) % frameCount;
  }

  /** Liczba klatek spritesheeta chodu AKTYWNEGO skina - 11 (precyzyjna,
   * ręcznie zmierzona animacja) dla domyślnego ciała, 2 (walk1/walk2 z
   * paczki Kenney) dla alternatywnych ciał skinów (patrz PLAYER_SKINS.body
   * w economy.js). Czytane przez _getSpriteDrawSize/_drawSprite/_drawBoots -
   * wszystkie trzy muszą się zgadzać, inaczej kadrowanie rozjedzie się z
   * rzeczywistym obrazkiem. */
  _activeWalkFrameCount() {
    const eco = window.economyManager;
    const skinId = (eco && eco.selectedSkin) || 'default';
    const baked = this._tintedSprites[skinId];
    return (baked && baked.frameCount) || PLAYER_WALK_FRAME_COUNT;
  }

  /**
   * Faktyczna narysowana szerokość/wysokość sprite'a (px) - DOKŁADNIE to,
   * czego _drawSprite użyje w TEJ klatce (ten sam obrazek, ten sam
   * naturalRatio). Gear liczony z osobnej stałej (this.radius, parametr
   * gry do kolizji/cienia - NIE rozmiar narysowanej postaci) zawsze wychodził
   * za mały ("filtr za mały" mimo kolejnych podbić mnożnika) - maska/buty
   * teraz skalują się względem TEGO SAMEGO rozmiaru co realnie widoczna
   * sylwetka, więc rosną/maleją razem z nią zamiast osobno zgadywać.
   *
   * BUGFIX (skiny na innym ciele): liczyło proporcje ZAWSZE z domyślnego
   * this._spriteImg/this._walkImg, niezależnie od wybranego skina - dla
   * skinów na alternatywnym ciele (inny rozmiar/kadr niż domyślny) dawało to
   * złe proporcje (gear i sylwetka rozjeżdżały się). Liczy teraz z
   * FAKTYCZNIE rysowanego obrazka (_getSkinImage), z fallbackiem na domyślny.
   */
  _getSpriteDrawSize() {
    let naturalRatio = 66 / 92; // domyslne proporcje sprite'a, zanim jakikolwiek obrazek zdazy sie wczytac
    if (this._spriteLoaded) {
      const useWalk = this.isMoving && this._walkLoaded;
      const skinImg = this._getSkinImage(useWalk);
      if (skinImg) {
        const iw = skinImg.naturalWidth || skinImg.width;
        const ih = skinImg.naturalHeight || skinImg.height;
        naturalRatio = useWalk ? (iw / this._activeWalkFrameCount()) / ih : iw / ih;
      } else {
        naturalRatio = useWalk
          ? (this._walkImg.naturalWidth / PLAYER_WALK_FRAME_COUNT) / this._walkImg.naturalHeight
          : this._spriteImg.naturalWidth / this._spriteImg.naturalHeight;
      }
    }
    const h = PLAYER_SPRITE_HEIGHT * this.bodySquash;
    const w = (PLAYER_SPRITE_HEIGHT * naturalRatio) / this.bodySquash;
    return { w, h };
  }

  _getBodyPointY(fraction) {
    const footY = this.radius * 0.8;
    const h = this._spriteLoaded
      ? PLAYER_SPRITE_HEIGHT * this.bodySquash
      : this.radius * 2 * this.bodySquash;
    return footY - h * (1 - fraction);
  }

  /** Przechył (rad) w kierunku ruchu poziomego - wspólny dla sylwetki I
   * gearu (patrz draw()), żeby "przechylenie się w biegu" wyglądało jak
   * jedna bryła, a nie osobno przechylona postać obok sztywno stojącego gearu. */
  _getLean() {
    return Math.max(-PLAYER_LEAN_MAX, Math.min(PLAYER_LEAN_MAX, this.vx * PLAYER_LEAN_FACTOR));
  }

  _drawGearOverlays(ctx2) {
    const eco = window.economyManager;
    if (!eco || typeof eco.hasUpgrade !== 'function') return;

    // Pasy kombinezonu NAJPIERW (na torsie, pod maską) - gdyby gracz miał
    // OBA naraz, maska (bliżej twarzy) nie powinna ginąć pod paskami tułowia.
    // Ułamki (patrz _getBodyPointY) zmierzone wprost na assets/player.png -
    // 0 = czubek głowy, ~0.27 = oczy, ~0.5 = kołnierz/początek tułowia, 1 = stopy.
    // BUGFIX ("kamizelka na szyi"): 0.6 wciąż czytało się jako kołnierz/szyja
    // na realnym telefonie (mimo że liczbowo leżało już PONIŻEJ kołnierza) -
    // przesunięte wyraźnie niżej, w okolice pasa/bioder, żeby jednoznacznie
    // czytało się jako pas na kombinezonie, nie coś przy głowie.
    if (eco.hasUpgrade('radiation_suit')) {
      this._drawHazmatTrim(ctx2, this._getBodyPointY(0.78));
    }
    // Maska teraz pokrywa CAŁĄ głowę (0% czubek - 64% linia szczęki/karku,
    // patrz _drawGasMask), więc zakotwiczona na środku tej strefy (~32%),
    // nie na wysokości samych oczu jak poprzednio.
    if (eco.hasUpgrade('toxic_filter')) {
      this._drawGasMask(ctx2, this._getBodyPointY(0.32));
    }
    // Latarka NA WYSOKOŚCI SKRONI, wyżej niż maska (patrz _drawHelmet -
    // bez kopuły hełmu, sama latarka przypięta z boku głowy), buty PRZY
    // stopach - żaden z gearów rysowanych TU (latarka/maska/pasy/buty) nie
    // nakłada się na inny. Plecak NIE jest już tutaj - rysuje się PRZED
    // sylwetką w draw(), żeby postać go częściowo zasłaniała (patrz
    // komentarz tam i przy _drawBackpack).
    if (eco.hasUpgrade('headlamp')) {
      this._drawHelmet(ctx2, this._getBodyPointY(0.16));
    }
    if (eco.hasUpgrade('boots')) {
      this._drawBoots(ctx2);
    }
  }

  /**
   * Plecak "Większy plecak" (sklep) - dotąd czysto liczbowy (więcej miejsc
   * na stosie), bez żadnego odzwierciedlenia na postaci. Rośnie z każdym
   * poziomem (1-5).
   *
   * BUGFIX: pierwsza wersja rysowała go WYŚRODKOWANY i PRZED sylwetką (żeby
   * "wystawał zza pleców") - ale przy realnych wymiarach sprite'a
   * (66x92, ~60px szerokości narysowanej) mały, wyśrodkowany prostokąt
   * mieścił się CAŁKOWICIE w cieniu korpusu i nigdy nie było go widać, więc
   * przesunięto go WYRAŹNIE w bok i za sylwetkę (rysowany PO niej) - zawsze
   * w pełni widoczny, ale czytał się jako doczepiony z boku pakunek, nie
   * plecak NA plecach.
   *
   * BUGFIX #2 (Tomek: "co robimy z plecakiem, może go bardziej na plecy
   * damy"): wrócono do PRZED-sylwetkowego rysowania (patrz wywołanie w
   * draw()), ale tym razem z x na tyle bliskim środka, żeby postać
   * ZASŁANIAŁA środek plecaka, a widoczny zostawał tylko fragment
   * wystający zza ramienia - kompromis między pierwszą wersją (całkiem
   * znikał) a drugą (cały czas widoczny obok, jak osobny pakunek). Trochę
   * większa bazowa szerokość niż poprzednio, żeby wystający fragment nadal
   * wyraźnie czytał się jako plecak po częściowym zasłonięciu.
   */
  _drawBackpack(ctx2, bodyTopY, level) {
    const growth = 1 + (level - 1) * 0.12; // 5 poziomów: 1.0 .. ~1.48
    const w = this.radius * 0.75 * growth;
    const h = this.radius * 0.8 * growth;
    const x = this.radius * 0.68;
    const y = bodyTopY + h * 0.3;

    ctx2.save();

    // BUGFIX (Tomek: "brązowa butle z rurką"): szelki wcześniej biegły AŻ do
    // punktu blisko głowy - z daleka czytały się jako osobna "rurka"
    // wychodząca z plecaka w stronę hełmu, nie jak pasek noszony na
    // ramieniu. Teraz to KRÓTKIE kreski TYLKO przy górnej krawędzi plecaka
    // (sugerują "tu zaczyna się szelka i znika za ramieniem"), bez ciągnięcia
    // linii przez pół sylwetki do głowy.
    ctx2.strokeStyle = 'rgba(0, 0, 0, 0.35)';
    ctx2.lineWidth = 2.2;
    ctx2.lineCap = 'round';
    [-0.28, 0.2].forEach((frac) => {
      const sx = x + w * frac;
      const sy = y - h / 2 + h * 0.06;
      ctx2.beginPath();
      ctx2.moveTo(sx, sy);
      ctx2.lineTo(sx - w * 0.22, sy - h * 0.16);
      ctx2.stroke();
    });

    // Korpus - gradient góra-dół zamiast płaskiego wypełnienia, żeby miał
    // wyczuwalną objętość (jaśniejsza górna krawędź, cień u dołu).
    const bodyGrad = ctx2.createLinearGradient(0, y - h / 2, 0, y + h / 2);
    bodyGrad.addColorStop(0, '#7A5548');
    bodyGrad.addColorStop(0.5, '#5D4037');
    bodyGrad.addColorStop(1, '#3E2723');
    ctx2.fillStyle = bodyGrad;
    ctx2.strokeStyle = 'rgba(0, 0, 0, 0.45)';
    ctx2.lineWidth = 1.3;
    this._roundRect(ctx2, x - w / 2, y - h / 2, w, h, w * 0.3);
    ctx2.fill();
    ctx2.stroke();

    // Boczna kieszeń - mały prostokąt z własnym cieniowaniem, żeby korpus
    // nie był jednolitą płaszczyzną.
    const pocketGrad = ctx2.createLinearGradient(0, y, 0, y + h * 0.32);
    pocketGrad.addColorStop(0, '#6D4C41');
    pocketGrad.addColorStop(1, '#4E342E');
    ctx2.fillStyle = pocketGrad;
    this._roundRect(ctx2, x - w * 0.32, y + h * 0.08, w * 0.64, h * 0.3, w * 0.14);
    ctx2.fill();

    // Klapa u góry - z gradientem i cienką jasną krawędzią (szew).
    const flapGrad = ctx2.createLinearGradient(0, y - h / 2 - h * 0.14, 0, y - h / 2 + h * 0.16);
    flapGrad.addColorStop(0, '#5D4037');
    flapGrad.addColorStop(1, '#3E2723');
    ctx2.fillStyle = flapGrad;
    this._roundRect(ctx2, x - w * 0.36, y - h / 2 - h * 0.14, w * 0.72, h * 0.3, w * 0.16);
    ctx2.fill();
    ctx2.strokeStyle = 'rgba(255, 255, 255, 0.18)';
    ctx2.lineWidth = 1;
    this._roundRect(ctx2, x - w * 0.36, y - h / 2 - h * 0.14, w * 0.72, h * 0.3, w * 0.16);
    ctx2.stroke();

    // Klamra na klapie - mały jasny prostokąt, sprzedaje "prawdziwy sprzęt"
    // zamiast gładkiej bryły.
    ctx2.fillStyle = '#FFCA28';
    this._roundRect(ctx2, x - w * 0.09, y - h / 2 - h * 0.01, w * 0.18, h * 0.13, w * 0.04);
    ctx2.fill();

    // Tomek: "progres capacity niech będzie widać na oko, nie tylko
    // rozmiarem" - od poziomu 3 dochodzi DRUGA kieszeń po przeciwnej
    // stronie plecaka (widoczna zza ramienia razem z główną), a na
    // maksymalnym poziomie 5 dodatkowo zwinięta mata/derka przypięta pod
    // spodem na krzyżujących się paskach - typowy język "w pełni
    // wyposażonego" plecaka, łatwo czytelny nawet w małej skali sprite'a.
    if (level >= 3) {
      const px = x + w * 0.4;
      const py = y + h * 0.02;
      const pw = w * 0.24;
      const ph = h * 0.24;
      ctx2.strokeStyle = 'rgba(0, 0, 0, 0.35)';
      ctx2.lineWidth = 1.6;
      ctx2.beginPath();
      ctx2.moveTo(px, py - ph * 0.5);
      ctx2.lineTo(px, y - h * 0.42);
      ctx2.stroke();
      const pocket2Grad = ctx2.createLinearGradient(0, py - ph / 2, 0, py + ph / 2);
      pocket2Grad.addColorStop(0, '#6D4C41');
      pocket2Grad.addColorStop(1, '#4E342E');
      ctx2.fillStyle = pocket2Grad;
      ctx2.strokeStyle = 'rgba(0, 0, 0, 0.4)';
      ctx2.lineWidth = 1;
      this._roundRect(ctx2, px - pw / 2, py - ph / 2, pw, ph, w * 0.08);
      ctx2.fill();
      ctx2.stroke();
    }

    if (level >= 5) {
      const rollY = y + h / 2 + h * 0.1;
      const rollW = w * 0.9;
      const rollH = h * 0.2;
      const rollGrad = ctx2.createLinearGradient(0, rollY - rollH / 2, 0, rollY + rollH / 2);
      rollGrad.addColorStop(0, '#8D9C4A');
      rollGrad.addColorStop(0.5, '#6B7A38');
      rollGrad.addColorStop(1, '#4A5626');
      ctx2.fillStyle = rollGrad;
      ctx2.strokeStyle = 'rgba(0, 0, 0, 0.4)';
      ctx2.lineWidth = 1.2;
      this._roundRect(ctx2, x - rollW / 2, rollY - rollH / 2, rollW, rollH, rollH * 0.5);
      ctx2.fill();
      ctx2.stroke();

      ctx2.strokeStyle = 'rgba(0, 0, 0, 0.5)';
      ctx2.lineWidth = 2;
      [-0.28, 0.28].forEach((frac) => {
        ctx2.beginPath();
        ctx2.moveTo(x + w * frac, y + h * 0.4);
        ctx2.lineTo(x + w * frac * 0.5, rollY);
        ctx2.stroke();
      });
    }

    ctx2.restore();
  }

  /**
   * "Kask z Latarką" (sklep) - WYŁĄCZNIE latarka przypięta z boku głowy,
   * bez kopuły hełmu (patrz BUGFIX niżej). Zakotwiczona na wysokości
   * skroni (fraction=0.16, patrz _getBodyPointY) - wyraźnie wyżej niż
   * maska na twarzy (fraction=0.32, środek całej twarzy), więc czyta się
   * jako coś przypiętego DO głowy z boku, nie unoszące się nad nią.
   *
   * BUGFIX (Tomek: "kask usuń, a latarkę daj z boku głowy"): wcześniejsza
   * wersja miała żółtą kopułę hełmu POD latarką (patrz historia tej
   * funkcji - najpierw lampka na czole kopuły, potem tuba z boku kopuły).
   * Teraz zostaje WYŁĄCZNIE sama latarka (uchwyt + tuba + soczewka),
   * przypięta wprost do sylwetki głowy - bez kopuły w ogóle.
   *
   * Tomek: "żeby była jakoś przypięta do hełmu [głowy]" - sam uchwyt
   * (mały prostokąt pod tubą) był za mało czytelny jako "coś zapiętego
   * NA głowie", więc doszedł jeszcze cienki PASEK opasujący górę głowy
   * (jak prawdziwa opaska latarki czołowej) + nit/klamra w miejscu
   * mocowania - dwa niezależne sygnały "to jest przypięte", nie
   * doklejone. Kąt nachylenia tuby (-0.25, czyli lekko w górę-przód)
   * ZOSTAJE, a nie "prosto w kamerę" - w tym rzucie z góry/boku płaska
   * soczewka patrząca wprost w ekran czytałaby się jako plaska kropka
   * bez kształtu, podczas gdy nachylona tuba jednoznacznie czyta się
   * jako źródło światła świecące w kierunku, w którym postać patrzy.
   *
   * BUGFIX (Tomek: "mocowanie niech dobrze i w dobrym miejscu leży na
   * hełmie i będzie łączone z latarką"): pasek zaczynał się w INNYM
   * miejscu (r*0.75) niż uchwyt tuby (r*0.92) - widoczna przerwa, nie
   * jedno spójne mocowanie. Do tego samo r*0.92 było zgadywanką z
   * this.radius (parametr KOLIZJI, nie rozmiar sylwetki - ten sam błąd,
   * który wcześniej psuł buty/pasek, patrz komentarz przy
   * PLAYER_ALIEN_BOOT_LEFT_FRAC) - wypadało WEWNĄTRZ sylwetki głowy
   * zamiast na jej krawędzi. Zmierzone wprost na pikselach
   * assets/player.png (wiersz 15, wysokość ~fraction 0.16): prawa
   * krawędź głowy leży na 0.409 * spriteW od środka. Ta sama wartość
   * działa dla WSZYSTKICH ciał (w przeciwieństwie do tułowia głowa ma
   * identyczny zarys na default i na wszystkich PLAYER_ALIEN_BODY_IDS -
   * zmierzone osobno, więc bez potrzeby _isAlienBodyActive tutaj).
   * Pasek i uchwyt teraz startują z TEGO SAMEGO punktu (mountX, sideY).
   *
   * BUGFIX (Tomek: "mocowanie nie idzie po krzywiźnie hełmu tylko jakoś
   * tak schodzi"): quadraticCurveTo z RĘCZNIE zgadniętym punktem
   * kontrolnym cięła po skosie przez środek twarzy zamiast trzymać się
   * krawędzi głowy. Zastąpione łamaną PRZEZ realnie zmierzone punkty
   * prawej krawędzi assets/player.png (wiersze 3/6/9/12/15, ta sama
   * tabela co wyżej) - pasek fizycznie leży NA sylwetce, więc opływa jej
   * krzywiznę niezależnie od kształtu, zamiast rysować własną, niezależną
   * krzywą, która akurat CZASEM się z nią pokrywa.
   */
  _drawHelmet(ctx2, sideY) {
    const r = this.radius * 0.62; // skala samych elementów (tuba/uchwyt/pasek), NIE ich pozycji
    const { w: spriteW } = this._getSpriteDrawSize();
    const mountX = spriteW * 0.409;

    // Pasek opasujący głowę - łamana PO zmierzonej krawędzi (patrz BUGFIX
    // wyżej), od miejsca mocowania w górę do okolic czubka głowy, bez
    // rysowania pełnej opaski dookoła (i tak w większości zasłoniłaby ją
    // sylwetka).
    const STRAP_EDGE_FRACS = [0.163, 0.13, 0.098, 0.065, 0.033]; // wysokość (_getBodyPointY)
    const STRAP_EDGE_X = [0.909, 0.879, 0.833, 0.788, 0.727]; // prawa krawędź głowy na tej wysokości
    ctx2.save();
    ctx2.strokeStyle = 'rgba(40, 40, 40, 0.75)';
    ctx2.lineWidth = r * 0.12;
    ctx2.lineCap = 'round';
    ctx2.lineJoin = 'round';
    ctx2.beginPath();
    ctx2.moveTo(mountX, sideY);
    STRAP_EDGE_FRACS.slice(1).forEach((frac, i) => {
      const px = (STRAP_EDGE_X[i + 1] - 0.5) * spriteW;
      const py = this._getBodyPointY(frac);
      ctx2.lineTo(px, py);
    });
    ctx2.stroke();
    ctx2.restore();

    // Latarka z boku głowy - własny lokalny układ (przesunięcie + obrót),
    // żeby tuba i jej soczewka nie musiały ręcznie przeliczać sinusów/
    // cosinusów kąta nachylenia. Zakotwiczona w TYM SAMYM punkcie
    // (mountX, sideY) co start paska powyżej - jedno spójne mocowanie.
    ctx2.save();
    ctx2.translate(mountX, sideY);
    ctx2.rotate(-0.25);

    // Uchwyt łączący tubę z głową (z małym nitem/klamrą - miejsce, gdzie
    // faktycznie "zapina się" na pasku powyżej).
    ctx2.fillStyle = 'rgba(0, 0, 0, 0.4)';
    ctx2.fillRect(-r * 0.22, -r * 0.08, r * 0.3, r * 0.16);
    ctx2.fillStyle = '#BDBDBD';
    ctx2.beginPath();
    ctx2.arc(-r * 0.07, 0, r * 0.06, 0, Math.PI * 2);
    ctx2.fill();

    // Tuba - gradient poprzeczny (jasna góra, ciemny dół), jak realny
    // metalowy walec, ten sam zabieg "obiekt ma objętość" co reszta gearu.
    const tubeLen = r * 0.85;
    const tubeW = r * 0.32;
    const tubeGrad = ctx2.createLinearGradient(0, -tubeW / 2, 0, tubeW / 2);
    tubeGrad.addColorStop(0, '#9E9E9E');
    tubeGrad.addColorStop(0.5, '#616161');
    tubeGrad.addColorStop(1, '#333333');
    ctx2.fillStyle = tubeGrad;
    ctx2.strokeStyle = 'rgba(0, 0, 0, 0.5)';
    ctx2.lineWidth = 1;
    this._roundRect(ctx2, 0, -tubeW / 2, tubeLen, tubeW, tubeW * 0.35);
    ctx2.fill();
    ctx2.stroke();

    // Soczewka na czubku tuby - ten sam efekt "źródła światła" (poświata +
    // jasny rdzeń, pulsujące) co poprzednia wersja, teraz osadzony na
    // czubku rozpoznawalnej latarki zamiast samotnie na czole kopuły.
    const pulse = 0.55 + 0.45 * Math.sin(performance.now() / 260);
    ctx2.save();
    ctx2.globalAlpha = pulse;
    const glowGrad = ctx2.createRadialGradient(tubeLen, 0, 0, tubeLen, 0, tubeW * 0.9);
    glowGrad.addColorStop(0, 'rgba(255, 249, 196, 0.9)');
    glowGrad.addColorStop(1, 'rgba(255, 249, 196, 0)');
    ctx2.fillStyle = glowGrad;
    ctx2.beginPath();
    ctx2.arc(tubeLen, 0, tubeW * 0.9, 0, Math.PI * 2);
    ctx2.fill();
    ctx2.fillStyle = '#FFF9C4';
    ctx2.beginPath();
    ctx2.arc(tubeLen, 0, tubeW * 0.42, 0, Math.PI * 2);
    ctx2.fill();
    ctx2.restore();

    ctx2.restore();
  }

  /**
   * "Robocze Buty" (sklep) - dwie proste, wyraźnie kolorowe "cholewki" na
   * stopach postaci.
   *
   * BUGFIX ("buty nie ruszają się zgodnie z nogami"): pierwsza wersja
   * unosiła but zaledwie o ~3.5px (radius*0.16) - praktycznie niewidoczne.
   *
   * BUGFIX ("buty poza stopami"): DRUGA wersja naprawiła widoczność ruchu,
   * ale liczyła pozycję but"ów z WŁASNEGO, wymyślonego wzoru sinusoidalnego
   * (stały rozstaw + sin(walkCycle)) - zupełnie niezależnego od tego, gdzie
   * NAPRAWDĘ leżą narysowane nogi w aktualnie wyświetlanej klatce
   * assets/player_walk.png. Klatki tego spritesheeta faktycznie się różnią
   * (nogi rozstawiają/zbiegają/unoszą - prawdziwy chód), więc stały wzór
   * nieuchronnie rozjeżdżał się z nogami w większości klatek. Teraz, gdy
   * pokazywany jest spritesheet chodu, buty czytają DOKŁADNIE zmierzoną
   * pozycję nóg z PLAYER_WALK_LEG_FRAMES dla TEGO SAMEGO kadru co
   * _drawSprite (_currentWalkFrameIndex()) - identyczna transformacja
   * ułamek->px jak przy rysowaniu sprite'a, więc but zawsze trafia w stopę.
   * BUGFIX (Tomek: "buty odstają trochę od stóp"): powyższy komentarz o
   * "sylwetce BEZ osobno narysowanych nóg" był nieaktualny/błędny -
   * zmierzone wprost na pikselach assets/player.png (y=82-91): statyczny
   * sprite MA dwie osobne, wyraźnie rozdzielone nogi (przerwa ~x=27-41 z
   * 66px szerokości), tylko nikt wcześniej ich nie zmierzył. Poprzedni
   * "stały, domyślny rozstaw" (this.radius*0.42, this.radius to parametr
   * KOLIZJI, nie rozmiar sylwetki) był więc zgadywanką, nie pomiarem - stąd
   * widoczne przesunięcie. Teraz buty w bezruchu czytają te same, realnie
   * zmierzone ułamki (lewa noga środek ~0.318, prawa ~0.697, stopa ~0.989
   * wysokości) przez _getSpriteDrawSize() - identyczna metoda co gałąź
   * chodu wyżej, tylko z inną, osobno zmierzoną tabelą (ten sprite to inny
   * plik niż assets/player_walk.png).
   */
  /**
   * BUGFIX (skiny na alternatywnym ciele): PLAYER_WALK_LEG_FRAMES to 11
   * ręcznie zmierzonych pozycji stóp - WYŁĄCZNIE dla domyślnego, 11-klatkowego
   * assets/player_walk.png. Skiny na innym ciele (patrz PLAYER_ALIEN_BODY_IDS)
   * mają tylko 2 klatki chodu (walk1/walk2) - indeksowanie ich do tej samej
   * 11-elementowej tabeli dawałoby zupełnie przypadkowe (złe) pozycje.
   * Precyzyjna IK jest więc używana TYLKO gdy aktywny jest domyślny,
   * 11-klatkowy chód - dla pozostałych skinów buty wracają do prostego,
   * stałego rozstawu (jak w bezruchu) - wciąż poprawnie przy stopach, tylko
   * bez animacji rozstawiania nóg krok po kroku.
   */
  _drawBoots(ctx2) {
    const footY = this.radius * 0.8;
    const bootW = this.radius * 0.4;
    const bootH = this.radius * 0.32;

    const frameCount = this._activeWalkFrameCount();
    const useWalk = this.isMoving && this._walkLoaded && this._spriteLoaded && frameCount === PLAYER_WALK_FRAME_COUNT;
    let leftX, rightX, groundY;

    if (useWalk) {
      const frame = PLAYER_WALK_LEG_FRAMES[this._currentWalkFrameIndex(frameCount)];
      const { w, h } = this._getSpriteDrawSize();
      leftX = (frame.leftFrac - 0.5) * w;
      rightX = (frame.rightFrac - 0.5) * w;
      groundY = footY - h * (1 - frame.footFrac);
    } else {
      const { w, h } = this._getSpriteDrawSize();
      const alien = this._isAlienBodyActive();
      const leftFrac = alien ? PLAYER_ALIEN_BOOT_LEFT_FRAC : 0.318;
      const rightFrac = alien ? PLAYER_ALIEN_BOOT_RIGHT_FRAC : 0.697;
      const footFrac = alien ? PLAYER_ALIEN_BOOT_FOOT_FRAC : 0.989;
      leftX = (leftFrac - 0.5) * w;
      rightX = (rightFrac - 0.5) * w;
      groundY = footY - h * (1 - footFrac);
    }

    ctx2.save();
    ctx2.strokeStyle = 'rgba(0, 0, 0, 0.4)';
    ctx2.lineWidth = 1.2;
    [leftX, rightX].forEach((dx) => {
      const bootTop = groundY - bootH * 0.7;
      // Cholewka - gradient góra-dół (jaśniejsza cholewka, ciemniejsza
      // podeszwa), zamiast jednego płaskiego koloru.
      const grad = ctx2.createLinearGradient(0, bootTop, 0, groundY);
      grad.addColorStop(0, '#FFC947');
      grad.addColorStop(0.65, '#F9A825');
      grad.addColorStop(1, '#B36A00');
      ctx2.fillStyle = grad;
      this._roundRect(ctx2, dx - bootW / 2, bootTop, bootW, bootH, bootW * 0.3);
      ctx2.fill();
      ctx2.stroke();

      // Podeszwa - ciemny pasek u samego dołu, sprzedaje "but", nie tylko
      // kolorowy prostokąt.
      ctx2.fillStyle = 'rgba(62, 39, 35, 0.85)';
      this._roundRect(ctx2, dx - bootW / 2, groundY - bootH * 0.22, bootW, bootH * 0.22, bootW * 0.14);
      ctx2.fill();

      // Pasek z klamerką w połowie cholewki.
      ctx2.fillStyle = 'rgba(62, 39, 35, 0.55)';
      ctx2.fillRect(dx - bootW / 2, bootTop + bootH * 0.32, bootW, bootH * 0.13);
      ctx2.fillStyle = '#FFECB3';
      ctx2.fillRect(dx - bootW * 0.1, bootTop + bootH * 0.3, bootW * 0.2, bootH * 0.17);
    });
    ctx2.restore();
  }

  /** Pas bezpieczeństwa w poprzek torsu + centralna klamra - czytelny sygnał
   * "wyposażenie ochronne" bez przerabiania całej sylwetki gracza. Gradient +
   * klamra (zamiast jednej płaskiej kreski) - ten sam poziom detalu co
   * reszta gearu po przeglądzie paczek (patrz komentarz przy _drawBackpack).
   *
   * BUGFIX (Tomek: "pasek [...] niech przylega do końców postaci po bokach
   * tułowia"): szerokość liczona z this.radius (parametr KOLIZJI/gry, nie
   * rozmiar narysowanej sylwetki) była kompletnie niezależna od faktycznej
   * szerokości sprite'a w tym miejscu - pas nigdy nie sięgał realnych
   * krawędzi ciała. Zmierzone wprost na pikselach assets/player.png (66x92)
   * na wysokości fraction=0.78 (tam, gdzie pas jest zakotwiczony, patrz
   * wywołanie w _drawGearOverlays): sylwetka zajmuje tam ~85% pełnej
   * szerokości narysowanego sprite'a (_getSpriteDrawSize().w) - reszta gearu
   * (maska) już liczy się z tego samego źródła, więc pas jest teraz spójny
   * z resztą, zamiast osobnego, niezależnie wymyślonego wymiaru.
   *
   * BUGFIX #2 (Tomek: "paski nachodzą na ręce, mają tylko tułów obejmować"):
   * 85% wyżej to szerokość TUŁOWIA + RĄK RAZEM na tej wysokości (ręce tej
   * postaci to boczne wybrzuszenia sylwetki dokładnie w tym miejscu, nie
   * osobne, wąskie kończyny) - pas więc realnie sięgał rąk. Zmierzone osobno
   * wąskie "jądro" tułowia (bez wybrzuszenia rąk) - dokładnie ta sama
   * szerokość co nogi (32 z 66px = ~0.485), bo tułów jest jednolitym
   * "baryłkowym" kształtem od karku po nogi, a ręce to DODATKOWE wybrzuszenie
   * NA TYM kształcie tylko w okolicy ramion. 0.485 zostaje więc w samym
   * tułowiu na każdej wysokości, niezależnie od tego, że akurat tu ręce się
   * poszerzają.
   */
  _drawHazmatTrim(ctx2, bodyY) {
    const { w: spriteW } = this._getSpriteDrawSize();
    const w = spriteW * (this._isAlienBodyActive() ? PLAYER_ALIEN_TORSO_WIDTH_FRAC : 0.485);
    ctx2.save();

    const beltGrad = ctx2.createLinearGradient(0, bodyY, 0, bodyY + 5);
    beltGrad.addColorStop(0, '#FFC947');
    beltGrad.addColorStop(1, '#E68900');
    ctx2.fillStyle = beltGrad;
    ctx2.fillRect(-w / 2, bodyY, w, 5);
    ctx2.fillStyle = 'rgba(33, 33, 33, 0.6)';
    ctx2.fillRect(-w / 2, bodyY + 5, w, 2);

    // Klamra na środku pasa - mały metaliczny prostokąt z ciemną obwódką,
    // sprzedaje "prawdziwy pas ochronny", nie tylko kolorową kreskę.
    const buckleW = w * 0.14;
    ctx2.fillStyle = '#CFD8DC';
    ctx2.strokeStyle = 'rgba(0, 0, 0, 0.45)';
    ctx2.lineWidth = 1;
    ctx2.fillRect(-buckleW / 2, bodyY - 1.5, buckleW, 8);
    ctx2.strokeRect(-buckleW / 2, bodyY - 1.5, buckleW, 8);

    ctx2.restore();
  }

  /**
   * Maska przeciwgazowa - "szklana" osłona na całą głowę + boczny filtr.
   *
   * BUGFIX ("filtr za mały"): DWIE poprzednie tury (0.5 -> 0.66 -> 0.8)
   * podbijały mnożnik this.radius - ale this.radius (22) to parametr GRY
   * (kolizje/cień), nie rozmiar narysowanej sylwetki (this radius*0.8 dawało
   * promień ~17.6px, podczas gdy realna głowa na sprite'cie jest szeroka na
   * ~60px w skali rysowania) - żaden mnożnik this.radius nie mógł więc
   * kiedykolwiek pokryć całej głowy. Zmierzone wprost na pikselach
   * assets/player.png (66x92): głowa zajmuje PRAWIE CAŁĄ szerokość
   * sylwetki (do ~99% w najszerszym miejscu, ~35% wysokości w dół) i sięga
   * od czubka (0%) do przewężenia "szyi" na ~64% wysokości. Maska liczy się
   * z TYCH SAMYCH wymiarów co realnie narysowany sprite (_getSpriteDrawSize()).
   *
   * BUGFIX ("brzydka, ma się zgrywać z ruchem głowy"): poprzednia wersja
   * malowała NIEPRZEZROCZYSTY korpus + WŁASNE, nowe "oczy" (dwa niebieskie
   * kółka) w innym miejscu niż prawdziwe oczy postaci pod spodem - dwie
   * niezależnie pozycjonowane pary oczu, które przy każdej klatce squash/
   * bob/chodu skalowały się osobno i potrafiły się rozjechać, plus wyglądało
   * to jak przyklejona plastikowa naklejka. Teraz szkło jest PÓŁPRZEZROCZYSTE
   * (prawdziwe oczy postaci przebijają spod spodu - automatycznie idealnie
   * zsynchronizowane, bo to ten sam piksel co reszta głowy, nie osobny
   * rysunek), z połyskiem szkła i metalową lamówką zamiast płaskiego szarego
   * owalu, a filtr przeniesiony z "brody" na bok głowy (jak w prawdziwym
   * respiratorze), żeby nie wyglądał jak druga, dziwna buzia.
   */
  /**
   * BUGFIX (Tomek: "czarna obramówka [maski] niech zasłania tę białą
   * dokładnie"): rx=w*0.46 był zmierzony za wąsko - realna sylwetka głowy
   * (zarówno domyślnego sprite'a, jak i ciał alienów, patrz
   * PLAYER_ALIEN_BODY_IDS - obie rodziny mają niemal IDENTYCZNY zarys w tym
   * samym 66x92 płótnie) sięga w najszerszym miejscu PRAWIE do samej
   * krawędzi obrazka (zmierzone wprost na pikselach: pełne 66px szerokości
   * przy y=29-35 z 92, czyli promień 0.5*w, nie 0.46*w). Przy 0.46 zostawał
   * ~2-3px rąbek prawdziwej głowy (u alienów: ich własny biały pierścień
   * hełmu) WIDOCZNY na zewnątrz ciemnej obwódki maski. 0.49 (+ połowa
   * grubości ciemnej kreski, darkLW/2=1.5) sięga niecały piksel poza
   * zmierzoną krawędź - z zapasem, żeby obwódka zawsze w pełni ją zakrywała.
   */
  _drawGasMask(ctx2, headCenterY) {
    const { w, h } = this._getSpriteDrawSize();
    const rx = w * 0.54;
    const ry = h * 0.36;
    const cy = 0;

    ctx2.save();
    ctx2.translate(0, headCenterY);

    const visorPath = () => {
      ctx2.beginPath();
      ctx2.ellipse(0, cy, rx, ry, 0, 0, Math.PI * 2);
    };

    // Szkło - lekko zabarwione i półprzezroczyste, żeby prawdziwe oczy
    // postaci było widać spod spodu zamiast zasłaniać je nową grafiką.
    visorPath();
    ctx2.fillStyle = 'rgba(179, 229, 252, 0.4)';
    ctx2.fill();

    // Połysk szkła - jasny łuk w górnym rogu, przycięty do kształtu wizjera.
    ctx2.save();
    visorPath();
    ctx2.clip();
    ctx2.fillStyle = 'rgba(255, 255, 255, 0.45)';
    ctx2.beginPath();
    ctx2.ellipse(-rx * 0.32, cy - ry * 0.55, rx * 0.55, ry * 0.32, -0.4, 0, Math.PI * 2);
    ctx2.fill();
    ctx2.restore();

    // Rama - gruba ciemna obwódka + cienka jasna lamówka tuż wewnątrz (metal).
    // BUGFIX ("biała obwódka wychodzi poza ciemny obrys"): lamówka na
    // rx*0.93/ry*0.93 to skalowanie PROCENTOWE, nie odsunięcie o stałą
    // liczbę pikseli - a stroke() rysuje centrowanie NA ścieżce (połowa
    // grubości w obie strony). Przy promieniu ~28px zewnętrzna krawędź
    // jasnej lamówki (rx*0.93 + jej połowa grubości) wypadała DALEJ niż
    // wewnętrzna krawędź ciemnej obwódki (rx - jej połowa grubości) - jasna
    // linia realnie wystawała poza ciemną. Teraz odsunięcie liczone wprost z
    // grubości obu linii + margines, więc lamówka ZAWSZE mieści się w
    // środku ciemnej obwódki, niezależnie od rozmiaru maski.
    const darkLW = 3;
    const lightLW = 1.2;
    const rimGap = 1;
    const innerRx = rx - darkLW / 2 - lightLW / 2 - rimGap;
    const innerRy = ry - darkLW / 2 - lightLW / 2 - rimGap;

    visorPath();
    ctx2.lineWidth = darkLW;
    ctx2.strokeStyle = '#37474F';
    ctx2.stroke();
    ctx2.beginPath();
    ctx2.ellipse(0, cy, innerRx, innerRy, 0, 0, Math.PI * 2);
    ctx2.lineWidth = lightLW;
    ctx2.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    ctx2.stroke();

    // Filtr - mały cylinder z boku głowy (respirator), nie na brodzie.
    const fx = rx * 0.88;
    const fy = cy + ry * 0.25;
    const fw = rx * 0.26;
    const fh = ry * 0.5;
    ctx2.fillStyle = '#455A64';
    ctx2.strokeStyle = 'rgba(0, 0, 0, 0.3)';
    ctx2.lineWidth = 1;
    this._roundRect(ctx2, fx - fw / 2, fy - fh / 2, fw, fh, fw * 0.35);
    ctx2.fill();
    ctx2.stroke();
    ctx2.fillStyle = 'rgba(0, 0, 0, 0.25)';
    ctx2.fillRect(fx - fw * 0.3, fy - fh * 0.1, fw * 0.6, fh * 0.14);

    ctx2.restore();
  }

  /**
   * Pasek ostrzegawczy nad głową gracza, widoczny TYLKO w hazardzie -
   * napełnia się w stronę ZONE_HAZARD_ITEM_LOSS_MS (patrz update()).
   * Kolor przechodzi z pomarańczowego na czerwony w ostatniej fazie, żeby
   * dać dodatkowy, nie tylko pozycyjny, sygnał narastającego zagrożenia.
   */
  _drawHazardBar(ctx2) {
    const w = ZONE_HAZARD_BAR_WIDTH;
    const h = ZONE_HAZARD_BAR_HEIGHT;
    const y = ZONE_HAZARD_BAR_OFFSET_Y;
    const pct = Math.min(1, this._hazardDamageTimer / ZONE_HAZARD_ITEM_LOSS_MS);

    ctx2.save();

    ctx2.fillStyle = 'rgba(0, 0, 0, 0.45)';
    this._roundRect(ctx2, -w / 2, y, w, h, 3);
    ctx2.fill();

    if (pct > 0) {
      ctx2.fillStyle = pct > 0.66 ? '#FF5252' : '#FFB74D';
      this._roundRect(ctx2, -w / 2, y, w * pct, h, 3);
      ctx2.fill();
    }

    ctx2.strokeStyle = 'rgba(255, 255, 255, 0.55)';
    ctx2.lineWidth = 1;
    this._roundRect(ctx2, -w / 2, y, w, h, 3);
    ctx2.stroke();

    ctx2.restore();
  }

  /**
   * Rysuje prawdziwy sprite postaci. W ruchu (gdy spritesheet chodzenia się
   * wczytał) wybiera klatkę na podstawie tego samego this.walkCycle, który
   * napędza już bujanie/squash - dzięki temu nogi, tułów i bujanie są w tej
   * samej fazie, zamiast osobnych, niezsynchronizowanych timerów. W bezruchu
   * (albo gdy spritesheet się nie wczytał) pokazuje statyczny assets/player.png.
   *
   * Squash & Stretch liczony jest tak samo jak w _drawProcedural (szerokosc
   * dzielona, wysokosc mnozona przez bodySquash) - dzieki temu "wage" ruchu
   * wyglada identycznie niezaleznie od tego, ktora sciezka rysowania jest
   * aktywna. Sprite jest odbijany lustrzanie w poziomie wg this.facing
   * (1 = prawo, -1 = lewo), więc postać faktycznie patrzy w stronę ruchu -
   * plus subtelny przechył (lean) w kierunku ruchu poziomego, niezależny od
   * odbicia (przechył to "przechylenie się w biegu", nie kierunek patrzenia).
   */
  _drawSprite(ctx2) {
    const useWalk = this.isMoving && this._walkLoaded;
    // Skin wybrany w economy.js (jeśli inny niż domyślny I jego kopia
    // zdążyła się już upiec - patrz _bakeSkinTints) podmienia obrazek
    // źródłowy - może to być inne CIAŁO (inny plik, inne wymiary/liczba
    // klatek, patrz PLAYER_SKINS.body) niż domyślny sprite, więc sx/sy/sw/sh
    // liczone są teraz Z FAKTYCZNIE rysowanego obrazka (img), nie zawsze z
    // domyślnego rawImg jak poprzednio (BUGFIX - patrz _getSpriteDrawSize).
    const rawImg = useWalk ? this._walkImg : this._spriteImg;
    const skinImg = this._getSkinImage(useWalk);
    const img = skinImg || rawImg;
    const frameCount = this._activeWalkFrameCount();

    let sx = 0;
    let sy = 0;
    let sw = (img.naturalWidth || img.width) || 66;
    let sh = (img.naturalHeight || img.height) || 92;

    if (useWalk) {
      sw = (img.naturalWidth || img.width) / frameCount;
      sh = img.naturalHeight || img.height;
      sx = this._currentWalkFrameIndex(frameCount) * sw;
    }

    const naturalRatio = sw / sh;
    const h = PLAYER_SPRITE_HEIGHT * this.bodySquash;
    const w = (PLAYER_SPRITE_HEIGHT * naturalRatio) / this.bodySquash;
    const footY = this.radius * 0.8; // gdzie "stoja stopy" wzgledem cienia

    // lean/odbicie(facing) - stosowane przez WYWOŁUJĄCEGO (draw()), wspólnie
    // dla sylwetki i gearu (patrz komentarz tam) - tu tylko rysujemy obrazek
    // w już przygotowanym układzie współrzędnych.
    ctx2.drawImage(img, sx, sy, sw, sh, -w / 2, footY - h, w, h);
  }

  /** Obrazek (canvas/img albo null) do użycia w _drawSprite() dla BIEŻĄCEGO
   * wybranego skina - null = brak/domyślny, wywołujący sam wraca wtedy do
   * surowego sprite'a domyślnego ciała. */
  _getSkinImage(useWalk) {
    const eco = window.economyManager;
    const skinId = (eco && eco.selectedSkin) || 'default';
    if (skinId === 'default') return null;
    const baked = this._tintedSprites[skinId];
    if (!baked) return null;
    return useWalk ? baked.walk : baked.static;
  }

  /** true, gdy aktywny skin siedzi na jednym z PLAYER_ALIEN_BODY_IDS (nie na
   * domyślnym ciele) - patrz komentarz przy PLAYER_ALIEN_BOOT_LEFT_FRAC dla
   * powodu, dlaczego gear potrzebuje osobnych ułamków dla tej rodziny. */
  _isAlienBodyActive() {
    const eco = window.economyManager;
    if (!eco || !window.PLAYER_SKINS) return false;
    const skin = window.PLAYER_SKINS.find((s) => s.id === eco.selectedSkin);
    return !!(skin && skin.body);
  }

  /**
   * Piecze RAZ (po wczytaniu sprite'ów) obrazek statyczny I spritesheet
   * chodu dla KAŻDEGO skina z PLAYER_SKINS oprócz 'default' (nic do
   * zrobienia - oryginał już jest tym skinem). Dwa niezależne wymiary na
   * skin: `body` (economy.js) wybiera ŹRÓDŁOWE ciało - domyślne
   * (this._spriteImg/_walkImg) albo jedno z PLAYER_ALIEN_BODY_IDS - a `tint`
   * opcjonalnie przebarwia TO ciało (patrz _bakeTintedCanvas). Bez tint
   * używamy surowego obrazka wprost (bez zbędnego kopiowania na canvas) -
   * ctx.drawImage() akceptuje zarówno <img> jak i <canvas> identycznie.
   * Bez tego przebarwianie musiałoby się liczyć co klatkę - dla postaci
   * widocznej bez przerwy 60x/s to byłby zauważalny koszt za darmo.
   */
  _bakeSkinTints() {
    const skins = window.PLAYER_SKINS || [];
    skins.forEach((skin) => {
      if (skin.id === 'default') return;
      const bodyId = skin.body || null;
      const body = bodyId ? this._alienBodies[bodyId] : null;
      const baseStatic = body ? body.staticImg : this._spriteImg;
      const baseWalk = body ? body.walkImg : this._walkImg;
      const staticReady = body ? body.staticLoaded : this._spriteLoaded;
      const walkReady = body ? body.walkLoaded : this._walkLoaded;

      this._tintedSprites[skin.id] = {
        static: staticReady ? (skin.tint ? this._bakeTintedCanvas(baseStatic, skin.tint) : baseStatic) : null,
        walk: walkReady ? (skin.tint ? this._bakeTintedCanvas(baseWalk, skin.tint) : baseWalk) : null,
        frameCount: bodyId ? PLAYER_ALIEN_WALK_FRAME_COUNT : PLAYER_WALK_FRAME_COUNT
      };
    });
  }

  /**
   * Przebarwia CAŁY obrazek jednolitym kolorem (żeby zadziałało identycznie
   * na spritesheecie chodu jak i na pojedynczym statycznym sprite) metodą
   * "source-atop": najpierw kopiujemy oryginał 1:1 (zachowuje przezroczystość
   * PIKSEL PO PIKSELU - klatki spritesheeta zostają rozdzielone), potem
   * dokładamy półprzezroczystą warstwę koloru, którą 'source-atop' ogranicza
   * WYŁĄCZNIE do już narysowanych (nieprzezroczystych) pikseli. Alpha 0.5 -
   * na tyle mocno, żeby kolor był rozpoznawalny, na tyle słabo, żeby oryginalne
   * cieniowanie/highlights sprite'a nadal przebijały (płaski, w pełni kryjący
   * kolor wyglądałby jak naklejka, nie jak przefarbowana tkanina).
   */
  _bakeTintedCanvas(sourceImg, tintColor) {
    const w = sourceImg.naturalWidth;
    const h = sourceImg.naturalHeight;
    if (!w || !h) return null;

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const tctx = canvas.getContext('2d');

    tctx.drawImage(sourceImg, 0, 0, w, h);
    tctx.globalCompositeOperation = 'source-atop';
    tctx.globalAlpha = 0.5;
    tctx.fillStyle = tintColor;
    tctx.fillRect(0, 0, w, h);
    tctx.globalCompositeOperation = 'source-over';
    tctx.globalAlpha = 1;

    return canvas;
  }

  /**
   * Oryginalne rysowanie proceduralne (zaokraglony prostokat + glowa + oczy).
   * Uzywane dopoki assets/player.png sie nie wczyta albo gdyby wczytanie
   * sie nie udalo - gra NIGDY nie zostaje bez widocznej postaci.
   */
  _drawProcedural(ctx2) {
    // Cialo (zaokraglony prostokat) - Squash & Stretch.
    const w = (this.radius * 1.4) / this.bodySquash;
    const h = this.radius * 2 * this.bodySquash;
    // Skin (economy.js) dziala TEZ tutaj, nie tylko na sprite (_bakeSkinTints) -
    // gdyby oba obrazki nigdy sie nie wczytaly, gracz i tak widzi wybrany kolor.
    const eco = window.economyManager;
    const skin = eco && window.PLAYER_SKINS && window.PLAYER_SKINS.find((s) => s.id === eco.selectedSkin);
    ctx2.fillStyle = (skin && (skin.tint || skin.previewColor)) || '#5C85D6'; // niebieski kombinezon domyslnie
    this._roundRect(ctx2, -w / 2, -h / 2, w, h, 8);
    ctx2.fill();

    // Glowa.
    ctx2.fillStyle = '#FBBF72'; // kolor skory
    ctx2.beginPath();
    ctx2.arc(0, -h / 2 - this.radius * 0.5, this.radius * 0.55, 0, Math.PI * 2);
    ctx2.fill();

    // Oczy (kierunek = this.facing).
    ctx2.fillStyle = '#222';
    ctx2.beginPath();
    ctx2.arc(this.facing * 5, -h / 2 - this.radius * 0.5 - 2, 3, 0, Math.PI * 2);
    ctx2.fill();
  }

  _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  setSpeed(newSpeed) {
    this.speed = newSpeed;
  }

  /**
   * Strefa mapy pod danymi współrzędnymi. Ten sam podział co w items.js
   * (spawn surowców) i game.js (mgła/popiół) - patrz stałe ZONE_*_RATIO -
   * ale granica jest teraz POFALOWANA (_edgeWaveC/_edgeWaveB), dokładnie tak
   * samo jak wizualna granica biomów w game.js, żeby hazard (i pasek
   * ostrzegawczy) włączał się dokładnie tam, gdzie widać zmianę tekstury,
   * a nie na starej prostej linii.
   */
  _getZoneAt(x, y) {
    // Strefa D (Kryształowa Grań) to teraz NIEZALEŻNY pas na pełnej
    // wysokości, z JEDNĄ pofalowaną krawędzią (lewą) - nie róg z dwiema jak
    // wcześniej (patrz obszerny komentarz przy GAME_ZONE_CORE_WIDTH w
    // game.js). Sprawdzana JAKO PIERWSZA, bo leży na prawo od C i B obu.
    const dLeftX = PLAYER_ZONE_CORE_WIDTH;
    if (x > dLeftX + this._edgeWaveD(y)) return 'D';

    const topH = PLAYER_WORLD_HEIGHT * PLAYER_ZONE_C_TOP_RATIO;
    if (y < topH + this._edgeWaveC(x)) return 'C';
    const rightX = PLAYER_ZONE_CORE_WIDTH * PLAYER_ZONE_B_RIGHT_RATIO;
    if (x > rightX + this._edgeWaveB(y)) return 'B';
    return 'A';
  }

  /**
   * Fala granicy Strefy C - IDENTYCZNA matematyka co Game._edgeWaveC
   * (game.js): suma dwóch sinusów o niewspółmiernych częstotliwościach,
   * zero losowości, więc granica hazardu pokrywa się klatka po klatce,
   * wczytanie po wczytaniu, z wizualną krawędzią popiołu.
   */
  _edgeWaveC(x) {
    return (
      (Math.sin(x * 0.012 + 0.8) * 0.62 + Math.sin(x * 0.027 + 2.4) * 0.38) *
      PLAYER_BIOME_EDGE_AMPLITUDE
    );
  }

  /** Jak _edgeWaveC, ale dla PIONOWEJ granicy Strefy B (inne fazy/częstotliwości - patrz Game._edgeWaveB w game.js). */
  _edgeWaveB(y) {
    return (
      (Math.sin(y * 0.0095 + 3.1) * 0.62 + Math.sin(y * 0.022 + 0.4) * 0.38) *
      PLAYER_BIOME_EDGE_AMPLITUDE
    );
  }

  /** Fala LEWEJ (jedynej) krawędzi Strefy D - MUSI być identyczna z
   * Game._edgeWaveD (game.js), inaczej hazard Grani włączałby się w innym
   * miejscu niż widać kryształowe podłoże (ten sam wymóg co przy
   * _edgeWaveC/_edgeWaveB). */
  _edgeWaveD(v) {
    return (
      (Math.sin(v * 0.0135 + 1.7) * 0.6 + Math.sin(v * 0.031 + 4.2) * 0.4) *
      PLAYER_BIOME_EDGE_AMPLITUDE
    );
  }

  /** Czy gracz ma sprzęt wymagany do bezpiecznego przebywania w danej strefie. */
  /** Mnożnik prędkości z modułu Silnika (1 = brak modułu). Czytane co klatkę
   * zamiast trzymane w polu - prestiż czyści moduły, więc efekt cofa się sam,
   * bez żadnej dodatkowej logiki resetu (dokładnie ten rodzaj bugu, który
   * trafił się przy capacity - patrz komentarz w _applyUpgrade w economy.js). */
  _getShipSpeedMult() {
    const eco = window.economyManager;
    if (!eco || typeof eco.hasShipPerk !== 'function') return 1;
    return eco.hasShipPerk('speed_boost') ? SHIP_PERK_SPEED_MULT : 1;
  }

  /** Po ilu ms ciągłego hazardu gracz traci przedmiot - moduł Podtrzymywania
   * Życia ORAZ "Robocze Buty" (sklep, patrz BOOTS_HAZARD_GRACE_MULT) wydłużają
   * ten czas, niezależnie od siebie (mnożą się, jeśli gracz ma oba naraz). */
  _getHazardLossThreshold() {
    const eco = window.economyManager;
    let ms = ZONE_HAZARD_ITEM_LOSS_MS;
    if (eco && typeof eco.hasShipPerk === 'function' && eco.hasShipPerk('hazard_grace')) {
      ms *= SHIP_PERK_HAZARD_GRACE_MULT;
    }
    if (eco && typeof eco.hasUpgrade === 'function' && eco.hasUpgrade('boots')) {
      ms *= BOOTS_HAZARD_GRACE_MULT;
    }
    return ms;
  }

  /** Mnożnik spowolnienia w hazardzie - "Kask z Latarką" (sklep) łagodzi karę
   * (lepsza widoczność = mniej się potykasz), ale NIE daje pełnej odporności
   * jak Filtr Toksyn/Kombinezon Radiacyjny (patrz _hasGearForZone). */
  _getHazardSpeedMult() {
    const eco = window.economyManager;
    if (eco && typeof eco.hasUpgrade === 'function' && eco.hasUpgrade('headlamp')) {
      return HEADLAMP_HAZARD_SPEED_MULT;
    }
    return ZONE_HAZARD_SPEED_MULT;
  }

  _hasGearForZone(zone) {
    if (zone === 'A') return true;
    const eco = window.economyManager;
    if (!eco || typeof eco.hasUpgrade !== 'function') return false;
    // Moduł Osłon (statek) - pełna odporność na WSZYSTKIE strefy naraz,
    // zastępuje potrzebę obu sztuk sprzętu ze sklepu. Naturalna progresja:
    // najpierw kupujesz Filtr (żeby w ogóle farmić Strefę B), potem
    // Kombinezon (Strefa C), a dopiero za zdobyte tam surowce stać cię na
    // Osłony (800$ + 6 produktów + 8 stopu) - które robią oba za darmo.
    if (typeof eco.hasShipPerk === 'function' && eco.hasShipPerk('hazard_immunity')) return true;
    if (zone === 'B') return eco.hasUpgrade('toxic_filter');
    if (zone === 'C') return eco.hasUpgrade('radiation_suit');
    // Strefa D (Kryształowa Grań) - CELOWO wymaga OBU sztuk sprzętu naraz
    // (Filtr + Kombinezon), nie własnego, nowego przedmiotu ze sklepu - to
    // naturalna "strefa endgame'owa": kto już ma pełną ochronę na B i C
    // (albo Osłony ze statku, sprawdzone wyżej), automatycznie odblokowuje
    // sobie D, zero dodatkowego zakupu do zaprojektowania/wybalansowania.
    if (zone === 'D') return eco.hasUpgrade('toxic_filter') && eco.hasUpgrade('radiation_suit');
    return true;
  }

  /**
   * Usuwa wszystkie nasluchiwacze podpiete pod window/canvas. Przydatne przy
   * restarcie gry / tworzeniu nowej instancji, zeby nie zostawiac "wiszacych"
   * listenerow (wyciek pamieci) po starej instancji PlayerController.
   */
  destroy() {
    this.canvas.removeEventListener('mousedown', this._onMouseDown);
    window.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('mouseup', this._onMouseUp);

    this.canvas.removeEventListener('touchstart', this._onTouchStart);
    window.removeEventListener('touchmove', this._onTouchMove);
    window.removeEventListener('touchend', this._onTouchEnd);
    window.removeEventListener('touchcancel', this._onTouchEnd);

    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
  }
}

window.PlayerController = PlayerController;