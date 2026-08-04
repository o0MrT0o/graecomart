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
// BUGFIX (Tomek: "ta trawa dobrze wygląda? może zamienimy ją na inny
// krzaczek"): grass_tuft.png BYŁO sprite_0002 z tej samej paczki - cienkie,
// kłujące źdźbła, przy małym rozmiarze w grze czytały się jako "chwasty".
// Podmienione na sprite_0009 - te same zaokrąglone liście zamiast ostrych
// szpikulców, ale WCIĄŻ inny kształt niż bush.png/shrub.png (te są okrągłymi
// "kulami" liści z Kenney RPG Pack) - żeby nie zdublować już istniejącego
// typu dekoracji, tylko dać trawie własną, mniej kłującą tożsamość.
const DECOR_TYPES = ['tree', 'bush', 'rock', 'shrub', 'crate', 'sign', 'grass_tuft', 'fern'];

// Warianty dekoracji per planeta (Tomek: "na innych prestige'ach daj inną
// roślinność i inne dodatki typu te skrzynki itd, tylko inne w podobnych
// ilościach") - NIEZALEŻNE od GAME_PLANET_VISUAL_FILTERS wyżej: tamten
// przebarwia CAŁE upieczone tło jednym globalnym filtrem, ten podmienia
// SAME pliki/kształty sprite'ów. Trzy zestawy, wybierane deterministycznie
// z planetNumber (patrz _currentDecorSet) - _generateDecorations (typ/
// pozycja/liczba/skala każdej dekoracji) zostaje CAŁKOWICIE bez zmian, ta
// tablica zmienia tylko to, JAKI obrazek rysujemy dla danego typu/miejsca.
// BRAK klucza "rock" w każdym zestawie - kamień NIE jest już częścią
// DECOR_SETS (Tomek: "ten oryginalny kamień usuń całkowicie" - oryginalny
// rock.png usunięty z projektu), tylko osobnej puli ROCK_VARIANT_SRC niżej,
// współdzielonej między wszystkimi trzema zestawami (patrz komentarz tam) -
// DECOR_SET_IMAGE_TYPES (niżej) pomija "rock" przy wczytywaniu/sprawdzaniu
// gotowości tych obiektów.
const DECOR_SETS = [
  {
    // Zestaw 0 - domyślny (oryginalne assety, patrz stary DECOR_SRC).
    tree: 'assets/decor/tree.png',
    bush: 'assets/decor/bush.png',
    shrub: 'assets/decor/shrub.png',
    crate: 'assets/decor/crate.png',
    sign: 'assets/decor/sign.png',
    grass_tuft: 'assets/decor/grass_tuft.png'
    // fern USUNIĘTY stąd (patrz FERN_VARIANT_SRC niżej) - dostał WŁASNY
    // mechanizm wariantów kształtu, ten sam duch co rock (ROCK_VARIANT_SRC).
  },
  {
    // Zestaw 1 - "iglasty/mroźny" (Kenney Background Elements Remastered dla
    // tree/bush/shrub, Platformer Pack Remastered dla crate, i Foliage
    // Sprites dotintowane offline chłodną zielenią, dla grass_tuft/fern).
    // sign: WRÓCIŁ do zwykłej tabliczki zestawu 0 (Tomek: "na ash są
    // tabliczki jakieś strzałki, usuń") - sign_alt1 (signRight.png) była
    // strzałką, czyli DOKŁADNIE tym samym problemem co usunięta wcześniej
    // tabliczka "EXIT" (signExit.png) - sugeruje kierunek/wyjście, czego
    // ambientowa dekoracja nie powinna robić. "sign" i tak spawnuje
    // WYŁĄCZNIE w Strefie C (patrz zoneTypes w _generateDecorations), więc
    // brak osobnej grafiki na zestaw nie odbiera żadnej realnej różnorodności -
    // tę i tak daje EXTRA_PROP_VARIANT_SRC (4 warianty przemysłowe).
    tree: 'assets/decor/tree_alt1.png',
    bush: 'assets/decor/bush_alt1.png',
    shrub: 'assets/decor/shrub_alt1.png',
    crate: 'assets/decor/crate_alt1.png',
    sign: 'assets/decor/sign.png',
    grass_tuft: 'assets/decor/grass_tuft_alt1.png'
  },
  {
    // Zestaw 2 - "pustynny" (palma z Background Elements Remastered, inna
    // skrzynia z Platformer Pack Remastered, Foliage Sprites dotintowane
    // offline piaskowym odcieniem). bush/shrub BYŁY kaktusami (bushAlt/
    // cactus z tej samej paczki) - Tomek: "z biomu bagna usuń kaktusy [...]
    // i na zwykłej trawie też są kaktusy, wyjebaj to". "shrub" spawnuje w
    // Strefie A (trawa) ORAZ w Strefie B (bagno) - patrz zoneTypes w
    // _generateDecorations - jeden kaktusowaty asset per zestaw ląduje więc
    // WSZĘDZIE, łącznie z bagnem, gdzie wygląda absurdalnie. Zamienione na
    // suchy, pomarańczowawy krzak (bushOrange1/4, ta sama paczka) - sensowny
    // zarówno na piaszczystej trawie, jak i na uschniętym skrawku bagna,
    // bez kaktusowej sylwetki. sign: jak wyżej, sign_alt2 (signLeft.png)
    // była TĄ SAMĄ strzałką co w zestawie 1, tylko odwróconą - ten sam fix.
    tree: 'assets/decor/tree_alt2.png',
    bush: 'assets/decor/bush_alt2.png',
    shrub: 'assets/decor/shrub_alt2.png',
    crate: 'assets/decor/crate_alt2.png',
    sign: 'assets/decor/sign.png',
    grass_tuft: 'assets/decor/grass_tuft_alt2.png'
  }
];
// Typy wczytywane/sprawdzane PER ZESTAW (patrz _decorImageSets/_decorImagesReady)
// - "rock"/"fern" celowo pominięte, mają WŁASNE pule wariantów kształtu
// (ROCK_VARIANT_SRC/FERN_VARIANT_SRC niżej).
const DECOR_SET_IMAGE_TYPES = DECOR_TYPES.filter((type) => type !== 'rock' && type !== 'fern');

// Warianty KSZTAŁTU paproci, PER ZESTAW dekoracji (Tomek: "Paproć [...] bez
// wariantów [...] nie ten sam zestaw poprawek co reszta" - rock dostał
// ROCK_VARIANT_SRC, teraz fern dostaje analogiczny mechanizm). W
// przeciwieństwie do roku paproć NIE MOŻE mieć jednej wspólnej puli
// niezależnej od planety - jej KOLOR (oliwkowy/turkusowy/piaskowy) jest
// częścią tożsamości danego DECOR_SETS, więc wariant jest tablicą TABLIC:
// [zestaw][wariant]. Oba kształty ("wijąca się łodyga" i "kępka listków")
// już wcześniej istniały osobno w projekcie (zestaw zimowy miał inny
// kształt niż 0/2) - teraz KAŻDY zestaw dostaje OBA, przetintowane offline
// w SWOIM odcieniu (ten sam dwustopniowy gradient co oryginalny plik tego
// zestawu, zmierzony wprost z pikseli i odtworzony na drugim kształcie).
const FERN_VARIANT_SRC = [
  ['assets/decor/fern.png', 'assets/decor/fern_var2.png'],
  ['assets/decor/fern_alt1.png', 'assets/decor/fern_alt1_var2.png'],
  ['assets/decor/fern_alt2.png', 'assets/decor/fern_alt2_var2.png']
];
// BUGFIX (Tomek: "Strefa D [...] wygląda pusto" - okazało się DUŻO gorsze
// niż "mało wariantów"): 'crystal' NIGDY nie było tu wpisane, mimo że
// _drawProceduralDecor (niżej) od zawsze umie je narysować i
// _generateDecorations od zawsze piecze mu teksturę (_bakeCrystalDecorTexture).
// _drawDecorations sprawdza WYŁĄCZNIE ten check przed przekazaniem dekoracji
// do _drawProceduralDecor - bez 'crystal' tutaj każda kępka kryształów w
// Strefie D po cichu przepadała (_decorImages['crystal'] nie istnieje, bo
// 'crystal' nie jest częścią DECOR_SETS, więc trafiała w `if (!img) return`
// kawałek niżej). W praktyce Strefa D od zawsze pokazywała tylko 'rock'
// (1/3 wagi w zoneTypes.D) - reszta (2/3, 'crystal') była niewidzialna, stąd
// wrażenie dużo bardziej pustej/powtarzalnej strefy niż A/B/C.
const DECOR_PROCEDURAL_TYPES = ['flower', 'puddle', 'crystal'];

// Warianty POJEDYNCZEGO kamienia (Tomek: "znajdź jakieś fajne kamienie w
// tych paczkach i podmień aktualne na różne warianty", potem "ten oryginalny
// kamień usuń całkowicie" - stary rock.png usunięty z projektu, zostają
// TYLKO te dwa) - NIEZALEŻNE od DECOR_SETS/planetNumber: to nie inny zestaw
// per planeta, tylko wizualna odmiana MIĘDZY POSZCZEGÓLNYMI kamieniami na
// TEJ SAMEJ planecie (jeden wylosowany RAZ per egzemplarz w
// _generateDecorations - patrz item.rockVariant), więc obie te grafiki są
// dostępne na wszystkich trzech zestawach. var2 (Platformer Pack Remastered -
// ta sama paczka co crate.png/sign.png) i var3 (New Platformer Pack) - oba
// stylistycznie pasują do już użytych assetów z tych samych paczek.
const ROCK_VARIANT_SRC = ['assets/decor/rock_var2.png', 'assets/decor/rock_var3.png'];

