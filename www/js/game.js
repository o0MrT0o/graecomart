'use strict';

/**
 * game.js
 * ------------------------------------------------------------------------
 * Główny koordynator gry "Eco Mart Arcade Idle".
 *
 * Game NIE tworzy instancji innych modułów (Economy, ItemManager,
 * MachineManager, StackController, PlayerController, UIManager,
 * SaveManager, GameFeel) - robi to main.js. Game odpowiada wyłącznie za:
 *   - pętlę gry (requestAnimationFrame + update/draw),
 *   - JEDEN canvas, rysowany w trzech logicznych fazach (background / gameplay / ui),
 *   - KAMERĘ: świat (GAME_WORLD_WIDTH x GAME_WORLD_HEIGHT) jest większy niż widoczny
 *     ekran, kamera śledzi gracza i pokazuje tylko fragment świata,
 *   - wspólny stan gry (pieniądze, wielkość stosu) na podstawie zdarzeń z Bus,
 *   - efekt screen shake.
 *
 * BUGFIX (przycinanie/lag, "za mała gra żeby tak zacinało"): było TRZY osobne
 * elementy <canvas> (background/gameplay/ui), każdy czyszczony i W CAŁOŚCI
 * przerysowywany co klatkę - a XADEN z nich nigdy nie korzystał z tego, że
 * mógłby zostać nietknięty (zero logiki "przerysuj tylko UI, zostaw tło").
 * Pełny trace wydajności Chrome (Tracing.start z kategorią devtools.timeline,
 * nie tylko profil JS) pokazał, że ~57% czasu KAŻDEJ klatki szło w
 * CanvasResourceProviderSharedImage::ProduceCanvasResource - wewnętrzny koszt
 * Chromium "sfinalizowania" zawartości canvasu do kompozycji na ekranie,
 * płacony OSOBNO za KAŻDY canvas. Przy trzech canvasach płaciliśmy go
 * trzykrotnie za KAŻDĄ klatkę, bez żadnej korzyści w zamian (skoro i tak
 * wszystkie trzy są czyszczone/przerysowywane razem). Teraz JEDEN element
 * <canvas>, a "warstwy" to już tylko KOLEJNOŚĆ rysowania na tym samym
 * kontekście (tło -> gameplay -> UI, dokładnie ta sama kolejność co
 * dawniej - z-order canvasu i tak już był ustalany przez kolejność
 * rysowania, nie przez osobne elementy). this.canvasBackground/canvasGameplay/
 * canvasUI i this.ctxBackground/ctxGameplay/ctxUI ZOSTAJĄ jako osobne pola
 * (żeby nie dotykać dziesiątek miejsc w tym pliku, które się do nich
 * odwołują) - wszystkie trzy wskazują teraz na TEN SAM element/kontekst.
 *
 * WAŻNE (świat > ekran): canvas.width/height to rozmiar EKRANU (viewportu),
 * NIE świata. Inne moduły (player.js, items.js, machines.js, market.js)
 * pozycjonują się względem GAME_WORLD_WIDTH/GAME_WORLD_HEIGHT (swoje własne kopie tych
 * stałych - konwencja projektu, brak współdzielonych utili), a Game
 * przesuwa cały widok (ctx.translate(-cameraX, -cameraY)) tak, żeby gracz
 * zawsze widniał na środku ekranu. Żaden inny moduł nie musi nic wiedzieć
 * o kamerze - rysuje tak jak zawsze, we współrzędnych świata.
 *
 * Tło rysowane jest jako powtarzalne tekstury terenu (CC0, Kenney RPG pack),
 * po jednej na strefę, z pofalowanymi i miękko wtapianymi granicami biomów
 * (patrz _buildBiomeEdgePaths / _drawBackground). Dopóki dany obrazek się nie
 * wczyta (albo gdyby się nie udało), jego strefa rysowana jest jednolitym
 * kolorem awaryjnym, więc gra nigdy nie zostaje z pustym/czarnym tłem.
 *
 * Zależności globalne (muszą być załadowane przed tym plikiem):
 *   - window.Bus     (EventBus: subscribe(name, cb) / publish(name, data))
 *   - window.Events  (stałe nazwy zdarzeń, np. Events.MONEY_COLLECTED)
 *   - window.playerController (odczyt .x/.y do sterowania kamerą - opcjonalne,
 *      dopóki nie istnieje, kamera stoi na środku świata)
 *
 * Przykładowy HTML (dopasuj ID w CANVAS_ID poniżej, jeśli Twój jest inny):
 *   <canvas id="layer-gameplay"></canvas>
 * ID celowo 'layer-gameplay' (nie coś neutralnego) - player.js wiesza na
 * tym elemencie nasłuchy dotyku/myszy (patrz komentarz w player.js).
 */
const CANVAS_ID = 'layer-gameplay';

// --- Świat (Faza 2b: mapa większa niż ekran) --------------------------------
// Stałe, NIEZALEŻNE od rozmiaru okna/ekranu - w przeciwieństwie do
// canvas.width/height (viewport), te wymiary się nie zmieniają przy resize.
// Te same wartości żyją też w player.js/items.js/ambient.js (świat + Strefa
// D); machines.js/market.js/ship.js/minimap.js/critters.js CELOWO NIE mają
// swojej kopii zaktualizowanej - patrz GAME_ZONE_CORE_WIDTH niżej.
//
// 1750, było 1400 - dołożone 350px z PRAWEJ strony WYŁĄCZNIE pod Strefę D
// (Kryształową Grań), żeby przestała dzielić kąt mapy z C/B (patrz historia
// przy GAME_ZONE_CORE_WIDTH) i stała się osobnym pasem po prawej stronie.
const GAME_WORLD_WIDTH = 1750;
const GAME_WORLD_HEIGHT = 2000;
// Jak szybko kamera "dogania" gracza (0..1, wyższe = mniej bezwładności).
const CAMERA_SMOOTHING = 0.15;

// Maksymalny "skok" delta (ms) dopuszczony w jednej klatce - chroni przed
// jednorazowym dużym skokiem po powrocie z zminimalizowanej karty/aplikacji.
const MAX_DELTA_MS = 100;

// Ścieżka do tekstury trawy (CC0, Kenney RPG pack). Umieść plik pod tą
// ścieżką względem index.html: assets/grass.png
const GRASS_TEXTURE_SRC = 'assets/grass.png';
// Tekstury stref B/C (ta sama technika co grass.png - duży, wewnętrznie
// zróżnicowany kafelek z Kenney RPG pack, tylko inne kafelki źródłowe +
// zabarwienie tematyczne). Zastępują dawną "przebarwioną trawę".
const ASH_TEXTURE_SRC = 'assets/ash.png';
const SWAMP_TEXTURE_SRC = 'assets/swamp.png';

// Dekoracje - czysto wizualne, nieinteraktywne obiekty rozrzucone po mapie.
// Dwie kategorie:
//  - SPRITE'OWE (CC0, Kenney RPG pack + Platformer Pack Remastered dla
//    crate/sign) - tree/bush/rock/shrub/crate/sign, wczytywane jako obrazki
//    (patrz _decorImages w konstruktorze).
//  - PROCEDURALNE (flower/puddle) - żadnego pliku PNG w projekcie, rysowane
//    wprost Canvasem (patrz _drawProceduralDecor niżej) - ten sam duch co
//    ItemRenderer._drawIngot (items.js) dla stopu bez sprite'a: prosty,
//    rozpoznawalny kształt zamiast pustego miejsca albo emoji.
// crate/sign zastąpiły dawny procedural 'barrel' (Strefa C, industrialna) -
// ręcznie rysowana beczka (gradient + żółto-czarny pas) wyglądała jak
// "sprzed reskinu" obok prawdziwych sprite'ów reszty dekoracji. boxCrate_
// double.png/sign.png (Kenney Platformer Pack Remastered, CC0) są rysowane
// z góry na wprost (nie w 3/4 jak beczka), ale ten sam "billboard" sposób
// stawiania płaskiej grafiki pionowo już i tak używają tree/bush/rock -
// żadna z tych dekoracji naprawdę nie jest renderowana "z lotu ptaka".
// grass_tuft/fern (Strefa A) - Kenney Foliage Sprites (CC0), oryginalnie
// białe/tintowalne sylwetki (jak .ui-icon w ui.js) - ale zamiast maski CSS w
// locie, tu wstępnie potintowane OFFLINE (skrypt Python, gradient
// hi->mid->lo tymi samymi trzema odcieniami zieleni co canopy tree.png:
// #8FB01B/#769413/#5A700E) i zapisane jako gotowe PNG, bo pozostałe typy
// sprite'owe (tree/bush/rock/shrub/crate/sign) też są "martwymi" bitmapami w
// natywnym kolorze, nie tintowanymi w locie - runtime tinting (source-atop,
// jak _getTintedFx w machines.js) byłby tu nową, niepotrzebną infrastrukturą.
const DECOR_TYPES = ['tree', 'bush', 'rock', 'shrub', 'crate', 'sign', 'grass_tuft', 'fern'];
const DECOR_SRC = {
  tree: 'assets/decor/tree.png',
  bush: 'assets/decor/bush.png',
  rock: 'assets/decor/rock.png',
  shrub: 'assets/decor/shrub.png',
  crate: 'assets/decor/crate.png',
  sign: 'assets/decor/sign.png',
  grass_tuft: 'assets/decor/grass_tuft.png',
  fern: 'assets/decor/fern.png'
};
const DECOR_PROCEDURAL_TYPES = ['flower', 'puddle'];
// Ile dekoracji rozrzucamy łącznie po całej mapie. Podniesione z 55 - przy
// świecie 1400x2000 to zostawiało spore puste połacie ("nudna, pusta mapa").
// 175, było 140 - poszerzenie mapy pod Strefę D (GAME_WORLD_WIDTH) podniosło
// całkowitą powierzchnię o ~25%, ta sama proporcja utrzymuje poprzednią
// gęstość zamiast rozrzedzać dekoracje na nowym pasie.
// Nadal tanie: _drawDecorations przycina do widoku (+margines), więc koszt
// per klatka zależy od tego, ile się faktycznie mieści na ekranie, nie od
// tej liczby.
const DECOR_COUNT = 175;
// Docelowa wysokość rysowanej dekoracji (px) - szerokość liczona proporcjonalnie.
const DECOR_BASE_HEIGHT = 58;
// Mnożnik zależny od typu - w rzeczywistości drzewo jest wyraźnie większe od
// krzewinki. Bez tego wszystkie typy skalowały się tak samo, więc mała,
// beztrzonowa krzewinka (shrub) mogła wyglądać jak "ucięte drzewo" zamiast
// czytelnie mniejszego, osobnego elementu.
// BALANS: tree 2.0->2.8 (za małe, miały nie wyglądać na "krzaki z pretensjami"),
// rock 0.5->0.7 (był NAJMNIEJSZYM typem, mniejszym nawet od shrub - przy tak
// małej skali każdy px niedopasowania cienia był proporcjonalnie ogromny,
// stąd m.in. wrażenie "latania" - patrz też fix cienia w _drawDecorations niżej).
const DECOR_TYPE_SCALE = {
  tree: 2.8,
  bush: 1.1,
  shrub: 0.65,
  rock: 0.7,
  // BUGFIX ("kwiatów nie widzę"): było 0.5 - w połączeniu z małym bazowym
  // rozmiarem w _drawFlowerDecor kwiatek ginął w gęstej teksturze trawy.
  // Podniesione razem z powiększeniem bazowego rozmiaru tam (patrz komentarz
  // przy _drawFlowerDecor).
  flower: 1,
  puddle: 1.6,
  crystal: 1.1,
  // Oba źródłowo 128x128 (kwadrat) - skala dobrana wizualnie względem
  // sąsiadów w Strefie C: skrzynia ma czytać się jako podobnej "wagi" co
  // kamień, tabliczka trochę smuklej (węższy słupek, nie chcemy kwadratowej
  // bryły).
  crate: 0.85,
  sign: 0.95,
  // Niskie naziemne akcenty (Strefa A) - mniejsze niż shrub (0.65), żeby nie
  // konkurowały z krzewinką o "wagę", tylko wypełniały puste kępki trawy.
  grass_tuft: 0.55,
  fern: 0.6
};
// Stały "seed" losowania rozrzutu - te same dekoracje w tym samym miejscu
// za każdym wczytaniem strony (nie generujemy losowo od nowa co reload).
const DECOR_SEED = 20260711;

// Delikatne kołysanie na wietrze dla organicznych sprite'owych typów
// (drzewo/krzak/krzewinka) - NIE dla kamienia (ten nie powinien "żyć").
// Faza liczona z pozycji X (patrz _drawDecorations), nie losowo per obiekt -
// dzięki temu podmuch wygląda jak fala PRZECHODZĄCA przez mapę, a nie jak
// niezależne drganie każdej rośliny z osobna. Kwiat (procedural) ma tę samą
// falę wbudowaną bezpośrednio w _drawFlowerDecor.
const DECOR_SWAY_TYPES = ['tree', 'bush', 'shrub', 'grass_tuft', 'fern'];
const DECOR_SWAY_AMPLITUDE = 0.035;
const DECOR_SWAY_SPEED = 1.1;

// BUGFIX ("krzaki wyglądają jakby latały"): bush.png/shrub.png mają kilka
// px PRZEZROCZYSTEGO marginesu POD właściwą grafiką (zmierzone wprost z
// plików: bush ~7% wysokości, shrub ~10% - Kenney pack, prawdopodobnie
// wyrównanie do wspólnej siatki kafelków). Przy zwykłym bottom-align
// (obraz.y+wysokość = d.y) ten margines zostawiał widoczną szczelinę
// między krzakiem a jego własnym cieniem - wyglądało jak unoszenie się nad
// ziemią. tree.png/rock.png nie mają tego problemu (zmierzone ~100%
// wypełnienia), stąd brak wpisu = 0 = bez zmian. Wartość = ułamek
// wysokości, o jaki dosuwamy sprite W DÓŁ względem cienia.
const DECOR_GROUND_OFFSET = {
  bush: 0.07,
  shrub: 0.1
};

