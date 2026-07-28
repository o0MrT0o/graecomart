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

const JOYSTICK_KNOB_DIAMETER = 50; // px - wygląd wewnętrznego "drążka"
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

// Ścieżka do sprite'a postaci (CC0, Kenney Platformer Pack - wariant niebieski).
// Umieść plik pod tą ścieżką względem index.html: assets/player.png
// BUGFIX: był 'assets/player.png' - taki folder nie istnieje w projekcie,
// plik leży płasko jako player.png (ten sam bug co w sprites.js). Postać
// od początku renderowała się więc proceduralnie (_drawProcedural), nigdy
// prawdziwym sprite'em.
// Lista kandydatur zamiast jednej sztywnej ścieżki - nie wiemy na pewno,
// czy pliki leżą płasko obok index.html, czy w assets/, więc próbujemy obu
// (patrz _loadImageWithFallbacks niżej) zamiast zgadywać i psuć jedno na
// rzecz drugiego, jak to już raz wyszło.
const PLAYER_SPRITE_CANDIDATES = ['player.png', 'assets/player.png'];
// Spritesheet animacji chodzenia (ta sama postać, 11 klatek w poziomym pasku,
// każda klatka to jednolity "stage" 71x95 - wyrównany tak, żeby stopy nie
// skakały przy zmianie klatek). Umieść plik pod tą ścieżką: assets/player_walk.png
const PLAYER_WALK_SPRITE_CANDIDATES = ['player_walk.png', 'assets/player_walk.png'];
const PLAYER_WALK_FRAME_COUNT = 11;
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
    // spritesReady - rozwiązuje się gdy OBA obrazki skończą próby wczytania
    // (sukces LUB ostateczna porażka - i tak mamy fallback proceduralny),
    // czytane przez main.js do ukrycia ekranu ładowania (patrz game.assetsReady).
    let resolveSpriteReady, resolveWalkReady;
    this.spritesReady = Promise.all([
      new Promise((resolve) => { resolveSpriteReady = resolve; }),
      new Promise((resolve) => { resolveWalkReady = resolve; }),
    ]);

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

    if (createdBase) {
      const baseDiameter = this.joystickRadius * 2;
      Object.assign(base.style, {
        width: `${baseDiameter}px`,
        height: `${baseDiameter}px`,
        marginLeft: `${-baseDiameter / 2}px`,
        marginTop: `${-baseDiameter / 2}px`,
        borderRadius: '50%',
        background: 'rgba(255, 255, 255, 0.15)',
        border: '2px solid rgba(255, 255, 255, 0.4)'
      });
    }
    if (createdKnob) {
      Object.assign(knob.style, {
        width: `${JOYSTICK_KNOB_DIAMETER}px`,
        height: `${JOYSTICK_KNOB_DIAMETER}px`,
        marginLeft: `${-JOYSTICK_KNOB_DIAMETER / 2}px`,
        marginTop: `${-JOYSTICK_KNOB_DIAMETER / 2}px`,
        borderRadius: '50%',
        background: 'rgba(255, 255, 255, 0.5)'
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
        const zoneWarnings = {
          B: '⚠️ Strefa Skażenia - bez Filtra Toksyn stracisz przedmiot!',
          C: '⚠️ Strefa Atomowa - bez Kombinezonu Radiacyjnego stracisz przedmiot!',
          D: '⚠️ Kryształowa Grań - potrzebujesz Filtra I Kombinezonu naraz!'
        };
        // BUGFIX: brak jawnego x/y powodował, że popup renderował się w
        // stałym punkcie ŚWIATA (fallback w gamefeel.js), a nie nad graczem
        // - w praktyce gdziekolwiek ten punkt akurat wypadał względem
        // kamery, kompletnie niezależnie od tego, w której strefie i nad
        // jakim biomem gracz faktycznie stał. Stąd wrażenie "Strefa Skażenia
        // wyświetla się nad ash" - tekst i tak nie miał związku z pozycją
        // gracza. y - 70, żeby popup wystartował nad głową, nie na twarzy.
        Bus.publish(Events.FX_POPUP, {
          text: zoneWarnings[this.currentZone] || '⚠️ Strefa niebezpieczna',
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
    const niceName = (meta && meta.name) || 'przedmiot';

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
    Bus.publish(Events.FX_POPUP, {
      text: `💢 Zgubiono: ${item.label || ''} ${niceName}`.trim(),
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
   * Który z 11 kadrów assets/player_walk.png jest teraz pokazywany - ta sama
   * faza co bujanie (Math.sin(this.walkCycle) w update()), znormalizowana do
   * 0..1 na pełnym okresie 2*PI i zmapowana na klatki. Wspólne dla
   * _drawSprite (który kadr narysować) i _drawBoots (gdzie dokładnie leżą
   * stopy W TYM kadrze, patrz PLAYER_WALK_LEG_FRAMES) - muszą zawsze
   * wskazywać na TEN SAM kadr, inaczej buty znowu rozjadą się z nogami.
   */
  _currentWalkFrameIndex() {
    const phase = (this.walkCycle % (Math.PI * 2)) / (Math.PI * 2);
    return Math.floor(phase * PLAYER_WALK_FRAME_COUNT) % PLAYER_WALK_FRAME_COUNT;
  }

  /**
   * Faktyczna narysowana szerokość/wysokość sprite'a (px) - DOKŁADNIE to,
   * czego _drawSprite użyje w TEJ klatce (ten sam obrazek, ten sam
   * naturalRatio). Gear liczony z osobnej stałej (this.radius, parametr
   * gry do kolizji/cienia - NIE rozmiar narysowanej postaci) zawsze wychodził
   * za mały ("filtr za mały" mimo kolejnych podbić mnożnika) - maska/buty
   * teraz skalują się względem TEGO SAMEGO rozmiaru co realnie widoczna
   * sylwetka, więc rosną/maleją razem z nią zamiast osobno zgadywać.
   */
  _getSpriteDrawSize() {
    let naturalRatio = 66 / 92; // domyslne proporcje sprite'a, zanim jakikolwiek obrazek zdazy sie wczytac
    if (this._spriteLoaded) {
      const useWalk = this.isMoving && this._walkLoaded;
      naturalRatio = useWalk
        ? (this._walkImg.naturalWidth / PLAYER_WALK_FRAME_COUNT) / this._walkImg.naturalHeight
        : this._spriteImg.naturalWidth / this._spriteImg.naturalHeight;
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
    // Kask NAD maską (patrz _drawHelmet - podniesiony ponad nią), plecak Z
    // BOKU torsu, buty PRZY stopach - żaden z pięciu możliwych gearów
    // (plecak/kask/maska/pasy/buty) nie nakłada się na inny.
    if (eco.hasUpgrade('headlamp')) {
      this._drawHelmet(ctx2, this._getBodyPointY(0));
    }
    if (eco.upgradeLevels && eco.upgradeLevels.capacity > 0) {
      this._drawBackpack(ctx2, this._getBodyPointY(0.47), eco.upgradeLevels.capacity);
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
   * mieścił się CAŁKOWICIE w cieniu korpusu i nigdy nie było go widać.
   * Teraz rysowany PO sylwetce (jak reszta gearu), przesunięty WYRAŹNIE w
   * bok od środka - zawsze w pełni widoczny, niezależnie od dokładnej
   * szerokości aktywnej ścieżki rysowania (sprite/procedural), z cienkim
   * "paskiem" łączącym go wizualnie z plecami zamiast wyglądać jak osobny,
   * oderwany obiekt.
   */
  _drawBackpack(ctx2, bodyTopY, level) {
    const growth = 1 + (level - 1) * 0.12; // 5 poziomów: 1.0 .. ~1.48
    const w = this.radius * 0.5 * growth;
    const h = this.radius * 0.8 * growth;
    const x = this.radius * 1.05;
    const y = bodyTopY + h * 0.3;

    ctx2.save();

    ctx2.strokeStyle = 'rgba(0, 0, 0, 0.35)';
    ctx2.lineWidth = 2;
    ctx2.beginPath();
    ctx2.moveTo(x - w / 2, y);
    ctx2.lineTo(0, bodyTopY + h * 0.15);
    ctx2.stroke();

    ctx2.fillStyle = '#5D4037';
    ctx2.strokeStyle = 'rgba(0, 0, 0, 0.4)';
    ctx2.lineWidth = 1.3;
    this._roundRect(ctx2, x - w / 2, y - h / 2, w, h, w * 0.3);
    ctx2.fill();
    ctx2.stroke();

    // Klapa u góry - drobny detal, żeby czytało się jako plecak, nie po
    // prostu ciemny prostokąt przy boku.
    ctx2.fillStyle = '#4E342E';
    this._roundRect(ctx2, x - w * 0.36, y - h / 2 - h * 0.14, w * 0.72, h * 0.3, w * 0.16);
    ctx2.fill();

    ctx2.restore();
  }

  /**
   * "Kask z Latarką" (sklep) - kopuła nad głową + pulsująca lampka na czole.
   * Zakotwiczony DOKŁADNIE na czubku głowy (fraction=0, patrz
   * _getBodyPointY) - kopuła i tak rysuje się w górę od tego punktu
   * (arc od PI do 0 = górna połówka), więc wizualnie "siedzi" na czubku,
   * wyraźnie nad maską na twarzy (fraction=0.28) - zero kolizji.
   */
  _drawHelmet(ctx2, topY) {
    const r = this.radius * 0.62;

    ctx2.save();
    ctx2.translate(0, topY);

    ctx2.fillStyle = '#FFB300';
    ctx2.strokeStyle = 'rgba(0, 0, 0, 0.4)';
    ctx2.lineWidth = 1.3;
    ctx2.beginPath();
    ctx2.arc(0, 0, r, Math.PI, 0);
    ctx2.lineTo(r, r * 0.22);
    ctx2.lineTo(-r, r * 0.22);
    ctx2.closePath();
    ctx2.fill();
    ctx2.stroke();

    ctx2.fillStyle = 'rgba(93, 64, 55, 0.5)';
    ctx2.fillRect(-r, r * 0.05, r * 2, r * 0.17);

    // Lampka - pulsuje, żeby czytała się jako WŁĄCZONA, nie naklejka.
    const pulse = 0.55 + 0.45 * Math.sin(performance.now() / 260);
    ctx2.save();
    ctx2.globalAlpha = pulse;
    ctx2.fillStyle = '#FFF9C4';
    ctx2.beginPath();
    ctx2.arc(0, -r * 0.15, r * 0.22, 0, Math.PI * 2);
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
   * W bezruchu (statyczny assets/player.png - okrągła sylwetka BEZ osobno
   * narysowanych nóg) nie ma do czego się dopasować, więc buty stoją w
   * stałym, domyślnym rozstawie przy podstawie sylwetki.
   */
  _drawBoots(ctx2) {
    const footY = this.radius * 0.8;
    const bootW = this.radius * 0.4;
    const bootH = this.radius * 0.32;

    const useWalk = this.isMoving && this._walkLoaded && this._spriteLoaded;
    let leftX, rightX, groundY;

    if (useWalk) {
      const frame = PLAYER_WALK_LEG_FRAMES[this._currentWalkFrameIndex()];
      const { w, h } = this._getSpriteDrawSize();
      leftX = (frame.leftFrac - 0.5) * w;
      rightX = (frame.rightFrac - 0.5) * w;
      groundY = footY - h * (1 - frame.footFrac);
    } else {
      const spread = this.radius * 0.42;
      leftX = -spread;
      rightX = spread;
      groundY = footY;
    }

    ctx2.save();
    ctx2.fillStyle = '#F9A825';
    ctx2.strokeStyle = 'rgba(0, 0, 0, 0.4)';
    ctx2.lineWidth = 1.2;
    [leftX, rightX].forEach((dx) => {
      this._roundRect(ctx2, dx - bootW / 2, groundY - bootH * 0.7, bootW, bootH, bootW * 0.3);
      ctx2.fill();
      ctx2.stroke();
    });
    ctx2.restore();
  }

  /** Pasy bezpieczeństwa w poprzek torsu - prosty, czytelny sygnał
   * "wyposażenie ochronne" bez przerabiania całej sylwetki gracza. */
  _drawHazmatTrim(ctx2, bodyY) {
    const w = this.radius * 1.3;
    ctx2.save();
    ctx2.fillStyle = '#FFB300';
    ctx2.fillRect(-w / 2, bodyY, w, 5);
    ctx2.fillStyle = 'rgba(33, 33, 33, 0.6)';
    ctx2.fillRect(-w / 2, bodyY + 5, w, 2);
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
  _drawGasMask(ctx2, headCenterY) {
    const { w, h } = this._getSpriteDrawSize();
    const rx = w * 0.46;
    const ry = h * 0.32;
    const cy = ry * 0.1;

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
    const img = useWalk ? this._walkImg : this._spriteImg;

    let sx = 0;
    let sy = 0;
    let sw = img.naturalWidth || 66;
    let sh = img.naturalHeight || 92;

    if (useWalk) {
      sw = img.naturalWidth / PLAYER_WALK_FRAME_COUNT;
      sh = img.naturalHeight;
      sx = this._currentWalkFrameIndex() * sw;
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

  /**
   * Oryginalne rysowanie proceduralne (zaokraglony prostokat + glowa + oczy).
   * Uzywane dopoki assets/player.png sie nie wczyta albo gdyby wczytanie
   * sie nie udalo - gra NIGDY nie zostaje bez widocznej postaci.
   */
  _drawProcedural(ctx2) {
    // Cialo (zaokraglony prostokat) - Squash & Stretch.
    const w = (this.radius * 1.4) / this.bodySquash;
    const h = this.radius * 2 * this.bodySquash;
    ctx2.fillStyle = '#5C85D6'; // niebieski kombinezon
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