// "Zamiennik" skrzyni/tabliczki (Tomek: "Strefa C jest zdominowana przez
// skrzynki i tabliczki, znajdź w paczkach czym można to zróżnicować, ale
// zamiast dodawać kolejne obiekty na mapie zastąp trochę istniejących
// skrzynek/tabliczek nowymi rzeczami") - część egzemplarzy typu crate/sign
// (patrz item.useAltProp w _generateDecorations, losowane RAZ per
// egzemplarz) rysuje się jednym z tych obrazków zamiast obrazka z
// aktywnego DECOR_SETS - CAŁKOWICIE NOWE rekwizyty (Kenney Platformer Pack
// Industrial + Remastered), nie kolejne warianty tego samego kształtu.
// Każdy typ to TABLICA (nie pojedynczy plik) - "sign" ma teraz 4 warianty
// (patrz item.altPropVariant), wybrane przez Tomka po obejrzeniu kilku rund
// propozycji ("043, 057, zniszczone ogrodzenie są git, gruz też"):
// pas ostrzegawczy / zaślepiony panel z X / zniszczone ogrodzenie / gruz -
// scenografia opuszczonej instalacji, nie pojedynczy rekwizyt-gadżet
// (wcześniej odrzucone: piła/dźwignia/przycisk - "wyglądają jak gadżet do
// kliknięcia, nie jak scenografia"; tabliczka z wykrzyknikiem i pochodnia -
// patrz historia w komitach). "crate" zostaje przy JEDNYM wariancie
// (beczka) - tablica i tak, dla jednolitego kodu wczytywania/losowania
// niżej. BEZ rotacji (w przeciwieństwie do ROCK_VARIANT_SRC) - Tomek: "bez
// losowego obrotu, bo jak tabliczka czy skrzynia do góry nogami" - to
// "zaprojektowane" obiekty z czytelną górą/dołem, tak samo jak oryginalne
// crate/sign. Współdzielone między wszystkimi trzema DECOR_SETS (te same
// rekwizyty niezależnie od planety), tak jak ROCK_VARIANT_SRC wyżej.
const EXTRA_PROP_VARIANT_SRC = {
  crate: ['assets/decor/crate_var2.png'],
  sign: [
    'assets/decor/sign_var2.png', // pas ostrzegawczy
    'assets/decor/sign_var3.png', // zaślepiony panel z X
    'assets/decor/sign_var4.png', // zniszczone ogrodzenie
    'assets/decor/sign_var5.png'  // gruz/płyta
  ]
};

// Sejdy PRNG narzutu na podłoże per zestaw dekoracji (patrz
// _drawGroundOverlay) - 0 = brak narzutu (zestaw domyślny, ziemia zostaje
// bez zmian, tak samo jak pierwsza planeta zostaje bez GAME_PLANET_VISUAL_
// FILTERS). Deterministyczne, stałe wartości (nie losowane per-planeta) -
// każda planeta z tym samym zestawem dekoracji dostaje identyczny narzut,
// spójnie z resztą upieczonego tła (tekstury/dekoracje też nie losują się
// od nowa przy każdym prestige, tylko WYBÓR zestawu/modyfikatora się zmienia).
const GROUND_OVERLAY_SEEDS = [0, 0x46524f53, 0x53414e44]; // 0, 'FROS', 'SAND'
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
  // Mały, STATYCZNY odłamek (Strefa D) - naziemny wypełniacz gęstości, ten
  // sam duch co grass_tuft w Strefie A (patrz _bakeCrystalShardTexture) -
  // wyraźnie mniejszy niż główna kępka (crystal: 1.1), żeby czytał się jako
  // drobny akcent, nie duplikat tej samej dekoracji.
  shard: 0.4,
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

// --- Cykl dnia i nocy (Tomek: "cyklu dnia/nocy zrób") -----------------------
// Własny, przyspieszony zegar odmierzany CZASEM AKTYWNEJ GRY (ten sam `delta`
// co reszta update()), NIE zegarem systemowym - gracz grający wyłącznie
// wieczorem realnie nigdy nie zobaczyłby dnia w grze, gdyby cykl podążał za
// prawdziwą porą doby. 10 minut na pełny obrót - wystarczająco długo, żeby
// przejścia nie były nerwowe, wystarczająco krótko, żeby jedna dłuższa sesja
// zdążyła zobaczyć cały cykl (dzień, zmierzch, noc, świt) chociaż raz.
const GAME_DAY_NIGHT_CYCLE_MS = 10 * 60 * 1000;
// Tabela klatek kluczowych (ten sam duch co AUDIO_MUSIC_TRACKS w audio.js -
// dane zamiast wzoru, łatwiej dostroić niż grzebać w trygonometrii) -
// phase 0..1 pozycja w cyklu, r/g/b/alpha nakładka na CAŁY ekran (jak
// _drawZoneTint, tylko dla pory doby zamiast strefy), starLight 0..1
// widoczność gwiazd (patrz _drawStars). Interpolowane LINIOWO między
// sąsiednimi klatkami (patrz _getDayNightBlend) - stąd gęściej rozstawione
// klatki w okolicach świtu/zmierzchu (szybsza zmiana) niż w środku nocy/dnia
// (długie, stabilne plateau).
const GAME_DAY_NIGHT_KEYFRAMES = [
  { phase: 0.00, r: 12, g: 16, b: 42, alpha: 0.55, starLight: 1 }, // północ
  { phase: 0.20, r: 12, g: 16, b: 42, alpha: 0.55, starLight: 1 }, // wciąż głęboka noc
  { phase: 0.27, r: 255, g: 140, b: 70, alpha: 0.30, starLight: 0.15 }, // świt - złota godzina
  { phase: 0.35, r: 255, g: 210, b: 140, alpha: 0.06, starLight: 0 }, // wschód, nakładka prawie znika
  { phase: 0.50, r: 255, g: 255, b: 255, alpha: 0.00, starLight: 0 }, // południe, brak nakładki
  { phase: 0.65, r: 255, g: 210, b: 140, alpha: 0.06, starLight: 0 }, // popołudnie
  { phase: 0.73, r: 255, g: 100, b: 55, alpha: 0.32, starLight: 0.15 }, // zmierzch - złota godzina
  { phase: 0.80, r: 12, g: 16, b: 42, alpha: 0.55, starLight: 1 }, // zapada noc
  { phase: 1.00, r: 12, g: 16, b: 42, alpha: 0.55, starLight: 1 } // = phase 0, domyka pętlę
];

// Wizualna odmiana planety (Tomek: "wizualna różnorodność między planetami -
// te same 4 strefy na każdej kolejnej planecie, tylko liczby się zmieniają").
// Zamiast nowych tekstur/assetów - jeden globalny filtr CSS Canvas 2D
// (hue-rotate/saturate/brightness) nałożony na CAŁE upieczone tło świata,
// kluczowany DOKŁADNIE tym samym modyfikatorem planety, który gracz już
// widzi w toaście "Nowa planeta" (economy.js: PLANET_MODIFIERS/
// activeModifier) - liczby I kolory mówią to samo za jednym razem ("to jest
// Gorączka Złota" = złocisty odcień + wyższe ceny), zero nowego stanu do
// synchronizowania. Pierwsza planeta (activeModifier === null) zostaje BEZ
// filtra - oryginalny, znany wygląd na start, żeby samouczek nie tłumaczył
// świata, który wygląda inaczej niż wszystkie zrzuty ekranu/materiały gry.
const GAME_PLANET_VISUAL_FILTERS = {
  bountiful: 'hue-rotate(15deg) saturate(1.15)',
  scarce: 'hue-rotate(-20deg) saturate(0.65) brightness(0.95)',
  efficient_factory: 'hue-rotate(150deg) saturate(1.05)',
  rusty_gear: 'hue-rotate(-50deg) saturate(1.15) brightness(0.95)',
  gold_rush: 'hue-rotate(35deg) saturate(1.25) brightness(1.08)',
  soft_landing: 'hue-rotate(190deg) saturate(0.85) brightness(1.05)'
};