// --- Cienie chmur (żywe niebo) ------------------------------------------
// Kilka wielkich, bardzo miękkich plam wolno przesuwających się nad całą
// mapą (jak cień chmury sunący po ziemi) - tani sposób na "żywe niebo" bez
// prawdziwej warstwy chmur/nieba. Patrz _generateCloudShadows/_drawCloudShadows.
const CLOUD_SHADOW_COUNT = 6;
const CLOUD_SHADOW_RADIUS = 380;
// Stały górny limit rozdzielczości ŹRÓDŁOWEJ tekstury chmury (px), niezależny
// od promienia na ekranie - patrz obszerny komentarz w _bakeCloudTexture.
// Kształt jest miękki/rozmyty, więc powiększenie przy rysowaniu nie jest
// widoczne, a próbkowanie mniejszego źródła jest dużo tańsze.
const CLOUD_SHADOW_BAKE_SIZE = 320;
// BUGFIX ("nie widzę cieni chmur"): było 0.09 - w połączeniu z bardzo miękkim
// gradientem (jedna warstwa środek->przezroczysty) i kolorowym, szczegółowym
// tłem (trawa/popiół/bagno) efekt był praktycznie niewidoczny. Podniesione,
// plus gradient niżej (_drawCloudShadows) ma teraz PLATEAU zamiast czystego
// stożka, żeby środek plamy faktycznie czytał się jako cień, nie tylko
// punktowy "hot-spot".
const CLOUD_SHADOW_ALPHA = 0.24;
// Px/s - było 6 (przy promieniu 420 pełne przejście własnej średnicy trwało
// >2 minuty, w praktyce niezauważalne w krótkiej sesji). Nadal wolno/ambientowo,
// ale teraz widać RUCH w ciągu minuty gry, nie tylko samą plamę.
const CLOUD_SHADOW_SPEED = 18;

// --- Strefy mapy (Faza 2) ---------------------------------------------------
// Te same progi co w items.js (spawn surowców) i player.js (hazard) - patrz
// komentarz tam. Tutaj używane tylko do narysowania mgły/popiołu na tle.
// Liczone teraz względem GAME_WORLD_WIDTH/HEIGHT, nie względem ekranu.
const GAME_ZONE_C_TOP_RATIO = 0.32;
const GAME_ZONE_B_RIGHT_RATIO = 0.62;

// Strefa D (Kryształowa Grań) - NIEZALEŻNY pas na CAŁEJ wysokości mapy, na
// prawo od "rdzenia" (Stref A/B/C), zamiast dawnego wcinającego się rogu.
//
// BYŁO (dwie wersje wstecz): D dzieliło kąt mapy z C i B (własny lewy+dolny
// próg WEWNĄTRZ starej szerokości 1400) - graniczyło z obiema naraz, więc
// każda zmiana C/B musiała pamiętać o omijaniu jego rogu (patrz historia w
// _getZoneBounds w items.js). Czytało się jako "kawałek odgryziony od
// sąsiadów", nie jako osobne miejsce.
//
// TERAZ: mapa jest PoszerzONA o GAME_ZONE_CORE_WIDTH...GAME_WORLD_WIDTH -
// ten cały nowy pas z prawej strony należy WYŁĄCZNIE do D, na pełnej
// wysokości. GAME_ZONE_CORE_WIDTH to STARA szerokość świata (sprzed
// poszerzenia) - A/B/C oraz WSZYSTKIE pozycje maszyn/statku/targu nadal
// liczą się względem NIEJ (nie GAME_WORLD_WIDTH), więc poszerzenie mapy pod
// Grań w ogóle ich nie rusza - C i B odzyskują swoje pełne, nieokrojone
// prostokąty sprzed istnienia D. Brak już osobnego progu dolnego (jak dawne
// GAME_ZONE_D_BOTTOM_RATIO) - Grań nie dzieli miejsca z nikim, więc nie
// trzeba jej niczego zostawiać/omijać w pionie.
const GAME_ZONE_CORE_WIDTH = 1400;
// Dystans (px), na jakim _drawZoneTint płynnie przechodzi między kolorem
// nastrojowym stref - patrz _getZoneBlend.
const GAME_ZONE_TINT_FADE = 260;

// --- Jakość renderowania (dawniej "adaptacyjna", patrz _trackPerformance) ---
// BUGFIX ("20 FPS i słaba rozdzielczość", "usuń to zmniejszenie rozdzielczości
// bo to nie działa"): adaptacyjne obniżanie dpr (Faza wydajności, kilka
// poprzednich BUGFIXów) zakładało, że wąskim gardłem jest liczba pikseli do
// wypełnienia - to prawda TYLKO gdy fill-rate faktycznie jest wąskim gardłem.
// Realny test na telefonie pokazał, że NIE jest: FPS nie poprawiał się mimo
// widocznego spadku ostrości, więc mechanizm płacił kosztem jakości obrazu
// bez żadnej korzyści. Jedna wartość, nie tablica kroków - dpr jest teraz
// STAŁY, nigdy się nie obniża w trakcie gry. _trackPerformance() (niżej)
// zostaje w kodzie, ale jest martwy: _qualityLevel jest zawsze 0, czyli
// zarazem "już na dole" tablicy jednoelementowej, więc jego pierwszy warunek
// (`if (this._qualityLevel <= 0) return;`) ucina go na starcie każdego
// wywołania - zero pomiarów, zero decyzji, zero efektu.
//
// 1.5, nie oryginalne 2.0 - to JEDYNA pozostałość po poprzednim mechanizmie:
// czysty koszt canvasu rośnie z KWADRATEM dpr (2x to 4x pikseli względem 1x),
// a różnica ostrości 1.5x->2.0x na ekranie telefonu jest ledwie zauważalna -
// to nie jest "zmniejszenie", tylko rezygnacja z najdroższego wariantu,
// którego i tak nie widać.
//
const GAME_QUALITY_DPR_STEPS = [1.5];
// Poniższe trzy stałe są teraz MARTWE (_trackPerformance nigdy do nich nie
// dociera - patrz komentarz przy GAME_QUALITY_DPR_STEPS) - zostawione tylko
// dlatego, że _trackPerformance() jako metoda wciąż istnieje w kodzie
// (świadomie nie usunięta - patrz jej nagłówek) i formalnie ich używa.
const GAME_PERF_WARMUP_FRAMES = 10;
const GAME_PERF_SAMPLE_SIZE = 20;
const GAME_PERF_BUDGET_MS = 22;

// --- Granice biomów (miękkie przejścia) --------------------------------------
// Zamiast prostych cięć (ctx.rect) granice stref są lekko pofalowane
// (deterministycznie - suma dwóch sinusów, zero losowości) i wtapiane
// w sąsiada pasami o rosnącej przezroczystości. LOGIKA stref (spawn w
// items.js, hazard w player.js) nadal używa prostych progów
// GAME_ZONE_*_RATIO - fala to czysto wizualne +-GAME_BIOME_EDGE_AMPLITUDE px
// wokół tej samej linii, a pas przejściowy i tak komunikuje "tu zmienia się
// teren", więc ten rozjazd jest w praktyce niezauważalny.
const GAME_BIOME_EDGE_AMPLITUDE = 20;
// Co ile px próbkujemy falę przy budowie ścieżki granicy (mniejszy krok =
// gładsza linia; 18 px w zupełności wystarcza przy tych długościach fal).
const GAME_BIOME_EDGE_STEP = 18;
// O ile Strefa B zaczyna się WYŻEJ niż prosty próg topH. Ten pas i tak
// przykrywa z wierzchu lita Strefa C (jej fala sięga najniżej topH-20),
// dzięki czemu w narożniku styku B/C nie zostaje szpara z trawą, a popiół
// naturalnie "nachodzi" na bagno.
const GAME_ZONE_B_TOP_BLEED = 60;
// Pasy wtapiania: od NAJSZERSZEGO i najbledszego do litego rdzenia.
// Kolejność MA znaczenie - rysujemy po kolei, każdy następny na poprzednim
// (kumulacja alpha daje rampę ~0.28 / ~0.64 / 1.0).
// offset = o ile px pas wchodzi w głąb sąsiedniej strefy.
const GAME_BIOME_BLEND_STEPS = [
  { offset: 26, alpha: 0.28 },
  { offset: 13, alpha: 0.5 },
  { offset: 0, alpha: 1 }
];