// Filtr koloru KLUCZOWANY ZESTAWEM DEKORACJI (patrz DECOR_SETS/
// _currentDecorSetIndex), nie modyfikatorem planety - Tomek: "filtr świata
// miał być niebieski na zimowym świecie, a nie szron" (poprawka po tym, jak
// pierwsza próba przebarwiła same plamy szronu w _drawGroundOverlay zamiast
// całego świata). Indeks 0 (domyślny) celowo bez własnego filtra - tylko
// "zimowy" (indeks 1, sosny/szron) dostaje wyraźnie niebieski hue-rotate, a
// "pustynny" (indeks 2, palmy/kaktusy) - żółty/wypłowiały (Tomek: "na
// pustynnym świecie niech wszystko będzie bardziej żółte, suche") - łączone
// w _currentPlanetFilter() z filtrem modyfikatora planety (dwie NIEZALEŻNE,
// jednocześnie aktywne warstwy przebarwienia - patrz komentarz tam).
const GAME_DECOR_SET_FILTERS = [
  null,
  'hue-rotate(100deg) saturate(0.9) brightness(1.05)',
  'hue-rotate(-35deg) saturate(1.05) brightness(1.08)'
];

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
    // Wczytujemy WSZYSTKIE zestawy (DECOR_SETS) od razu, nie tylko bieżący -
    // dzięki temu zmiana zestawu po prestige (patrz PRESTIGE_DONE w
    // _bindEvents) jest natychmiastowa (bez czekania na dociągnięcie nowych
    // obrazków w środku sesji) kosztem kilkunastu dodatkowych, malutkich
    // plików wczytanych z góry na ekranie ładowania.
    this._decorImageSets = DECOR_SETS.map((set) => {
      const images = {};
      DECOR_SET_IMAGE_TYPES.forEach((type) => {
        const img = new Image();
        readyPromises.push(new Promise((resolve) => {
          img.onload = () => resolve();
          img.onerror = () => {
            console.warn(`[Game] Nie udało się wczytać dekoracji ${type} (${set[type]}).`);
            resolve();
          };
        }));
        img.src = set[type];
        images[type] = img;
      });
      return images;
    });
    // Wskaźnik na AKTYWNY zestaw (patrz _currentDecorSet) - reszta kodu
    // (_decorImagesReady/_bakeStaticDecorations/_drawDecorations) używa
    // wyłącznie this._decorImages, bez wiedzy o istnieniu innych zestawów.
    this._decorImages = this._decorImageSets[this._currentDecorSetIndex()];

    // Warianty kształtu paproci (patrz FERN_VARIANT_SRC) - PER ZESTAW, w
    // przeciwieństwie do ROCK_VARIANT_SRC niżej (kolor paproci musi zostać
    // zgodny z aktywnym DECOR_SETS) - stąd tablica TABLIC, nie płaska lista.
    // this._activeFernVariants (jak this._decorImages wyżej) wskazuje na
    // AKTYWNY zestaw wariantów - reszta kodu go używa bez wiedzy o innych.
    this._fernVariantImageSets = FERN_VARIANT_SRC.map((variants, setIdx) => variants.map((src, i) => {
      const img = new Image();
      readyPromises.push(new Promise((resolve) => {
        img.onload = () => resolve();
        img.onerror = () => {
          console.warn(`[Game] Nie udało się wczytać wariantu paproci ${setIdx}/${i} (${src}).`);
          resolve();
        };
      }));
      img.src = src;
      return img;
    }));
    this._activeFernVariants = this._fernVariantImageSets[this._currentDecorSetIndex()];

    // Warianty kamienia (patrz ROCK_VARIANT_SRC) - WSPÓLNE dla wszystkich
    // trzech DECOR_SETS (rock i tak jest tam identyczny w każdym), więc
    // wczytywane RAZ, osobno od _decorImageSets wyżej.
    this._rockVariantImages = ROCK_VARIANT_SRC.map((src, i) => {
      const img = new Image();
      readyPromises.push(new Promise((resolve) => {
        img.onload = () => resolve();
        img.onerror = () => {
          console.warn(`[Game] Nie udało się wczytać wariantu kamienia ${i} (${src}).`);
          resolve();
        };
      }));
      img.src = src;
      return img;
    });

    // Zamienniki skrzyni/tabliczki (patrz EXTRA_PROP_VARIANT_SRC) - ten sam
    // wzorzec co warianty kamienia wyżej, tylko zagnieżdżony: klucz to TYP
    // (crate/sign), wartość to TABLICA obrazków (każdy typ może mieć inną
    // liczbę wariantów - "sign" ma 4, "crate" 1).
    this._extraPropImages = {};
    Object.keys(EXTRA_PROP_VARIANT_SRC).forEach((type) => {
      this._extraPropImages[type] = EXTRA_PROP_VARIANT_SRC[type].map((src, i) => {
        const img = new Image();
        readyPromises.push(new Promise((resolve) => {
          img.onload = () => resolve();
          img.onerror = () => {
            console.warn(`[Game] Nie udało się wczytać zamiennika ${type} #${i} (${src}).`);
            resolve();
          };
        }));
        img.src = src;
        return img;
      });
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

    // --- Cykl dnia i nocy (patrz GAME_DAY_NIGHT_CYCLE_MS/_KEYFRAMES wyżej) -------
    // Start losowy w obrębie cyklu (nie zawsze "południe") - każde uruchomienie
    // gry zaczyna w innej porze doby, zamiast identycznie za każdym razem.
    // Pole gwiazd (_starField) tworzone leniwie przy pierwszym _drawStars -
    // patrz komentarz tam.
    this._dayNightTime = Math.random() * GAME_DAY_NIGHT_CYCLE_MS;
    this._starField = null;

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

    // Nowy modyfikator planety (economy.js: _rollPlanetModifier, wołane
    // WEWNĄTRZ prestige() przed publikacją tego eventu) - upieczone tło
    // trzeba przepiec z nowym filtrem koloru (patrz GAME_PLANET_VISUAL_FILTERS/
    // _bakeWorldBackground) i nowym zestawem dekoracji (DECOR_SETS) - patrz
    // _requestWorldRebake (pokazuje też nakładkę ładowania na czas pieczenia,
    // BUGFIX "wszystko się zacięło" przy prestige'u w środku gry).
    if (Events.PRESTIGE_DONE) {
      Bus.subscribe(Events.PRESTIGE_DONE, () => {
        this._requestWorldRebake();
      });
    }
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

    // Cykl dnia i nocy - modulo, żeby _dayNightTime nigdy nie rosło bez
    // ograniczeń (sesja idle trwająca godzinami nie ma po co gromadzić
    // milionów ms w jednej liczbie).
    this._dayNightTime = (this._dayNightTime + delta) % GAME_DAY_NIGHT_CYCLE_MS;

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

    // Cykl dnia i nocy - PO tincie strefy (kolory się sumują - ciemna noc w
    // Strefie C np. wypadnie jeszcze ciemniej niż sama Strefa C w dzień,
    // logicznie), PRZED winietą (patrz GAME_DAY_NIGHT_KEYFRAMES wyżej).
    this._drawDayNightOverlay();

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

  /**
   * Nakładka pory doby na CAŁY ekran (jak _drawZoneTint, tylko dla czasu
   * zamiast pozycji) + gwiazdy w nocy (patrz _drawStars). Liniowa
   * interpolacja między dwiema sąsiadującymi klatkami z
   * GAME_DAY_NIGHT_KEYFRAMES wg aktualnej fazy cyklu (_dayNightTime).
   */
  _drawDayNightOverlay() {
    const phase = this._dayNightTime / GAME_DAY_NIGHT_CYCLE_MS;
    const frames = GAME_DAY_NIGHT_KEYFRAMES;

    let i = 0;
    while (i < frames.length - 2 && frames[i + 1].phase <= phase) i++;
    const a = frames[i];
    const b = frames[i + 1];
    const span = b.phase - a.phase;
    const t = span > 0 ? (phase - a.phase) / span : 0;

    const r = Math.round(a.r + (b.r - a.r) * t);
    const g = Math.round(a.g + (b.g - a.g) * t);
    const bl = Math.round(a.b + (b.b - a.b) * t);
    const alpha = a.alpha + (b.alpha - a.alpha) * t;
    const starLight = a.starLight + (b.starLight - a.starLight) * t;

    if (starLight > 0.01) this._drawStars(starLight);

    if (alpha < 0.01) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.ctxUI.save();
    this.ctxUI.fillStyle = `rgba(${r}, ${g}, ${bl}, ${alpha})`;
    this.ctxUI.fillRect(0, 0, w, h);
    this.ctxUI.restore();
  }

  /**
   * Pole "gwiazd" (drobne, migoczące punkty) widoczne nocą - rozrzucone po
   * CAŁYM ekranie (nie tylko górnej połowie - to widok z góry, nie ma tu
   * dosłownego "nieba"), więc czyta się jako nocna, magiczna poświata
   * otoczenia, nie fizyczne odwzorowanie gwiazdozbioru. Pozycje LOSOWANE
   * RAZ i cache'owane (this._starField) - tylko jasność każdej migocze co
   * klatkę (własny sinus + losowe przesunięcie fazy na gwiazdę, ten sam
   * trik co _maybePlayShimmer w audio.js - bez tego wszystkie migotałyby
   * identycznie i mechanicznie).
   */
  _drawStars(intensity) {
    if (!this._starField) {
      this._starField = Array.from({ length: 55 }, () => ({
        xFrac: Math.random(),
        yFrac: Math.random(),
        size: 1 + Math.random() * 1.6,
        phaseOffset: Math.random() * Math.PI * 2,
        speed: 0.0012 + Math.random() * 0.0022
      }));
    }

    const w = window.innerWidth;
    const h = window.innerHeight;
    const now = performance.now();

    this.ctxUI.save();
    this.ctxUI.fillStyle = '#FFFFFF';
    this._starField.forEach((star) => {
      const twinkle = 0.5 + 0.5 * Math.sin(now * star.speed + star.phaseOffset);
      this.ctxUI.globalAlpha = intensity * (0.35 + twinkle * 0.65);
      this.ctxUI.beginPath();
      this.ctxUI.arc(star.xFrac * w, star.yFrac * h, star.size, 0, Math.PI * 2);
      this.ctxUI.fill();
    });
    this.ctxUI.restore();
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
      // Przepieczenie ŚRODKIEM gry (prestige/DEBUG.setPlanet - patrz
      // _requestWorldRebake) trzyma _worldRebakeInFlight=true przez cały czas
      // pieczenia i sama nim steruje (własny podwójny requestAnimationFrame,
      // ŻEBY przeglądarka zdążyła faktycznie namalować nakładkę PRZED ciężką,
      // synchroniczną pracą) - tutaj więc tylko czekamy (tani _renderZoneFills
      // jako podkład pod nakładką), nigdy nie pieczemy sami w tej gałęzi.
      if (!this._worldRebakeInFlight && this._grass.pattern && this._swamp.pattern && this._ash.pattern && this._decorImagesReady()) {
        // PIERWSZE pieczenie przy starcie gry - osłonięte #loading-screen
        // (patrz index.html), więc synchroniczny koszt tutaj jest niewidoczny
        // dla gracza i nie potrzebuje nakładki/podwójnego rAF jak rebake wyżej.
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
   * Żąda przepieczenia tła świata (nowy zestaw dekoracji/filtr planety) PLUS
   * pokazania nakładki ładowania na czas tej pracy - JEDYNE miejsce, które
   * powinno zerować _worldBackgroundBaked w trakcie gry (prestige). Sam
   * _bakeWorldBackground zostaje bez zmian (dalej wołany wprost przy
   * PIERWSZYM pieczeniu na starcie, gdzie nakładka jest zbędna - patrz
   * #loading-screen w index.html), ale KAŻDE pieczenie W TRAKCIE gry
   * powinno przechodzić przez to.
   *
   * BUGFIX v2 (Tomek: nakładka z poprzedniej wersji i tak "chujowo
   * działała" - w praktyce nigdy się nie malowała): poprzednia wersja
   * pokazywała nakładkę w JEDNEJ klatce (dodając klasę przez pojedynczy
   * requestAnimationFrame), a ciężkie, synchroniczne pieczenie odpalała w
   * NASTĘPNEJ - ale oba te kroki i tak leciały w tym samym cyklu rAF
   * głównej pętli gry (_drawBackground jest wołane co klatkę), więc
   * przeglądarka batchowała "pokaż nakładkę" + "zablokuj wątek pieczeniem"
   * w JEDNO malowanie i nakładka nigdy faktycznie nie trafiała na ekran -
   * gracz dalej widział "zamrożenie" (i podmieniające się tekstury pod
   * spodem), tylko teraz bez żadnego wytłumaczenia czemu.
   *
   * Naprawione PODWÓJNYM requestAnimationFrame, niezależnym od pętli
   * _drawBackground: pierwszy rAF odpala się PRZED najbliższym malowaniem
   * (więc samo dodanie klasy --visible jeszcze nie gwarantuje niczego), ale
   * DRUGI rAF (zagnieżdżony w pierwszym) odpala się dopiero PO tym, jak
   * przeglądarka już wykonała to malowanie - dopiero wtedy gracz NAPRAWDĘ
   * widzi nakładkę na ekranie, i dopiero wtedy bezpiecznie można zablokować
   * główny wątek ciężkim _bakeWorldBackground. _worldRebakeInFlight w tym
   * czasie każe _drawBackground pokazywać tani _renderZoneFills jako
   * podkład (patrz wyżej) - świat i tak jest cały czas zakryty nakładką.
   */
  _requestWorldRebake() {
    this._worldBackgroundBaked = false;
    this._worldBackgroundCanvas = null;
    this._worldRebakeInFlight = true;
    this._showWorldRebakeOverlay();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        this._bakeWorldBackground();
        this._worldRebakeInFlight = false;
        this._hideWorldRebakeOverlay();
      });
    });
  }

  /** Leniwie tworzy i pokazuje pełnoekranową nakładkę "Aktualizuję świat…"
   * (spinner + tekst, ten sam ciemny/przezroczysty język co reszta HUD) -
   * BUGFIX (Tomek: "jak chciałem włączyć następną planetę [...] wszystko
   * się zacięło i nie mogłem wyjść z menu"): _bakeWorldBackground jest
   * synchroniczne i (nawet PO naprawie kosztu blur() w _drawGroundOverlay)
   * może zająć zauważalną chwilę na słabszym telefonie - bez tej nakładki
   * ekran po prostu "zamiera" bez żadnej wskazówki, że coś się w ogóle
   * dzieje, więc wygląda na zawieszenie/błąd zamiast normalnego ładowania.
   * Samo dodanie klasy nie gwarantuje malowania - o to dba dopiero podwójny
   * rAF w _requestWorldRebake, który woła tę metodę. */
  _showWorldRebakeOverlay() {
    if (!this._rebakeOverlayEl) {
      const el = document.createElement('div');
      el.className = 'world-rebake-overlay';
      el.innerHTML = `
        <div class="world-rebake-overlay__box">
          <div class="world-rebake-overlay__spinner" aria-hidden="true"></div>
          <span>Aktualizuję świat…</span>
        </div>
      `;
      document.body.appendChild(el);
      this._rebakeOverlayEl = el;
    }
    this._rebakeOverlayEl.classList.add('world-rebake-overlay--visible');
  }

  /** Chowa nakładkę z _showWorldRebakeOverlay (element zostaje w DOM,
   * ukryty przez CSS - taniej niż tworzyć/usuwać przy każdym prestige'u). */
  _hideWorldRebakeOverlay() {
    if (this._rebakeOverlayEl) this._rebakeOverlayEl.classList.remove('world-rebake-overlay--visible');
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

    // Filtr koloru bieżącej planety (patrz GAME_PLANET_VISUAL_FILTERS) -
    // BUGFIX (Tomek: "2 pretig jest różowe zamiast zimowe"): filtr obejmował
    // dawniej TEŻ dekoracje (rock/crate/sign/tree/...), a hue-rotate() kręci
    // WSZYSTKIMI kolorami w obrazie, nie tylko zielenią trawy - niebieski
    // pasek na beczce (crate_var2) wychodził różowy, drewniana tabliczka
    // wychodziła jaskrawozielona, itd. Same tereny (trawa/bagno/popiół +
    // narzut szronu/piasku) already czytają się
    // jako "zimowe/pustynne" bez tego psucia kolorów obiektów - filtr więc
    // teraz obejmuje WYŁĄCZNIE _renderZoneFills/_drawGroundOverlay (ziemia
    // pod stopami), a _bakeStaticDecorations piecze się już z filtrem
    // zdjętym, czystymi kolorami assetów. To samo w _drawDecorations niżej
    // (dekoracje rysowane na żywo - kołyszące się drzewa/krzaki).
    const planetFilter = this._currentPlanetFilter();
    if (planetFilter) wctx.filter = planetFilter;

    // Zestaw dekoracji (patrz DECOR_SETS) dobrany TU, tuż przed pieczeniem -
    // nie w konstruktorze, bo przy starcie gry window.economyManager (i
    // odczytany z zapisu planetNumber) jeszcze nie istnieje w momencie
    // tworzenia Game() (main.js tworzy go dopiero PO Game() - patrz
    // _currentDecorSetIndex). Pieczenie i tak czeka na _decorImagesReady(),
    // czyli zawsze wypada już PO pełnej inicjalizacji main.js. Ten sam
    // indeks steruje TEŻ narzutem na podłoże (patrz _drawGroundOverlay) -
    // jeden zestaw = jedna spójna tożsamość biomu (rośliny + ziemia pod nimi).
    const decorSetIndex = this._currentDecorSetIndex();
    this._decorImages = this._decorImageSets[decorSetIndex];
    this._activeFernVariants = this._fernVariantImageSets[decorSetIndex];

    this._renderZoneFills(wctx, 0, 0, this.worldWidth, this.worldHeight);
    this._drawGroundOverlay(wctx, decorSetIndex);

    if (planetFilter) wctx.filter = 'none';
    this._bakeStaticDecorations(wctx);

    this._worldBackgroundCanvas = canvas;
    this._worldBackgroundBaked = true;
  }

  /**
   * Narzut na CAŁE upieczone podłoże (Tomek: "zmieńmy na innych prestigach
   * wygląd podłoża jeszcze bardziej") - dorzuca WŁASNY, tematyczny wzór
   * (miękkie płaty szronu / piaszczyste plamy + pęknięcia suchej ziemi)
   * NA WIERZCH już wypełnionych stref, więc różnica między planetami jest
   * widoczna nie tylko w rozstawionych obiektach (DECOR_SETS) i globalnym
   * przebarwieniu (GAME_PLANET_VISUAL_FILTERS), ale i w samej fakturze
   * ziemi pod stopami. Wołane WEWNĄTRZ _bakeWorldBackground (PRZED
   * wctx.filter = 'none'), więc dostaje też przebarwienie modyfikatora
   * planety jak reszta tła - koszt jednorazowy, ten sam wzorzec co reszta
   * pieczenia tła.
   *
   * setIndex to DOKŁADNIE ten sam indeks co wybór DECOR_SETS (patrz wywołanie
   * w _bakeWorldBackground) - jeden zestaw = jedna spójna tożsamość biomu,
   * zamiast dwóch niezależnych, mogących się nie zgrywać loterii. Zestaw 0
   * (GROUND_OVERLAY_SEEDS[0] === 0) celowo nic nie rysuje - pierwsza planeta
   * (i co trzecia kolejna) zostaje z oryginalną, nietkniętą ziemią.
   *
   * mulberry32 z deterministycznym seedem per zestaw (nie per-planeta) -
   * ten sam PRNG co dekoracje/chmury/kryształowy grunt gdzie indziej w tym
   * pliku, więc wzór jest stabilny między przeładowaniami, nie migoczący.
   */
  _drawGroundOverlay(ctx, setIndex) {
    const seed = GROUND_OVERLAY_SEEDS[setIndex];
    if (!seed) return;

    let s = seed;
    const rand = () => {
      s |= 0;
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    const w = this.worldWidth;
    const h = this.worldHeight;
    // Gęstość liczona względem powierzchni świata (jak DECOR_COUNT) - te
    // same plamy wyglądają identycznie gęsto niezależnie od GAME_WORLD_
    // WIDTH/HEIGHT, gdyby kiedyś jeszcze urosły. 26000 (nie 45000) - Tomek:
    // "zmieńmy wygląd podłoża jeszcze bardziej" - pierwsza wersja z rzadszymi/
    // słabszymi plamami ledwo było widać pod kamerą gry, ta gęstsza + mocniej
    // kryjąca (wyższe alpha niżej) faktycznie czyta się jako inny teren, nie
    // tylko pojedyncze plamki.
    const patchCount = Math.round((w * h) / 26000);

    // BUGFIX (Tomek: "jak chciałem włączyć następną planetę [...] wszystko
    // się zacięło"): ctx.filter = blur(...) na CAŁYM canvasie świata (nawet
    // RAZ, nie >100x jak w pierwszej wersji tego BUGFIXa) to wciąż realny
    // koszt - blur to konwolucja, jej cena rośnie z POWIERZCHNIĄ obrazu, a
    // świat ma 1750x2000 = 3.5 MPx. Zmierzone (CPU throttling 6x, symulacja
    // słabego telefonu): ~1.9s na SAMO to jedno rozmycie - dalej wystarczająco
    // dużo, żeby zamrozić główny wątek na cały ten czas.
    // Rozwiązanie: klasyczny "tani blur" z grafiki - rozmycie na obrazie
    // 5x MNIEJSZYM (skala scale niżej, 1/25 powierzchni = ~25x tańsze
    // rozmycie), potem SKALOWANIE W GÓRĘ z powrotem do pełnego rozmiaru
    // świata jednym drawImage. Samo skalowanie w górę (interpolacja
    // dwuliniowa canvasu) dokłada WŁASNE, dodatkowe rozmazanie - końcowy
    // efekt jest RÓWNIE (a nawet odrobinę bardziej) miękki co pełnorozdzielczy
    // blur, przy ułamku kosztu.
    const overlayScale = 0.2;
    const smallW = Math.round(w * overlayScale);
    const smallH = Math.round(h * overlayScale);
    const patchLayer = document.createElement('canvas');
    patchLayer.width = smallW;
    patchLayer.height = smallH;
    const pctx = patchLayer.getContext('2d');
    // Transform zamiast ręcznego mnożenia każdej współrzędnej/promienia -
    // reszta kodu niżej rysuje plamy w NORMALNYCH (pełnych) jednostkach
    // świata, ten scale() cichutko przekłada je na mały canvas.
    pctx.scale(overlayScale, overlayScale);

    ctx.save();
    if (setIndex === 1) {
      // "Iglasty/mroźny" - biało-szara warstwa szronu (NIE niebieska - o
      // niebieski odcień całej planety dba teraz GAME_DECOR_SET_FILTERS/
      // _currentPlanetFilter, patrz tam - Tomek: "filtr świata miał być
      // niebieski na zimowym świecie, a nie szron"), płaty złożone pod
      // ctx.filter = blur(...) zamiast samego gradientu radialnego - dużo
      // miększe, "mglistsze" krawędzie plam zamiast wyraźnych okrągłych
      // kształtów (ten sam mechanizm co planet-filter, tylko blur zamiast
      // hue-rotate/saturate).
      ctx.fillStyle = 'rgba(225, 240, 248, 0.12)';
      ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < patchCount; i++) {
        const x = rand() * w;
        const y = rand() * h;
        const r = 45 + rand() * 100;
        // Dwa stopnie (środek->przezroczysty), nie trzy - "plateau" z
        // dawnego środkowego stopnia (0.7) dawało twardszą, bardziej
        // widoczną krawędź niż czysty, ciągły spadek do zera (Tomek:
        // "wygładź krawędzie tej mgły").
        const grad = pctx.createRadialGradient(x, y, 0, x, y, r);
        grad.addColorStop(0, 'rgba(232, 244, 250, 0.5)');
        grad.addColorStop(1, 'rgba(232, 244, 250, 0)');
        pctx.fillStyle = grad;
        pctx.beginPath();
        pctx.ellipse(x, y, r, r * (0.55 + rand() * 0.3), rand() * Math.PI, 0, Math.PI * 2);
        pctx.fill();
      }
      // setTransform (nie tylko filter) - pctx wciąż ma aktywny scale()
      // sprzed rysowania plam (współrzędne świata -> mały canvas). Bez
      // zresetowania tego TU, ten drawImage (już w pikselach małego
      // canvasu, nie współrzędnych świata) narysowałby się 5x za mały.
      pctx.setTransform(1, 0, 0, 1, 0, 0);
      // Tomek: "wygładź krawędzie tej mgły bo źle wygląda" - 8px->28px na
      // małym canvasie (po przeskalowaniu w górę odpowiednik ~140px w
      // świecie) - poprzednia wartość ledwo zmiękczała krawędź gradientu,
      // przy odrobinę większych/gęstszych plamach nadal było widać gdzie
      // się kończą. Nadal tanio (mały canvas, patrz komentarz przy
      // overlayScale wyżej).
      pctx.filter = `blur(${28 * overlayScale}px)`;
      pctx.drawImage(patchLayer, 0, 0); // rozmyj SAM SIEBIE - tani na małym canvasie
      ctx.drawImage(patchLayer, 0, 0, smallW, smallH, 0, 0, w, h);
    } else if (setIndex === 2) {
      // "Pustynny" - słaby ogólny piaszczysty nalot na całej ziemi + mocniejsze
      // plamy suchego piasku + wyraźne pęknięcia spieczonej ziemi (ta sama
      // technika łamanych linii co _bakeCrystalGroundTexture).
      ctx.fillStyle = 'rgba(205, 170, 105, 0.14)';
      ctx.fillRect(0, 0, w, h);
      // Plamy piasku złożone pod tym samym "tanim blurem" co szron wyżej -
      // pęknięcia ziemi rysowane PO złożeniu, wprost na ctx w pełnej
      // rozdzielczości (bez rozmycia), żeby zostały ostre/czytelne.
      for (let i = 0; i < patchCount; i++) {
        const x = rand() * w;
        const y = rand() * h;
        const r = 40 + rand() * 90;
        // Dwa stopnie, nie trzy - patrz komentarz przy analogicznym
        // gradiencie szronu wyżej.
        const grad = pctx.createRadialGradient(x, y, 0, x, y, r);
        grad.addColorStop(0, 'rgba(213, 178, 112, 0.46)');
        grad.addColorStop(1, 'rgba(213, 178, 112, 0)');
        pctx.fillStyle = grad;
        pctx.beginPath();
        pctx.ellipse(x, y, r, r * (0.55 + rand() * 0.3), rand() * Math.PI, 0, Math.PI * 2);
        pctx.fill();
      }
      pctx.setTransform(1, 0, 0, 1, 0, 0);
      // Tomek: "wygładź krawędzie tej mgły bo źle wygląda" - 8px->28px na
      // małym canvasie (po przeskalowaniu w górę odpowiednik ~140px w
      // świecie) - poprzednia wartość ledwo zmiękczała krawędź gradientu,
      // przy odrobinę większych/gęstszych plamach nadal było widać gdzie
      // się kończą. Nadal tanio (mały canvas, patrz komentarz przy
      // overlayScale wyżej).
      pctx.filter = `blur(${28 * overlayScale}px)`;
      pctx.drawImage(patchLayer, 0, 0);
      ctx.drawImage(patchLayer, 0, 0, smallW, smallH, 0, 0, w, h);
      ctx.strokeStyle = 'rgba(84, 60, 30, 0.4)';
      ctx.lineWidth = 2.5;
      const crackCount = Math.round(patchCount / 2);
      for (let i = 0; i < crackCount; i++) {
        let x = rand() * w;
        let y = rand() * h;
        ctx.beginPath();
        ctx.moveTo(x, y);
        for (let j = 0; j < 4; j++) {
          x += (rand() - 0.5) * 70;
          y += (rand() - 0.5) * 70;
          ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /** CSS Canvas 2D filter (hue-rotate/saturate/brightness) dla bieżącej
   * planety, albo null gdy żadna z dwóch NIEZALEŻNYCH warstw przebarwienia
   * nie ma nic do dodania - patrz komentarz przy GAME_PLANET_VISUAL_FILTERS
   * (kluczowane loterią activeModifier) i GAME_DECOR_SET_FILTERS (kluczowane
   * DECOR_SETS/_currentDecorSetIndex, np. niebieski odcień "zimowego"
   * świata). Obie warstwy mogą być aktywne jednocześnie (złączone w jeden
   * string CSS filter - kolejne funkcje filtra po prostu się składają) - to
   * jedyne miejsce z tym odczytem, używane zarówno przy pieczeniu tła
   * (_bakeWorldBackground, koszt jednorazowy) jak i przy rysowaniu
   * kołyszących się dekoracji (_drawDecorations, koszt co klatkę, ale tylko
   * dla NIEupieczonej, zwykle nielicznej części sceny) - bez tego drzewa/
   * krzaki zostałyby w oryginalnym kolorze, podczas gdy ziemia pod nimi już
   * by się przebarwiła. */
  _currentPlanetFilter() {
    const modifier = window.economyManager && window.economyManager.activeModifier;
    const modifierFilter = (modifier && GAME_PLANET_VISUAL_FILTERS[modifier.id]) || null;
    const decorSetFilter = GAME_DECOR_SET_FILTERS[this._currentDecorSetIndex()] || null;
    const combined = [modifierFilter, decorSetFilter].filter(Boolean).join(' ');
    return combined || null;
  }

  /** Który z DECOR_SETS jest aktywny na bieżącej planecie - cyklicznie z
   * planetNumber (1, 2, 3, 4... -> 0, 1, 2, 0...), NIEZALEŻNIE od
   * activeModifier/_currentPlanetFilter (ten dobiera KOLOR, to dobiera
   * KSZTAŁTY - dwie osobne, niezsynchronizowane loterie dają więcej
   * realnych kombinacji niż gdyby jechały na tym samym kluczu). Brak
   * economyManager (np. bardzo wczesne wywołanie) -> zestaw 0, tak samo jak
   * dla pierwszej planety. */
  _currentDecorSetIndex() {
    const planetNumber = (window.economyManager && window.economyManager.planetNumber) || 1;
    return (planetNumber - 1) % DECOR_SETS.length;
  }

  /** true, gdy WSZYSTKIE obrazki dekoracji sprite'owych, ZE WSZYSTKICH
   * zestawów (patrz DECOR_SETS/_decorImageSets) - nie tylko bieżącego -
   * skończyły próbę wczytania (sukces LUB porażka - `complete` jest true w
   * obu przypadkach, tak samo jak przy _loadTexture) - warunek gotowości do
   * _bakeWorldBackground/_bakeStaticDecorations. Sprawdzamy WSZYSTKIE, bo
   * _bakeWorldBackground dobiera aktywny zestaw dopiero tuż przed pieczeniem
   * (patrz _currentDecorSetIndex) - w tamtym momencie każdy z trzech mógłby
   * się okazać tym wybranym. */
  _decorImagesReady() {
    return this._decorImageSets.every((set) => DECOR_SET_IMAGE_TYPES.every((type) => {
      const img = set[type];
      return img && img.complete;
    })) && this._rockVariantImages.every((img) => img.complete)
      && this._fernVariantImageSets.every((variants) => variants.every((img) => img.complete))
      && Object.values(this._extraPropImages).every((imgs) => imgs.every((img) => img.complete));
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
      // 'shard' (Strefa D) - jedyny procedural-ale-STATYCZNY typ (bez pulsu/
      // animacji, patrz _bakeCrystalShardTexture) - cień już upieczony PROSTO
      // w d.texture, więc tu tylko jeden tani drawImage, ten sam trik co
      // rock/crate/sign niżej, tylko bez sprite'a/wariantu kształtu.
      if (d.type === 'shard') {
        if (d.texture) wctx.drawImage(d.texture, d.x - d.textureAnchorX, d.y - d.textureAnchorY);
        return;
      }
      if (!DECOR_TYPES.includes(d.type)) return; // tylko sprite'owe (tree/bush/rock/shrub/crate/sign) mają tu osobny cień

      // Kamień - własny, wylosowany RAZ wariant kształtu (patrz ROCK_VARIANT_SRC/
      // item.rockVariant w _generateDecorations), NIEZALEŻNY od DECOR_SETS -
      // reszta typów bierze obrazek z aktywnego zestawu jak dotychczas.
      // Kolejność: kamień (własna pula, ROCK_VARIANT_SRC) -> zamiennik
      // skrzyni/tabliczki, JEŚLI wylosowany (EXTRA_PROP_VARIANT_SRC, patrz
      // item.useAltProp) -> normalny obrazek z aktywnego DECOR_SETS.
      const img = d.type === 'rock'
        ? this._rockVariantImages[d.rockVariant]
        : d.type === 'fern'
          ? this._activeFernVariants[d.fernVariant]
          : (d.useAltProp && this._extraPropImages[d.type] && this._extraPropImages[d.type][d.altPropVariant])
            || this._decorImages[d.type];
      if (!img || !img.complete || !img.naturalWidth) return;

      const h = DECOR_BASE_HEIGHT * d.scale * (DECOR_TYPE_SCALE[d.type] || 1);
      const w = h * (img.naturalWidth / img.naturalHeight);

      // Tomek: "trawa nie musi mieć cienia" - grass_tuft/fern to cienkie,
      // rzadkie kępki (dużo pustej przestrzeni między źdźbłami), a pełny,
      // wypełniony owal cienia pod nimi wyglądał nieproporcjonalnie ciężko
      // względem tego, jak niewiele piksela faktycznie zasłaniają. Reszta
      // typów (drzewo/krzak/kamień/skrzynia/tabliczka) zostaje bez zmian -
      // to bryły, którym cień faktycznie kotwiczy je do ziemi.
      //
      // BUGFIX (Tomek: "niech pod trawą tą nową też będzie mały cień",
      // potem: "Paproć bez cienia [...] nie ten sam zestaw poprawek co
      // reszta") - fern dostaje TERAZ WŁASNY cień, jeszcze mniejszy/słabszy
      // niż grass_tuft (cieńsza, rzadsza sylwetka - uzasadnienie z
      // pierwszego fixu wciąż aktualne dla ROZMIARU, tylko "wcale" znów
      // zmienione na "odrobinę mniej niż grass_tuft" zamiast "wcale").
      if (d.type === 'grass_tuft' || d.type === 'fern') {
        const isFern = d.type === 'fern';
        wctx.fillStyle = isFern ? 'rgba(0, 0, 0, 0.14)' : 'rgba(0, 0, 0, 0.18)';
        wctx.beginPath();
        wctx.ellipse(d.x, d.y, w * (isFern ? 0.16 : 0.22), Math.max(2, h * (isFern ? 0.05 : 0.07)), 0, 0, Math.PI * 2);
        wctx.fill();
      } else {
        // Kamień dostaje węższy/ciaśniejszy owal niż drzewo/krzak/skrzynia/
        // tabliczka (Tomek: "cienie niech będą bliżej nich") - rock.png ma
        // sporo "powietrza" wokół samej bryły (nieregularny, zaokrąglony
        // kształt w kwadratowo-prostokątnym oknie obrazka), więc pełny
        // 0.42*w owal wystawał wizualnie POZA widoczne krawędzie kamienia.
        const widthMult = d.type === 'rock' ? 0.3 : 0.42;
        const heightMult = d.type === 'rock' ? 0.1 : 0.14;
        const shadowRy = Math.max(3, h * heightMult);
        // BUGFIX (Tomek: "dodaj cień tam gdzie go nie ma, a gdzie trzeba to
        // popraw"): zmierzone wprost w pikselach (dolne 8% wysokości każdego
        // obrazka) - crate.png/crate_alt1/crate_alt2 (~93% nieprzezroczyste
        // w tym pasie) i WSZYSTKIE rekwizyty EXTRA_PROP_VARIANT_SRC
        // (d.useAltProp - pas ostrzegawczy, panel z X, ogrodzenie, gruz,
        // beczka, 81-100%) wypełniają obrazek "na styk", w przeciwieństwie
        // do sign.png (17% - wąski słupek zostawia mnóstwo pustego miejsca).
        // Sprite kończy się DOKŁADNIE na d.y (groundOffset=0), więc owal
        // wyśrodkowany na d.y miał górną połowę schowaną pod nieprzezroczystym
        // sprite'em, a widoczna dolna połówka (kilka px) ginęła w oku - w
        // praktyce WYGLĄDAŁO na brak cienia (zweryfikowane bezpośrednim
        // renderem - normalna skrzynia/tabliczka miały wyraźny owal, te NIE).
        // Przesuwamy środek owalu w dół o jego własny promień, żeby CAŁY
        // owal był pod sprite'em, tak jak u reszty typów.
        const shadowY = (d.type === 'crate' || d.useAltProp) ? d.y + shadowRy : d.y;
        // Ten sam kształt/pozycja cienia co dawniej w _drawDecorations (patrz
        // komentarz "kamienie latają" tam) - tylko przeniesiony tutaj, do
        // jednorazowego pieczenia zamiast rysowania co klatkę.
        wctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
        wctx.beginPath();
        wctx.ellipse(d.x, shadowY, w * widthMult, shadowRy, 0, 0, Math.PI * 2);
        wctx.fill();
      }

      // Reszta sprite'owych typów (rock/crate/sign) - jedyne poza tree/bush/
      // shrub, które NIE kołyszą się na wietrze (DECOR_SWAY_TYPES), więc ich
      // sylwetkę bezpiecznie piec RAZ razem z cieniem zamiast rysować co
      // klatkę w _drawDecorations.
      if (d.type === 'rock' || d.type === 'crate' || d.type === 'sign') {
        const groundOffset = h * (DECOR_GROUND_OFFSET[d.type] || 0);
        if (d.type === 'rock' && d.rotation) {
          // Obrót WOKÓŁ punktu podstawy (d.x, d.y+groundOffset), NIE środka
          // obrazka - kamień "obraca się w miejscu, na ziemi", zamiast
          // zjeżdżać w bok przy każdym innym kącie. Dzięki temu cień (wyżej,
          // wciąż na sztywno w d.x/d.y) zostaje pod kamieniem niezależnie od
          // wylosowanego obrotu, zamiast z czasem "odjeżdżać" od bryły.
          wctx.save();
          wctx.translate(d.x, d.y + groundOffset);
          wctx.rotate(d.rotation);
          wctx.drawImage(img, -w / 2, -h, w, h);
          wctx.restore();
        } else {
          wctx.drawImage(img, d.x - w / 2, d.y - h + groundOffset, w, h);
        }
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
    // rzadkie akcenty (po 1/7 każdy).
    // Strefa D przebalansowana PO naprawie bugu z DECOR_PROCEDURAL_TYPES
    // (patrz komentarz tam) - dopóki 'crystal' było niewidzialne, 2/3 wagi
    // sprowadzało się w praktyce do 'rock' (1/3). Teraz, kiedy kryształy
    // faktycznie się renderują (i są jedynym ANIMOWANYM/pulsującym typem w
    // tej strefie - kosztowniejsze na klatkę niż statyczne rock/shard),
    // ich waga jest CELOWO niższa niż wcześniej zakładano - rzadki,
    // "specjalny" akcent, nie dominujący wypełniacz. 'shard' (nowy, mały,
    // statyczny odłamek - patrz DECOR_TYPE_SCALE/_bakeCrystalShardTexture)
    // przejmuje rolę gęstego naziemnego wypełniacza, tak jak grass_tuft w A.
    const zoneTypes = {
      A: ['tree', 'bush', 'shrub', 'flower', 'flower', 'grass_tuft', 'grass_tuft', 'fern'],
      B: ['shrub', 'rock', 'puddle'],
      C: ['rock', 'rock', 'rock', 'rock', 'rock', 'sign', 'crate'],
      D: ['crystal', 'rock', 'rock', 'shard', 'shard', 'shard']
    };

    // WSZYSTKIE dekoracje pilnują odstępu od SIEBIE NAWZAJEM (dowolna para,
    // dowolne typy - Tomek: "niech trawa czy inne kwiatki i obiekty nie
    // nachodzą na inne") - BYŁO tylko dla "ciężkich" sprite'owych typów
    // (tree/bush/rock/...), z drobnym naziemnym wypełnieniem (kwiat/kałuża/
    // trawa/paproć) celowo pominiętym jako "ma tworzyć gęsty dywan" - to
    // założenie się nie sprawdziło, gracz i tak widział nachodzące na siebie
    // kępki. Promień "zajętości" liczony z realnego rozmiaru renderu
    // (DECOR_BASE_HEIGHT * skala typu * losowa skala egzemplarza), więc małe
    // typy (trawa/paproć) wymagają dużo mniejszego odstępu niż drzewo -
    // gęstość "dywanu" i tak zostaje wysoka, tylko bez faktycznego
    // zachodzenia kształtów jednego na drugi.
    const DECOR_SOLID_MARGIN = 12; // dodatkowy odstęp POZA sumą promieni - inaczej "brak nachodzenia" pozwoliłby na czysto styczne krawędzie
    const footprintRadius = (type, scale) => (DECOR_BASE_HEIGHT * (DECOR_TYPE_SCALE[type] || 1) * scale) / 2;
    const placedSolids = [];

    const list = [];
    let attempts = 0;
    while (list.length < DECOR_COUNT && attempts < DECOR_COUNT * 25) {
      attempts++;
      const px = 40 + rand() * (this.worldWidth - 80);
      const py = 40 + rand() * (this.worldHeight - 80);

      // Strefa D to teraz NIEZALEŻNY pas na pełnej wysokości (na prawo od
      // dLeftX) - stąd sprawdzana jako PIERWSZA, tak samo jak w _getZoneAt
      // (player.js) i _getZoneBounds (items.js).
      const zone = px > dLeftX
        ? 'D'
        : py < topH ? 'C' : px > rightX ? 'B' : 'A';
      const options = zoneTypes[zone];
      const type = options[Math.floor(rand() * options.length)];
      // Skala MUSI się wylosować TU (przed ewentualnym `continue` niżej),
      // nie dopiero przy budowie `item` - inaczej odrzucona próba zużyłaby
      // inną liczbę wywołań rand() niż przyjęta, psując deterministyczny
      // ciąg reszty dekoracji przy każdej zmianie DECOR_SOLID_MARGIN itp.
      const scale = 0.75 + rand() * 0.65;
      const radius = footprintRadius(type, scale);

      // BUGFIX ("drzewo nachodzi pod statek"): odstęp od keepAway (maszyny/
      // statek/terminal) liczył się od STAŁEGO promienia (170px), bez
      // uwzględnienia WŁASNEGO rozmiaru dekoracji - drzewo (promień nawet
      // >100px przy DECOR_TYPE_SCALE.tree=2.8) mogło wylosować się tuż ZA
      // granicą 170px, a jego korona i tak sięgała w stronę obiektu. Doliczamy
      // promień dekoracji do progu, ten sam pomysł co przy overlapsExisting
      // niżej - duże typy dostają większy realny odstęp, małe (trawa) prawie
      // żaden.
      const tooCloseToKeyPoint = keepAway.some((k) => {
        const dx = px - k.x;
        const dy = py - k.y;
        return Math.sqrt(dx * dx + dy * dy) < k.r + radius;
      });
      if (tooCloseToKeyPoint) continue;

      const overlapsExisting = placedSolids.some((s) => {
        const dx = px - s.x;
        const dy = py - s.y;
        return Math.sqrt(dx * dx + dy * dy) < radius + s.radius + DECOR_SOLID_MARGIN;
      });
      if (overlapsExisting) continue;
      placedSolids.push({ x: px, y: py, radius });

      // seed: losowa, ale STAŁA (raz wygenerowana) wartość 0..1 - typy
      // proceduralne (flower/puddle) czytają ją do wyboru wariantu koloru/
      // fazy animacji, żeby każdy egzemplarz wyglądał inaczej, ale identycznie
      // za każdym odświeżeniem (ta sama filozofia co DECOR_SEED).
      const item = { x: px, y: py, type, scale, seed: rand() };

      // Kamienie obrócone w różne strony (Tomek: "kamienie niech będą
      // obrócone w różne strony a nie tylko w jedną") - losowana TU (RAZ,
      // deterministycznie, ten sam mulberry32 co reszta), nie w
      // _bakeStaticDecorations, żeby kamień miał tę samą orientację za
      // każdym przeliczeniem tła (przebarwienie/nowy zestaw dekoracji przy
      // prestige'u NIE powinno "obrócić" kamieni na nowo). Tylko rock -
      // crate/sign zostają proste (skrzynia/tabliczka to "zaprojektowane"
      // obiekty z czytelną górą/dołem, obrócone wyglądałyby na przewrócone).
      if (type === 'rock') {
        item.rotation = rand() * Math.PI * 2;
        // Wariant kształtu (patrz ROCK_VARIANT_SRC) - losowany RAZ tu, z tego
        // samego powodu co rotation wyżej (stały kształt między przeliczeniami
        // tła). Tomek: "znajdź fajne kamienie w tych paczkach i podmień
        // aktualne na różne warianty".
        item.rockVariant = Math.floor(rand() * ROCK_VARIANT_SRC.length);
      }

      // Zamiennik skrzyni/tabliczki (patrz EXTRA_PROP_VARIANT_SRC) - Tomek:
      // "zastąp trochę skrzynek i tablic nowymi rzeczami" - 1/3 egzemplarzy
      // (nie połowa - "trochę", nie "większość") rysuje się NOWYM rekwizytem
      // zamiast obrazka z aktywnego DECOR_SETS. altPropVariant wybiera
      // KTÓRY z rekwizytów w puli danego typu (np. sign ma 4 - patrz
      // EXTRA_PROP_VARIANT_SRC) - liczony ZAWSZE (nie tylko gdy useAltProp
      // wypadnie), żeby liczba wywołań rand() nie zależała od losowanego
      // wyniku (ten sam powód co przy scale/radius wyżej w tej funkcji).
      // Losowane RAZ tu, tym samym mulberry32 - stałe między przeliczeniami
      // tła, tak jak rockVariant wyżej.
      if (type === 'crate' || type === 'sign') {
        item.useAltProp = rand() < (1 / 3);
        item.altPropVariant = Math.floor(rand() * EXTRA_PROP_VARIANT_SRC[type].length);
      }

      // Wariant kształtu paproci (patrz FERN_VARIANT_SRC) - losowany RAZ tu,
      // ten sam powód co rockVariant wyżej (stały kształt między
      // przeliczeniami tła). Tomek: "paproć bez wariantów - nie ten sam
      // zestaw poprawek co reszta".
      if (type === 'fern') {
        item.fernVariant = Math.floor(rand() * 2);
      }

      // Losowe lustrzane odbicie (Tomek: "krzaki/krzewy zawsze w tej samej
      // orientacji - tanie do zrobienia (losowe lustrzane odbicie)") - ten
      // sam pomysł co rotation dla rock, ale zamiast pełnego obrotu (który
      // dla asymetrycznej sylwetki krzaka/krzewu wyglądałby na "przewrócony",
      // nie "inny egzemplarz") zwykłe odbicie w poziomie - tanie (jeden
      // ctx.scale(-1,1) przy rysowaniu, patrz _drawDecorations), a przy
      // stylizowanej, w miarę symetrycznej sylwetce bush/shrub daje
      // wystarczającą wizualną odmianę bez ryzyka "do góry nogami" (bez
      // problemu crate/sign - te MAJĄ czytelną górę/dół, bush/shrub nie).
      if (type === 'bush' || type === 'shrub') {
        item.flipX = rand() < 0.5;
      }

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
      else if (type === 'shard') this._bakeCrystalShardTexture(item);

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

    // BEZ filtra koloru planety (patrz obszerny komentarz w
    // _bakeWorldBackground - hue-rotate() na dekoracjach psuł kolory
    // obiektów, np. różowa beczka na zimowym świecie) - dekoracje (w tym te
    // kołyszące się tutaj) trzymają naturalne kolory swoich assetów,
    // niezależnie od tego, że ziemia pod nimi jest przebarwiona.
    this._decorations.forEach((d) => {
      if (d.x < camX - margin || d.x > camX + viewW + margin) return;
      if (d.y < camY - margin || d.y > camY + viewH + margin) return;

      // W pełni statyczne - już wypalone w tle, patrz komentarz wyżej.
      // 'shard' dołącza do tej listy (patrz _bakeStaticDecorations) - to
      // JEDYNY procedural-typ bez animacji, więc traktowany jak rock/crate/sign,
      // nie jak crystal/flower/puddle niżej.
      if (staticBaked && (d.type === 'rock' || d.type === 'crate' || d.type === 'sign' || d.type === 'shard')) return;

      // Krótkie okno PRZED bakiem (patrz komentarz na górze metody) - 'shard'
      // jeszcze nie jest w upieczonym tle, więc rysujemy jego gotową
      // teksturę wprost, tym samym trikiem co _bakeStaticDecorations.
      if (d.type === 'shard') {
        if (d.texture) ctx.drawImage(d.texture, d.x - d.textureAnchorX, d.y - d.textureAnchorY);
        return;
      }

      if (DECOR_PROCEDURAL_TYPES.includes(d.type)) {
        this._drawProceduralDecor(ctx, d, nowSec);
        return;
      }

      // Kamień - wariant kształtu (patrz ROCK_VARIANT_SRC), niezależny od
      // aktywnego DECOR_SETS - ten sam wybór co _bakeStaticDecorations.
      // Kolejność: kamień (własna pula, ROCK_VARIANT_SRC) -> zamiennik
      // skrzyni/tabliczki, JEŚLI wylosowany (EXTRA_PROP_VARIANT_SRC, patrz
      // item.useAltProp) -> normalny obrazek z aktywnego DECOR_SETS.
      const img = d.type === 'rock'
        ? this._rockVariantImages[d.rockVariant]
        : d.type === 'fern'
          ? this._activeFernVariants[d.fernVariant]
          : (d.useAltProp && this._extraPropImages[d.type] && this._extraPropImages[d.type][d.altPropVariant])
            || this._decorImages[d.type];
      if (!img || !img.complete || !img.naturalWidth) return;

      const h = DECOR_BASE_HEIGHT * d.scale * (DECOR_TYPE_SCALE[d.type] || 1);
      const w = h * (img.naturalWidth / img.naturalHeight);

      // BUGFIX ("kamienie latają"): środek cienia siedział 2px POD podstawą
      // sprite'a (d.y+2), nie NA niej - przy dużych dekoracjach (drzewo)
      // niezauważalne, ale przy najmniejszym typie (kamień, po fixie skali
      // wyżej wciąż mały) te 2px to spory procent całej wysokości obiektu,
      // więc cień wizualnie "odjeżdżał" od kamienia. Środek teraz DOKŁADNIE
      // na d.y. Minimalna wysokość (Math.max), żeby przy małych dekoracjach
      // nie ścieńczał się do niewidocznej kreski. Rozmiar per-typ (grass_tuft/
      // fern mniejsze/słabsze, rock ciaśniejszy - patrz _bakeStaticDecorations,
      // TA SAMA logika, zduplikowana tu bo to inny kontekst rysowania)
      // - "cienie bliżej nich" (Tomek).
      // Po bake'u cień jest już w tle (patrz _bakeStaticDecorations) - tu
      // rysujemy go tylko w krótkim oknie PRZED bakiem.
      if (!staticBaked) {
        const isGrass = d.type === 'grass_tuft';
        const isFern = d.type === 'fern';
        const widthMult = isGrass ? 0.22 : isFern ? 0.16 : d.type === 'rock' ? 0.3 : 0.42;
        const heightMult = isGrass ? 0.07 : isFern ? 0.05 : d.type === 'rock' ? 0.1 : 0.14;
        const shadowRy = Math.max(isGrass || isFern ? 2 : 3, h * heightMult);
        // Ten sam fix co w _bakeStaticDecorations (patrz komentarz tam) -
        // crate i rekwizyty EXTRA_PROP_VARIANT_SRC wypełniają obrazek "na
        // styk", więc owal trzeba zsunąć w dół, inaczej ginie pod
        // nieprzezroczystym sprite'em.
        const shadowY = (d.type === 'crate' || d.useAltProp) ? d.y + shadowRy : d.y;
        ctx.fillStyle = (isGrass || isFern) ? `rgba(0, 0, 0, ${isFern ? 0.14 : 0.18})` : 'rgba(0, 0, 0, 0.3)';
        ctx.beginPath();
        ctx.ellipse(d.x, shadowY, w * widthMult, shadowRy, 0, 0, Math.PI * 2);
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
        // Lustrzane odbicie bush/shrub (patrz item.flipX w _generateDecorations) -
        // PO rotate (kołysanie), więc oba efekty się nie gryzą - odbity
        // egzemplarz kołysze się tak samo, tylko w "swoją" stronę.
        if (d.flipX) ctx.scale(-1, 1);
        ctx.drawImage(img, -w / 2, -h + groundOffset, w, h);
        ctx.restore();
      } else if (d.type === 'rock' && d.rotation) {
        // Ten sam obrót "wokół podstawy" co w _bakeStaticDecorations - patrz
        // komentarz tam. Tylko w krótkim oknie PRZED bakiem (potem kamień
        // rysuje się już z upieczonego tła).
        ctx.save();
        ctx.translate(d.x, d.y + groundOffset);
        ctx.rotate(d.rotation);
        ctx.drawImage(img, -w / 2, -h, w, h);
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
   * Mały, POJEDYNCZY odłamek kryształu (Strefa D) - naziemny wypełniacz
   * gęstości (Tomek: "Strefa D [...] wygląda pusto/powtarzalnie w porównaniu
   * do A/B/C"), ten sam duch co grass_tuft w Strefie A: tani, liczny,
   * wypełnia puste kępki między "ciężkimi" dekoracjami (crystal/rock).
   * Ta sama paleta/technika co _bakeCrystalDecorTexture (jedna iglica
   * zamiast trzech, węższa, bez oddzielnej pulsującej poświaty) - czyta się
   * jako "ten sam materiał", ale wyraźnie mniejszy i celowo BEZ animacji
   * (patrz DECOR_TYPE_SCALE.shard), więc bezpiecznie piecze się RAZ do
   * upieczonego tła świata (_bakeStaticDecorations), tak jak rock/crate/sign -
   * zero kosztu na klatkę, w przeciwieństwie do prawdziwego 'crystal'
   * (animowany puls + Light Mask, patrz _drawCrystalDecor). Cień upieczony
   * PROSTO W teksturę (ten sam trik co _bakeCrystalDecorTexture) - żadnej
   * osobnej logiki cienia w _bakeStaticDecorations dla tego typu.
   */
  _bakeCrystalShardTexture(d) {
    const scale = d.scale * (DECOR_TYPE_SCALE.shard || 1);
    const pad = 6;
    const h = 30 * scale;
    const w = 11 * scale;
    const texW = Math.ceil(w + pad * 2);
    const texH = Math.ceil(h + pad * 2);
    const anchorX = texW / 2;
    const anchorY = texH - pad;

    const canvas = document.createElement('canvas');
    canvas.width = texW;
    canvas.height = texH;
    const tctx = canvas.getContext('2d');
    const baseX = anchorX;
    const baseY = anchorY;

    tctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
    tctx.beginPath();
    tctx.ellipse(baseX, baseY, w * 0.75, w * 0.28, 0, 0, Math.PI * 2);
    tctx.fill();

    tctx.save();
    tctx.translate(baseX, baseY);
    // Lekkie przechylenie (stałe, z seeda dekoracji - patrz item.seed w
    // _generateDecorations) - kilka identycznie prostych iglic obok siebie
    // wyglądałoby na siatkę, nie na naturalny rozrzut.
    tctx.rotate((d.seed - 0.5) * 0.5);

    const grad = tctx.createLinearGradient(-w / 2, 0, w / 2, 0);
    grad.addColorStop(0, '#4527A0');
    grad.addColorStop(0.5, '#B39DDB');
    grad.addColorStop(1, '#7E57C2');
    tctx.fillStyle = grad;
    tctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
    tctx.lineWidth = 1;
    tctx.beginPath();
    tctx.moveTo(0, 0);
    tctx.lineTo(-w / 2, -h * 0.35);
    tctx.lineTo(0, -h);
    tctx.lineTo(w / 2, -h * 0.35);
    tctx.closePath();
    tctx.fill();
    tctx.stroke();

    tctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
    tctx.lineWidth = 0.8;
    tctx.beginPath();
    tctx.moveTo(0, -h * 0.08);
    tctx.lineTo(0, -h * 0.9);
    tctx.stroke();

    tctx.restore();

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