class Game {
  constructor() {
    // --- Canvas i kontekst 2D ------------------------------------------
    // JEDEN element/kontekst pod trzema nazwami - patrz obszerny komentarz w
    // nagłówku pliku (BUGFIX przycinania/laga). Nic poniżej w tym pliku nie
    // musiało się zmienić poza TYM przypisaniem: this.ctxBackground.save()
    // i this.ctxUI.fillRect(...) nadal działają identycznie, bo to
    // dosłownie ten sam obiekt CanvasRenderingContext2D pod trzema polami.
    const canvas = document.getElementById(CANVAS_ID);

    if (!canvas) {
      console.error(
        `[Game] Brakuje elementu <canvas id="${CANVAS_ID}">. Sprawdź stałą CANVAS_ID na górze game.js oraz ID w HTML.`
      );
    }

    const ctx = canvas.getContext('2d', { alpha: true });

    this.canvasBackground = canvas;
    this.canvasGameplay = canvas;
    this.canvasUI = canvas;
    this.ctxBackground = ctx;
    this.ctxGameplay = ctx;
    this.ctxUI = ctx;

    // --- Tekstury terenu (jedna na strefę) + dekoracje --------------------------
    // _loadTexture() to mały, lokalny helper (nie eksportowany) - wspólny kod
    // ładowania obrazka + budowania wzorca powtarzania dla wszystkich trzech
    // tekstur terenu, żeby nie kopiować tego samego onload/onerror 3 razy.
    // Każdy zwraca (oprócz {img,pattern}) .ready - promise rozwiązywany PO
    // wczytaniu (sukces LUB porażka - awaryjny kolor i tak już obsłużony
    // gdzie indziej) - zbierane niżej w this.assetsReady dla ekranu ładowania
    // (patrz main.js).
    const readyPromises = [];

    this._grass = this._loadTexture(GRASS_TEXTURE_SRC);
    this._ash = this._loadTexture(ASH_TEXTURE_SRC);
    this._swamp = this._loadTexture(SWAMP_TEXTURE_SRC);
    readyPromises.push(this._grass.ready, this._ash.ready, this._swamp.ready);

    // Strefa D (Kryształowa Grań) - BRAK pliku PNG w projekcie (jak
    // flower/puddle niżej), więc tekstura terenu jest upieczona
    // proceduralnie NA MIEJSCU (synchronicznie, zero Promise/wczytywania -
    // to zwykły canvas, nie <img>), tym samym wzorcem co pozostałe trzy
    // (pattern do CanvasPattern via createPattern, patrz _fillZoneRegion).
    this._crystalGround = this._bakeCrystalGroundTexture();

    // Dekoracje (drzewa/krzaki/kamienie) - czysto wizualne, nieinteraktywne,
    // rysowane na warstwie tła (więc zawsze POD graczem/przedmiotami/maszynami,
    // bez potrzeby sortowania po Z). Ładujemy jako zwykłe obrazki - jeśli któryś
    // się nie wczyta, po prostu nie rysujemy tego typu (reszta działa normalnie).
    this._decorImages = {};
    DECOR_TYPES.forEach((type) => {
      const img = new Image();
      readyPromises.push(new Promise((resolve) => {
        img.onload = () => resolve();
        img.onerror = () => {
          console.warn(`[Game] Nie udało się wczytać dekoracji ${type} (${DECOR_SRC[type]}).`);
          resolve();
        };
      }));
      img.src = DECOR_SRC[type];
      this._decorImages[type] = img;
    });

    // Ekran ładowania (main.js) czeka na to, ZANIM w ogóle pokaże grę - żeby
    // pierwsza widoczna klatka miała już upieczone tło świata (patrz
    // _bakeWorldBackground) i wszystkie dekoracje, zamiast migotać kolorami
    // awaryjnymi przez ułamek sekundy.
    this.assetsReady = Promise.all(readyPromises);

    // --- Świat i kamera (Faza 2b) ---------------------------------------------
    this.worldWidth = GAME_WORLD_WIDTH;
    this.worldHeight = GAME_WORLD_HEIGHT;
    this.cameraX = (GAME_WORLD_WIDTH - window.innerWidth) / 2;
    this.cameraY = (GAME_WORLD_HEIGHT - window.innerHeight) / 2;

    // Rozrzut dekoracji wygenerowany RAZ, deterministycznie (patrz
    // _generateDecorations) - te same drzewa/kamienie w tym samym miejscu za
    // każdym razem, nie losowe od nowa przy każdym wczytaniu strony.
    this._decorations = this._generateDecorations();
    // Cienie chmur - pozycje/prędkości startowe wygenerowane RAZ, ruch sam w
    // sobie liczony w _drawCloudShadows z performance.now().
    this._cloudShadows = this._generateCloudShadows();

    // Pofalowane granice biomów + pasy wtapiania - geometria budowana RAZ
    // (świat ma stały rozmiar), więc w draw() zostaje tylko clip + fill.
    this._buildBiomeEdgePaths();

    // Tło świata (trawa+bagno+popiół z miękkimi granicami) - upieczone RAZ
    // do offscreen canvasu, gdy tylko wszystkie 3 tekstury się wczytają
    // (patrz _drawBackground/_bakeWorldBackground). To był GŁÓWNY winowajca
    // przycinania - patrz obszerny komentarz w _drawBackground.
    this._worldBackgroundCanvas = null;
    this._worldBackgroundBaked = false;

    // --- Moduły gry ---------------------------------------------------------
    // Rejestrowane z zewnątrz (main.js) przez registerModule().
    this.modules = [];

    // --- Wspólny stan gry -----------------------------------------------------
    this.state = {
      running: true,
      money: 0,
      stackSize: 0,
      maxStack: 10
    };

    // --- Screen shake ------------------------------------------------------------
    this.shakeIntensity = 0;
    this.shakeDuration = 0;

    // --- Jakość renderowania (patrz komentarz przy GAME_QUALITY_DPR_STEPS) -----
    // Zawsze najwyższy (jedyny) dostępny poziom - _trackPerformance() już nic
    // nie obniża, patrz komentarz tam.
    this._qualityLevel = GAME_QUALITY_DPR_STEPS.length - 1;
    this._frameSamples = [];
    this._perfWarmupFrames = 0;
    this._firstQualityCheckResolve = null;
    this.firstQualityCheckReady = new Promise((resolve) => {
      this._firstQualityCheckResolve = resolve;
    });
    // Jeden stały poziom jakości - nie ma czego kalibrować, więc rozwiązujemy
    // od razu. Gdyby to zostało puste, main.js/hideLoadingScreenWhenReady
    // czekałoby na coś, co nigdy by nie nadeszło (_trackPerformance() kończy
    // się na pierwszej linii, gdy _qualityLevel <= 0 - nigdy nie dotarłby do
    // miejsca, które normalnie by to rozwiązało), aż do jego 9s limitu -
    // czyli 9 zbędnych sekund na ekranie ładowania przy KAŻDYM uruchomieniu.
    if (GAME_QUALITY_DPR_STEPS.length <= 1) {
      this._firstQualityCheckResolve();
    }

    // --- Timing pętli gry -------------------------------------------------------
    this.lastTimestamp = 0;
    // Zbindowana raz referencja - unikamy tworzenia nowej funkcji co klatkę.
    this._loop = this.loop.bind(this);

    // --- Subskrypcje na globalnym Bus --------------------------------------------
    this._bindEvents();

    // --- Pierwszy resize + nasłuchiwanie zmiany rozmiaru okna ---------------------
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  /**
   * Podpina Game pod globalny event bus.
   */
  _bindEvents() {
    Bus.subscribe(Events.MONEY_COLLECTED, () => {
      if (window.economyManager) {
        this.state.money = window.economyManager.getMoney();
      }
    });

    Bus.subscribe(Events.STACK_ADDED, (data) => {
      this.state.stackSize = (data && data.size) || 0;
    });

    Bus.subscribe(Events.FX_SHAKE, (data) => {
      this.triggerShake(data);
    });
  }

  /**
   * Rejestruje moduł gry. Moduł powinien implementować:
   *   - update(delta)
   *   - draw(ctxBackground, ctxGameplay, ctxUI)
   * Game wywołuje obie metody defensywnie (sprawdza typeof), więc moduł
   * może chwilowo mieć tylko jedną z nich bez błędu - ostrzeżenie w konsoli
   * pomoże jednak wyłapać literówki na wczesnym etapie.
   */
  registerModule(module) {
    const hasUpdate = module && typeof module.update === 'function';
    const hasDraw = module && typeof module.draw === 'function';

    if (!hasUpdate && !hasDraw) {
      console.warn('[Game] Rejestrowany moduł nie ma metod update() ani draw():', module);
    }

    this.modules.push(module);
  }

  /**
   * Startuje pętlę gry.
   */
  start() {
    this.lastTimestamp = performance.now();
    requestAnimationFrame(this._loop);
  }

  /**
   * Główna pętla gry (requestAnimationFrame).
   */
  loop(timestamp) {
    const rawDelta = timestamp - this.lastTimestamp;
    this.lastTimestamp = timestamp;
    const delta = Math.min(rawDelta, MAX_DELTA_MS);

    if (this.state.running) {
      this.update(delta);
    }

    this.draw();

    // Adaptacyjna jakość - MUSI być na końcu klatki (mierzy rawDelta, czyli
    // realny odstęp między klatkami, a nie sam czas naszego kodu).
    this._trackPerformance(rawDelta);

    requestAnimationFrame(this._loop);
  }

  /**
   * MARTWY KOD (świadomie, nie zapomniany) - dawniej automatyczne dostrajanie
   * jakości do wydajności urządzenia, wyłączone na prośbę Toma (patrz
   * komentarz przy GAME_QUALITY_DPR_STEPS): obniżanie dpr nie poprawiało FPS
   * na realnym telefonie, więc mechanizm płacił kosztem ostrości obrazu bez
   * żadnej korzyści. GAME_QUALITY_DPR_STEPS ma teraz jeden element, więc
   * `this._qualityLevel <= 0` poniżej jest PRAWDZIWE od pierwszej klatki -
   * metoda zawsze wychodzi na tej linii, reszta ciała nigdy się nie wykonuje.
   * Zostawiona (nie usunięta) na wypadek, gdyby kiedyś w przyszłości znów
   * była potrzebna - wtedy wystarczy dopisać więcej wartości z powrotem do
   * GAME_QUALITY_DPR_STEPS.
   */
  _trackPerformance(rawDelta) {
    if (this._qualityLevel <= 0) return; // już najniżej - nie ma czego mierzyć
    // Pierwsze klatki po starcie są zawsze wolne (dekodowanie tekstur,
    // pieczenie tła, pierwsze kompilacje) - to NIE jest miara wydajności
    // urządzenia, więc je pomijamy.
    if (this._perfWarmupFrames < GAME_PERF_WARMUP_FRAMES) {
      this._perfWarmupFrames++;
      return;
    }

    this._frameSamples.push(rawDelta);
    if (this._frameSamples.length < GAME_PERF_SAMPLE_SIZE) return;

    const sorted = this._frameSamples.slice().sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    this._frameSamples.length = 0;

    // Pierwszy pełny cykl pomiaru zakończony - jakość jest już DOBRANA
    // (obniżona teraz, jeśli trzeba, albo świadomie zostawiona na
    // najwyższej). Wołane RAZ (resolve() na już rozwiązanej Promise jest
    // no-opem z definicji, więc bez dodatkowej flagi/guarda).
    if (this._firstQualityCheckResolve) {
      this._firstQualityCheckResolve();
      this._firstQualityCheckResolve = null;
    }

    if (median > GAME_PERF_BUDGET_MS) {
      const ratio = median / GAME_PERF_BUDGET_MS;
      const dropSteps = Math.max(1, Math.floor(ratio));
      this._qualityLevel = Math.max(0, this._qualityLevel - dropSteps);
      const newDpr = GAME_QUALITY_DPR_STEPS[this._qualityLevel];
      console.warn(
        `[Game] Klatki po ~${median.toFixed(1)}ms (budżet ${GAME_PERF_BUDGET_MS}ms) - ` +
        `obniżam rozdzielczość renderowania do ${newDpr}x, żeby gra chodziła płynnie.`
      );
      this.resize();
    }
  }

  /**
   * Aktualizuje stan wewnętrzny (screen shake) oraz wszystkie moduły.
   */
  update(delta) {
    // Zanikanie intensywności screen shake.
    if (this.shakeIntensity > 0.05) {
      this.shakeIntensity *= 0.85;
    } else {
      this.shakeIntensity = 0;
    }

    if (this.shakeDuration > 0) {
      this.shakeDuration = Math.max(0, this.shakeDuration - delta);
    }

    for (const module of this.modules) {
      if (typeof module.update === 'function') {
        module.update(delta);
      }
    }
  }

  /**
   * Oblicza pozycję kamery - śledzi window.playerController (jeśli istnieje),
   * z lekkim wygładzeniem (CAMERA_SMOOTHING), przycięte tak, żeby widok
   * nigdy nie pokazywał obszaru poza granicami świata (GAME_WORLD_WIDTH/HEIGHT).
   */
  _updateCamera() {
    // window.innerWidth/innerHeight, NIE canvas.width/height - po fixie DPR
    // (patrz resize()) to ostatnie to fizyczne piksele bufora (dpr-krotnie
    // większe), a viewW/viewH tutaj musi zostać w logicznych pikselach CSS,
    // bo cała reszta gry (pozycje świata, kamera) operuje właśnie w nich.
    const viewW = window.innerWidth;
    const viewH = window.innerHeight;
    const player = window.playerController;
    const targetPlayerX = player ? player.x : this.worldWidth / 2;
    const targetPlayerY = player ? player.y : this.worldHeight / 2;

    const targetCameraX = targetPlayerX - viewW / 2;
    const targetCameraY = targetPlayerY - viewH / 2;

    this.cameraX += (targetCameraX - this.cameraX) * CAMERA_SMOOTHING;
    this.cameraY += (targetCameraY - this.cameraY) * CAMERA_SMOOTHING;

    // Nie pokazuj pustki poza światem - jeśli świat jest mniejszy niż
    // ekran w jakimś wymiarze (np. bardzo szerokie okno desktopowe),
    // kamera zostaje przyklejona do 0 w tym wymiarze zamiast oscylować.
    const maxCameraX = Math.max(0, this.worldWidth - viewW);
    const maxCameraY = Math.max(0, this.worldHeight - viewH);
    this.cameraX = Math.max(0, Math.min(maxCameraX, this.cameraX));
    this.cameraY = Math.max(0, Math.min(maxCameraY, this.cameraY));
  }

  /**
   * Rysuje wszystkie 3 fazy na WSPÓLNYM canvasie: tło -> gameplay (z screen
   * shake) -> UI (patrz komentarz w nagłówku pliku - dawniej trzy osobne
   * canvasy, teraz jeden, kolejność rysowania = z-order, bez zmian).
   */
  draw() {
    // BUGFIX ("czarny ekran"/"rozmazana postać" przy niskiej jakości): to
    // clearRect wołało canvas.width/height - FIZYCZNE piksele bufora
    // (innerWidth*dpr, patrz resize()) - na kontekście, który ma już
    // ustawiony setTransform(dpr,...). Argumenty clearRect() są interpretowane
    // W BIEŻĄCEJ przestrzeni transformacji, więc dostawały PRZESKALOWANE
    // DRUGI RAZ przez dpr - realnie czyściło obszar o boku dpr-krotnie
    // mniejszym niż cały bufor, nie cały bufor.
    // Przy dpr >= 1 (jedyne wartości sprzed rozszerzenia GAME_QUALITY_DPR_STEPS
    // poniżej 1.0) to nadmiarowe czyszczenie - niegroźne, bo obetnie się do
    // granic canvasu. Przy dpr < 1 (nowe kroki 0.5/0.65/0.8, patrz
    // GAME_QUALITY_DPR_STEPS) to NIEDOMIAROWE czyszczenie: czyści tylko
    // ułamek `dpr` bufora w każdej osi, reszta ZOSTAJE - a półprzezroczyste
    // warstwy (winieta, poświaty) domalowywane na to co klatkę zbijają się w
    // nieprzezroczystą czerń w kilka klatek, i zostawiają "duchy" ruszających
    // się sprite'ów tam, gdzie clearRect w ogóle nie sięgał.
    // Naprawa: te same window.innerWidth/innerHeight (logiczne piksele CSS),
    // których cała reszta pliku już używa (patrz komentarz w resize()) -
    // transform przeskaluje je DOKŁADNIE RAZ, tak jak powinien.
    //
    // JEDNO wywołanie, nie trzy - this.ctxBackground/ctxGameplay/ctxUI to
    // teraz ten sam kontekst (patrz konstruktor), więc czyszczenie go trzy
    // razy pod rząd na dokładnie tym samym obszarze było czystą stratą.
    this.ctxBackground.clearRect(0, 0, window.innerWidth, window.innerHeight);

    this._updateCamera();

    // Tło przesuwamy o kamerę (bez shake - drganie samej trawy pod stopami
    // wygladałoby dziwnie), żeby przewijało się razem ze światem.
    this.ctxBackground.save();
    this.ctxBackground.translate(-this.cameraX, -this.cameraY);
    this._drawBackground();
    this.ctxBackground.restore();

    const shakeX = (Math.random() - 0.5) * this.shakeIntensity * 2;
    const shakeY = (Math.random() - 0.5) * this.shakeIntensity * 2;

    // Warstwa gameplay (postać, przedmioty, maszyny, stos, FX) - kamera + shake.
    this.ctxGameplay.save();
    this.ctxGameplay.translate(-this.cameraX + shakeX, -this.cameraY + shakeY);

    for (const module of this.modules) {
      if (typeof module.draw !== 'function') continue;
      if (module.drawLayer === 'ui') continue;
      module.draw(this.ctxBackground, this.ctxGameplay, this.ctxUI);
    }

    this.ctxGameplay.restore();

    // Moduły z drawLayer === 'ui' (gdyby były używane w przyszłości).
    for (const module of this.modules) {
      if (typeof module.draw === 'function' && module.drawLayer === 'ui') {
        module.draw(this.ctxBackground, this.ctxGameplay, this.ctxUI);
      }
    }

    // Zabarwienie nastrojowe zależne od strefy, w której stoi gracz - PRZED
    // winietą (winieta ma być ostatnia/najwyżej, patrz niżej).
    this._drawZoneTint();

    // Winieta - delikatne przyciemnienie rogów ekranu, ostatnia rzecz na
    // warstwie UI (nad wszystkim). Nie przesuwa się z kamerą (to efekt
    // "obiektywu", przyklejony do ekranu), stąd tutaj, poza translacjami.
    // Daje głębię i subtelnie prowadzi wzrok do środka, gdzie dzieje się
    // akcja. Przeliczana raz na resize (buforowana), nie co klatkę - sam
    // gradient radialny jest dość kosztowny.
    this._drawVignette();
  }

  /**
   * Delikatne zabarwienie CAŁEGO ekranu kolorem nastrojowym danej strefy -
   * chłodna, toksyczna zieleń w Strefie B (bagno), ciepły, brudny popiół w
   * Strefie C, praktycznie nic w bezpiecznej Strefie A. Płynne przejście
   * (fade nad GAME_ZONE_TINT_FADE px od granicy, ten sam duch co wtapianie
   * tekstur terenu w _drawBackground) - gracz WYCZUWA zmianę otoczenia
   * kątem oka, zanim jeszcze zobaczy inną teksturę pod nogami. Rysowane na
   * ctxUI (warstwa ekranu, NIE świata) - nie przesuwa się z kamerą, jak winieta.
   */
  _drawZoneTint() {
    const player = window.playerController;
    if (!player) return;

    const blend = this._getZoneBlend(player.x, player.y);
    if (blend.B < 0.01 && blend.C < 0.01 && blend.D < 0.01) return;

    // window.innerWidth/innerHeight (logiczne piksele CSS), NIE
    // canvas.width/height (fizyczne piksele bufora po fixie DPR, patrz
    // resize()) - inaczej ten fillRect rysowałby dpr-krotnie za duży
    // prostokąt (nieszkodliwie przycięty, ale marnujący pracę GPU co klatkę).
    const w = window.innerWidth;
    const h = window.innerHeight;
    // Strefa D - chłodny fiolet (zgodny z _bakeCrystalGroundTexture), wyraźnie
    // inny niż zielonkawa B i brudnobrązowa C, żeby dało się je rozróżnić
    // "kątem oka" tak samo jak resztę stref.
    const r = Math.round(blend.B * 40 + blend.C * 70 + blend.D * 70);
    const g = Math.round(blend.B * 100 + blend.C * 45 + blend.D * 30);
    const b = Math.round(blend.B * 75 + blend.C * 40 + blend.D * 110);
    const alpha = blend.B * 0.09 + blend.C * 0.11 + blend.D * 0.13;

    this.ctxUI.save();
    this.ctxUI.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
    this.ctxUI.fillRect(0, 0, w, h);
    this.ctxUI.restore();
  }

  /**
   * Ile gracz jest "zanurzony" w każdej z 3 stref (0..1, sumują się do 1) -
   * płynne cross-fade zamiast twardego przełącznika, liczone z odległości
   * do najbliższej granicy strefy (GAME_ZONE_TINT_FADE px = pełne przejście).
   * Te same progi co gdzie indziej (GAME_ZONE_C_TOP_RATIO/B_RIGHT_RATIO).
   */
  _getZoneBlend(px, py) {
    const topH = this.worldHeight * GAME_ZONE_C_TOP_RATIO;
    const rightX = GAME_ZONE_CORE_WIDTH * GAME_ZONE_B_RIGHT_RATIO;
    const dLeftX = GAME_ZONE_CORE_WIDTH;
    const fade = GAME_ZONE_TINT_FADE;

    const depthC = Math.max(0, Math.min(1, (topH - py) / fade));
    const depthB = py > topH ? Math.max(0, Math.min(1, (px - rightX) / fade)) : 0;
    // Strefa D jest teraz NIEZALEŻNYM pasem na pełnej wysokości (patrz
    // GAME_ZONE_CORE_WIDTH) - jedna krawędź (lewa pionowa) wystarcza, bez
    // dawnego min() z drugiej (dolnej), której już nie ma.
    const depthD = Math.max(0, Math.min(1, (px - dLeftX) / fade));
    // D "wygrywa" nad C i B w swoim pasie - odejmujemy je, żeby suma
    // A+B+C+D nadal wynosiła 1 i tinty się nie sumowały podwójnie.
    const depthA = Math.max(0, 1 - depthC - depthB);
    return {
      A: Math.max(0, depthA - depthD),
      B: Math.max(0, depthB - depthD),
      C: Math.max(0, depthC - depthD),
      D: depthD
    };
  }

  _drawVignette() {
    // BUGFIX (DPR): musi być window.innerWidth/innerHeight, nie
    // canvas.width/height - z fizycznymi (dpr-krotnie większymi) pikselami
    // środek gradientu i promienie liczyłyby się w złej przestrzeni, a
    // potem PONOWNIE przeskalowały przez ctx transform - winietka
    // wylądowałaby w złym miejscu / z promieniem tak dużym, że praktycznie
    // niewidoczna.
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (!this._vignette || this._vignetteW !== w || this._vignetteH !== h) {
      // Bufor gradientu odtwarzany tylko gdy zmieni się rozmiar canvasu.
      const grad = this.ctxUI.createRadialGradient(
        w / 2, h / 2, Math.min(w, h) * 0.42,
        w / 2, h / 2, Math.max(w, h) * 0.72
      );
      grad.addColorStop(0, 'rgba(0, 0, 0, 0)');
      grad.addColorStop(1, 'rgba(0, 0, 0, 0.28)');
      this._vignette = grad;
      this._vignetteW = w;
      this._vignetteH = h;
    }
    this.ctxUI.save();
    this.ctxUI.fillStyle = this._vignette;
    this.ctxUI.fillRect(0, 0, w, h);
    this.ctxUI.restore();
  }

  /**
   * Ładuje obrazek tekstury i buduje z niego powtarzalny wzorzec (pattern)
   * gdy się wczyta. Wspólny helper dla 3 tekstur terenu (trawa/popiół/bagno) -
   * identyczna logika onload/onerror, więc nie kopiujemy jej 3 razy.
   * .ready rozwiązuje się PO wczytaniu, sukces LUB porażka (awaryjny kolor
   * jest już obsłużony przez fallbackColor w _fillZoneRegion) - używane do
   * zbiorczego this.assetsReady dla ekranu ładowania (patrz main.js).
   * @returns {{img: HTMLImageElement, pattern: CanvasPattern|null, ready: Promise<void>}}
   */
  _loadTexture(src) {
    const state = { img: new Image(), pattern: null };
    state.ready = new Promise((resolve) => {
      state.img.onload = () => {
        state.pattern = this.ctxBackground.createPattern(state.img, 'repeat');
        resolve();
      };
      state.img.onerror = () => {
        console.warn(`[Game] Nie udało się wczytać tekstury ${src} - rysuję awaryjny kolor.`);
        resolve();
      };
    });
    state.img.src = src;
    return state;
  }

  /**
   * Tekstura terenu Strefy D (Kryształowa Grań) - proceduralny kafelek
   * (ciemny, fioletowawy grunt z rozrzuconymi drobnymi kryształkami-rombami
   * + pęknięciami), bo w projekcie nie ma na to gotowego PNG (jak
   * flower/puddle w dekoracjach). Deterministyczny PRNG (mulberry32,
   * ten sam co dekoracje/chmury) - kafelek wygląda identycznie za każdym
   * wczytaniem strony, nie miga losowo. Zwraca ten sam kształt co
   * _loadTexture() ({pattern}), więc _fillZoneRegion() używa go bez zmian.
   */
  _bakeCrystalGroundTexture() {
    const size = 160;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const tctx = canvas.getContext('2d');

    let seed = 0x43727973; // 'Crys' jako liczba - stały, powtarzalny seed
    const rand = () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    // Baza - ciemny, chłodny fiolet (wyraźnie inny niż trawa/bagno/popiół).
    tctx.fillStyle = '#3d2f52';
    tctx.fillRect(0, 0, size, size);

    // Subtelne, ciemniejsze plamy podłoża (głębia tekstury pod kryształkami).
    for (let i = 0; i < 10; i++) {
      tctx.fillStyle = `rgba(0, 0, 0, ${0.08 + rand() * 0.1})`;
      tctx.beginPath();
      tctx.ellipse(rand() * size, rand() * size, 14 + rand() * 22, 10 + rand() * 16, rand() * Math.PI, 0, Math.PI * 2);
      tctx.fill();
    }

    // Porozrzucane drobne kryształki (romby) - fiolet/błękit, różne jasności.
    // BUGFIX ("kryształy nie pasują do reszty"): pierwsza wersja rysowała
    // każdy jako PŁASKI kolor bez konturu - obok kamyków ash.png (każdy z
    // własnym cieniem/blaskiem) i kamieni swamp.png (błyszczący highlight)
    // wyglądały jak naklejki, nie bryły. Każdy rombik ma teraz radialny
    // gradient (jasny błysk od góry-lewej, ciemniejszy w stronę krawędzi -
    // ten sam kierunek "światła" co reszta gry) + cienki ciemny kontur.
    for (let i = 0; i < 45; i++) {
      const x = rand() * size;
      const y = rand() * size;
      const r = 2.5 + rand() * 5;
      const hue = 250 + rand() * 45;
      const grad = tctx.createRadialGradient(x - r * 0.3, y - r * 0.3, 0, x, y, r * 1.1);
      grad.addColorStop(0, `hsla(${hue}, 65%, ${78 + rand() * 12}%, ${0.55 + rand() * 0.35})`);
      grad.addColorStop(1, `hsla(${hue}, 70%, ${38 + rand() * 15}%, ${0.4 + rand() * 0.35})`);
      tctx.fillStyle = grad;
      tctx.strokeStyle = 'rgba(20, 12, 35, 0.4)';
      tctx.lineWidth = 0.8;
      tctx.beginPath();
      tctx.moveTo(x, y - r);
      tctx.lineTo(x + r * 0.55, y);
      tctx.lineTo(x, y + r);
      tctx.lineTo(x - r * 0.55, y);
      tctx.closePath();
      tctx.fill();
      tctx.stroke();
    }

    // Cienkie pęknięcia gruntu - łamane linie, żeby powierzchnia nie
    // wyglądała jak płaska plama koloru.
    tctx.strokeStyle = 'rgba(0, 0, 0, 0.28)';
    tctx.lineWidth = 1;
    for (let i = 0; i < 6; i++) {
      let x = rand() * size;
      let y = rand() * size;
      tctx.beginPath();
      tctx.moveTo(x, y);
      for (let j = 0; j < 3; j++) {
        x += (rand() - 0.5) * 50;
        y += (rand() - 0.5) * 50;
        tctx.lineTo(x, y);
      }
      tctx.stroke();
    }

    return { pattern: this.ctxBackground.createPattern(canvas, 'repeat') };
  }

  /**
   * Tło: TRZY różne tekstury terenu, jedna na strefę (Strefa A = trawa,
   * B = bagno, C = popiół). Granice stref NIE są już prostymi cięciami -
   * każda strefa wtapia się w sąsiada pofalowaną linią + pasami o rosnącej
   * przezroczystości (GAME_BIOME_BLEND_STEPS, ścieżki z _buildBiomeEdgePaths).
   *
   * Kolejność rysowania: trawa (baza) -> bagno -> popiół. Popiół na SAMYM
   * wierzchu, żeby w narożniku styku B/C naturalnie nachodził na bagno
   * (wcześniej było odwrotnie, ale przy prostych, rozłącznych cięciach
   * kolejność nie miała znaczenia - teraz, z nachodzącymi pasami, ma).
   *
   * Dopóki dana tekstura się nie wczyta (albo się nie uda), jej strefa
   * rysowana jest jednolitym kolorem zastępczym - tło nigdy nie zostaje puste.
   *
   * WAŻNE: ta metoda jest wołana WEWNĄTRZ już przesuniętego (o -cameraX/Y)
   * kontekstu (patrz draw()) - dlatego wypełnia dokładnie widoczny fragment
   * świata, nie całe (0,0,w,h).
   *
   * BUGFIX (przycinanie - GŁÓWNA przyczyna, nie chmury ani dekoracje): to
   * wypełnianie kosztowało ~20ms/klatkę - WIĘCEJ niż cała reszta gry razem
   * wzięta (zmierzone wprost: pojedynczy ctx.clip() na pofalowanej ścieżce +
   * pattern fill całego viewportu, powtórzone do 6 razy - 3 kroki wtapiania
   * × 2 granice - KAŻDĄ klatkę). Granice/tekstury są całkowicie STATYCZNE
   * (świat ma stały rozmiar, nic się nie przesuwa), więc nie ma powodu
   * liczyć tego w kółko - pieczemy CAŁY świat RAZ do offscreen canvasu
   * (_bakeWorldBackground), a tutaj zostaje już tylko jeden tani drawImage.
   * Dopóki tekstury się jeszcze nie wczytały, tymczasowo używamy starego,
   * wolniejszego toru per-klatkę (_renderZoneFills) - krótkie okno przy
   * starcie gry, żeby ekran nigdy nie został pusty.
   */
  _drawBackground() {
    const ctx = this.ctxBackground;
    // window.innerWidth/innerHeight (logiczne piksele CSS) - patrz komentarz
    // w _updateCamera(), ten sam powód (culling chmur/dekoracji niżej musi
    // działać w tej samej przestrzeni co pozycje świata/kamera).
    const viewW = window.innerWidth;
    const viewH = window.innerHeight;
    const x = this.cameraX;
    const y = this.cameraY;

    if (!this._worldBackgroundBaked) {
      // Czekamy TEŻ na obrazki dekoracji (nie tylko 3 tekstury terenu) -
      // _bakeStaticDecorations (wołane z _bakeWorldBackground niżej) piecze
      // cienie/sprite'y dekoracji do tego samego bufora RAZ, więc muszą już
      // być wczytane, inaczej upieklibyśmy cień ze złym rozmiarem (liczonym
      // z img.naturalWidth/Height) albo w ogóle pominęli 'rock' na stałe.
      if (this._grass.pattern && this._swamp.pattern && this._ash.pattern && this._decorImagesReady()) {
        this._bakeWorldBackground();
      } else {
        this._renderZoneFills(ctx, x, y, viewW, viewH);
      }
    }

    if (this._worldBackgroundBaked) {
      // Kontekst jest już przesunięty o -cameraX/-cameraY (patrz draw()),
      // więc rysowanie upieczonego świata OD (0,0) trafia dokładnie tam,
      // gdzie trzeba - ten sam trik co pattern.fillStyle wcześniej, patrz
      // komentarz w _fillZoneRegion.
      ctx.drawImage(this._worldBackgroundCanvas, 0, 0);
    }

    this._drawCloudShadows(ctx, x, y, viewW, viewH);
    this._drawDecorations(ctx, x, y, viewW, viewH);
  }

  /**
   * Piecze RAZ całe tło świata (trawa+bagno+popiół z miękkimi granicami) do
   * offscreen canvasu rozmiaru świata - patrz obszerny komentarz w
   * _drawBackground. CanvasPattern NIE jest przywiązany do kontekstu, w
   * którym powstał (można go użyć jako fillStyle na dowolnym 2D kontekście),
   * więc this._grass.pattern/itd. da się użyć wprost na nowym offscreen
   * kontekście bez odtwarzania wzorców. Wołane dopiero gdy wszystkie 3
   * tekstury terenu są już gotowe.
   */
  _bakeWorldBackground() {
    const canvas = document.createElement('canvas');
    canvas.width = this.worldWidth;
    canvas.height = this.worldHeight;
    const wctx = canvas.getContext('2d');

    this._renderZoneFills(wctx, 0, 0, this.worldWidth, this.worldHeight);
    this._bakeStaticDecorations(wctx);

    this._worldBackgroundCanvas = canvas;
    this._worldBackgroundBaked = true;
  }

  /** true, gdy WSZYSTKIE obrazki dekoracji sprite'owych (patrz DECOR_TYPES)
   * skończyły próbę wczytania (sukces LUB porażka - `complete` jest true w
   * obu przypadkach, tak samo jak przy _loadTexture) - warunek gotowości do
   * _bakeWorldBackground/_bakeStaticDecorations. */
  _decorImagesReady() {
    return DECOR_TYPES.every((type) => {
      const img = this._decorImages[type];
      return img && img.complete;
    });
  }

  /**
   * Domalowuje do TEGO SAMEGO upieczonego tła świata (wołane z
   * _bakeWorldBackground) elementy dekoracji, które są W PEŁNI statyczne -
   * nigdy się nie poruszają/nie animują, więc nie ma powodu płacić za ich
   * rysowanie co klatkę:
   *   - cień KAŻDEJ dekoracji sprite'owej (tree/bush/rock/shrub) - cień
   *     nigdy nie kołysze się razem ze sprite'em nad nim (patrz
   *     DECOR_SWAY_TYPES), więc wygląda identycznie na każdej klatce
   *     niezależnie od typu/tego czy sprite nad nim się porusza.
   *   - sam sprite 'rock'/'crate'/'sign' (JEDYNE typy sprite'owe spoza
   *     DECOR_SWAY_TYPES - nic w nich się nie kołysze, więc bezpiecznie
   *     rysować je RAZ tutaj zamiast co klatkę w _drawDecorations).
   *
   * BUGFIX (przycinanie/lag, "za mała gra żeby tak zacinało"): profil CPU
   * (Chrome DevTools Profiler, symulacja słabego telefonu przez CPU
   * throttling) pokazał ~35% czasu KAŻDEJ klatki w _drawBackground - w
   * większości właśnie tutaj: fillStyle+beginPath+ellipse+fill dla KAŻDEGO
   * cienia + osobny drawImage dla KAŻDEJ w pełni statycznej dekoracji, 60x/s,
   * dla wszystkiego widocznego naraz (kilkadziesiąt obiektów na raz przy
   * typowym kadrze). To dokładnie ten koszt, którego obniżenie rozdzielczości
   * renderowania (dpr) NIE dotyka - liczba wywołań Canvas API zostaje ta sama
   * niezależnie od dpr, a to WYWOŁANIA (nie piksele) tu kosztowały najwięcej.
   * Wołane RAZ, tylko gdy sprite'y dekoracji są już wczytane (patrz warunek
   * w _drawBackground) - inaczej cień/sprite policzyłby się ze złym
   * (domyślnym) rozmiarem obrazka.
   */
  _bakeStaticDecorations(wctx) {
    this._decorations.forEach((d) => {
      if (!DECOR_TYPES.includes(d.type)) return; // tylko sprite'owe (tree/bush/rock/shrub/crate/sign) mają tu osobny cień

      const img = this._decorImages[d.type];
      if (!img || !img.complete || !img.naturalWidth) return;

      const h = DECOR_BASE_HEIGHT * d.scale * (DECOR_TYPE_SCALE[d.type] || 1);
      const w = h * (img.naturalWidth / img.naturalHeight);

      // Ten sam kształt/pozycja cienia co dawniej w _drawDecorations (patrz
      // komentarz "kamienie latają" tam) - tylko przeniesiony tutaj, do
      // jednorazowego pieczenia zamiast rysowania co klatkę.
      wctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
      wctx.beginPath();
      wctx.ellipse(d.x, d.y, w * 0.42, Math.max(3, h * 0.14), 0, 0, Math.PI * 2);
      wctx.fill();

      // Reszta sprite'owych typów (rock/crate/sign) - jedyne poza tree/bush/
      // shrub, które NIE kołyszą się na wietrze (DECOR_SWAY_TYPES), więc ich
      // sylwetkę bezpiecznie piec RAZ razem z cieniem zamiast rysować co
      // klatkę w _drawDecorations.
      if (d.type === 'rock' || d.type === 'crate' || d.type === 'sign') {
        const groundOffset = h * (DECOR_GROUND_OFFSET[d.type] || 0);
        wctx.drawImage(img, d.x - w / 2, d.y - h + groundOffset, w, h);
      }
    });
  }

  /**
   * Wspólna logika wypełniania trzech stref terenu z miękkimi granicami -
   * używana ZARÓWNO do jednorazowego pieczenia całego świata
   * (_bakeWorldBackground, x=0,y=0,viewW/H=cały świat - warunki cullingu
   * poniżej naturalnie nie odetną wtedy żadnej strefy) JAK I do tymczasowego
   * renderowania per-klatkę, dopóki tekstury terenu się jeszcze ładują.
   */
  _renderZoneFills(ctx, x, y, viewW, viewH) {
    const topH = this.worldHeight * GAME_ZONE_C_TOP_RATIO;
    const rightX = GAME_ZONE_CORE_WIDTH * GAME_ZONE_B_RIGHT_RATIO;
    // Najdalej, jak fala + najszerszy pas wtapiania sięgają w głąb sąsiada.
    const maxReach = GAME_BIOME_EDGE_AMPLITUDE + GAME_BIOME_BLEND_STEPS[0].offset;

    // Culling stref: nie wypełniamy warstw, których na pewno nie widać
    // (np. głęboko w Strefie C trawa i bagno leżą w całości pod litym
    // popiołem - szkoda fillRectów, zwłaszcza na telefonie).
    const fullyInsideC = y + viewH < topH - maxReach;
    const fullyInsideB = x > rightX + maxReach && y > topH + maxReach;

    // Strefa A (trawa) - baza pod wszystkim.
    if (!fullyInsideC && !fullyInsideB) {
      this._fillZoneRegion(ctx, x, y, viewW, viewH, this._grass, '#5a8f4a');
    }

    // Strefa B (bagno) - prawy pas, rysowany PRZED popiołem.
    const bVisible =
      !fullyInsideC &&
      x + viewW > rightX - maxReach &&
      y + viewH > topH - GAME_ZONE_B_TOP_BLEED;
    if (bVisible) {
      for (let i = 0; i < GAME_BIOME_BLEND_STEPS.length; i++) {
        ctx.save();
        ctx.globalAlpha = GAME_BIOME_BLEND_STEPS[i].alpha;
        ctx.clip(this._zoneBPaths[i]);
        this._fillZoneRegion(ctx, x, y, viewW, viewH, this._swamp, '#4d6b47');
        ctx.restore();
      }
    }

    // Strefa C (popiół) - górny pas, na samym wierzchu.
    if (y < topH + maxReach) {
      for (let i = 0; i < GAME_BIOME_BLEND_STEPS.length; i++) {
        ctx.save();
        ctx.globalAlpha = GAME_BIOME_BLEND_STEPS[i].alpha;
        ctx.clip(this._zoneCPaths[i]);
        this._fillZoneRegion(ctx, x, y, viewW, viewH, this._ash, '#4a4038');
        ctx.restore();
      }
    }

    // Strefa D (Kryształowa Grań) - NIEZALEŻNY pas z własną pofalowaną lewą
    // krawędzią (_zoneDPaths), rysowany NA SAMYM KOŃCU. Pełna wysokość mapy,
    // więc widoczność zależy tylko od tego, czy widok w ogóle sięga na
    // prawo od GAME_ZONE_CORE_WIDTH - bez dawnego warunku na y.
    const dLeftX = GAME_ZONE_CORE_WIDTH;
    if (x + viewW > dLeftX - maxReach) {
      for (let i = 0; i < GAME_BIOME_BLEND_STEPS.length; i++) {
        ctx.save();
        ctx.globalAlpha = GAME_BIOME_BLEND_STEPS[i].alpha;
        ctx.clip(this._zoneDPaths[i]);
        this._fillZoneRegion(ctx, x, y, viewW, viewH, this._crystalGround, '#3d2f52');
        ctx.restore();
      }
    }
  }

  /**
   * Wypełnia widoczny obszar wzorcem tekstury, albo jednolitym kolorem awaryjnym.
   *
   * NAPRAWIONY BUG "płynącego podłoża": CanvasPattern podlega bieżącej
   * transformacji kontekstu dokładnie tak samo jak geometria. Kontekst tła
   * jest już przesunięty o -cameraX/-cameraY (patrz draw()), więc wzorzec
   * SAM Z SIEBIE jest zakotwiczony w punkcie (0,0) ŚWIATA - czyli tak,
   * jak trzeba. Wcześniejsze pattern.setTransform(translate(+cameraX,
   * +cameraY)) odwracało tę translację DRUGI raz i w efekcie przypinało
   * teksturę do EKRANU: świat się przewijał, a kafelki stały w miejscu
   * względem monitora, więc ziemia "płynęła" pod nogami. Fix = brak
   * jakiegokolwiek setTransform.
   */
  _fillZoneRegion(ctx, x, y, viewW, viewH, texture, fallbackColor) {
    ctx.fillStyle = texture.pattern ? texture.pattern : fallbackColor;
    ctx.fillRect(x, y, viewW, viewH);
  }

  /**
   * Fala granicy Strefy C (pozioma linia popiół/reszta świata). Suma dwóch
   * sinusów o niewspółmiernych częstotliwościach daje organiczny meander
   * bez widocznego powtarzania; zero losowości, więc granica wygląda
   * IDENTYCZNIE co klatkę i co wczytanie strony (ta sama filozofia co
   * DECOR_SEED przy dekoracjach).
   * @param {number} x - współrzędna świata wzdłuż granicy
   * @returns {number} odchylenie od prostej linii w px
   */
  _edgeWaveC(x) {
    return (
      (Math.sin(x * 0.012 + 0.8) * 0.62 + Math.sin(x * 0.027 + 2.4) * 0.38) *
      GAME_BIOME_EDGE_AMPLITUDE
    );
  }

  /** Jak _edgeWaveC, ale dla PIONOWEJ granicy Strefy B (inne fazy/częstotliwości). */
  _edgeWaveB(y) {
    return (
      (Math.sin(y * 0.0095 + 3.1) * 0.62 + Math.sin(y * 0.022 + 0.4) * 0.38) *
      GAME_BIOME_EDGE_AMPLITUDE
    );
  }

  /**
   * Fala LEWEJ granicy Strefy D (jedyna krawędź, odkąd D jest niezależnym
   * pasem na pełnej wysokości, nie rogiem z dwiema granicami) - inne
   * fazy/częstotliwości niż C i B, żeby pas Grani nie wyglądał na
   * "równoległy" do sąsiednich granic. Ta sama matematyka co wyżej, więc
   * granica jest deterministyczna (identyczna co klatkę i co wczytanie) i
   * musi być IDENTYCZNIE skopiowana w player.js (hazard) - patrz komentarz
   * przy _edgeWaveC tam.
   */
  _edgeWaveD(v) {
    return (
      (Math.sin(v * 0.0135 + 1.7) * 0.6 + Math.sin(v * 0.031 + 4.2) * 0.4) *
      GAME_BIOME_EDGE_AMPLITUDE
    );
  }

  /**
   * Buduje RAZ (w konstruktorze) ścieżki Path2D granic biomów - po jednej
   * na każdy pas wtapiania z GAME_BIOME_BLEND_STEPS. Świat ma stały rozmiar,
   * więc ścieżki nigdy się nie zmieniają: w draw() zostaje tylko
   * ctx.clip(gotowaŚcieżka) + fill, zero liczenia geometrii co klatkę.
   */
  _buildBiomeEdgePaths() {
    const topH = this.worldHeight * GAME_ZONE_C_TOP_RATIO;
    const rightX = GAME_ZONE_CORE_WIDTH * GAME_ZONE_B_RIGHT_RATIO;
    // Zapas poza granice świata - kamera i tak jest przycięta do świata,
    // ale dzięki temu clip nigdy nie utnie wypełnienia przy samej krawędzi.
    const bleed = 80;

    // Strefa C: obszar NAD pofalowaną linią y = topH + fala(x) + offset.
    this._zoneCPaths = GAME_BIOME_BLEND_STEPS.map((step) => {
      const p = new Path2D();
      p.moveTo(-bleed, -bleed);
      p.lineTo(-bleed, topH + this._edgeWaveC(0) + step.offset);
      for (let px = 0; px <= this.worldWidth; px += GAME_BIOME_EDGE_STEP) {
        p.lineTo(px, topH + this._edgeWaveC(px) + step.offset);
      }
      p.lineTo(this.worldWidth + bleed, topH + this._edgeWaveC(this.worldWidth) + step.offset);
      p.lineTo(this.worldWidth + bleed, -bleed);
      p.closePath();
      return p;
    });

    // Strefa B: obszar NA PRAWO od pofalowanej linii x = rightX + fala(y) - offset.
    // Zaczyna się GAME_ZONE_B_TOP_BLEED nad prostym progiem topH - patrz
    // komentarz przy tej stałej (lita Strefa C i tak przykrywa ten pas).
    this._zoneBPaths = GAME_BIOME_BLEND_STEPS.map((step) => {
      const p = new Path2D();
      const yTop = topH - GAME_ZONE_B_TOP_BLEED;
      p.moveTo(this.worldWidth + bleed, yTop);
      p.lineTo(rightX + this._edgeWaveB(yTop) - step.offset, yTop);
      for (let py = yTop; py <= this.worldHeight; py += GAME_BIOME_EDGE_STEP) {
        p.lineTo(rightX + this._edgeWaveB(py) - step.offset, py);
      }
      p.lineTo(rightX + this._edgeWaveB(this.worldHeight) - step.offset, this.worldHeight + bleed);
      p.lineTo(this.worldWidth + bleed, this.worldHeight + bleed);
      p.closePath();
      return p;
    });

    // Strefa D (Kryształowa Grań): NIEZALEŻNY pas na PEŁNEJ wysokości mapy,
    // z JEDNĄ pofalowaną krawędzią - lewą pionową (x = dLeftX + fala(y)).
    // Prawa/górna/dolna krawędź to po prostu granice świata (bleed poza nie,
    // tak jak przy C/B) - w przeciwieństwie do dawnej wersji (róg z DWIEMA
    // własnymi granicami) nie ma już dolnej fali do zbudowania (patrz obszerny
    // komentarz przy GAME_ZONE_CORE_WIDTH).
    const dLeftX = GAME_ZONE_CORE_WIDTH;
    this._zoneDPaths = GAME_BIOME_BLEND_STEPS.map((step) => {
      const p = new Path2D();
      // Górny-prawy narożnik świata -> w lewo po górnej krawędzi.
      p.moveTo(this.worldWidth + bleed, -bleed);
      p.lineTo(dLeftX + this._edgeWaveD(-bleed) - step.offset, -bleed);
      // W dół po lewej, pofalowanej krawędzi, aż pod dolną krawędź świata.
      for (let py = -bleed; py <= this.worldHeight + bleed; py += GAME_BIOME_EDGE_STEP) {
        p.lineTo(dLeftX + this._edgeWaveD(py) - step.offset, py);
      }
      // Zamknięcie: w prawo do prawej krawędzi świata, potem do startu.
      p.lineTo(this.worldWidth + bleed, this.worldHeight + bleed);
      p.closePath();
      return p;
    });
  }

  /**
   * Generuje RAZ (w konstruktorze) stałą listę pozycji dekoracji - seedowany
   * PRNG (mulberry32), więc układ jest identyczny za każdym wczytaniem
   * strony, nie losowy od nowa. Omija promień wokół znanych punktów
   * zainteresowania (maszyny/statek/terminal/start gracza), żeby drzewo nie
   * wyrosło graczowi na głowie. Typ dekoracji dobrany do strefy, w której
   * akurat wylosowano pozycję (drzewa/krzaki w bezpiecznej Strefie A,
   * tylko krzewinki/kamienie w Strefie B, gołe kamienie w spalonej Strefie C).
   */
  _generateDecorations() {
    let seed = DECOR_SEED;
    const rand = () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    // Te same pozycje co w machines.js/market.js/ship.js (własne kopie -
    // konwencja projektu) - trzymamy dekoracje z dala od nich.
    const keepAway = [
      { xr: 0.32, yr: 0.4 }, // recykler
      { xr: 0.28, yr: 0.72 }, // prasa
      { xr: 0.59, yr: 0.35 }, // piec hutniczy
      // BUGFIX: Oczyszczalnia (dodana w Fazie progresji) nigdy nie dostała
      // wpisu tutaj - dekoracje mogły spawnować się wprost na niej. xr/yr
      // muszą się zgadzać z refinery_b w machines.js.
      { xr: 0.8, yr: 0.62 }, // oczyszczalnia
      { xr: 0.5, yr: 0.85 }, // terminal handlowy
      // BUGFIX: było (0.42, 0.58) - stara pozycja statku SPRZED przesunięcia
      // opisanego w ship.js (komentarz przy this.xRatio/this.yRatio tam) na
      // (0.18, 0.55). Ten wpis nigdy nie został zaktualizowany, więc
      // dekoracje mogły spawnować się na/tuż obok statku zamiast dookoła
      // niego.
      { xr: 0.18, yr: 0.55 }, // statek
      { xr: 0.5, yr: 0.5 }, // start gracza
      // Szlifiernia Kryształów (crystal_polisher w machines.js) - JEDYNA
      // pozycja tutaj z xr > 1 (patrz komentarz przy jej definicji w
      // machines.js: stoi w Strefie D, za starą szerokością rdzenia).
      { xr: 1.15, yr: 0.28 } // szlifiernia kryształów
      // BUGFIX (poszerzenie mapy pod Strefę D): xr/yr wyżej to ratio
      // WZGLĘDEM GAME_ZONE_CORE_WIDTH (gdzie maszyny/statek faktycznie stoją -
      // patrz machines.js/ship.js/market.js), NIE względem this.worldWidth
      // (teraz szerszego o pas D) - inaczej te kręgi "trzymaj się z dala"
      // przesunęłyby się w prawo, przestając pokrywać realne pozycje maszyn.
    ].map((p) => ({ x: GAME_ZONE_CORE_WIDTH * p.xr, y: this.worldHeight * p.yr, r: 170 }));

    const topH = this.worldHeight * GAME_ZONE_C_TOP_RATIO;
    const rightX = GAME_ZONE_CORE_WIDTH * GAME_ZONE_B_RIGHT_RATIO;
    const dLeftX = GAME_ZONE_CORE_WIDTH;
    // 'flower'/'puddle'/'crystal' powtórzone w listach - najprostszy
    // sposób na podbicie ich szansy wylosowania bez pełnego systemu wag: te
    // drobne akcenty koloru/detalu powinny być częstsze niż rzadkie drzewo,
    // ale rzadsze niż podstawowa trawa/krzak danej strefy.
    // BALANS (Strefa C/ash): crate i sign były OBA za częste (crate 1/4 na
    // równi z rock, sign podbite razem z pierwszą rundą poprawek do 3/7 -
    // wciąż za dużo). rock teraz wyraźnie dominuje (5/7), sign i crate to
    // rzadkie akcenty (po 1/7 każdy) - crate dodatkowo pilnuje odstępu
    // między egzemplarzami (patrz crateTooClose niżej).
    const zoneTypes = {
      A: ['tree', 'bush', 'shrub', 'flower', 'flower', 'grass_tuft', 'grass_tuft', 'fern'],
      B: ['shrub', 'rock', 'puddle'],
      C: ['rock', 'rock', 'rock', 'rock', 'rock', 'sign', 'crate'],
      D: ['crystal', 'crystal', 'rock']
    };

    // Minimalny odstęp między środkami dwóch skrzyń (Strefa C) - bez tego
    // rejection-sampling wyżej (tooClose od keepAway) nic nie mówi o
    // ODLEGŁOŚCI OD SIEBIE dekoracji tego samego typu, więc dwie skrzynie
    // mogły wylosować się w tym samym miejscu i wizualnie zlać w jedną
    // plamę. Wartość z grubsza pokrywa najszerszy możliwy rendering skrzyni
    // (DECOR_BASE_HEIGHT * crate scale * maks. losowy mnożnik item.scale)
    // + mały margines - patrz DECOR_TYPE_SCALE.crate wyżej w pliku.
    const CRATE_MIN_SPACING = 85;
    const placedCrates = [];

    const list = [];
    let attempts = 0;
    while (list.length < DECOR_COUNT && attempts < DECOR_COUNT * 25) {
      attempts++;
      const px = 40 + rand() * (this.worldWidth - 80);
      const py = 40 + rand() * (this.worldHeight - 80);

      const tooClose = keepAway.some((k) => {
        const dx = px - k.x;
        const dy = py - k.y;
        return Math.sqrt(dx * dx + dy * dy) < k.r;
      });
      if (tooClose) continue;

      // Strefa D to teraz NIEZALEŻNY pas na pełnej wysokości (na prawo od
      // dLeftX) - stąd sprawdzana jako PIERWSZA, tak samo jak w _getZoneAt
      // (player.js) i _getZoneBounds (items.js).
      const zone = px > dLeftX
        ? 'D'
        : py < topH ? 'C' : px > rightX ? 'B' : 'A';
      const options = zoneTypes[zone];
      const type = options[Math.floor(rand() * options.length)];

      if (type === 'crate') {
        const crateTooClose = placedCrates.some((c) => {
          const dx = px - c.x;
          const dy = py - c.y;
          return Math.sqrt(dx * dx + dy * dy) < CRATE_MIN_SPACING;
        });
        if (crateTooClose) continue;
        placedCrates.push({ x: px, y: py });
      }

      // seed: losowa, ale STAŁA (raz wygenerowana) wartość 0..1 - typy
      // proceduralne (flower/puddle) czytają ją do wyboru wariantu koloru/
      // fazy animacji, żeby każdy egzemplarz wyglądał inaczej, ale identycznie
      // za każdym odświeżeniem (ta sama filozofia co DECOR_SEED).
      const item = { x: px, y: py, type, scale: 0.75 + rand() * 0.65, seed: rand() };

      // BUGFIX (przycinanie na telefonie): _drawFlowerDecor/_drawPuddleDecor
      // odbudowywały swój kształt OD ZERA co klatkę - dla kwiatka to ~50
      // osobnych fill()/stroke() (3 kwiatuszki × 5 płatków + łodyżki +
      // środki), a kałuża tworzyła NOWY gradient co klatkę (jedna z droższych
      // operacji Canvas) - dla każdej widocznej dekoracji naraz, 60 razy/s.
      // Dokładnie ten sam błąd co przy chmurach (patrz
      // _bakeCloudTexture) - kształt każdej dekoracji jest stały (scale/seed
      // ustalone RAZ tutaj), więc pieczemy go RAZ TERAZ do małego canvasu;
      // draw() później tylko go przesuwa (i ewentualnie obraca/przyciemnia
      // dla animacji - patrz _drawFlowerDecor/_drawPuddleDecor).
      if (type === 'flower') this._bakeFlowerTexture(item);
      else if (type === 'puddle') this._bakePuddleTexture(item);
      else if (type === 'crystal') this._bakeCrystalDecorTexture(item);

      list.push(item);
    }
    return list;
  }

  /**
   * Generuje RAZ (w konstruktorze) garstkę "cieni chmur" - pozycje startowe
   * + prędkości/fazy, deterministycznie (ten sam mulberry32 co dekoracje,
   * osobny seed). Sam ruch liczony dopiero w _drawCloudShadows z
   * performance.now() - tu tylko geometria/parametry startowe.
   */
  _generateCloudShadows() {
    let seed = 0x9e3779b1;
    const rand = () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    const list = [];
    for (let i = 0; i < CLOUD_SHADOW_COUNT; i++) {
      const radius = CLOUD_SHADOW_RADIUS * (0.7 + rand() * 0.6);

      // BUGFIX ("chmury niech wyglądają jak chmury"): jedna gładka elipsa
      // czytała się jako zwykła rozmyta plama, nie jako kształt chmury.
      // Kilka nakładających się "płatów" wokół wspólnego środka (klasyczny
      // zarys chmury kłębiastej) - pozycje/rozmiary WZGLĘDEM radius,
      // wygenerowane RAZ, więc kształt jest stały, nie migocze losowo
      // klatka po klatce (patrz _drawCloudShadows).
      const lobeCount = 4 + Math.floor(rand() * 2);
      const lobes = [{ dx: 0, dy: 0, r: radius * 0.6 }]; // rdzeń na środku
      for (let j = 0; j < lobeCount; j++) {
        const a = (j / lobeCount) * Math.PI * 2 + rand() * 0.6;
        const dist = radius * (0.28 + rand() * 0.32);
        lobes.push({
          dx: Math.cos(a) * dist,
          dy: Math.sin(a) * dist * 0.55, // spłaszczone pionowo, jak reszta chmury
          r: radius * (0.4 + rand() * 0.3)
        });
      }

      const cloud = {
        startX: rand() * this.worldWidth,
        y: rand() * this.worldHeight,
        radius,
        speed: CLOUD_SHADOW_SPEED * (0.6 + rand() * 0.8),
        driftPhase: rand() * Math.PI * 2,
        lobes
      };
      // BUGFIX (przycinanie/lag): _drawCloudShadows dawniej odbudowywało ten
      // kształt na dużym (1300x1300px) buforze roboczym - clearRect +
      // kilka fill()i + PEŁNY destination-in na całym buforze - CO KLATKĘ,
      // dla KAŻDEJ widocznej chmury naraz (do kilku milionów pikseli/klatkę
      // tylko na to). Kształt każdej chmury jest stały (lobes ustalone RAZ
      // wyżej) - upiekamy go RAZ TERAZ do małego, dopasowanego do promienia
      // canvasu, a draw() później tylko go przesuwa (drawImage), zero
      // przeliczania geometrii/masek w pętli gry.
      this._bakeCloudTexture(cloud);
      list.push(cloud);
    }
    return list;
  }

  /**
   * Piecze kształt chmury (suma litych płatów + miękka maska na krawędzi
   * całości - patrz komentarz w _generateCloudShadows) RAZ do własnego,
   * dopasowanego do promienia tej chmury canvasu (cloud.texture). Wywołane
   * tylko przy starcie gry (garstka chmur), nigdy w pętli rysowania.
   *
   * BUGFIX (przycinanie/lag): źródłowa tekstura była pieczona w NATURALNYM
   * rozmiarze chmury (do ~1280px przy większych promieniach) - profil CPU
   * pokazał, że sam _drawCloudShadows (drawImage tej tekstury, co klatkę,
   * dla każdej widocznej chmury) to ~17% czasu klatki, mimo że kształt jest
   * już upieczony RAZ. Powód: to WCIĄŻ drawImage kopiujący/próbkujący do
   * MILIONA źródłowych pikseli za każdym wywołaniem. Kształt jest miękki i
   * rozmyty (suma kół + gradientowa maska, zero ostrych krawędzi) - w takiej
   * treści powiększenie przy rysowaniu jest wizualnie niewidoczne (w
   * przeciwieństwie do ostrych sprite'ów), więc pieczemy źródło w STAŁYM,
   * dużo mniejszym rozmiarze (CLOUD_SHADOW_BAKE_SIZE) niezależnie od
   * promienia, a _drawCloudShadows i tak rysuje go w docelowym rozmiarze
   * NA EKRANIE (cloud.textureSize) - ten sam efekt wizualny, dużo mniej
   * pikseli źródłowych do spróbkowania/przeskalowania KAŻDĄ klatkę.
   */
  _bakeCloudTexture(cloud) {
    const targetSize = Math.ceil(cloud.radius * 2.6); // rozmiar NA EKRANIE - bez zmian
    const bakeSize = Math.min(targetSize, CLOUD_SHADOW_BAKE_SIZE); // rozmiar ŹRÓDŁA - nowe
    const bakeScale = bakeSize / targetSize;
    const half = bakeSize / 2;
    const canvas = document.createElement('canvas');
    canvas.width = bakeSize;
    canvas.height = bakeSize;
    const tctx = canvas.getContext('2d');

    tctx.fillStyle = '#000000';
    cloud.lobes.forEach((lobe) => {
      tctx.beginPath();
      tctx.arc(half + lobe.dx * bakeScale, half + lobe.dy * bakeScale, lobe.r * bakeScale, 0, Math.PI * 2);
      tctx.fill();
    });

    tctx.globalCompositeOperation = 'destination-in';
    const maskGrad = tctx.createRadialGradient(half, half, 0, half, half, cloud.radius * 1.15 * bakeScale);
    maskGrad.addColorStop(0, 'rgba(0, 0, 0, 1)');
    maskGrad.addColorStop(0.75, 'rgba(0, 0, 0, 1)');
    maskGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    tctx.fillStyle = maskGrad;
    tctx.fillRect(0, 0, bakeSize, bakeSize);

    cloud.texture = canvas;
    // NA EKRANIE dalej ma być targetSize (docelowy wizualny rozmiar) -
    // _drawCloudShadows rysuje c.texture SKALOWANE do tego rozmiaru, nie w
    // jego rzeczywistym (mniejszym) rozmiarze źródłowym bakeSize.
    cloud.textureSize = targetSize;
  }

  /**
   * Rysuje dekoracje widoczne w aktualnym oknie kamery (z marginesem, żeby
   * obiekty tuż za krawędzią - a mają realną wysokość - też się pojawiły).
   * Czysto wizualne - żadnej logiki kolizji, gracz może przez nie przechodzić.
   *
   * Gdy tło świata jest już upieczone (this._worldBackgroundBaked - patrz
   * _bakeWorldBackground/_bakeStaticDecorations), CAŁA statyczna część
   * (cienie sprite'ów, 'rock'/'crate'/'sign') już tam siedzi na stałe - tutaj
   * zostaje tylko to, co FAKTYCZNIE się porusza (kołysanie tree/bush/shrub,
   * puls kałuży/kryształu, kwiat). Dopóki bake nie zdążył się wykonać
   * (krótkie okno na starcie, i tak schowane pod ekranem ładowania - patrz
   * main.js), rysujemy WSZYSTKO jak dawniej, żeby ekran nigdy nie został bez
   * cieni/kamieni/beczek.
   */
  _drawDecorations(ctx, camX, camY, viewW, viewH) {
    const margin = 120;
    const nowSec = performance.now() / 1000;
    const staticBaked = this._worldBackgroundBaked;

    this._decorations.forEach((d) => {
      if (d.x < camX - margin || d.x > camX + viewW + margin) return;
      if (d.y < camY - margin || d.y > camY + viewH + margin) return;

      // W pełni statyczne - już wypalone w tle, patrz komentarz wyżej.
      if (staticBaked && (d.type === 'rock' || d.type === 'crate' || d.type === 'sign')) return;

      if (DECOR_PROCEDURAL_TYPES.includes(d.type)) {
        this._drawProceduralDecor(ctx, d, nowSec);
        return;
      }

      const img = this._decorImages[d.type];
      if (!img || !img.complete || !img.naturalWidth) return;

      const h = DECOR_BASE_HEIGHT * d.scale * (DECOR_TYPE_SCALE[d.type] || 1);
      const w = h * (img.naturalWidth / img.naturalHeight);

      // BUGFIX ("kamienie latają"): środek cienia siedział 2px POD podstawą
      // sprite'a (d.y+2), nie NA niej - przy dużych dekoracjach (drzewo)
      // niezauważalne, ale przy najmniejszym typie (kamień, po fixie skali
      // wyżej wciąż mały) te 2px to spory procent całej wysokości obiektu,
      // więc cień wizualnie "odjeżdżał" od kamienia. Środek teraz DOKŁADNIE
      // na d.y. Cień też szerszy i mocniejszy niż wcześniej (0.3->0.42,
      // 0.2->0.3 alpha) - lepiej "kotwiczy" obiekt do podłoża, z minimalną
      // wysokością (Math.max), żeby przy małych dekoracjach nie ścieńczał
      // się do niewidocznej kreski.
      // Po bake'u cień jest już w tle (patrz _bakeStaticDecorations) - tu
      // rysujemy go tylko w krótkim oknie PRZED bakiem.
      if (!staticBaked) {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
        ctx.beginPath();
        ctx.ellipse(d.x, d.y, w * 0.42, Math.max(3, h * 0.14), 0, 0, Math.PI * 2);
        ctx.fill();
      }

      // Patrz DECOR_GROUND_OFFSET - dosuwa sprite w dół o zmierzony
      // przezroczysty margines pod grafiką (bush/shrub), 0 dla reszty typów.
      const groundOffset = h * (DECOR_GROUND_OFFSET[d.type] || 0);

      if (DECOR_SWAY_TYPES.includes(d.type)) {
        // Kołysanie na wietrze - pivot DOKŁADNIE w podstawie (d.x, d.y), więc
        // korona wychyla się widocznie, a podstawa stoi w miejscu (fizycznie
        // poprawne - roślina nie "pływa" nad ziemią). Patrz DECOR_SWAY_* wyżej.
        const sway = Math.sin(nowSec * DECOR_SWAY_SPEED + d.x * 0.01) * DECOR_SWAY_AMPLITUDE;
        ctx.save();
        ctx.translate(d.x, d.y);
        ctx.rotate(sway);
        ctx.drawImage(img, -w / 2, -h + groundOffset, w, h);
        ctx.restore();
      } else {
        ctx.drawImage(img, d.x - w / 2, d.y - h + groundOffset, w, h);
      }
    });
  }

  /**
   * Rozdziela typy dekoracji BEZ pliku PNG do ich dedykowanych rysowaczy.
   * Same kształty upieczone RAZ (patrz _bakeFlowerTexture/_bakePuddleTexture,
   * wołane z _generateDecorations) - tutaj tylko animacja i pozycjonowanie
   * gotowej tekstury, zero przeliczania geometrii co klatkę.
   */
  _drawProceduralDecor(ctx, d, nowSec) {
    if (d.type === 'flower') this._drawFlowerDecor(ctx, d, nowSec);
    else if (d.type === 'puddle') this._drawPuddleDecor(ctx, d, nowSec);
    else if (d.type === 'crystal') this._drawCrystalDecor(ctx, d, nowSec);
  }

  /**
   * Drobny kwiatek (Strefa A) - kępka trzech kwiatuszków, upieczona RAZ do
   * d.texture (patrz _bakeFlowerTexture). Jedyna rzecz liczona tu na bieżąco
   * to kołysanie na wietrze - CAŁA kępka kołysze się teraz jako jedna bryła
   * (wcześniej każdy kwiatuszek osobno, w przeciwnych kierunkach - drobna
   * wizualna uproszczenie w zamian za 1 drawImage zamiast ~50 fill/stroke).
   */
  _drawFlowerDecor(ctx, d, nowSec) {
    if (!d.texture) return;
    const sway = Math.sin(nowSec * DECOR_SWAY_SPEED + d.x * 0.01) * DECOR_SWAY_AMPLITUDE * 1.6;
    ctx.save();
    ctx.translate(d.x, d.y);
    ctx.rotate(sway);
    ctx.drawImage(d.texture, -d.textureAnchorX, -d.textureAnchorY);
    ctx.restore();
  }

  /**
   * Piecze RAZ (wołane z _generateDecorations) kępkę trzech kwiatuszków -
   * łodyżka + 5 płatków z obrysem + jasny środek, każdy - do małego canvasu.
   * d.textureAnchorX/Y to punkt w teksturze odpowiadający (d.x, d.y) w
   * świecie, żeby _drawFlowerDecor mogło go po prostu przesunąć/obrócić.
   */
  _bakeFlowerTexture(d) {
    const scale = d.scale * (DECOR_TYPE_SCALE.flower || 1);
    const palette = [
      ['#F48FB1', '#FFF9C4'],
      ['#FFEE58', '#FFFFFF'],
      ['#CE93D8', '#FFF9C4'],
      ['#81D4FA', '#FFFFFF']
    ];
    const [petalColor, centerColor] = palette[Math.floor(d.seed * palette.length) % palette.length];

    // Hojny, stały zapas miejsca wokół podstawy - prostsze i bezpieczniejsze
    // niż liczenie dokładnego bounding-boxa kępki, a przy takich rozmiarach
    // (rzędu kilkudziesięciu px) koszt marnowanej pamięci jest znikomy.
    const pad = 46 * scale;
    const texSize = Math.ceil(pad * 2);
    const anchorX = pad;
    const anchorY = pad + 6 * scale; // trochę niżej - kwiatki rosną W GÓRĘ od podstawy

    const canvas = document.createElement('canvas');
    canvas.width = texSize;
    canvas.height = texSize;
    const tctx = canvas.getContext('2d');

    const blossoms = [
      { dx: 0, dy: 0, s: 1 },
      { dx: -8 * scale, dy: 2.5 * scale, s: 0.72 },
      { dx: 7 * scale, dy: 3.5 * scale, s: 0.65 }
    ];

    blossoms.forEach((b) => {
      const bx = anchorX + b.dx;
      const by = anchorY + b.dy;
      const size = 11 * scale * b.s;

      tctx.fillStyle = 'rgba(0, 0, 0, 0.22)';
      tctx.beginPath();
      tctx.ellipse(bx, by, size * 0.5, size * 0.18, 0, 0, Math.PI * 2);
      tctx.fill();

      tctx.save();
      tctx.translate(bx, by);

      tctx.strokeStyle = '#4C7A3D';
      tctx.lineWidth = Math.max(1, size * 0.14);
      tctx.beginPath();
      tctx.moveTo(0, 0);
      tctx.lineTo(0, -size * 1.2);
      tctx.stroke();

      const petalR = size * 0.36;
      const cy = -size * 1.2;
      tctx.strokeStyle = 'rgba(0, 0, 0, 0.4)';
      tctx.lineWidth = Math.max(0.75, size * 0.05);
      for (let k = 0; k < 5; k++) {
        const a = (k / 5) * Math.PI * 2 + d.seed * 6;
        tctx.fillStyle = petalColor;
        tctx.beginPath();
        tctx.arc(Math.cos(a) * petalR * 0.8, cy + Math.sin(a) * petalR * 0.8, petalR, 0, Math.PI * 2);
        tctx.fill();
        tctx.stroke();
      }
      tctx.fillStyle = centerColor;
      tctx.beginPath();
      tctx.arc(0, cy, petalR * 0.6, 0, Math.PI * 2);
      tctx.fill();
      tctx.stroke();

      tctx.restore();
    });

    d.texture = canvas;
    d.textureAnchorX = anchorX;
    d.textureAnchorY = anchorY;
  }

  /**
   * Płaska toksyczna kałuża (Strefa B) - poświata upieczona RAZ do d.texture
   * (patrz _bakePuddleTexture). Na bieżąco liczony jest tylko delikatny
   * puls jasności (globalAlpha - tanie, żadnego przeliczania gradientu) i
   * pierścień "sonaru" (jedno stroke() na klatkę - to jedyna faktycznie
   * animowana geometria, więc zostaje liczona na żywo).
   */
  _drawPuddleDecor(ctx, d, nowSec) {
    if (!d.texture) return;
    const scale = d.scale * (DECOR_TYPE_SCALE.puddle || 1);
    const w = 34 * scale;
    const h = w * 0.42;
    const pulse = 0.5 + 0.5 * Math.sin(nowSec * 1.4 + d.seed * Math.PI * 2);

    ctx.save();
    ctx.globalAlpha = 0.82 + pulse * 0.18;
    ctx.drawImage(d.texture, d.x - d.textureAnchorX, d.y - d.textureAnchorY);
    ctx.restore();

    const ringT = (nowSec * 0.35 + d.seed) % 1;
    ctx.save();
    ctx.globalAlpha = (1 - ringT) * 0.4;
    ctx.strokeStyle = '#C5E1A5';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(d.x, d.y, (w / 2) * (0.3 + ringT * 0.7), (h / 2) * (0.3 + ringT * 0.7), 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  /** Piecze RAZ poświatę kałuży (radialny gradient - jedna z droższych
   * operacji Canvas, warta upieczenia najbardziej ze wszystkich trzech). */
  _bakePuddleTexture(d) {
    const scale = d.scale * (DECOR_TYPE_SCALE.puddle || 1);
    const w = 34 * scale;
    const h = w * 0.42;
    const pad = 4;
    const texW = Math.ceil(w + pad * 2);
    const texH = Math.ceil(h + pad * 2);
    const anchorX = texW / 2;
    const anchorY = texH / 2;

    const canvas = document.createElement('canvas');
    canvas.width = texW;
    canvas.height = texH;
    const tctx = canvas.getContext('2d');

    const grad = tctx.createRadialGradient(anchorX, anchorY, 0, anchorX, anchorY, w / 2);
    grad.addColorStop(0, 'rgba(150, 214, 120, 0.68)');
    grad.addColorStop(0.6, 'rgba(90, 150, 80, 0.4)');
    grad.addColorStop(1, 'rgba(60, 100, 60, 0)');
    tctx.fillStyle = grad;
    tctx.beginPath();
    tctx.ellipse(anchorX, anchorY, w / 2, h / 2, 0, 0, Math.PI * 2);
    tctx.fill();

    d.texture = canvas;
    d.textureAnchorX = anchorX;
    d.textureAnchorY = anchorY;
  }

  /**
   * Tonuje prawdziwą teksturę światła (fx_light_glow.png, Kenney "Light
   * Masks" CC0 - patrz sprites.js) na dowolny kolor, tą samą techniką
   * "source-atop" co GameFeel._getTintedGlow (gamefeel.js) i tint skinów
   * gracza (player.js) - własna kopia zgodnie z konwencją "brak
   * współdzielonych utili" w tym projekcie. Cache'owana per DOKŁADNY string
   * koloru, więc każdy unikalny kolor liczy się raz, nie co klatkę.
   */
  _getTintedCrystalGlow(color) {
    this._crystalGlowCache = this._crystalGlowCache || {};
    if (this._crystalGlowCache[color]) return this._crystalGlowCache[color];
    const img = window.spriteLoader && window.spriteLoader.get('fx_light_glow');
    if (!img || !img.complete || !img.naturalWidth) return null;
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const tctx = canvas.getContext('2d');
    tctx.drawImage(img, 0, 0);
    tctx.globalCompositeOperation = 'source-atop';
    tctx.fillStyle = color;
    tctx.fillRect(0, 0, w, h);
    this._crystalGlowCache[color] = canvas;
    return canvas;
  }

  /**
   * Kępka kryształów Strefy D (Kryształowa Grań) - kilka ostrych, przeźro-
   * czystych "iglic" różnej wysokości sterczących z ziemi, plus subtelny
   * pulsujący blask u podstawy (ta sama filozofia co pulsujący pierścień
   * kałuży - _drawPuddleDecor - żywe tło zamiast martwej naklejki). Blask
   * to teraz prawdziwa miękka teksturka światła (Kenney Light Masks,
   * _getTintedCrystalGlow) zamiast płaskiej elipsy jednego koloru - pulsuje
   * jednocześnie przezroczystością I skalą (rdzeń "oddycha"), rysowana pod
   * spodem PRZEZ 'lighter' (addytywnie), żeby faktycznie czytała się jako
   * światło, nie jako naklejona plama. KSZTAŁT kryształów upieczony RAZ
   * (patrz _bakeCrystalDecorTexture) - tutaj tylko przesunięcie gotowej
   * tekstury + osobno rysowany, animowany blask.
   */
  _drawCrystalDecor(ctx, d, nowSec) {
    if (!d.texture) return;
    const scale = d.scale * (DECOR_TYPE_SCALE.crystal || 1);
    const pulse = 0.5 + 0.5 * Math.sin(nowSec * 1.8 + d.seed * Math.PI * 2);

    const glow = this._getTintedCrystalGlow('#B39DDB');
    if (glow) {
      const r = 22 * scale * (0.85 + pulse * 0.25);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.35 + pulse * 0.35;
      ctx.drawImage(glow, d.x - r, d.y - r * 0.65, r * 2, r * 1.3);
      ctx.restore();
    } else {
      // Fallback (tekstura jeszcze niewczytana) - dawna płaska elipsa,
      // żeby kryształ nigdy nie został kompletnie bez podstawy blasku.
      ctx.save();
      ctx.globalAlpha = 0.55 + pulse * 0.35;
      ctx.fillStyle = '#B39DDB';
      ctx.beginPath();
      ctx.ellipse(d.x, d.y, 10 * scale, 4 * scale, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    ctx.drawImage(d.texture, d.x - d.textureAnchorX, d.y - d.textureAnchorY);
  }

  /** Piecze RAZ kępkę 3 kryształowych iglic (cień + gradient fioletu/błękitu
   * + jasna krawędź "szkła") - proceduralna bryła w tym samym duchu co
   * MachineManager._drawHull (pionowy gradient blachy, machines.js). */
  _bakeCrystalDecorTexture(d) {
    const scale = d.scale * (DECOR_TYPE_SCALE.crystal || 1);
    const pad = 8;
    const texW = Math.ceil(34 * scale + pad * 2);
    const texH = Math.ceil(40 * scale + pad * 2);
    const anchorX = texW / 2;
    const anchorY = texH - pad;

    const canvas = document.createElement('canvas');
    canvas.width = texW;
    canvas.height = texH;
    const tctx = canvas.getContext('2d');
    const baseX = anchorX;
    const baseY = anchorY;

    // Iglice od najniższej/skrajnej do najwyższej/środkowej - rysowanie w tej
    // kolejności daje naturalne zachodzenie na siebie (środkowa na wierzchu).
    const spikes = [
      { dx: -9 * scale, h: 20 * scale, w: 5 * scale, tilt: -0.25 },
      { dx: 8 * scale, h: 24 * scale, w: 5.5 * scale, tilt: 0.2 },
      { dx: 0, h: 34 * scale, w: 7 * scale, tilt: 0 }
    ];

    // Wspólny cień u podstawy CAŁEJ kępki (pod wszystkimi iglicami naraz).
    tctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
    tctx.beginPath();
    tctx.ellipse(baseX, baseY, 15 * scale, 4.5 * scale, 0, 0, Math.PI * 2);
    tctx.fill();

    spikes.forEach((s) => {
      tctx.save();
      tctx.translate(baseX + s.dx, baseY);
      tctx.rotate(s.tilt);

      const grad = tctx.createLinearGradient(-s.w / 2, 0, s.w / 2, 0);
      grad.addColorStop(0, '#4527A0');
      grad.addColorStop(0.5, '#B39DDB');
      grad.addColorStop(1, '#7E57C2');
      tctx.fillStyle = grad;
      // BUGFIX ("kryształy nie pasują do reszty"): brakowało CIEMNEGO obrysu
      // - jedyna krawędź była JASNA (rgba(255,255,255,0.5)), więc kształt
      // "pływał" bez zakotwiczenia, w przeciwieństwie do KAŻDEJ innej
      // proceduralnej dekoracji w grze (kwiatek/kałuża - obie mają ciemny,
      // definiujący kontur, patrz _bakeFlowerTexture/_bakePuddleTexture).
      // Ciemny obrys teraz PIERWSZY (definiuje sylwetkę), jasna "szklana"
      // krawędź osobno, jako DODATKOWY detal na wierzchu.
      tctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
      tctx.lineWidth = 1.2;
      tctx.beginPath();
      tctx.moveTo(0, 0);
      tctx.lineTo(-s.w / 2, -s.h * 0.35);
      tctx.lineTo(0, -s.h);
      tctx.lineTo(s.w / 2, -s.h * 0.35);
      tctx.closePath();
      tctx.fill();
      tctx.stroke();

      // Jasna "szklana" krawędź po jednej stronie - sprzedaje wrażenie
      // ostrego, oszlifowanego kryształu zamiast płaskiego trójkąta.
      tctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
      tctx.lineWidth = 1;
      tctx.beginPath();
      tctx.moveTo(0, -s.h * 0.05);
      tctx.lineTo(0, -s.h * 0.92);
      tctx.stroke();

      tctx.restore();
    });

    d.texture = canvas;
    d.textureAnchorX = anchorX;
    d.textureAnchorY = anchorY;
  }

  /**
   * Kilka wielkich, miękkich (na SAMEJ krawędzi) plam przesuwających się
   * poziomo po całej mapie w pętli (jak cień chmury sunący po ziemi) - tani
   * sposób na "żywe niebo" bez prawdziwej warstwy chmur. Rysowane MIĘDZY
   * teksturami terenu a dekoracjami (patrz _drawBackground) - przyciemniają
   * grunt, ale nie zasłaniają drzew/kamieni nad nimi.
   *
   * BUGFIX ("chmury niech wyglądają jak chmury"): pierwsza wersja rysowała
   * KAŻDY płat jako osobny miękki gradient - nakładające się gradienty po
   * prostu zlewały się w jedną gładką, amorficzną plamę bez czytelnego
   * zarysu. Teraz płaty są sumą litych kół (ostry, kłębiasty/powycinany
   * zarys "cumulusa" - klasyczna technika) z jedną wspólną miękką krawędzią
   * - ale ZERO liczenia tego tutaj: kształt jest upieczony RAZ na start gry
   * (patrz _bakeCloudTexture/_generateCloudShadows), więc ta metoda robi
   * już tylko tanie drawImage() na aktualnej pozycji.
   *
   * BUGFIX (przycinanie/lag): poprzednia wersja odbudowywała cały bufor
   * (clearRect + kilka fill()i + PEŁNY destination-in na 1300x1300px) CO
   * KLATKĘ, dla KAŻDEJ widocznej chmury - kilka milionów pikseli/klatkę
   * tylko na cienie. Patrz komentarz w _generateCloudShadows.
   */
  _drawCloudShadows(ctx, camX, camY, viewW, viewH) {
    const t = performance.now() / 1000;
    const span = this.worldWidth + CLOUD_SHADOW_RADIUS * 2;

    ctx.save();
    ctx.globalAlpha = CLOUD_SHADOW_ALPHA;
    this._cloudShadows.forEach((c) => {
      // Zawijanie w poziomie na szerokość świata + zapas o promień z każdej
      // strony, żeby plama znikała/pojawiała się PŁYNNIE za krawędzią mapy,
      // zamiast "teleportować się" widocznie na środku ekranu.
      let x = (c.startX + t * c.speed) % span;
      if (x < 0) x += span;
      x -= CLOUD_SHADOW_RADIUS;
      const y = c.y + Math.sin(t * 0.12 + c.driftPhase) * 40;

      if (x + c.radius < camX - 20 || x - c.radius > camX + viewW + 20) return;
      if (y + c.radius < camY - 20 || y - c.radius > camY + viewH + 20) return;
      if (!c.texture) return;

      const half = c.textureSize / 2;
      // Jawny docelowy rozmiar (c.textureSize) - c.texture.width jest teraz
      // MNIEJSZA (patrz CLOUD_SHADOW_BAKE_SIZE w _bakeCloudTexture), więc bez
      // tego drawImage narysowałby chmurę w jej (mniejszym) rozmiarze
      // źródłowym zamiast docelowego rozmiaru na ekranie.
      ctx.drawImage(c.texture, x - half, y - half, c.textureSize, c.textureSize);
    });
    ctx.restore();
  }

  /**
   * Wyzwala efekt screen shake (np. w reakcji na Events.FX_SHAKE).
   */
  triggerShake(data) {
    this.shakeIntensity = (data && data.intensity) || 5;
    this.shakeDuration = (data && data.duration) || 300;
  }

  /**
   * Dopasowuje rozmiar canvasu do okna.
   *
   * BUGFIX ("postać w słabej jakości" na telefonie): bufor canvasu miał
   * dotąd DOKŁADNIE w/h pikseli CSS - na ekranie z devicePixelRatio 2-3
   * (każdy nowszy telefon) to MNIEJ fizycznych pikseli niż realny ekran,
   * więc przeglądarka rozciąga bufor przy wyświetlaniu -> rozmycie całej
   * gry, nie tylko postaci. Bufor ma teraz dpr-krotnie więcej pikseli
   * (ostry rendering), a setTransform() kompensuje to W PRZESTRZENI
   * RYSOWANIA, więc WSZYSTKIE istniejące współrzędne (kamera, pozycje,
   * culling) nadal są w tych samych "logicznych" pikselach CSS co dotąd -
   * ŻADNA inna metoda rysująca nie musiała się zmienić.
   *
   * WYJĄTEK: kilka miejsc czytało canvas.width/height WPROST jako "rozmiar
   * widoku" zamiast dostawać go w parametrze - _updateCamera/_drawZoneTint/
   * _drawVignette tutaj oraz ambient.js/critters.js/gamefeel.js/minimap.js -
   * te musiały zostać przepisane na window.innerWidth/innerHeight (patrz
   * komentarze przy nich), bo po tej zmianie canvas.width/height znaczy już
   * fizyczne piksele bufora, nie logiczne piksele CSS. clearRect() NIE
   * wymagał zmiany - z fizycznymi wymiarami i tak czyści cały bufor (co
   * najwyżej "nadmiarowo", nigdy za mało).
   *
   * dpr ograniczone do sufitu GAME_QUALITY_DPR_STEPS (1.5x, nie surowe
   * devicePixelRatio, które na części telefonów sięga 3-4) - koszt (pikseli
   * do wypełnienia KAŻDĄ klatkę) rośnie z KWADRATEM mnożnika, więc zysk
   * ostrości powyżej tego progu nie jest wart ceny.
   */
  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    // GAME_QUALITY_DPR_STEPS ma jeden element (patrz komentarz tam) - sufit
    // jest więc w praktyce stały. Nadal ograniczone przez PRAWDZIWE
    // devicePixelRatio: na ekranie 1x renderowanie w 1.5x to czysta strata
    // (i tak nie widać różnicy).
    const qualityCap = GAME_QUALITY_DPR_STEPS[this._qualityLevel];
    const dpr = Math.min(window.devicePixelRatio || 1, qualityCap);
    this.dpr = dpr;

    // Jeden canvas (patrz konstruktor) - canvasBackground/canvasGameplay/
    // canvasUI to ten sam element, więc jedno przypisanie wystarczy.
    this.canvasBackground.width = Math.round(w * dpr);
    this.canvasBackground.height = Math.round(h * dpr);

    // Ustawienie .width/.height zeruje macierz transformacji kontekstu (spec
    // canvas) - trzeba ją odtworzyć PO KAŻDYM resize (nie tylko raz przy
    // starcie), inaczej po obrocie ekranu/zmianie rozmiaru okna rendering
    // wróciłby do 1:1 i znowu byłby rozmyty. setTransform (nie scale) -
    // ustawia macierz wprost zamiast ją mnożyć, więc wielokrotne wywołania
    // resize() nigdy się nie skumulują w błędną skalę.
    this.ctxBackground.setTransform(dpr, 0, 0, dpr, 0, 0);

    Bus.publish(Events.RESIZE, { width: w, height: h });
  }
}

window.Game = Game;