'use strict';

/**
 * economy.js
 * ------------------------------------------------------------------------
 * Ekonomia gry: monety ze sprzedaży przetworzonych surowców (market.js
 * ustala CENY, tutaj tylko naliczamy wypłatę), sklep z ulepszeniami.
 *
 * WAŻNE (Faza 1 giełdy): maszyny same z siebie NIE dają już pieniędzy po
 * zakończeniu produkcji - EconomyManager nie słucha już Events.MACHINE_OUTPUT.
 * Pieniądze pojawiają się wyłącznie przez sellItem(), wywoływane przez
 * TradingPost (market.js) w momencie sprzedaży przedmiotu ze stosu.
 */

// Combo: kolejna wypłata w ciągu tylu ms od poprzedniej podbija mnożnik -
// nagradza aktywne żonglowanie kilkoma maszynami/sprzedażą zamiast stania
// w miejscu.
const ECONOMY_COMBO_WINDOW_MS = 4000;
const ECONOMY_COMBO_MAX_STACKS = 8;
const ECONOMY_COMBO_BONUS_PER_STACK = 0.08; // +8% do wypłaty za poziom combo

// Złoty Bonus (goldbonus.js) - rzadki, zanikający pickup na mapie, osobny od
// zwykłej sprzedaży (nagroda "za granie aktywne" w duchu "arcade" połowy
// nazwy gry, nie kolejny mnożnik ekonomii). Nagroda liczona z REALNEGO tempa
// zarobku gracza (sellEarnings/totalPlaytimeSeconds - ta sama para pól co
// computeOfflineReward), nie ze stałej kwoty - late-game gracz z wykupionymi
// ulepszeniami dostaje proporcjonalnie więcej, early-game nie czuje się
// pominięty dzięki GOLD_BONUS_MIN_REWARD. "SECONDS_WORTH" = ile sekund
// normalnego zarobku reprezentuje jeden bonus - 90s to zauważalny, ale nie
// ekonomię-łamiący zastrzyk (dla porównania: offline daje maks. 8h × 40%
// skuteczności, więc pojedynczy bonus to ułamek tego).
const GOLD_BONUS_SECONDS_WORTH = 90;
const GOLD_BONUS_MIN_REWARD = 15;

// Symbol głównej waluty - własna kopia ui.js CREDIT_ICON_SVG, pod INNĄ
// nazwą (przedrostek ECONOMY_) - klasyczne <script> (nie moduły) dzielą
// JEDNĄ globalną przestrzeń nazw najwyższego poziomu, więc dwie stałe
// `const` o tej samej nazwie w dwóch plikach wysadzają całą stronę
// (SyntaxError: already been declared) zamiast się cicho nadpisać jak
// `var`. economy.js i tak ładuje się PRZED ui.js (patrz kolejność
// <script> w index.html), więc nie mógłby się odwołać do tamtej stałej
// nawet gdyby nazwa się zgadzała - stąd pełna, osobna kopia (ta sama
// "brak współdzielonych utili" konwencja co reszta projektu). Wstawiany
// jako sufiks w opisach wyzwań/osiągnięć/ulepszeń zamiast dawnego "180$".
const ECONOMY_CREDIT_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" style="vertical-align:-2px" fill="#FFD54F" stroke="none"><path fill-rule="evenodd" d="M21 12 16.5 19.79 7.5 19.79 3 12 7.5 4.21 16.5 4.21Z M14.2 12A2.2 2.2 0 1 1 9.8 12A2.2 2.2 0 1 1 14.2 12Z"/></svg>';

// Ikonka-plakietka z PRAWDZIWEGO assetu Kenney (kółko tła + .ui-icon maska) -
// JEDEN wspólny helper dla WSZYSTKICH katalogów w tym pliku (Sklep/Statek/
// Ulepszenia maszyn/Osiągnięcia), żeby każdy panel w grze miał TEN SAM styl
// ikon (Tomek: "żeby każde miało ten sam styl, sprawdź paczki i lecisz").
// Wcześniej istniał TYLKO dla ACHIEVEMENTS (tier 3, jako _achKenneyIcon) -
// SHOP_UPGRADES/PRESTIGE_UPGRADES/MACHINE_UPGRADE_KINDS i pierwsze 13
// osiągnięć dalej rysowały ręczne, wielokolorowe SVG. Zdefiniowany TU (przed
// SHOP_UPGRADES), nie przy ACHIEVEMENTS jak poprzednio - wszystkie trzy
// katalogi go potrzebują, a SHOP_UPGRADES jest zdefiniowany pierwszy w pliku.
const _kenneyIcon = (maskClass, color) =>
  `<span class="ui-shop-item__icon-badge" style="background:${color}26"><span class="ui-icon ui-icon--${maskClass}" style="color:${color}" aria-hidden="true"></span></span>`;

// Wyjątek od powyższego - "magnes" to JEDYNA koncepcja w tych katalogach, dla
// której żadna z przejrzanych paczek Kenney (Game Icons, Game Icons
// Expansion, Board Game Icons, Generic Items) nie miała pasującego kształtu.
// Płaski, jednokolorowy SVG w TEJ SAMEJ plakietce co _kenneyIcon wyżej - ten
// sam "custom SVG gdy paczka nie ma odpowiednika" wyjątek co PLANET/core w
// getStatsCatalog niżej (tam udokumentowany podobnie).
const _magnetIcon = (color) =>
  `<span class="ui-shop-item__icon-badge" style="background:${color}26"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="${color}" stroke-width="2.2" stroke-linecap="round"><path d="M7 4 v7 a5 5 0 0 0 10 0 V4"/><path d="M7 4 h4 M13 4 h4"/><path d="M7 9 h4 M13 9 h4"/></svg></span>`;

const SHOP_UPGRADES = [
  {
    id: 'capacity',
    icon: _kenneyIcon('backpack', '#E8EAF6'),
    get name() { return I18n.t('shop.item.capacity.name'); },
    get description() { return I18n.t('shop.item.capacity.desc'); },
    baseCost: 40,
    costScale: 1.65,
    maxLevel: 5,
    getValue(level) {
      return 10 + level * 2;
    }
  },
  {
    id: 'speed',
    icon: _kenneyIcon('star', '#FFEE58'),
    get name() { return I18n.t('shop.item.speed.name'); },
    get description() { return I18n.t('shop.item.speed.desc'); },
    baseCost: 60,
    costScale: 1.8,
    maxLevel: 4,
    getValue(level) {
      return 180 * (1 + level * 0.15);
    }
  },
  {
    id: 'pickup',
    icon: _magnetIcon('#EF5350'),
    get name() { return I18n.t('shop.item.pickup.name'); },
    get description() { return I18n.t('shop.item.pickup.desc'); },
    baseCost: 35,
    costScale: 1.5,
    maxLevel: 3,
    getValue(level) {
      return 55 + level * 10;
    }
  },
  {
    id: 'stage_paper',
    icon: _kenneyIcon('book', '#E8EAF6'),
    get name() { return I18n.t('shop.item.stage_paper.name'); },
    get description() { return I18n.t('shop.item.stage_paper.desc'); },
    baseCost: 150,
    costScale: 1.0,
    maxLevel: 1,
    getValue(level) {
      return level;
    }
  },
  {
    // Tańszy, WCZEŚNIEJSZY stopień pośredni przed Filtrem Toksyn/Kombinezonem
    // Radiacyjnym niżej - łagodzi karę prędkości w hazardzie, ale NIE daje
    // pełnej odporności (patrz player.js _getHazardSpeedMult). Widoczny na
    // postaci jako kask nad głową (_drawHelmet w player.js).
    id: 'headlamp',
    icon: _kenneyIcon('shield', '#FFD54F'),
    get name() { return I18n.t('shop.item.headlamp.name'); },
    get description() { return I18n.t('shop.item.headlamp.desc'); },
    baseCost: 130,
    costScale: 1.0,
    maxLevel: 1,
    getValue(level) {
      return level;
    }
  },
  {
    // Ten sam duch co headlamp wyżej - częściowa, tania ulga PRZED pełnymi
    // strojami niżej. Wydłuża czas przed utratą przedmiotu (patrz player.js
    // _getHazardLossThreshold). Widoczny na postaci jako buty przy stopach
    // (_drawBoots w player.js).
    id: 'boots',
    icon: _kenneyIcon('shield', '#A1887F'),
    get name() { return I18n.t('shop.item.boots.name'); },
    get description() { return I18n.t('shop.item.boots.desc'); },
    baseCost: 100,
    costScale: 1.0,
    maxLevel: 1,
    getValue(level) {
      return level;
    }
  },
  {
    id: 'toxic_filter',
    icon: _kenneyIcon('shield', '#66BB6A'),
    get name() { return I18n.t('shop.item.toxic_filter.name'); },
    get description() { return I18n.t('shop.item.toxic_filter.desc'); },
    baseCost: 250,
    costScale: 1.0,
    maxLevel: 1,
    getValue(level) {
      return level;
    }
  },
  {
    id: 'radiation_suit',
    icon: _kenneyIcon('shield', '#FFC107'),
    get name() { return I18n.t('shop.item.radiation_suit.name'); },
    get description() { return I18n.t('shop.item.radiation_suit.desc'); },
    baseCost: 500,
    costScale: 1.0,
    maxLevel: 1,
    getValue(level) {
      return level;
    }
  },
  {
    // BYŁO 'compass' (strzałka wskazująca kierunek) - zastąpione minimapą
    // (patrz minimap.js) na prośbę Toma: "kompasu nie widać, zmienimy na
    // minimapę do kupienia". Id zmienione na 'minimap' (nie tylko
    // nazwa/opis), żeby hasUpgrade('minimap') w kodzie czytało się zgodnie
    // z tym, czym to ulepszenie faktycznie jest - patrz też SHIP_MODULE_PERKS
    // (free_minimap) niżej.
    id: 'minimap',
    icon: _kenneyIcon('target', '#FFD54F'),
    get name() { return I18n.t('shop.item.minimap.name'); },
    get description() { return I18n.t('shop.item.minimap.desc'); },
    baseCost: 350,
    costScale: 1.0,
    maxLevel: 1,
    getValue(level) {
      return level;
    }
  },
  {
    // Automatyzacja (drone.js) - JEDYNE ulepszenie, które zbiera surowce
    // BEZ obecności gracza w pobliżu (w przeciwieństwie do 'pickup' wyżej,
    // który tylko poszerza zasięg PRZY graczu). getValue(level) = liczba
    // dronów, czytana NA ŻYWO przez DroneManager (window.economyManager.
    // upgradeLevels.drone) - zeruje się przy prestige() jak każde inne
    // ulepszenie sklepowe, więc drony znikają/pojawiają się same, bez
    // żadnego dodatkowego kodu w _applyUpgrade/prestige().
    id: 'drone',
    icon: _kenneyIcon('gear', '#64B5F6'),
    get name() { return I18n.t('shop.item.drone.name'); },
    get description() { return I18n.t('shop.item.drone.desc'); },
    baseCost: 300,
    costScale: 2.0,
    maxLevel: 3,
    getValue(level) {
      return level;
    }
  }
];

// --- Wartości domyślne "od zera" dla zwykłych ulepszeń (Faza 4: prestiż) ----
// Gdy prestige() (niżej) zeruje upgradeLevels, TE wartości muszą wrócić do
// modułów, które trzymają efekt u siebie (player.speed / itemManager.
// pickupRadius / stackController.maxCapacity) - inaczej powstałby dokładnie
// ten sam bug, który naprawiliśmy w _applyUpgrade(): licznik w economy.js
// mówi "poziom 0", ale efekt w drugim module wciąż siedzi na starej,
// wykupionej wartości z poprzedniej planety. Muszą się zgadzać z domyślnymi
// polami w player.js (this.speed) / items.js (ITEM_PICKUP_RADIUS) /
// stacking.js (this.maxCapacity).
const ECONOMY_DEFAULT_SPEED = 180;
const ECONOMY_DEFAULT_PICKUP_RADIUS = 55;
const ECONOMY_DEFAULT_CAPACITY = 10;

// Musi się zgadzać z SHIP_MODULE_DEFINITIONS.length w ship.js - własna kopia
// zgodnie z konwencją projektu (brak współdzielonych utili). Używane przez
// isReadyToPrestige() do sprawdzenia, czy wszystkie moduły są gotowe.
const ECONOMY_SHIP_MODULE_COUNT = 5;

// --- Prestiż: "Nowa Planeta" (Faza 4) ----------------------------------------
// Po dostarczeniu wszystkich ECONOMY_SHIP_MODULE_COUNT modułów gracz MOŻE
// (nie musi od razu) odlecieć na nową planetę: prestige() (niżej) zeruje CAŁY
// przebieg - pieniądze, zwykłe SHOP_UPGRADES, postęp statku, zawartość
// plecaka - w zamian za Rdzenie: TRWAŁĄ walutę, której reset NIC nie rusza,
// wydawaną wyłącznie na ten katalog. Nagroda w Rdzeniach liczona jest z
// totalEarned (łączny zarobek W TYM PRZEBIEGU - patrz _addMoney), NIE z
// aktualnego money - inaczej opłacałoby się zostać z pustym portfelem tuż
// przed odlotem (np. przez zakup upgrade'u na chwilę przed), co byłoby
// mylące i karałoby dokładnie odwrotne zachowanie niż chcemy nagradzać.
//
// Od której planetNumber odblokowuje się drugi poziom ulepszeń niżej
// (unlockPlanet: CORE_TIER2_UNLOCK_PLANET) - patrz komentarz przy "Drugi
// poziom (weterani)".
const CORE_TIER2_UNLOCK_PLANET = 5;
const PRESTIGE_UPGRADES = [
  {
    id: 'core_income',
    icon: _kenneyIcon('coin', '#FFD54F'),
    get name() { return I18n.t('core.item.core_income.name'); },
    get description() { return I18n.t('core.item.core_income.desc'); },
    baseCost: 3,
    costScale: 1.7,
    maxLevel: 10,
    getValue(level) {
      return 1 + level * 0.1;
    }
  },
  {
    id: 'core_headstart',
    icon: _kenneyIcon('pouch', '#81D4FA'),
    get name() { return I18n.t('core.item.core_headstart.name'); },
    get description() { return I18n.t('core.item.core_headstart.desc'); },
    baseCost: 2,
    costScale: 1.6,
    maxLevel: 8,
    getValue(level) {
      return level * 200;
    }
  },
  // --- Dołożone, żeby pętla prestiżu miała ciąg dalszy -----------------------
  // Były tylko DWA ulepszenia za Rdzenie, więc po drugim odlocie nie było już
  // czego za nie kupować - a to jedyna waluta przeżywająca prestiż, czyli
  // jedyny powód, żeby lecieć na kolejną planetę. Poniższe celowo dotykają
  // INNYCH części pętli niż tamte dwa (te ruszają wyłącznie gotówkę):
  // przetwarzanie, zbieranie, ceny i start przebiegu.
  {
    id: 'core_machine_speed',
    icon: _kenneyIcon('gear', '#66BB6A'),
    get name() { return I18n.t('core.item.core_machine_speed.name'); },
    get description() { return I18n.t('core.item.core_machine_speed.desc'); },
    baseCost: 3,
    costScale: 1.65,
    maxLevel: 8,
    getValue(level) {
      // Mnożnik czasu przetwarzania: 1.0 = bez zmian, mniej = szybciej.
      // Przy maksie (8) daje 0.52, czyli prawie dwukrotnie szybciej.
      return 1 - level * 0.06;
    }
  },
  {
    id: 'core_magnet',
    icon: _magnetIcon('#FF8A80'),
    get name() { return I18n.t('core.item.core_magnet.name'); },
    get description() { return I18n.t('core.item.core_magnet.desc'); },
    baseCost: 2,
    costScale: 1.55,
    maxLevel: 6,
    getValue(level) {
      return level * 12;
    }
  },
  {
    id: 'core_prices',
    icon: _kenneyIcon('chart', '#FFD54F'),
    get name() { return I18n.t('core.item.core_prices.name'); },
    get description() { return I18n.t('core.item.core_prices.desc'); },
    baseCost: 4,
    costScale: 1.7,
    maxLevel: 8,
    getValue(level) {
      return 1 + level * 0.06;
    }
  },
  {
    id: 'core_backpack',
    icon: _kenneyIcon('backpack', '#AB47BC'),
    get name() { return I18n.t('core.item.core_backpack.name'); },
    get description() { return I18n.t('core.item.core_backpack.desc'); },
    baseCost: 3,
    costScale: 1.6,
    maxLevel: 6,
    getValue(level) {
      return level * 3;
    }
  },
  // --- Drugi poziom (weterani) -----------------------------------------------
  // Sześć ulepszeń wyżej wyczerpuje się po kilku odlotach (maxLevel 6-10,
  // koszty rosną, ale w końcu każde da się dobić do maksa) - gracz, który
  // zebrał sporo Rdzeni, zostawał bez żadnego powodu, żeby dalej odlatywać.
  // Te cztery odblokowują się dopiero na planetNumber >= CORE_TIER2_UNLOCK_PLANET
  // (patrz getCoreShopCatalog/buyCoreUpgrade niżej) - CELOWO ukryte, nie
  // pokazane jako "zablokowane" (w przeciwieństwie do SHOP_UPGRADES, ten
  // katalog nie ma wzorca zaszarzonych pozycji), żeby dotarcie do 5. planety
  // dawało realną, nieoczekiwaną nagrodę: nowy rząd katalogu. Każde z nich
  // CELOWO dotyka innej, już istniejącej formuły (combo/offline/streak/
  // prestiż), więc zero nowych systemów - tylko głębsze skalowanie tego, co
  // już jest.
  {
    id: 'core_combo_master',
    icon: _kenneyIcon('fire', '#FF7043'),
    get name() { return I18n.t('core.item.core_combo_master.name'); },
    get description() { return I18n.t('core.item.core_combo_master.desc'); },
    baseCost: 6,
    costScale: 1.9,
    maxLevel: 6,
    unlockPlanet: CORE_TIER2_UNLOCK_PLANET,
    getValue(level) {
      return level;
    }
  },
  {
    id: 'core_offline_master',
    icon: _kenneyIcon('hourglass', '#26C6DA'),
    get name() { return I18n.t('core.item.core_offline_master.name'); },
    get description() { return I18n.t('core.item.core_offline_master.desc'); },
    baseCost: 8,
    costScale: 1.85,
    maxLevel: 6,
    unlockPlanet: CORE_TIER2_UNLOCK_PLANET,
    getValue(level) {
      return level * 0.05;
    }
  },
  {
    id: 'core_daily_master',
    icon: _kenneyIcon('award', '#EC407A'),
    get name() { return I18n.t('core.item.core_daily_master.name'); },
    get description() { return I18n.t('core.item.core_daily_master.desc'); },
    baseCost: 6,
    costScale: 1.85,
    maxLevel: 6,
    unlockPlanet: CORE_TIER2_UNLOCK_PLANET,
    getValue(level) {
      return 1 + level * 0.08;
    }
  },
  {
    id: 'core_prestige_boost',
    icon: _kenneyIcon('diamond', '#7E57C2'),
    get name() { return I18n.t('core.item.core_prestige_boost.name'); },
    get description() { return I18n.t('core.item.core_prestige_boost.desc'); },
    baseCost: 10,
    costScale: 2.0,
    maxLevel: 5,
    unlockPlanet: CORE_TIER2_UNLOCK_PLANET,
    getValue(level) {
      return 1 + level * 0.1;
    }
  }
];

// --- Ulepszenia KONKRETNYCH maszyn (za gotówkę, zerowane prestiżem) ---------
// Osobno od SHOP_UPGRADES, bo to jedyna kategoria kupowana PER MASZYNA, nie
// globalnie - ten sam wpis (np. "Przyspieszenie") istnieje niezależnie dla
// Recyklera, Prasy, Pieca i Oczyszczalni, każdy z własnym poziomem i ceną.
//
// Wypełnia realną dziurę w środku przebiegu: po wykupieniu sprzętu ochronnego
// (Filtr/Kombinezon) pieniądze traciły sens aż do modułów statku. Teraz zawsze
// jest w co inwestować, a inwestycja wprost przyspiesza produkcję.
//
// CELOWO nie ma tu "większy magazyn": maszyna zamienia PEŁEN magazyn na JEDNĄ
// sztukę wyjścia (patrz update() w machines.js), więc zwiększenie pojemności
// byłoby pogorszeniem - więcej wsadu na ten sam produkt. Stąd 'yield', który
// podbija WYJŚCIE: to on realnie poprawia opłacalność łańcucha (komentarze
// BALANS w machines.js liczą go jako 9:1 - 9 śmieci na 1 produkt).
const MACHINE_UPGRADE_KINDS = [
  {
    id: 'speed',
    get name() { return I18n.t('machineUpgrade.speed.name'); },
    get description() { return I18n.t('machineUpgrade.speed.desc'); },
    icon: _kenneyIcon('gear', '#4FC3F7'),
    maxLevel: 4,
    // Mnożnik czasu: 1.0 -> 0.52 przy maksie (prawie 2x szybciej).
    getValue(level) {
      return 1 - level * 0.12;
    }
  },
  {
    id: 'yield',
    get name() { return I18n.t('machineUpgrade.yield.name'); },
    get description() { return I18n.t('machineUpgrade.yield.desc'); },
    icon: _kenneyIcon('award', '#FFB74D'),
    maxLevel: 2,
    // Ile sztuk wypada z jednego cyklu: 1 -> 3 przy maksie.
    getValue(level) {
      return 1 + level;
    }
  }
];

// Bazowe koszty ulepszeń per maszyna. Własna kopia listy maszyn (konwencja
// projektu - economy.js nie importuje z machines.js). Droższe maszyny w
// łańcuchu = droższe ulepszenia, żeby kolejność inwestowania miała sens.
const MACHINE_UPGRADE_BASE_COST = {
  recycle_a: 120,
  press_b: 180,
  furnace_c: 260,
  refinery_b: 340,
  // BALANS: brakowało tego wpisu - Szlifiernia Kryształów (najdroższa i
  // najpóźniej odblokowana maszyna, patrz PROGRESSION_UNLOCKS) nie miała
  // WCALE ulepszeń, bo getMachineUpgradeCost()/getMachineUpgradeCatalog()
  // iterują tylko po kluczach tego obiektu. Wartość kontynuuje wzorzec
  // wzrostu (+60/+80/+80) powyższych maszyn.
  crystal_polisher: 450
};
// Nazwy maszyn do UI - własna kopia etykiet z MACHINE_DEFINITIONS (machines.js),
// zgodnie z konwencją projektu (brak współdzielonych utili).
const MACHINE_UPGRADE_LABELS = {
  get recycle_a() { return I18n.t('machine.recycle_a.label'); },
  get press_b() { return I18n.t('machine.press_b.label'); },
  get furnace_c() { return I18n.t('machine.furnace_c.label'); },
  get refinery_b() { return I18n.t('machine.refinery_b.label'); },
  get crystal_polisher() { return I18n.t('machine.crystal_polisher.label'); }
};
// O ile drożeje każdy kolejny poziom TEJ SAMEJ maszyny.
const MACHINE_UPGRADE_COST_SCALE = 1.85;
// Mnożnik ceny dla 'yield' - mocniejszy efekt (wprost więcej produktu) niż
// 'speed', więc i wyraźnie droższy, inaczej nie byłoby żadnego wyboru.
const MACHINE_UPGRADE_YIELD_COST_MULT = 2.4;

// --- Codzienne haki: streak logowania + wyzwanie dnia (Faza 5) --------------
// W PRZECIWIEŃSTWIE do reszty przebiegu, to TEŻ jest trwałe (nie zerowane
// przez prestige()) - streak i wyzwanie dnia liczą się w kalendarzowych
// dniach, nie w przebiegach ekonomii, więc odlot na nową planetę nie
// powinien go kasować.
//
// Nagroda streaka: 40 + min(streak,20)*15 - dzień 1 to 55$, dzień 7 to 145$,
// pułap na dniu 20 (340$), żeby liczby nie rosły w nieskończoność. Co 7 dni
// (7, 14, 21...) dodatkowo +1 Rdzeń - łączy powracanie codziennie z
// systemem prestiżu, nawet dla gracza, który akurat nie farmi aktywnie.
const DAILY_STREAK_BASE = 40;
const DAILY_STREAK_PER_DAY = 15;
const DAILY_STREAK_CAP_DAYS = 20;
const DAILY_STREAK_CORE_INTERVAL = 7;

// --- Produkcja offline (Faza 5) ----------------------------------------------
// Gra jest z natury AKTYWNA (chodzenie/zbieranie), więc offline nie
// symulujemy dosłownie ("co konkretnie by się wydarzyło"), tylko liczymy
// nagrodę z ŚREDNIEGO tempa zarobku W TYM PRZEBIEGU (totalEarned /
// totalPlaytimeSeconds) - samokorygujące się: silniejsza ekonomia gracza =
// wyższe tempo = większa nagroda, bez osobnego strojenia per-etap gry.
// BALANS: 40%/8h (poprzednie wartości) dawało za dużo - kilka godzin offline
// starczało na wykupienie niemal całego drzewka ulepszeń, więc powrót do
// gry przestawał się różnić od zwykłego grania. 15% aktywnego tempa (nie
// 100%) - to bonus za sam fakt wracania, nie zamiennik grania. Pułap 5h
// chroni przed absurdalnymi liczbami z zostawionej karty na tydzień, ale
// wciąż zostawia sensowną nagrodę za noc.
const OFFLINE_MIN_SECONDS = 120; // ponizej tego nie pokazujemy modala (np. szybkie odswiezenie)
const OFFLINE_MAX_SECONDS = 5 * 3600;
const OFFLINE_EFFICIENCY = 0.15;
// BUGFIX: dodatkowe zabezpieczenie przed dzieleniem przez prawie-zero na
// samym początku sesji (nawet z czystym sellEarnings, kilka sekund gry +
// jedna szczęśliwa sprzedaż dałoby chwilowo zawyżone tempo). Poniżej tego
// progu realnej gry, computeOfflineReward() po prostu nic nie zwraca.
const OFFLINE_MIN_PLAYTIME_SECONDS = 120;

// Cele dobrane tak, żeby dały się zrobić w jednej, niedługiej sesji (nie
// cały dzień grindu) - "zbierz" celuje w surowce Stref B/C nieco niżej niż
// A, bo są trudniej dostępne (hazard). Nagrody rzędu 90-110$, porównywalne
// do streaka w pierwszym tygodniu.
// type: 'collect' (zebrać N surowca `material`), 'earn' (zarobić N$),
// 'process' (nakarmić maszyny N razy) lub 'sell' (sprzedać N sztuk czegokolwiek).
// 'sell' i 'earn' liczone są w sellItem(); 'collect' w _onItemPickup;
// 'process' w _onMachineReceived (patrz handlery w konstruktorze).
const DAILY_CHALLENGE_TEMPLATES = [
  { type: 'collect', material: 'trash', target: 20, reward: 90, get label() { return I18n.t('challenge.0.label'); } },
  { type: 'collect', material: 'plastic', target: 15, reward: 100, get label() { return I18n.t('challenge.1.label'); } },
  { type: 'collect', material: 'paper', target: 15, reward: 100, get label() { return I18n.t('challenge.2.label'); } },
  { type: 'collect', material: 'glass', target: 10, reward: 110, get label() { return I18n.t('challenge.3.label'); } },
  { type: 'collect', material: 'metal', target: 10, reward: 110, get label() { return I18n.t('challenge.4.label'); } },
  // Odłamek Kryształu (Strefa D) - jedyny surowiec BEZ maszyny-odbiorcy (od
  // razu na targ, patrz TRADING_POST_ACCEPTS w market.js), więc niższy cel
  // niż reszta "collect" (8, nie 10-20) - dotarcie do Grani samo w sobie
  // kosztuje więcej (pełna ochrona), zbieranie ma być krótkim dodatkiem, nie
  // drugim wyzwaniem. Nagroda wyższa - najcenniejszy surowiec w grze.
  { type: 'collect', material: 'crystal_shard', target: 8, reward: 240, get label() { return I18n.t('challenge.5.label'); } },
  { type: 'earn', target: 180, reward: 100, get label() { return I18n.t('challenge.6.label', { icon: ECONOMY_CREDIT_ICON_SVG }); } },
  { type: 'earn', target: 400, reward: 200, get label() { return I18n.t('challenge.7.label', { icon: ECONOMY_CREDIT_ICON_SVG }); } },
  // Trzeci próg 'earn' (po 180/400) - reszta typów ma już 2 poziomy trudności,
  // 'earn' miało tylko dwa, mimo że to najbardziej uniwersalny typ (działa
  // od pierwszej sekundy, nie wymaga żadnego konkretnego surowca/strefy).
  { type: 'earn', target: 800, reward: 320, get label() { return I18n.t('challenge.8.label', { icon: ECONOMY_CREDIT_ICON_SVG }); } },
  { type: 'process', target: 15, reward: 90, get label() { return I18n.t('challenge.9.label'); } },
  { type: 'process', target: 30, reward: 160, get label() { return I18n.t('challenge.10.label'); } },
  { type: 'sell', target: 20, reward: 110, get label() { return I18n.t('challenge.11.label'); } },
  { type: 'sell', target: 40, reward: 190, get label() { return I18n.t('challenge.12.label'); } }
];

// --- Osiągnięcia (meta-progresja) -------------------------------------------
// Trwałe wyróżnienia za łączne (LIFETIME - nie zerowane prestiżem) dokonania,
// ten sam duch co PROGRESSION_UNLOCKS/streak: dają graczowi długoterminowe
// cele PONAD pojedynczy przebieg ("dobiłem do 3 planet", "przetworzyłem 1000
// surowców"), żeby było po co wracać nawet gdy jedna planeta jest już
// "ograna". Każde jest czysto danymi: `stat` wskazuje licznik w this.stats,
// `target` to próg - system nie ma logiki per-osiągnięcie, tylko sprawdza
// stat >= target (patrz _checkAchievements). Dzięki temu dodanie nowego to
// jedna linijka tutaj, zero nowego kodu. Ikony SVG (ten sam styl co
// SHOP_UPGRADES/PRESTIGE_UPGRADES niżej) - BYŁY emoji ("trofea, cieplejszy
// rejestr"), ale gra już nigdzie indziej ich nie używa, więc osiągnięcia
// zostawały jedynym niespójnym miejscem.
//
// BALANS: osiągnięcia dawały WYŁĄCZNIE toast - zero realnej korzyści, więc
// zdobywanie ich nie miało żadnej wagi poza kolekcjonerską satysfakcją.
// Typowe gry idle spinają achievementy z małym, TRWAŁYM bonusem (patrz
// ACHIEVEMENT_INCOME_BONUS_PER_UNLOCK + _getAchievementIncomeMultiplier w
// _addMoney niżej) - stąd jest już realny powód, żeby o nie zabiegać, nie
// tylko żeby "odhaczyć listę". Płaski +1%/osiągnięcie (nie osobna wartość
// per wpis) - prościej dla gracza do policzenia w głowie ("mam 5/13, więc
// +5% na zawsze") niż zapamiętywanie różnych wartości dla różnych wpisów,
// a NIGDY nie zerowany prestiżem (jak unlockedAchievements), więc to
// jedyny mnożnik zarobku, który rośnie z każdym kolejnym przebiegiem
// niezależnie od bieżących ulepszeń.
const ACHIEVEMENT_INCOME_BONUS_PER_UNLOCK = 0.01;

// Lokalna tablica wyników (Tomek: "najlepsze przebiegi - zarobek, czas do
// prestiżu, liczba planet - lepsza alternatywa dla auto-kupowania, daje
// powód do rywalizacji z samym sobą"). Ile najlepszych przebiegów trzymamy
// NA LISTĘ (dwie osobne listy, patrz bestRunsByEarned/bestRunsByTime w
// konstruktorze) - 10 wystarcza, żeby było "o co grać" bez rozdymania save'a.
const LEADERBOARD_MAX_ENTRIES = 10;

// Format czasu przebiegu dla tablicy wyników - w SEKUNDACH przy krótszych
// czasach (typowy przedział pojedynczego przebiegu), bo minutowa
// granularność (jak fmtPlaytime w getStatsCatalog, myślana dla łącznego
// czasu gry liczonego w godzinach) zlewałaby blisko siebie leżące, ale
// realnie różne wyniki ("5min" dla 5:02 I 5:58 to nie to samo miejsce w
// rankingu najszybszych przelotów).
const _formatRunTime = (totalSeconds) => {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}min`;
  if (m > 0) return `${m}min ${sec}s`;
  return `${sec}s`;
};


const ACHIEVEMENTS = [
  { id: 'first_pickup', icon: _kenneyIcon('trashcan', '#81C784'), get name() { return I18n.t('achievement.first_pickup.name'); }, get desc() { return I18n.t('achievement.first_pickup.desc'); }, stat: 'itemsCollected', target: 1 },
  { id: 'collector_100', icon: _kenneyIcon('trashcan', '#66BB6A'), get name() { return I18n.t('achievement.collector_100.name'); }, get desc() { return I18n.t('achievement.collector_100.desc'); }, stat: 'itemsCollected', target: 100 },
  { id: 'collector_1000', icon: _kenneyIcon('trashcan', '#4FC3F7'), get name() { return I18n.t('achievement.collector_1000.name'); }, get desc() { return I18n.t('achievement.collector_1000.desc'); }, stat: 'itemsCollected', target: 1000 },
  { id: 'feeder_50', icon: _kenneyIcon('wrench', '#FFB74D'), get name() { return I18n.t('achievement.feeder_50.name'); }, get desc() { return I18n.t('achievement.feeder_50.desc'); }, stat: 'machinesFed', target: 50 },
  { id: 'feeder_500', icon: _kenneyIcon('wrench', '#FFD54F'), get name() { return I18n.t('achievement.feeder_500.name'); }, get desc() { return I18n.t('achievement.feeder_500.desc'); }, stat: 'machinesFed', target: 500 },
  { id: 'earn_500', icon: _kenneyIcon('coin', '#A5D6A7'), get name() { return I18n.t('achievement.earn_500.name'); }, get desc() { return I18n.t('achievement.earn_500.desc', { icon: ECONOMY_CREDIT_ICON_SVG }); }, stat: 'lifetimeEarned', target: 500 },
  { id: 'earn_10000', icon: _kenneyIcon('coin', '#FFD54F'), get name() { return I18n.t('achievement.earn_10000.name'); }, get desc() { return I18n.t('achievement.earn_10000.desc', { icon: ECONOMY_CREDIT_ICON_SVG }); }, stat: 'lifetimeEarned', target: 10000 },
  { id: 'shopper_10', icon: _kenneyIcon('cart', '#FFE082'), get name() { return I18n.t('achievement.shopper_10.name'); }, get desc() { return I18n.t('achievement.shopper_10.desc'); }, stat: 'upgradesBought', target: 10 },
  { id: 'first_planet', icon: _kenneyIcon('flag', '#81D4FA'), get name() { return I18n.t('achievement.first_planet.name'); }, get desc() { return I18n.t('achievement.first_planet.desc'); }, stat: 'planetsCompleted', target: 1 },
  { id: 'planets_3', icon: _kenneyIcon('flag', '#B39DDB'), get name() { return I18n.t('achievement.planets_3.name'); }, get desc() { return I18n.t('achievement.planets_3.desc'); }, stat: 'planetsCompleted', target: 3 },
  { id: 'modules_5', icon: _kenneyIcon('wrench', '#B0BEC5'), get name() { return I18n.t('achievement.modules_5.name'); }, get desc() { return I18n.t('achievement.modules_5.desc'); }, stat: 'shipModulesCompleted', target: 5 },
  { id: 'streak_3', icon: _kenneyIcon('fire', '#FF7043'), get name() { return I18n.t('achievement.streak_3.name'); }, get desc() { return I18n.t('achievement.streak_3.desc'); }, stat: 'maxLoginStreak', target: 3 },
  { id: 'challenges_5', icon: _kenneyIcon('target', '#CE93D8'), get name() { return I18n.t('achievement.challenges_5.name'); }, get desc() { return I18n.t('achievement.challenges_5.desc'); }, stat: 'challengesClaimed', target: 5 },
  // --- Tier 3 (późna gra) - dla graczy, którzy ograli komplet powyższych.
  // Progi wielokrotnie wyższe niż tier 2, żeby dać sens dalszemu, wielo-
  // planetowemu grindowi (patrz balans previewPrestigeCores - pełne
  // zmaksowanie ulepszeń Rdzeni to i tak ~60-100 odlotów).
  { id: 'collector_10000', icon: _kenneyIcon('medal1', '#FFD54F'), get name() { return I18n.t('achievement.collector_10000.name'); }, get desc() { return I18n.t('achievement.collector_10000.desc'); }, stat: 'itemsCollected', target: 10000 },
  { id: 'feeder_2000', icon: _kenneyIcon('medal2', '#FFA726'), get name() { return I18n.t('achievement.feeder_2000.name'); }, get desc() { return I18n.t('achievement.feeder_2000.desc'); }, stat: 'machinesFed', target: 2000 },
  { id: 'earn_100000', icon: _kenneyIcon('crown', '#FFCA28'), get name() { return I18n.t('achievement.earn_100000.name'); }, get desc() { return I18n.t('achievement.earn_100000.desc', { icon: ECONOMY_CREDIT_ICON_SVG }); }, stat: 'lifetimeEarned', target: 100000 },
  { id: 'shopper_50', icon: _kenneyIcon('gear', '#B0BEC5'), get name() { return I18n.t('achievement.shopper_50.name'); }, get desc() { return I18n.t('achievement.shopper_50.desc'); }, stat: 'upgradesBought', target: 50 },
  { id: 'planets_10', icon: _kenneyIcon('flag', '#B39DDB'), get name() { return I18n.t('achievement.planets_10.name'); }, get desc() { return I18n.t('achievement.planets_10.desc'); }, stat: 'planetsCompleted', target: 10 },
  { id: 'modules_25', icon: _kenneyIcon('wrench', '#CFD8DC'), get name() { return I18n.t('achievement.modules_25.name'); }, get desc() { return I18n.t('achievement.modules_25.desc'); }, stat: 'shipModulesCompleted', target: 25 },
  // DAILY_STREAK_CAP_DAYS (economy.js) = 20 - powyżej tego dalsze dni nie
  // podbijają już nagrody streaka, więc 20 to naturalny "pełny" próg.
  { id: 'streak_20', icon: _kenneyIcon('fire', '#FF5722'), get name() { return I18n.t('achievement.streak_20.name'); }, get desc() { return I18n.t('achievement.streak_20.desc'); }, stat: 'maxLoginStreak', target: 20 },
  { id: 'challenges_30', icon: _kenneyIcon('target', '#CE93D8'), get name() { return I18n.t('achievement.challenges_30.name'); }, get desc() { return I18n.t('achievement.challenges_30.desc'); }, stat: 'challengesClaimed', target: 30 },
  // Jedyny nowy licznik (stats.coresEarned) - patrz komentarz przy nim w
  // konstruktorze i przy prestige() (rośnie tam obok this.cores).
  { id: 'cores_100', icon: _kenneyIcon('diamond', '#81D4FA'), get name() { return I18n.t('achievement.cores_100.name'); }, get desc() { return I18n.t('achievement.cores_100.desc'); }, stat: 'coresEarned', target: 100 },
  // stats.lifetimePlaytimeSeconds istniało już wcześniej (zasila wiersz
  // "Czas gry łącznie" w getStatsCatalog) - liczony na bieżąco w update(),
  // ale dotąd BEZ żadnego osiągnięcia na nim opartego, jedyny licznik w
  // this.stats zupełnie nieużyty przez ACHIEVEMENTS. hourglass - jedyna
  // ikona z puli, której żadne inne osiągnięcie jeszcze nie zajęło.
  { id: 'playtime_60', icon: _kenneyIcon('hourglass', '#A5D6A7'), get name() { return I18n.t('achievement.playtime_60.name'); }, get desc() { return I18n.t('achievement.playtime_60.desc'); }, stat: 'lifetimePlaytimeSeconds', target: 3600 },
  { id: 'playtime_600', icon: _kenneyIcon('hourglass', '#26C6DA'), get name() { return I18n.t('achievement.playtime_600.name'); }, get desc() { return I18n.t('achievement.playtime_600.desc'); }, stat: 'lifetimePlaytimeSeconds', target: 36000 },
  // stats.skinsCollected (nowy licznik, patrz konstruktor/buySkin) - brush,
  // ten sam motyw co nagłówek panelu Skinów (SHIRT_ICON_SVG w ui.js).
  { id: 'skins_4', icon: _kenneyIcon('brush', '#F06292'), get name() { return I18n.t('achievement.skins_4.name'); }, get desc() { return I18n.t('achievement.skins_4.desc'); }, stat: 'skinsCollected', target: 4 },
  // Wszystkie 7 (patrz PLAYER_SKINS niżej) - włącznie z sezonowym
  // Meteorytowym, więc realnie wymaga trafienia na Deszcz Meteorytów, nie
  // tylko zebrania Rdzeni - stąd tier3 (najwyższy próg w tej grupie).
  { id: 'skins_7', icon: _kenneyIcon('brush', '#BA68C8'), get name() { return I18n.t('achievement.skins_7.name'); }, get desc() { return I18n.t('achievement.skins_7.desc'); }, stat: 'skinsCollected', target: 7 }
];

// --- Progresywne odblokowania (walka z "martwo - wszystko dostępne od razu") --
// Największy problem gry przed tą zmianą: WSZYSTKIE 3 maszyny, WSZYSTKIE 3
// strefy i wszystkie surowce były dostępne od pierwszej sekundy - gracz w
// minutę widział 100% treści i dalej tylko podbijał liczby. Bramkujemy
// istniejącą zawartość progami łącznego zarobku (totalEarned - rośnie
// monotonicznie w przebiegu, nigdy nie maleje przy wydawaniu, więc próg raz
// przekroczony zostaje przekroczony). To NIE dokłada nowej treści (nic do
// balansowania od zera) - zamienia "wszystko naraz" w sekwencję odkryć z
// rytmem "aha, otworzyło się coś nowego" co kilka minut.
//
// Start: tylko łąka (Strefa Łąkowa) + Recykler. Reszta otwiera się progami.
// Strefa A jest zawsze odblokowana (bez progu), więc nie ma tu wpisu jak
// zone_B/C/D - jej nazwa żyje tylko tam, gdzie faktycznie się pojawia
// (patrz opis skina 'verde' niżej).
// Progi celowo niskie na początku (pierwsze odblokowanie szybko, żeby od
// razu było czuć że "coś się dzieje"), potem rozstawione szerzej.
//
// kind: 'machine' (bramka w machines.js) albo 'zone' (bramka spawnu w items.js).
// zone odblokowuje JEDNOCZEŚNIE spawn surowca I sens wejścia tam (piec).
const PROGRESSION_UNLOCKS = [
  { id: 'press_b', kind: 'machine', threshold: 60, get name() { return I18n.t('unlock.press_b.name'); }, get desc() { return I18n.t('unlock.press_b.desc'); } },
  { id: 'zone_B', kind: 'zone', threshold: 200, get name() { return I18n.t('unlock.zone_B.name'); }, get desc() { return I18n.t('unlock.zone_B.desc'); } },
  { id: 'furnace_c', kind: 'machine', threshold: 350, get name() { return I18n.t('unlock.furnace_c.name'); }, get desc() { return I18n.t('unlock.furnace_c.desc'); } },
  { id: 'zone_C', kind: 'zone', threshold: 550, get name() { return I18n.t('unlock.zone_C.name'); }, get desc() { return I18n.t('unlock.zone_C.desc'); } },
  // Oczyszczalnia - odblokowana najpóźniej (po wszystkich strefach), bo daje
  // najdroższy produkt (kryształ, patrz MARKET_BASE_PRICES). Wypełnia lukę w
  // progresji między ostatnią strefą (550$) a pierwszym modułem statku (800$),
  // dając konkretny nowy cel zamiast tylko mielenia w kółko.
  { id: 'refinery_b', kind: 'machine', threshold: 750, get name() { return I18n.t('unlock.refinery_b.name'); }, get desc() { return I18n.t('unlock.refinery_b.desc'); } },
  // Strefa D (Kryształowa Grań) - NAJPÓŹNIEJSZE odblokowanie ze wszystkich.
  // W przeciwieństwie do B/C nie wystarczy próg zarobku - _hasGearForZone('D')
  // w player.js dodatkowo wymaga OBU strojów ochronnych naraz (Filtr +
  // Kombinezon), więc to naturalna "nagroda za pełne wyposażenie" pod koniec
  // przebiegu, nie kolejny przystanek po drodze.
  // BALANS: próg podniesiony z 950 do 1200 - Filtr (250$) + Kombinezon (500$)
  // to DODATKOWE 750$ ponad totalEarned potrzebne, żeby faktycznie wejść do
  // strefy, więc sam próg 950 dawał za mało czasu na uzbieranie obu naraz
  // (progresja liczy totalEarned, nie zapas gotówki). 1200 daje realny bufor.
  { id: 'zone_D', kind: 'zone', threshold: 1200, get name() { return I18n.t('unlock.zone_D.name'); }, get desc() { return I18n.t('unlock.zone_D.desc'); } },
  // Szlifiernia Kryształów - kapitalizuje Grań (odblokowaną wyżej) drugim,
  // wolniejszym zastosowaniem odłamka obok bezpośredniej sprzedaży (ten sam
  // duch co Oczyszczalnia dla szkła: surowiec ma teraz realny wybór -
  // szybko i pewnie na targ, albo przez maszynę na coś droższego). Próg
  // WYŻSZY niż zone_D (1200), bo wymaga, żeby gracz zdążył już nazbierać
  // odłamków - wypełnia lukę między Granią a 3. modułem statku (1600$).
  { id: 'crystal_polisher', kind: 'machine', threshold: 1400, get name() { return I18n.t('unlock.crystal_polisher.name'); }, get desc() { return I18n.t('unlock.crystal_polisher.desc'); } }
];

// --- Zdolności z modułów statku ---------------------------------------------
// Wypełnienie "martwego środka" gry: odblokowania (PROGRESSION_UNLOCKS wyżej)
// pokrywają tylko 0-550$ zarobku, czyli ~11% drogi do statku (4800$). Przez
// pozostałe ~89% NIC nowego się nie pojawiało - gracz tylko mielił w kółko to
// samo, żeby dobić do końca. A statek MA już pięć modułów rozłożonych
// równomiernie po całej tej przestrzeni (narastająco 300/800/1600/2800/4800$) -
// gotowe, dobrze rozstawione kamienie milowe, które dotąd nie dawały NIC poza
// paskiem postępu. Każdy moduł włącza teraz konkretną zdolność, więc jest
// powód, żeby budować statek PO DRODZE, a nie tylko na końcu.
//
// Perki są ODCZYTYWANE na bieżąco (hasShipPerk), NIE "wpychane" do modułów
// przy ukończeniu - wpychanie kolidowałoby z ulepszeniami ze sklepu (patrz
// _applyUpgrade + ostrzeżenie przy ZONE_HAZARD_SPEED_MULT w player.js) i
// wymagałoby ponownego nakładania po każdym wczytaniu zapisu.
//
// Zasięg: PRZEBIEG, nie meta - prestige() czyści shipCompletedModules (nowa
// planeta = nowy zepsuty statek), więc perki też znikają. To celowe i zgodne
// z tematem, inaczej niż PROGRESSION_UNLOCKS (wiedza o świecie = trwała).
const SHIP_MODULE_PERKS = {
  life_support: { perk: 'hazard_grace', get label() { return I18n.t('shipPerk.life_support.label'); } },
  navigation: { perk: 'free_minimap', get label() { return I18n.t('shipPerk.navigation.label'); } },
  shields: { perk: 'hazard_immunity', get label() { return I18n.t('shipPerk.shields.label'); } },
  engine: { perk: 'speed_boost', get label() { return I18n.t('shipPerk.engine.label'); } },
  hyperdrive: { perk: null, get label() { return I18n.t('shipPerk.hyperdrive.label'); } }
};

// Które ulepszenia ze sklepu stają się BEZUŻYTECZNE, gdy gracz ma dany perk
// ze statku.
//
// BUGFIX (pułapka na 1100$): perki statku i część sklepu robią DOKŁADNIE to
// samo, ale getShopCatalog() o tym nie wiedział - sklep dalej sprzedawał
// Minimapę (350$), Filtr Toksyn (250$) i Kombinezon (500$) graczowi, który
// te zdolności miał już z Nawigacji/Osłon. Zakup przechodził normalnie,
// pieniądze znikały i NIC się nie zmieniało - zmierzone: 1100$ w błoto, bez
// żadnego komunikatu.
//
// Zamierzona progresja (patrz komentarz w _hasGearForZone w player.js) jest
// OK: sklep to przystanek, moduł statku to nagroda, która go zastępuje. Zła
// była tylko cisza sklepu na ten temat - więc nie zmieniamy ekonomii, tylko
// przestajemy sprzedawać rzeczy, które gracz już ma.
//
// NIE ma tu 'speed' ani 'boots' - Silnik (+25%) i Podtrzymywanie Życia (x2)
// MNOŻĄ się z nimi (patrz moveMult w player.js oraz _getHazardLossThreshold),
// więc tam kupowanie obu naprawdę coś daje i sklep ma prawo je oferować.
const SHOP_UPGRADES_SUPERSEDED_BY_PERK = {
  minimap: 'free_minimap',
  toxic_filter: 'hazard_immunity',
  radiation_suit: 'hazard_immunity'
};

// --- Modyfikatory planety (zawartość długoterminowa) ------------------------
// Rozwiązuje realny problem pętli prestiżu: PRESTIGE_UPGRADES/SHOP_UPGRADES/
// PROGRESSION_UNLOCKS są identyczne na KAŻDEJ planecie - po kilku odlotach
// gracz robi dokładnie to samo od nowa. prestige() (niżej) losuje JEDEN
// modyfikator z tej puli i aplikuje go do nowego przebiegu - ten sam duch co
// roguelite'owe "seedy rundy": inny układ mnożników na TYCH SAMYCH systemach
// (ceny targu, tempo spawnu, tempo maszyn), więc zero nowej mechaniki do
// zbalansowania od zera.
//
// Celowo TYLKO jeden naraz (nie kombinacja kilku) - łatwiej opisać jednym
// zdaniem w UI i łatwiej zbalansować (brak kombinatorycznych par do
// przetestowania). Efekty czytane NA BIEŻĄCO przez inne moduły (patrz
// getPlanetPriceMultiplier/getPlanetSpawnMultiplier/
// getPlanetMachineSpeedMultiplier niżej) i MNOŻĄ się z odpowiednikami z
// Rdzeni (core_prices/core_machine_speed), nie zastępują ich - tak jak
// Silnik statku i Szybsze buty w player.js.
//
// Brak modyfikatora na pierwszej planecie (this.activeModifier = null w
// konstruktorze, rollowane wyłącznie w prestige()) - pierwszy przebieg ma
// uczyć podstaw bez dodatkowej zmiennej.
const PLANET_MODIFIERS = [
  {
    id: 'bountiful',
    icon: _kenneyIcon('star', '#C5E1A5'),
    get name() { return I18n.t('planetMod.bountiful.name'); },
    get desc() { return I18n.t('planetMod.bountiful.desc'); },
    spawnMult: 1.4,
    priceMult: 0.85
  },
  {
    id: 'scarce',
    icon: _kenneyIcon('diamond', '#D7B98E'),
    get name() { return I18n.t('planetMod.scarce.name'); },
    get desc() { return I18n.t('planetMod.scarce.desc'); },
    spawnMult: 0.7,
    priceMult: 1.25
  },
  {
    id: 'efficient_factory',
    icon: _kenneyIcon('gear', '#66BB6A'),
    get name() { return I18n.t('planetMod.efficient_factory.name'); },
    get desc() { return I18n.t('planetMod.efficient_factory.desc'); },
    machineSpeedMult: 0.8
  },
  {
    id: 'rusty_gear',
    icon: _kenneyIcon('wrench', '#D08A5C'),
    get name() { return I18n.t('planetMod.rusty_gear.name'); },
    get desc() { return I18n.t('planetMod.rusty_gear.desc'); },
    machineSpeedMult: 1.15,
    spawnMult: 1.25
  },
  {
    id: 'gold_rush',
    icon: _kenneyIcon('coin', '#FFD54F'),
    get name() { return I18n.t('planetMod.gold_rush.name'); },
    get desc() { return I18n.t('planetMod.gold_rush.desc'); },
    priceMult: 1.2
  },
  {
    id: 'soft_landing',
    icon: _kenneyIcon('pouch', '#90CAF9'),
    get name() { return I18n.t('planetMod.soft_landing.name'); },
    get desc() { return I18n.t('planetMod.soft_landing.desc', { icon: ECONOMY_CREDIT_ICON_SVG }); },
    cashBonus: 150
  }
];

// --- Skiny postaci (kosmetyka za Rdzenie) ------------------------------------
// Czysto kosmetyczne - ZERO wpływu na rozgrywkę, tylko kolor kombinezonu
// gracza. Trwałe jak PRESTIGE_UPGRADES (przeżywają prestiż, nigdy nie
// zerowane) i płatne tą samą walutą - to kolejny sposób na wydanie Rdzeni,
// obok samych ulepszeń.
//
// `tint`/`body` to jedyne pola, które NIE są tu tylko danymi UI - player.js
// czyta je BEZPOŚREDNIO (window.PLAYER_SKINS, patrz eksport na dole pliku) do
// zbudowania sprite'a (_bakeSkinTints). Jeden katalog zamiast dwóch kopii
// (tu + w player.js), żeby cena/nazwa/kolor NIGDY się nie rozjechały -
// wyjątek od "brak współdzielonych utili" tej samej klasy co odczyt
// window.economyManager przez inne moduły (to dane, nie funkcja pomocnicza).
// `tint: null` = bez przebarwienia (surowy sprite ciała). `body: null` =
// domyślne ciało (assets/player.png/player_walk.png), string (patrz
// PLAYER_ALIEN_BODY_SRC w player.js) = INNA sylwetka z Kenney "Platformer
// Art Extended" (Alien sprites - beige/green/pink/yellow), nie tylko
// przebarwiona kopia tej samej postaci.
// BUGFIX (Tomek: "skiny to tylko przebarwienia tego samego sprite'a, zero
// odmiany kształtu"): każdy skin miał TEN SAM sprite, różnił je wyłącznie
// tint. Cztery z pięciu kolorów paczki (Blue jest już samym domyślnym
// wyglądem gracza) dostały więc PRAWDZIWIE inne ciało - verde/gold w
// natywnym kolorze paczki (zero tint, już są zielone/żółte), crimson/
// crystal/amber przebarwione na wierzchu (paczka nie ma czerwonego ani
// fioletowego, więc tint dociąga do nazwy). Dwa niskopriorytetowe sloty
// (amber/meteor) dzielą ciało 'beige' - wciąż odróżnialne tintem, ale to
// jedyne powielenie, reszta ma unikalną sylwetkę.
// Nazwy BEZ "Kombinezon" (Tomek: "to nie są kombinezony tylko kolor
// postaci") - `tint` przebarwia sam sprite gracza (skórę obcego), nie
// dokłada żadnego ubrania, więc nazwa sugerująca strój była myląca, tym
// bardziej że w grze istnieje osobny, PRAWDZIWY Kombinezon Radiacyjny
// (gear, patrz SHOP_UPGRADES) - dwie zupełnie różne rzeczy o niemal tej
// samej nazwie.
const PLAYER_SKINS = [
  { id: 'default', get name() { return I18n.t('skin.default.name'); }, get desc() { return I18n.t('skin.default.desc'); }, tint: null, body: null, cost: 0 },
  // previewColor: tylko dla skinów BEZ tint (natywny kolor ciała paczki) -
  // używane jako awaryjny kolor kółka/proceduralnej sylwetki, zanim sprite
  // się wczyta (patrz ui.js SkinsPanel/_drawProcedural w tym pliku) - dla
  // skinów Z tint ten sam cel spełnia samo pole tint, previewColor zbędne.
  { id: 'verde', get name() { return I18n.t('skin.verde.name'); }, get desc() { return I18n.t('skin.verde.desc'); }, tint: null, body: 'green', previewColor: '#5FBF7A', cost: 2 },
  { id: 'crimson', get name() { return I18n.t('skin.crimson.name'); }, get desc() { return I18n.t('skin.crimson.desc'); }, tint: '#E53935', body: 'pink', cost: 2 },
  { id: 'amber', get name() { return I18n.t('skin.amber.name'); }, get desc() { return I18n.t('skin.amber.desc'); }, tint: '#FFB74D', body: 'beige', cost: 4 },
  // Barwy Kryształowej Grani (patrz _bakeCrystalGroundTexture w game.js) -
  // nagroda-nawiązanie do najtrudniej dostępnej strefy, nie wymaga jednak
  // faktycznego jej odblokowania (kupowana wyłącznie za Rdzenie, jak reszta).
  { id: 'crystal', get name() { return I18n.t('skin.crystal.name'); }, get desc() { return I18n.t('skin.crystal.desc'); }, tint: '#B388FF', body: 'pink', cost: 8 },
  // BUGFIX (Tomek: "żółty jest za mały usuń go"): body:'yellow' (jedyny
  // skin, który go używał) renderował się ~11% mniejszy niż reszta -
  // wcześniejsza próba naprawy (pad_top 10px na alien_yellow.png, patrz
  // historia w commitach) wyrównała POZYCJĘ stóp, ale drawImage() skaluje
  // CAŁE płótno do jednego stałego rozmiaru docelowego niezależnie od tego,
  // ile z niego jest faktycznie nieprzezroczyste - dopchane 10px pustego
  // marginesu zmniejszyło więc UDZIAŁ prawdziwej grafiki w płótnie, czyniąc
  // narysowaną postać mniejszą, nie tej samej wielkości. Zamiast kolejnej
  // łatki na tym samym, kruchym assetcie: wraca do domyślnego ciała (tint
  // zamiast natywnego koloru paczki) - ten sam złoty odcień co dawny
  // previewColor, teraz jako realny tint zamiast samego kolora zastępczego.
  { id: 'gold', get name() { return I18n.t('skin.gold.name'); }, get desc() { return I18n.t('skin.gold.desc'); }, tint: '#F5C542', body: null, cost: 15 },
  // Wydarzenie sezonowe "Deszcz Meteorytów" (events.js) - kupowalny WYŁĄCZNIE
  // gdy trwa (sobota/niedziela wg zegara urządzenia), ale raz kupiony
  // zostaje NA STAŁE (unlockedSkins się nie zeruje) - jak każdy inny skin,
  // po prostu okno zakupu jest ograniczone w czasie. Zostaje na oryginalnym
  // ciele (body: null) - najrzadziej noszony skin, nie wart dodatkowego
  // powielania sylwetki.
  { id: 'meteor', get name() { return I18n.t('skin.meteor.name'); }, get desc() { return I18n.t('skin.meteor.desc'); }, tint: '#FF6E40', body: null, cost: 12, eventOnly: true }
];

class EconomyManager {
  constructor(game) {
    this.game = game || null;
    this.money = 0;
    this.upgradeLevels = {};

    // Łączny zarobek W TYM PRZEBIEGU (od ostatniego prestiżu, albo od startu
    // gry) - w przeciwieństwie do this.money NIGDY nie maleje przy wydawaniu,
    // więc jest to uczciwa podstawa formuły nagrody w Rdzeniach (patrz
    // previewPrestigeCores/prestige niżej). Zerowane WYŁĄCZNIE przez prestige().
    this.totalEarned = 0;

    // Sekundy AKTYWNEJ gry W TYM PRZEBIEGU - podstawa (razem z totalEarned)
    // tempa zarobku użytego do wyliczenia nagrody offline (Faza 5, patrz
    // computeOfflineReward niżej). Zerowane RAZEM z totalEarned przy
    // prestige() - inaczej licznik zliczałby czas z całej gry, a licznik
    // zarobku tylko z bieżącej planety, co dałoby fałszywie niskie tempo
    // zaraz po odlocie. Aktualizowane w update(delta) - EconomyManager
    // MUSI być zarejestrowany w game.registerModule() (main.js), inaczej
    // to zawsze zostanie na zerze.
    this.totalPlaytimeSeconds = 0;

    // BUGFIX (Faza 5, offline): totalEarned rośnie od WSZYSTKIEGO co idzie
    // przez _addMoney() - realnej sprzedaży, ALE TEŻ DEBUG.addMoney(),
    // nagrody streaka (checkDailyLogin) i nagrody wyzwania dnia
    // (claimDailyChallenge). computeOfflineReward() dzieli zarobek przez
    // czas gry, żeby dostać "tempo $/s" - jeśli licznikiem jest totalEarned,
    // JEDNORAZOWY zastrzyk (np. DEBUG.addMoney(2000) przy dopiero co
    // rozpoczętej sesji, małe totalPlaytimeSeconds) winduje tempo do
    // absurdu, bo to nie jest powtarzalny, prawdziwy rytm grania. sellEarnings
    // rośnie WYŁĄCZNIE w sellItem() (patrz niżej) - to jedyne uczciwe źródło
    // tempa, reszta idzie tylko do totalEarned (dalej używanego przez
    // prestiż - tam kontaminacja jest nieszkodliwa/pożądana, bo prestiż i
    // tak ma nagradzać CAŁY dorobek przebiegu, nie tylko sprzedaż).
    this.sellEarnings = 0;

    // Combo za tempo: rośnie, gdy kolejna sprzedaż na giełdzie zdarzy się
    // zanim okno czasowe wygaśnie; liczone na zegarze rzeczywistym
    // (Date.now()), więc nie potrzeba osobnego update(delta) ani rejestracji
    // w game.modules.
    this.comboStacks = 0;
    this._lastPayoutAt = 0;

    SHOP_UPGRADES.forEach((u) => {
      this.upgradeLevels[u.id] = 0;
    });

    // Poziomy ulepszeń per maszyna: { machineId: { speed: 0, yield: 0 } }.
    // Stan PRZEBIEGU (kupowane za gotówkę), więc prestige() je zeruje - tak
    // samo jak upgradeLevels wyżej.
    this.machineUpgrades = {};
    this._resetMachineUpgrades();

    // --- Postęp modułów statku (Faza 3: cel gry) ------------------------------
    // Trzymane TU, nie w ship.js - żeby automatycznie wchodziło do zapisu
    // obok reszty stanu gracza (ship.js tylko WOŁA te metody, samego stanu
    // nie trzyma - ten sam wzorzec co TradingPost/sellItem()).
    this.shipMoneyContributed = {}; // { moduleId: ile już wpłacono }
    this.shipMaterialsContributed = {}; // { moduleId: { typeId: ile dostarczono } }
    this.shipCompletedModules = []; // [moduleId, ...] w kolejności ukończenia

    // --- Prestiż: "Nowa Planeta" (Faza 4) -------------------------------------
    // W PRZECIWIEŃSTWIE do wszystkiego powyżej, te trzy pola NIGDY nie są
    // zerowane przez prestige() - to one SĄ tym, co z niego przetrwa. Reszta
    // tej klasy (money/upgradeLevels/shipXxx/totalEarned) to stan "przebiegu",
    // zerowany w prestige() poniżej.
    this.cores = 0; // trwała waluta - patrz PRESTIGE_UPGRADES
    this.prestigeLevels = {}; // trwałe poziomy PRESTIGE_UPGRADES
    this.planetNumber = 1; // licznik "które to podejście" - kosmetyczne/UI

    // Modyfikator BIEŻĄCEJ planety (patrz PLANET_MODIFIERS powyżej) - null na
    // pierwszej planecie, losowany od nowa przy każdym prestige().
    this.activeModifier = null;

    PRESTIGE_UPGRADES.forEach((u) => {
      this.prestigeLevels[u.id] = 0;
    });

    // --- Codzienne haki (Faza 5) - też trwałe, patrz komentarz przy stałych. ---
    this.loginStreak = 0;
    this.lastLoginDateStr = null; // null = jeszcze nigdy nie sprawdzane (pierwsze uruchomienie)
    this.dailyChallenge = null; // { dateStr, type, material?, target, reward, label, progress, claimed }

    // Samouczek (tutorial.js) - TEŻ trwały, ten sam powód co streak/wyzwanie
    // dnia: raz nauczony gracz nie powinien dostawać samouczka od nowa po
    // każdym prestiżu. tutorialStep to indeks w TUTORIAL_STEPS (tutorial.js);
    // >= długości tablicy = ukończony.
    this.tutorialStep = 0;
    this.tutorialDismissed = false;

    // Progresywne odblokowania (patrz PROGRESSION_UNLOCKS). Set zawiera id
    // WSZYSTKIEGO co już odblokowane. Zawartość startowa (łąka + recykler)
    // jest ZAWSZE odblokowana i NIE ma wpisu w PROGRESSION_UNLOCKS - to, co
    // nie jest bramkowane, jest dostępne domyślnie (patrz isUnlocked).
    // NIE resetowane przez prestige() - progresja odkrywania świata to
    // meta-postęp gracza, nie stan pojedynczego przebiegu (inaczej każdy
    // odlot na nową planetę kazałby od nowa "odkrywać" te same strefy, co
    // jest anty-zabawą). Zapisywane jako tablica (Set nie serializuje się
    // wprost do JSON).
    this.unlockedIds = new Set();

    // Skiny postaci (patrz PLAYER_SKINS) - TEŻ meta-postęp, NIE zerowane
    // prestiżem, ten sam powód co unlockedIds wyżej: kosmetyczny wybór
    // gracza to nie stan pojedynczego przebiegu. 'default' zawsze odblokowany
    // (jak łąka+recykler w unlockedIds) - nikt nie zaczyna bez działającego
    // wyglądu postaci.
    this.selectedSkin = 'default';
    this.unlockedSkins = new Set(['default']);

    // Lokalna tablica wyników - TEŻ meta-postęp, NIE zerowana prestiżem
    // (ten sam powód co unlockedSkins wyżej: przebiegi z CAŁEJ historii
    // gracza, nie tylko bieżącej planety). Dwie NIEZALEŻNE listy top-N
    // zamiast jednej wspólnej z sortowaniem w locie - przebieg może być
    // jednocześnie "wolny, ale bogaty" (trafia tylko do listy zarobku) albo
    // "szybki, ale ubogi" (trafia tylko do listy czasu), więc każda lista
    // pilnuje WŁASNEGO topu niezależnie (patrz _recordRun/prestige niżej).
    this.bestRunsByEarned = [];
    this.bestRunsByTime = [];

    // Liczniki LIFETIME dla osiągnięć (patrz ACHIEVEMENTS) - meta-postęp,
    // NIE zerowane prestiżem (jak unlockedIds/cores), inaczej "zbierz 1000
    // surowców" resetowałoby się przy każdym odlocie. lifetimeEarned to
    // osobny licznik od totalEarned (ten drugi zeruje się prestiżem, bo
    // służy do formuły Rdzeni w bieżącym przebiegu). planetsCompleted i
    // maxLoginStreak są też pochodną planetNumber/loginStreak, ale trzymamy
    // je osobno, bo achievementy potrzebują "ile RAZEM", nie "ile teraz".
    this.stats = {
      itemsCollected: 0,
      machinesFed: 0,
      upgradesBought: 0,
      lifetimeEarned: 0,
      shipModulesCompleted: 0,
      planetsCompleted: 0,
      challengesClaimed: 0,
      maxLoginStreak: 0,
      // Odpowiednik lifetimeEarned, tylko dla czasu - totalPlaytimeSeconds
      // (wyżej) zeruje się przy prestige() (patrz komentarz przy nim), więc
      // ekran statystyk (getStatsCatalog niżej) potrzebuje osobnego,
      // NIGDY nie zerowanego licznika łącznego czasu gry.
      lifetimePlaytimeSeconds: 0,
      // Odpowiednik lifetimeEarned, tylko dla Rdzeni - this.cores MALEJE przy
      // wydawaniu (ulepszenia/skiny), więc osiągnięcie "zdobądź łącznie 100
      // Rdzeni" potrzebuje osobnego licznika, który tylko rośnie (patrz
      // prestige()).
      coresEarned: 0,
      // Start od 1 (nie 0) - 'default' liczy się jako już odblokowany skin
      // (patrz unlockedSkins niżej), więc licznik musi się z nim zgadzać od
      // pierwszej klatki, inaczej "odblokuj 4 skiny" wymagałoby w
      // rzeczywistości kupienia 5 (default + 4), nie 3 dodatkowych.
      skinsCollected: 1
    };
    // Set id-ków już zdobytych osiągnięć (patrz ACHIEVEMENTS). Serializowany
    // jako tablica (Set nie idzie wprost do JSON), tak jak unlockedIds.
    this.unlockedAchievements = new Set();

    // Śledzenie postępu wyzwania - działa ZAWSZE (nawet zanim jakiekolwiek
    // wyzwanie istnieje), każdy handler sam sprawdza `if (!this.dailyChallenge)
    // return`, więc bezpieczne od pierwszej klatki. 'earn'/'sell' liczone
    // osobno w sellItem() (potrzebuje finalnej kwoty PO comboBonus, nie
    // samego eventu). Te same handlery podbijają też liczniki osiągnięć.
    this._onItemPickup = (d) => {
      this.stats.itemsCollected++;
      this._checkAchievements();
      const c = this.dailyChallenge;
      if (!c || c.claimed || c.type !== 'collect' || d.typeId !== c.material) return;
      c.progress = Math.min(c.target, c.progress + 1);
      Bus.publish(Events.DAILY_CHALLENGE_UPDATED, { ...c });
    };
    this._onMachineReceived = () => {
      this.stats.machinesFed++;
      this._checkAchievements();
      const c = this.dailyChallenge;
      if (!c || c.claimed || c.type !== 'process') return;
      c.progress = Math.min(c.target, c.progress + 1);
      Bus.publish(Events.DAILY_CHALLENGE_UPDATED, { ...c });
    };
    this._onShipModuleCompletedStat = () => {
      this.stats.shipModulesCompleted++;
      this._checkAchievements();
    };
    Bus.subscribe(Events.ITEM_PICKUP, this._onItemPickup);
    Bus.subscribe(Events.MACHINE_RECEIVED, this._onMachineReceived);
    if (Events.SHIP_MODULE_COMPLETED) Bus.subscribe(Events.SHIP_MODULE_COMPLETED, this._onShipModuleCompletedStat);
  }

  /**
   * Sprawdza WSZYSTKIE osiągnięcia i odblokowuje te, których próg (stat >=
   * target) właśnie został osiągnięty. Wołane po KAŻDEJ zmianie licznika
   * this.stats - tania pętla po kilkunastu wpisach, a dzięki temu system
   * nie musi wiedzieć, KTÓRY licznik się zmienił (żaden achievement nie
   * odblokuje się dwa razy - Set pilnuje). Publikuje ACHIEVEMENT_UNLOCKED
   * dla każdego świeżo zdobytego (ui.js pokazuje toast).
   */
  _checkAchievements() {
    ACHIEVEMENTS.forEach((a) => {
      if (this.unlockedAchievements.has(a.id)) return;
      if ((this.stats[a.stat] || 0) >= a.target) {
        this.unlockedAchievements.add(a.id);
        Bus.publish(Events.ACHIEVEMENT_UNLOCKED, {
          id: a.id, name: a.name, icon: a.icon, desc: a.desc
        });
      }
    });
  }

  /**
   * Katalog osiągnięć dla UI (AchievementsPanel w ui.js): każdy wpis z
   * aktualnym postępem i flagą unlocked. Odblokowane najpierw, w pozostałych
   * kolejność jak w definicji (naturalna progresja trudności).
   */
  getAchievementsCatalog() {
    return ACHIEVEMENTS.map((a) => ({
      id: a.id,
      icon: a.icon,
      name: a.name,
      desc: a.desc,
      target: a.target,
      progress: Math.min(this.stats[a.stat] || 0, a.target),
      unlocked: this.unlockedAchievements.has(a.id)
    })).sort((x, y) => (y.unlocked ? 1 : 0) - (x.unlocked ? 1 : 0));
  }

  /**
   * Katalog dla ekranu Statystyk (StatsPanel w ui.js) - czysty przegląd
   * liczników LIFETIME (this.stats + kilka pól spoza niego, patrz niżej),
   * bez żadnej logiki odblokowań/progresji (to już robią osiągnięcia
   * wyżej). Ikony: tam gdzie w projekcie już istnieje prawdziwa ikonka
   * Kenney UŻYWANA GDZIE INDZIEJ w DOKŁADNIE tym samym znaczeniu (moneta =
   * zapłata, koszyk = sklep, klucz = moduł statku, płomień = combo/streak,
   * puchar = osiągnięcia, klepsydra = odliczanie), pożyczamy ją (.ui-icon,
   * ten sam mechanizm maski co Sklep/Menu) zamiast rysować coś nowego -
   * mniej niespójnych ikon w grze. Reszta zostaje pożyczona z ACHIEVEMENTS
   * (ten sam koncept, np. "surowce zebrane" - nie ma sensu rysować drugi
   * raz) albo własna, gdy naprawdę nie ma dobrego odpowiednika w paczkach
   * (planeta - kenney_planets.zip to surowy generator tekstur, nie ikony;
   * Rdzenie - to bytowy symbol WALUTY używany wszędzie w HUD/PrestizPanel,
   * podmiana tylko tutaj rozjechałaby się z resztą gry).
   */
  getStatsCatalog() {
    const achIcon = (id) => {
      const a = ACHIEVEMENTS.find((x) => x.id === id);
      return a ? a.icon : '';
    };
    // Prawdziwa ikonka Kenney (kółko tła + .ui-icon maska) - patrz komentarz
    // .ui-shop-item__icon-badge w style.css.
    const kenneyIcon = (maskClass, color) =>
      `<span class="ui-shop-item__icon-badge" style="background:${color}26"><span class="ui-icon ui-icon--${maskClass}" style="color:${color}" aria-hidden="true"></span></span>`;

    const planetIcon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="#81D4FA" stroke-width="1.8"><circle cx="12" cy="12" r="7" fill="#81D4FA" fill-opacity="0.2"/><ellipse cx="12" cy="12" rx="10.5" ry="3.4" transform="rotate(-16 12 12)"/></svg>';
    const coreIcon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="26" height="26" fill="#81D4FA" stroke="none"><path d="M13 2 4 14h6l-1 8 9-12h-6Z"/></svg>';

    const fmtPlaytime = (totalSeconds) => {
      const h = Math.floor(totalSeconds / 3600);
      const m = Math.floor((totalSeconds % 3600) / 60);
      return h > 0 ? `${h}h ${m}min` : `${m}min`;
    };

    return [
      { id: 'planet', icon: planetIcon, label: I18n.t('stats.planet'), value: `#${this.planetNumber}` },
      { id: 'cores', icon: coreIcon, label: I18n.t('stats.cores'), value: `${this.cores}` },
      { id: 'lifetimeEarned', icon: kenneyIcon('coin', '#FFD54F'), label: I18n.t('stats.lifetimeEarned'), value: `${this.stats.lifetimeEarned.toLocaleString('pl-PL')}${ECONOMY_CREDIT_ICON_SVG}` },
      { id: 'itemsCollected', icon: achIcon('collector_1000'), label: I18n.t('stats.itemsCollected'), value: this.stats.itemsCollected.toLocaleString('pl-PL') },
      { id: 'machinesFed', icon: achIcon('feeder_500'), label: I18n.t('stats.machinesFed'), value: this.stats.machinesFed.toLocaleString('pl-PL') },
      { id: 'upgradesBought', icon: kenneyIcon('cart', '#FFE082'), label: I18n.t('stats.upgradesBought'), value: this.stats.upgradesBought.toLocaleString('pl-PL') },
      { id: 'planetsCompleted', icon: achIcon('planets_3'), label: I18n.t('stats.planetsCompleted'), value: this.stats.planetsCompleted.toLocaleString('pl-PL') },
      { id: 'shipModulesCompleted', icon: kenneyIcon('wrench', '#B0BEC5'), label: I18n.t('stats.shipModulesCompleted'), value: this.stats.shipModulesCompleted.toLocaleString('pl-PL') },
      { id: 'maxLoginStreak', icon: kenneyIcon('fire', '#FF7043'), label: I18n.t('stats.maxLoginStreak'), value: I18n.t('stats.maxLoginStreak.value', { days: this.stats.maxLoginStreak }) },
      { id: 'challengesClaimed', icon: achIcon('challenges_5'), label: I18n.t('stats.challengesClaimed'), value: this.stats.challengesClaimed.toLocaleString('pl-PL') },
      { id: 'achievements', icon: kenneyIcon('trophy', '#FFD54F'), label: I18n.t('stats.achievements'), value: I18n.t('stats.achievements.value', { unlocked: this.unlockedAchievements.size, total: ACHIEVEMENTS.length, bonus: this.getAchievementIncomeBonusPercent() }) },
      { id: 'playtime', icon: kenneyIcon('hourglass', '#A5D6A7'), label: I18n.t('stats.playtime'), value: fmtPlaytime(this.stats.lifetimePlaytimeSeconds) }
    ];
  }

  /**
   * JEDYNY powód, dla którego EconomyManager musi być zarejestrowany w
   * game.registerModule() (main.js) - nalicza totalPlaytimeSeconds, używane
   * przez computeOfflineReward() (Faza 5) do wyliczenia tempa zarobku.
   * Wszystko inne w tej klasie jest event-driven/Date.now()-based i update()
   * by nie potrzebowało (patrz komentarz przy comboStacks w konstruktorze).
   */
  update(delta) {
    this.totalPlaytimeSeconds += delta / 1000;
    this.stats.lifetimePlaytimeSeconds += delta / 1000;
    // BUGFIX: playtime_60/playtime_600 (ACHIEVEMENTS) to jedyne osiągnięcia
    // oparte na liczniku, który rośnie TU (co klatkę), a nie w odpowiedzi na
    // Bus event - bez tego wywołania próg mógłby zostać przekroczony bez
    // żadnego wywołania _checkAchievements() w pobliżu (gracz stoi w
    // miejscu, nic nie zbiera/sprzedaje), więc toast/bonus spóźniałby się aż
    // do następnej zupełnie niezwiązanej akcji. Tania pętla po ~24 wpisach,
    // 60x/s - pomijalny koszt (patrz identyczne uzasadnienie przy
    // _checkAchievements() wyżej).
    this._checkAchievements();
  }

  /**
   * Sprzedaje jedną sztukę surowca po cenie jednostkowej ustalonej przez
   * market.js (TradingPost.update() woła to po zdjęciu przedmiotu ze stosu).
   * Combo działa identycznie jak wcześniej przy MACHINE_OUTPUT - tylko teraz
   * liczy się tempo sprzedaży na giełdzie, nie tempo kończenia produkcji.
   * @param {string} typeId - typ sprzedawanego przedmiotu (np. 'plastic').
   * @param {number} unitPrice - aktualna cena jednostkowa z MarketManager.
   * @param {number} [x] - pozycja X do popupu/cząsteczek (np. terminal).
   * @param {number} [y] - pozycja Y do popupu/cząsteczek.
   * @returns {number} faktycznie wypłacona kwota (po uwzględnieniu combo).
   */
  sellItem(typeId, unitPrice, x, y) {
    const now = Date.now();
    const comboMax = this._getComboMaxStacks();
    this.comboStacks = (now - this._lastPayoutAt <= ECONOMY_COMBO_WINDOW_MS)
      ? Math.min(comboMax, this.comboStacks + 1)
      : 0;
    this._lastPayoutAt = now;

    const multiplier = 1 + this.comboStacks * ECONOMY_COMBO_BONUS_PER_STACK;
    const comboAmount = Math.round(unitPrice * multiplier);

    // BUGFIX: _addMoney() teraz ZWRACA finalną kwotę PO mnożniku
    // core_income (Rdzenie) - dawniej popup/zwrot/wyzwanie dnia liczyły
    // comboAmount (SPRZED tego mnożnika), więc gracz z wykupionym
    // Wzmacniaczem Zarobku widział w popupie mniej, niż faktycznie
    // dostawał na konto, a wyzwanie "zarób X$" zaniżało postęp o dokładnie
    // ten sam procent.
    const paidOut = this._addMoney(comboAmount, x, y);
    // Jedyne miejsce, gdzie sellEarnings rośnie - patrz komentarz przy polu
    // w konstruktorze (musi zostać odizolowane od DEBUG.addMoney/nagród).
    this.sellEarnings += paidOut;

    // Licznik LIFETIME dla osiągnięć - liczymy realną wypłatę ze SPRZEDAŻY
    // (nie _addMoney ogólnie, żeby DEBUG.addMoney/nagrody dnia nie zawyżały
    // "zarobionego łącznie" - achievement "Magnat" ma nagradzać realną grę).
    this.stats.lifetimeEarned += paidOut;
    this._checkAchievements();

    const c = this.dailyChallenge;
    if (c && !c.claimed) {
      if (c.type === 'earn') {
        c.progress = Math.min(c.target, c.progress + paidOut);
        Bus.publish(Events.DAILY_CHALLENGE_UPDATED, { ...c });
      } else if (c.type === 'sell') {
        c.progress = Math.min(c.target, c.progress + 1);
        Bus.publish(Events.DAILY_CHALLENGE_UPDATED, { ...c });
      }
    }

    const comboSuffix = this.comboStacks > 0 ? ` x${this.comboStacks + 1}` : '';
    // Bez symbolu waluty - to czysty canvas (fillText, patrz gamefeel.js),
    // nie DOM, więc nie da się tu wstawić ECONOMY_CREDIT_ICON_SVG (ui.js) jak w
    // reszcie gry. Ikona popupu i tak jest zajęta przez 'flame' (combo),
    // a złoty/pomarańczowy kolor (color niżej) + kontekst (leci w górę z
    // miejsca sprzedaży) wystarczą, żeby czytać to jako pieniądze.
    Bus.publish(Events.FX_POPUP, {
      text: `+${paidOut}${comboSuffix}`,
      // Płomień rysowany PROCEDURALNIE nad popupem (patrz _drawPopupIcon w
      // gamefeel.js) zamiast dawnego 🔥 wtopionego w text - tylko gdy combo
      // faktycznie trwa (poziom 0 = zwykła sprzedaż, bez ikony).
      icon: this.comboStacks > 0 ? 'flame' : null,
      x,
      y,
      duration: 900,
      color: this.comboStacks >= comboMax ? '#FF7043' : '#FFD700'
    });

    return paidOut;
  }

  /**
   * Wypłaca nagrodę Złotego Bonusu (goldbonus.js woła to w momencie
   * zebrania) - kwota z realnego tempa zarobku (patrz komentarz przy
   * GOLD_BONUS_SECONDS_WORTH), przez _addMoney() jak każda inna wypłata
   * (core_income + bonus osiągnięć wliczone automatycznie). Publikuje
   * własny FX_POPUP/FX_PARTICLES w miejscu zebrania - ten sam wzorzec co
   * sellItem() wyżej, tylko złoty kolor i bez sufiksu combo (to nie jest
   * combo-sprzedaż).
   * @returns {number} faktycznie wypłacona kwota.
   */
  collectGoldBonus(x, y) {
    const rate = this.totalPlaytimeSeconds > 0 ? this.sellEarnings / this.totalPlaytimeSeconds : 0;
    const base = Math.max(GOLD_BONUS_MIN_REWARD, Math.round(rate * GOLD_BONUS_SECONDS_WORTH));
    const paidOut = this._addMoney(base, x, y);

    Bus.publish(Events.GOLD_BONUS_COLLECTED, { reward: paidOut, x, y });
    Bus.publish(Events.FX_PARTICLES, { x, y, color: '#FFD700', count: 14 });
    Bus.publish(Events.FX_POPUP, {
      text: `+${paidOut}`,
      icon: 'star',
      x,
      y,
      duration: 1100,
      color: '#FFD700'
    });

    return paidOut;
  }

  /**
   * Wpłaca pieniądze na poczet modułu statku (Ship.update() woła to, gdy
   * gracz stoi w zasięgu). Nigdy nie wpłaca więcej, niż gracz faktycznie ma.
   * @returns {number} faktycznie wpłacona kwota.
   */
  contributeShipMoney(moduleId, amount) {
    const actual = Math.max(0, Math.min(amount, this.money));
    if (actual <= 0) return 0;
    this.money -= actual;
    this.shipMoneyContributed[moduleId] = (this.shipMoneyContributed[moduleId] || 0) + actual;
    this._syncMoneyState();
    return actual;
  }

  /**
   * Dostarcza jedną sztukę surowca na poczet modułu. Ship.update() woła to
   * PO zdjęciu przedmiotu ze stosu (sam nie rusza stosu, tylko liczy).
   */
  contributeShipMaterial(moduleId, typeId) {
    if (!this.shipMaterialsContributed[moduleId]) this.shipMaterialsContributed[moduleId] = {};
    this.shipMaterialsContributed[moduleId][typeId] =
      (this.shipMaterialsContributed[moduleId][typeId] || 0) + 1;
  }

  getShipMoneyContributed(moduleId) {
    return this.shipMoneyContributed[moduleId] || 0;
  }

  getShipMaterialContributed(moduleId, typeId) {
    return (this.shipMaterialsContributed[moduleId] && this.shipMaterialsContributed[moduleId][typeId]) || 0;
  }

  isShipModuleComplete(moduleId) {
    return this.shipCompletedModules.includes(moduleId);
  }

  /**
   * true, gdy gracz ukończył moduł statku dający daną zdolność (patrz
   * SHIP_MODULE_PERKS). Konsumenci (player.js, compass.js) wołają to wprost,
   * dokładnie tak samo jak od dawna wołają hasUpgrade() - zero nowych
   * kanałów komunikacji, zero stanu do synchronizowania.
   */
  hasShipPerk(perkId) {
    if (!perkId) return false;
    for (const moduleId in SHIP_MODULE_PERKS) {
      if (SHIP_MODULE_PERKS[moduleId].perk === perkId) {
        return this.isShipModuleComplete(moduleId);
      }
    }
    return false;
  }

  /** Opis zdolności danego modułu - do pokazania graczowi w momencie
   * ukończenia (ui.js) i w panelu statku. */
  getShipPerkLabel(moduleId) {
    const entry = SHIP_MODULE_PERKS[moduleId];
    return entry ? entry.label : '';
  }

  markShipModuleComplete(moduleId) {
    if (!this.shipCompletedModules.includes(moduleId)) {
      this.shipCompletedModules.push(moduleId);
    }
  }

  /**
   * Jedyne miejsce, w którym gracz faktycznie ZARABIA (w przeciwieństwie do
   * contributeShipMoney, które WYDAJE). Oprócz this.money aktualizuje też
   * totalEarned (podstawa nagrody w Rdzeniach - patrz previewPrestigeCores)
   * i dolicza trwałe mnożniki core_income (jeśli wykupiony) oraz osiągnięć
   * (patrz _getAchievementIncomeMultiplier) - oba wchodzą PRZED zapisaniem
   * do totalEarned, żeby kolejne przebiegi z tymi bonusami szybciej
   * generowały kolejne Rdzenie (celowa spirala postępu, standard w grach
   * z prestiżem).
   */
  _addMoney(amount, x, y) {
    const base = Math.max(0, Math.round(amount));
    if (base <= 0) return 0;

    const value = Math.round(base * this._getCoreIncomeMultiplier() * this._getAchievementIncomeMultiplier());

    this.money += value;
    this.totalEarned += value;
    if (this.game && this.game.state) {
      this.game.state.money = this.money;
    }
    Bus.publish(Events.MONEY_COLLECTED, { amount: value, x, y, total: this.money });
    // Progresywne odblokowania - sprawdzamy TU, bo to jedyne miejsce gdzie
    // rośnie totalEarned (podstawa progów). checkUnlocks() sam pilnuje, żeby
    // nie odpalić tego samego odblokowania dwa razy.
    this._checkUnlocks();
    // BUGFIX: metoda dawniej nic nie zwracała, więc sellItem() (niżej) po
    // wykupieniu core_income (mnożnik z Rdzeni) pokazywał graczowi w
    // popupie i liczył w wyzwaniu dnia kwotę SPRZED mnożnika - mniej niż
    // faktycznie wpadało na konto. Teraz wywołujący dostaje prawdziwą,
    // finalną wartość.
    return value;
  }

  /** true, gdy dana zawartość (maszyna/strefa) jest dostępna. Wszystko, co
   * NIE ma wpisu w PROGRESSION_UNLOCKS, jest odblokowane domyślnie (np. łąka
   * i recykler - zawartość startowa). Reszta wymaga wpisu w unlockedIds. */
  isUnlocked(id) {
    const gated = PROGRESSION_UNLOCKS.some((u) => u.id === id);
    if (!gated) return true;
    return this.unlockedIds.has(id);
  }

  /** Sprawdza wszystkie progi i odblokowuje te, które totalEarned właśnie
   * przekroczył. Publikuje UNLOCK_GRANTED za każde NOWE odblokowanie (ui.js
   * pokazuje wtedy celebracyjny toast). Idempotentne - już odblokowane id
   * jest pomijane, więc wielokrotne wywołanie jest bezpieczne. */
  _checkUnlocks() {
    for (const u of PROGRESSION_UNLOCKS) {
      if (this.unlockedIds.has(u.id)) continue;
      if (this.totalEarned >= u.threshold) {
        this.unlockedIds.add(u.id);
        Bus.publish(Events.UNLOCK_GRANTED, { id: u.id, kind: u.kind, name: u.name, desc: u.desc });
      }
    }
  }

  /** Następne nieodblokowane odblokowanie + ile jeszcze brakuje zarobku -
   * używane przez HUD do pokazania "co dalej" (pasek postępu do kolejnego
   * odkrycia). null, gdy wszystko już odblokowane. */
  getNextUnlock() {
    for (const u of PROGRESSION_UNLOCKS) {
      if (!this.unlockedIds.has(u.id)) {
        return { ...u, current: this.totalEarned, remaining: Math.max(0, u.threshold - this.totalEarned) };
      }
    }
    return null;
  }

  /** Trwały mnożnik zarobku z wykupionych poziomów core_income (1.0 = brak bonusu). */
  _getCoreIncomeMultiplier() {
    const def = PRESTIGE_UPGRADES.find((u) => u.id === 'core_income');
    if (!def) return 1;
    return def.getValue(this.prestigeLevels.core_income || 0);
  }

  /** Trwały mnożnik zarobku ze zdobytych osiągnięć (1.0 = brak bonusu, patrz
   * ACHIEVEMENT_INCOME_BONUS_PER_UNLOCK) - NIGDY nie zerowany prestiżem,
   * bo unlockedAchievements też nie jest. */
  _getAchievementIncomeMultiplier() {
    return 1 + this.unlockedAchievements.size * ACHIEVEMENT_INCOME_BONUS_PER_UNLOCK;
  }

  /** Aktualny bonus zarobku z osiągnięć jako liczba całkowita procent
   * (np. 5 = "+5%") - do wyświetlenia w AchievementsPanel/StatsPanel bez
   * duplikowania formuły w ui.js. */
  getAchievementIncomeBonusPercent() {
    return Math.round(this.unlockedAchievements.size * ACHIEVEMENT_INCOME_BONUS_PER_UNLOCK * 100);
  }

  /** Maks. poziom combo (ECONOMY_COMBO_MAX_STACKS + trwały bonus z
   * core_combo_master, patrz drugi poziom Rdzeni) - czytane w sellItem(). */
  _getComboMaxStacks() {
    return ECONOMY_COMBO_MAX_STACKS + (this.getCoreValue('core_combo_master') || 0);
  }

  /**
   * Wartość dowolnego trwałego ulepszenia (Rdzenie) po id. Publiczne, bo
   * czytają to INNE moduły: machines.js (tempo przetwarzania), market.js
   * (ceny), items.js/stacking.js (zasięg/pojemność na starcie planety).
   * Zwraca wartość dla poziomu 0, gdy ulepszenia nie ma - czyli neutralną,
   * więc wywołujący nie musi się bronić przed brakiem wpisu.
   */
  getCoreValue(upgradeId) {
    const def = PRESTIGE_UPGRADES.find((u) => u.id === upgradeId);
    if (!def) return null;
    return def.getValue(this.prestigeLevels[upgradeId] || 0);
  }

  /** Mnożnik czasu przetwarzania maszyn (<1 = szybciej) - core_machine_speed. */
  getMachineSpeedMultiplier() {
    const v = this.getCoreValue('core_machine_speed');
    return typeof v === 'number' ? v : 1;
  }

  /** Mnożnik cen na targu (>1 = drożej sprzedajesz) - core_prices. */
  getMarketPriceMultiplier() {
    const v = this.getCoreValue('core_prices');
    return typeof v === 'number' ? v : 1;
  }

  /** Losuje nowy modyfikator BIEŻĄCEJ planety z PLANET_MODIFIERS - wołane
   * WYŁĄCZNIE z prestige() niżej. */
  _rollPlanetModifier() {
    const def = PLANET_MODIFIERS[Math.floor(Math.random() * PLANET_MODIFIERS.length)];
    this.activeModifier = { ...def };
  }

  /** Modyfikator aktywny na bieżącej planecie, albo null (pierwsza planeta,
   * zanim gracz choć raz poleci dalej) - do wyświetlenia w UI (ui.js). */
  getActiveModifier() {
    return this.activeModifier;
  }

  /** Mnożnik cen targu z modyfikatora planety (1 = brak) - MNOŻY się z
   * getMarketPriceMultiplier() (Rdzenie), nie zastępuje go - patrz getPrice()
   * w market.js. */
  getPlanetPriceMultiplier() {
    return (this.activeModifier && typeof this.activeModifier.priceMult === 'number')
      ? this.activeModifier.priceMult
      : 1;
  }

  /** Mnożnik tempa spawnu surowców z modyfikatora planety (>1 = częściej) -
   * patrz ItemManager.update() w items.js. */
  getPlanetSpawnMultiplier() {
    return (this.activeModifier && typeof this.activeModifier.spawnMult === 'number')
      ? this.activeModifier.spawnMult
      : 1;
  }

  /** Mnożnik czasu przetwarzania maszyn z modyfikatora planety (<1 =
   * szybciej) - MNOŻY się z getMachineSpeedMultiplier() (Rdzenie), patrz
   * _getSpeedMultiplier() w machines.js. */
  getPlanetMachineSpeedMultiplier() {
    return (this.activeModifier && typeof this.activeModifier.machineSpeedMult === 'number')
      ? this.activeModifier.machineSpeedMult
      : 1;
  }

  /**
   * Nakłada trwałe bonusy z Rdzeni, które NIE są czytane na bieżąco, tylko
   * trzymane jako stan w innym module (zasięg podnoszenia, pojemność stosu).
   * Zawsze liczone jako "bazowa wartość ulepszenia sklepowego + bonus z
   * Rdzeni", nigdy przyrostowo - dzięki temu wielokrotne wywołanie jest
   * bezpieczne (idempotentne) i nie da się bonusu naliczyć dwa razy.
   * Wołane po zakupie za Rdzenie, po prestiżu i po wczytaniu zapisu.
   */
  _applyCorePassives() {
    const pickupDef = SHOP_UPGRADES.find((u) => u.id === 'pickup');
    const capacityDef = SHOP_UPGRADES.find((u) => u.id === 'capacity');

    if (window.itemManager && pickupDef) {
      const shopValue = pickupDef.getValue(this.upgradeLevels.pickup || 0);
      window.itemManager.pickupRadius = shopValue + (this.getCoreValue('core_magnet') || 0);
    }
    if (window.stackController && capacityDef) {
      const shopValue = capacityDef.getValue(this.upgradeLevels.capacity || 0);
      window.stackController.maxCapacity = shopValue + (this.getCoreValue('core_backpack') || 0);
    }
  }

  _syncMoneyState() {
    if (this.game && this.game.state) {
      this.game.state.money = this.money;
    }
    Bus.publish(Events.MONEY_COLLECTED, { amount: 0, total: this.money });
  }

  getMoney() {
    return this.money;
  }

  canAfford(cost) {
    return this.money >= cost;
  }

  /** Czy gracz kupił dane ulepszenie (poziom > 0)? Używane m.in. przez
   * player.js do sprawdzenia sprzętu ochronnego przed wejściem w strefę. */
  hasUpgrade(upgradeId) {
    return (this.upgradeLevels[upgradeId] || 0) > 0;
  }

  getUpgradeCost(upgradeId) {
    const def = SHOP_UPGRADES.find((u) => u.id === upgradeId);
    if (!def) return Infinity;
    const level = this.upgradeLevels[upgradeId] || 0;
    if (level >= def.maxLevel) return Infinity;
    return Math.round(def.baseCost * Math.pow(def.costScale, level));
  }

  getShopCatalog() {
    return SHOP_UPGRADES.map((def) => {
      const level = this.upgradeLevels[def.id] || 0;
      // Zdolność już dana przez moduł statku (patrz
      // SHOP_UPGRADES_SUPERSEDED_BY_PERK) = pozycja jest wyczerpana tak samo
      // jak kupiona na maksa. Bez tego sklep sprzedawał duplikaty za realne
      // pieniądze, nic nie dając w zamian.
      const fromShip = this.isSupersededByShip(def.id);
      const maxed = level >= def.maxLevel || fromShip;
      return {
        id: def.id,
        icon: def.icon,
        name: def.name,
        description: def.description,
        level,
        maxLevel: def.maxLevel,
        cost: maxed ? null : this.getUpgradeCost(def.id),
        maxed,
        // UI rozróżnia "kupione na maksa" od "masz to ze statku" (ui.js) -
        // dla gracza to zupełnie inna informacja.
        fromShip,
        nextValue: maxed ? def.getValue(level) : def.getValue(level + 1)
      };
    });
  }

  /** Czy dane ulepszenie ze sklepu jest już zapewnione przez perk statku
   * (patrz SHOP_UPGRADES_SUPERSEDED_BY_PERK). */
  isSupersededByShip(upgradeId) {
    const perk = SHOP_UPGRADES_SUPERSEDED_BY_PERK[upgradeId];
    return !!perk && this.hasShipPerk(perk);
  }

  // ==========================================================================
  // ULEPSZENIA MASZYN (per maszyna, za gotówkę - patrz MACHINE_UPGRADE_KINDS)
  // ==========================================================================

  /** Zeruje wszystkie poziomy maszyn do stanu "nic nie kupione". Wołane w
   * konstruktorze i przy prestiżu (to stan przebiegu, nie meta). */
  _resetMachineUpgrades() {
    this.machineUpgrades = {};
    Object.keys(MACHINE_UPGRADE_BASE_COST).forEach((machineId) => {
      this.machineUpgrades[machineId] = {};
      MACHINE_UPGRADE_KINDS.forEach((k) => {
        this.machineUpgrades[machineId][k.id] = 0;
      });
    });
  }

  /** Poziom danego ulepszenia danej maszyny (0, gdy nic nie kupione). */
  getMachineUpgradeLevel(machineId, kindId) {
    const m = this.machineUpgrades[machineId];
    return (m && m[kindId]) || 0;
  }

  /**
   * Aktualna wartość efektu (mnożnik czasu dla 'speed', liczba sztuk dla
   * 'yield'). Czytane na bieżąco przez machines.js - patrz komentarz przy
   * _getSpeedMultiplier tam.
   */
  getMachineUpgradeValue(machineId, kindId) {
    const kind = MACHINE_UPGRADE_KINDS.find((k) => k.id === kindId);
    if (!kind) return 1;
    return kind.getValue(this.getMachineUpgradeLevel(machineId, kindId));
  }

  getMachineUpgradeCost(machineId, kindId) {
    const base = MACHINE_UPGRADE_BASE_COST[machineId];
    const kind = MACHINE_UPGRADE_KINDS.find((k) => k.id === kindId);
    if (base === undefined || !kind) return null;
    const level = this.getMachineUpgradeLevel(machineId, kindId);
    const kindMult = kindId === 'yield' ? MACHINE_UPGRADE_YIELD_COST_MULT : 1;
    return Math.round(base * kindMult * Math.pow(MACHINE_UPGRADE_COST_SCALE, level));
  }

  buyMachineUpgrade(machineId, kindId) {
    const kind = MACHINE_UPGRADE_KINDS.find((k) => k.id === kindId);
    if (!kind || !this.machineUpgrades[machineId]) return false;

    const level = this.getMachineUpgradeLevel(machineId, kindId);
    if (level >= kind.maxLevel) return false;

    const cost = this.getMachineUpgradeCost(machineId, kindId);
    if (cost === null || !this.canAfford(cost)) return false;

    this.money -= cost;
    this.machineUpgrades[machineId][kindId] = level + 1;

    this.stats.upgradesBought++;
    this._checkAchievements();
    this._syncMoneyState();

    // Ten sam event co zwykłe ulepszenia - UI odświeża się jednym handlerem,
    // a audio/gamefeel dostają sygnał zakupu bez żadnych zmian u siebie.
    Bus.publish(Events.UPGRADE_BOUGHT, {
      upgradeId: `${machineId}_${kindId}`,
      machineId,
      kindId,
      level: level + 1,
      value: kind.getValue(level + 1)
    });
    return true;
  }

  /**
   * Katalog dla UI - TYLKO odblokowane maszyny (patrz isUnlocked). Bez tego
   * gracz na starcie widziałby ulepszenia do Pieca i Oczyszczalni, których
   * nawet jeszcze nie ma na mapie - a lista i tak ma 8 pozycji przy komplecie.
   */
  getMachineUpgradeCatalog() {
    const out = [];
    Object.keys(MACHINE_UPGRADE_BASE_COST).forEach((machineId) => {
      if (!this.isUnlocked(machineId)) return;
      MACHINE_UPGRADE_KINDS.forEach((kind) => {
        const level = this.getMachineUpgradeLevel(machineId, kind.id);
        const maxed = level >= kind.maxLevel;
        out.push({
          id: `${machineId}_${kind.id}`,
          machineId,
          kindId: kind.id,
          icon: kind.icon,
          name: `${MACHINE_UPGRADE_LABELS[machineId] || machineId}: ${kind.name}`,
          description: kind.description,
          level,
          maxLevel: kind.maxLevel,
          cost: maxed ? null : this.getMachineUpgradeCost(machineId, kind.id),
          maxed
        });
      });
    });
    return out;
  }

  buyUpgrade(upgradeId) {
    const def = SHOP_UPGRADES.find((u) => u.id === upgradeId);
    if (!def) return false;

    const level = this.upgradeLevels[upgradeId] || 0;
    if (level >= def.maxLevel) return false;
    // Twarda blokada na duplikat perku statku - getShopCatalog() już takiej
    // pozycji nie pokazuje jako kupowalnej, ale buyUpgrade() jest publiczne
    // (woła je UI, DEBUG, a wcześniej dało się tak wyrzucić 1100$ w błoto),
    // więc warunek musi stać TU, przy pobieraniu pieniędzy - nie tylko w
    // warstwie widoku.
    if (this.isSupersededByShip(upgradeId)) return false;

    const cost = this.getUpgradeCost(upgradeId);
    if (!this.canAfford(cost)) return false;

    this.money -= cost;
    this.upgradeLevels[upgradeId] = level + 1;
    const newLevel = this.upgradeLevels[upgradeId];
    const value = def.getValue(newLevel);

    this.stats.upgradesBought++;
    this._checkAchievements();

    this._syncMoneyState();

    Bus.publish(Events.UPGRADE_BOUGHT, {
      upgradeId,
      level: newLevel,
      value
    });

    Bus.publish(Events.FX_POPUP, {
      // BUGFIX: był `${def.icon} Ulepszenie!` - def.icon to teraz SVG (napis
      // do UI w ui.js), a ten popup rysuje się przez ctx.fillText na
      // canvasie, który SVG/HTML po prostu wypisałby jako surowy tekst.
      text: I18n.t('economy.popup.upgrade'),
      duration: 1200,
      color: '#7CFC98'
    });

    this._applyUpgrade(upgradeId, value);
    return true;
  }

  _applyUpgrade(upgradeId, value) {
    if (upgradeId === 'speed' && window.playerController) {
      window.playerController.setSpeed(value);
    }
    // BUGFIX (dwa źródła tej samej wartości): te branche ustawiają wartość
    // ABSOLUTNĄ z ulepszenia sklepowego. Odkąd Rdzenie też podbijają zasięg
    // (core_magnet) i pojemność (core_backpack), samo przypisanie skasowałoby
    // trwały bonus przy pierwszym zakupie w sklepie - gracz traciłby to, za
    // co zapłacił Rdzeniami, i to po cichu. Bonus z Rdzeni musi więc być
    // doliczany W KAŻDYM miejscu, które ustawia te pola.
    if (upgradeId === 'pickup' && window.itemManager) {
      window.itemManager.pickupRadius = value + (this.getCoreValue('core_magnet') || 0);
    }
    // BUGFIX: ten branch brakował. applySaveData() (niżej) wywołuje
    // _applyUpgrade() dla KAŻDEGO przywróconego ulepszenia, ale bez tego
    // brancha przywrócenie poziomu 'capacity' nigdy nie docierało do
    // window.stackController.maxCapacity - ten zostawał na domyślnych 10,
    // mimo że economyManager.upgradeLevels.capacity (i sklep) poprawnie
    // pokazywały wykupiony poziom. Efekt: po każdym odświeżeniu strony
    // realna pojemność plecaka cofała się do 10, choć sklep twierdził
    // inaczej - i kolejny zakup "działał" tylko do następnego reloadu.
    // Na ŻYWO (bez reloadu) bug nie był widoczny, bo buyUpgrade() (niżej)
    // publikuje Events.UPGRADE_BOUGHT, a stacking.js ma WŁASNY,
    // niezależny listener na ten event, który sam sobie ustawia
    // maxCapacity - stąd wrażenie "działa, dopóki nie odświeżę".
    if (upgradeId === 'capacity' && window.stackController) {
      window.stackController.maxCapacity = value + (this.getCoreValue('core_backpack') || 0);
    }
  }

  // ============================================================================
  // PRESTIŻ: "Nowa Planeta" (Faza 4)
  // ============================================================================

  /**
   * Czy wszystkie moduły statku są ukończone i gracz MOŻE (nie musi od razu)
   * odlecieć na nową planetę. W przeciwieństwie do Events.GAME_WON (strzela
   * TYLKO RAZ, w momencie ukończenia piątego modułu) ten stan da się odczytać
   * też zaraz po wczytaniu zapisu, zanim jakikolwiek event zdąży przelecieć -
   * dlatego ui.js do pokazania trwałego przycisku "Leć dalej" powinien pytać
   * O TO, a nie polegać wyłącznie na złapaniu GAME_WON.
   */
  isReadyToPrestige() {
    return this.shipCompletedModules.length >= ECONOMY_SHIP_MODULE_COUNT;
  }

  /**
   * Ile Rdzeni gracz dostałby, gdyby odleciał TERAZ - do pokazania w UI PRZED
   * kliknięciem, żeby decyzja "lecieć czy jeszcze pozbierać" była świadoma.
   * Ta sama formuła, której faktycznie używa prestige() (woła tę metodę
   * wprost) - jedno miejsce z matematyką, więc podgląd nigdy nie rozjedzie
   * się z realną wypłatą.
   *
   * Pierwiastek zamiast zależności liniowej: rosnący totalEarned daje coraz
   * mniejszy PRZYROST Rdzeni za każde kolejne 100 zarobione, więc farmienie
   * jednego przebiegu w nieskończoność ma malejący sens, a start kolejnej
   * planety zawsze się opłaca.
   *
   * BALANS (przegląd ekonomii): dzielnik był 10 - dawało to ~6-10 Rdzeni za
   * typowy pierwszy odlot (totalEarned ~4800, tyle kosztują wszystkie 5
   * modułów statku), a zmaksowanie JEDNEGO ulepszenia za Rdzenie kosztuje
   * od ~140 (Zapasy Startowe, najtańsze) do ~860 (Wzmacniacz Zarobku)
   * Rdzeni - dawny dzielnik wymagałby dziesiątek-setek odlotów na
   * jedno ulepszenie. Dzielnik 10 -> 2 (5x) daje ten sam pierwszy odlot
   * ~30-35 Rdzeni - wciąż długofalowa progresja (pełne zmaksowanie
   * wszystkich 10 ulepszeń to nadal ~60-100 odlotów), ale każdy
   * pojedynczy odlot realnie kupuje kilka poziomów, nie ułamek jednego.
   *
   * Drugi poziom Rdzeni (core_prestige_boost) mnoży WYNIK pierwiastka, nie
   * totalEarned pod nim - inaczej rósłby wolniej niż liniowo (sam
   * pierwiastek), co przeczyłoby opisowi "+10% Rdzeni za poziom".
   */
  previewPrestigeCores() {
    const boostMult = this.getCoreValue('core_prestige_boost') || 1;
    return Math.max(1, Math.floor((Math.sqrt(this.totalEarned) / 2) * boostMult));
  }

  getCoreUpgradeCost(upgradeId) {
    const def = PRESTIGE_UPGRADES.find((u) => u.id === upgradeId);
    if (!def) return Infinity;
    const level = this.prestigeLevels[upgradeId] || 0;
    if (level >= def.maxLevel) return Infinity;
    return Math.round(def.baseCost * Math.pow(def.costScale, level));
  }

  getCoreShopCatalog() {
    return PRESTIGE_UPGRADES
      // Drugi poziom (patrz komentarz przy definicjach) jest CELOWO
      // niewidoczny w katalogu, dopóki gracz nie dotrze do odpowiedniej
      // planety - nie "zablokowany/zaszarzony" jak w zwykłym sklepie, tylko
      // w ogóle nieobecny, żeby odblokowanie było niespodzianką.
      .filter((def) => !def.unlockPlanet || this.planetNumber >= def.unlockPlanet)
      .map((def) => {
        const level = this.prestigeLevels[def.id] || 0;
        const maxed = level >= def.maxLevel;
        return {
          id: def.id,
          icon: def.icon,
          name: def.name,
          description: def.description,
          level,
          maxLevel: def.maxLevel,
          cost: maxed ? null : this.getCoreUpgradeCost(def.id),
          maxed,
          nextValue: maxed ? def.getValue(level) : def.getValue(level + 1)
        };
      });
  }

  /** Kupuje poziom trwałego ulepszenia za Rdzenie. Osobny katalog/waluta od
   * buyUpgrade() (zwykły sklep, za money) - stąd osobna metoda i osobny event
   * (Events.CORE_UPGRADE_BOUGHT), żeby nie mieszać dwóch różnych "sklepów"
   * pod jednym listenerem w ui.js. */
  buyCoreUpgrade(upgradeId) {
    const def = PRESTIGE_UPGRADES.find((u) => u.id === upgradeId);
    if (!def) return false;
    // Lustrzane zabezpieczenie do filtra w getCoreShopCatalog() - katalog i
    // tak nie pokazuje tej pozycji przed odblokowaniem, ale metoda broni się
    // sama, tak samo jak isReadyToPrestige() niżej w prestige().
    if (def.unlockPlanet && this.planetNumber < def.unlockPlanet) return false;

    const level = this.prestigeLevels[upgradeId] || 0;
    if (level >= def.maxLevel) return false;

    const cost = this.getCoreUpgradeCost(upgradeId);
    if (this.cores < cost) return false;

    this.cores -= cost;
    this.prestigeLevels[upgradeId] = level + 1;
    const newLevel = this.prestigeLevels[upgradeId];
    const value = def.getValue(newLevel);

    // Zasięg/pojemność nakładamy OD RAZU, nie dopiero od następnej planety -
    // gracz kupuje je zwykle tuż po odlocie i czekanie cały przebieg na
    // efekt czegoś, za co właśnie zapłacił, byłoby zwyczajnie mylące.
    // (core_income/core_prices/core_machine_speed są czytane na bieżąco przez
    // odpowiednie moduły, więc te nie wymagają żadnego nakładania.)
    this._applyCorePassives();

    Bus.publish(Events.CORE_UPGRADE_BOUGHT, { upgradeId, level: newLevel, value });
    Bus.publish(Events.FX_POPUP, {
      // BUGFIX: ten sam powód co przy zwykłym zakupie wyżej - def.icon to
      // teraz SVG, nie da się tego narysować przez ctx.fillText.
      text: I18n.t('economy.popup.coreUpgrade'),
      duration: 1200,
      color: '#81D4FA'
    });

    return true;
  }

  /** Katalog skinów do UI (patrz PLAYER_SKINS) - ten sam kształt danych co
   * getCoreShopCatalog(), tylko z unlocked/selected zamiast level/maxed.
   * `available` = false dla eventOnly skinów poza oknem wydarzenia (patrz
   * events.js: SeasonalEventManager.isActive()) - JUŻ odblokowane zostają
   * jednak zawsze available (kupiony raz, nie znika z listy do wyboru). */
  getSkinCatalog() {
    const eventActive = !!(window.seasonalEventManager && window.seasonalEventManager.isActive());
    return PLAYER_SKINS.map((def) => ({
      id: def.id,
      name: def.name,
      desc: def.desc,
      tint: def.tint,
      body: def.body,
      previewColor: def.previewColor,
      cost: def.cost,
      unlocked: this.unlockedSkins.has(def.id),
      selected: this.selectedSkin === def.id,
      eventOnly: !!def.eventOnly,
      available: !def.eventOnly || eventActive || this.unlockedSkins.has(def.id)
    }));
  }

  /** Kupuje i OD RAZU zakłada skin (nikt nie kupuje kosmetyki, żeby jej NIE
   * nosić - osobne "kup" + "wybierz" byłoby zbędnym dodatkowym klikiem). */
  buySkin(skinId) {
    const def = PLAYER_SKINS.find((s) => s.id === skinId);
    if (!def) return false;
    if (this.unlockedSkins.has(skinId)) return false;
    if (def.eventOnly && !(window.seasonalEventManager && window.seasonalEventManager.isActive())) return false;
    if (this.cores < def.cost) return false;

    this.cores -= def.cost;
    this.unlockedSkins.add(skinId);
    this.selectedSkin = skinId;
    this.stats.skinsCollected++;
    this._checkAchievements();

    Bus.publish(Events.FX_POPUP, {
      text: `${def.name} odblokowany!`,
      duration: 1200,
      color: '#81D4FA'
    });
    return true;
  }

  /** Zakłada JUŻ odblokowany skin - osobna metoda od buySkin() (ten sam
   * podział co buyUpgrade() vs zwykłe czytanie upgradeLevels gdzie indziej). */
  selectSkin(skinId) {
    if (!this.unlockedSkins.has(skinId)) return false;
    this.selectedSkin = skinId;
    return true;
  }

  /**
   * Odlot na nową planetę - JEDYNY sposób na zdobycie Rdzeni. Zeruje CAŁY
   * przebieg (pieniądze, zwykłe SHOP_UPGRADES + ich efekty w innych modułach,
   * postęp statku, zawartość plecaka), ale NIGDY nie rusza cores/
   * prestigeLevels/planetNumber - te trwają (patrz komentarz w konstruktorze).
   *
   * Wymaga isReadyToPrestige() - ui.js ma to sprawdzić PRZED pokazaniem
   * przycisku, ale metoda i tak broni się sama na wypadek błędu w UI.
   *
   * @returns {{coresEarned:number, totalCores:number, planetNumber:number}|null}
   *   null, gdy statek jeszcze nie jest gotowy (nic nie zostaje zresetowane).
   */
  /**
   * Wpisuje właśnie ukończony przebieg do lokalnej tablicy wyników (patrz
   * bestRunsByEarned/bestRunsByTime w konstruktorze) - do KAŻDEJ z dwóch list
   * niezależnie, tylko jeśli przebieg faktycznie łapie się do topu
   * LEADERBOARD_MAX_ENTRIES. Zwraca, czy to nowy rekord (pozycja #1) w
   * którejś liście - ui.js pokazuje na tej podstawie osobny toast.
   */
  _recordRun(entry) {
    const record = { ...entry, ts: Date.now() };
    return {
      earned: this._insertIntoLeaderboard(this.bestRunsByEarned, record, (a, b) => b.earned - a.earned),
      time: this._insertIntoLeaderboard(this.bestRunsByTime, record, (a, b) => a.timeSeconds - b.timeSeconds)
    };
  }

  /** Wstawia wpis w odpowiednie miejsce posortowanej listy i przycina do
   * LEADERBOARD_MAX_ENTRIES. Zwraca true, gdy wpis wylądował na #1 ORAZ
   * lista miała już wcześniej jakąś zawartość (pierwszy przebieg w historii
   * trywialnie "wygrywa" pustą listę - to nie jest pobity rekord, tylko
   * pierwszy punkt danych, więc nie zasługuje na toast "Nowy rekord!"). */
  _insertIntoLeaderboard(list, entry, compareFn) {
    const hadPriorEntries = list.length > 0;
    list.push(entry);
    list.sort(compareFn);
    const brokeRecord = hadPriorEntries && list[0] === entry;
    list.length = Math.min(list.length, LEADERBOARD_MAX_ENTRIES);
    return brokeRecord;
  }

  /**
   * Katalog tablicy wyników dla UI (LeaderboardPanel w ui.js) - ten sam
   * wzorzec co getStatsCatalog()/getSkinCatalog(): gotowe do wyświetlenia
   * stringi (kwota z ikoną waluty, czas sformatowany), nie surowe liczby.
   * @param {'earned'|'time'} mode - którą listę zwrócić.
   */
  getLeaderboard(mode) {
    const list = mode === 'time' ? this.bestRunsByTime : this.bestRunsByEarned;
    return list.map((entry, i) => ({
      rank: i + 1,
      planetNumber: entry.planetNumber,
      earnedLabel: `${Math.round(entry.earned).toLocaleString('pl-PL')}${ECONOMY_CREDIT_ICON_SVG}`,
      timeLabel: _formatRunTime(entry.timeSeconds)
    }));
  }

  prestige() {
    if (!this.isReadyToPrestige()) return null;

    const coresEarned = this.previewPrestigeCores();
    this.cores += coresEarned;
    this.stats.coresEarned += coresEarned;

    // Migawka PRZED resetem niżej - reset zeruje totalEarned/
    // totalPlaytimeSeconds, a inkrement planetNumber (dalej w tej metodzie)
    // zmieniłby, KTÓREJ planety ten wpis właściwie dotyczy (ma być numer
    // planety, którą gracz WŁAŚNIE ukończył, nie tej, na którą dopiero leci).
    const newRecords = this._recordRun({
      planetNumber: this.planetNumber,
      earned: this.totalEarned,
      timeSeconds: this.totalPlaytimeSeconds,
      coresEarned
    });

    // --- Reset przebiegu -----------------------------------------------------
    this.money = 0;
    this.totalEarned = 0;
    // Razem z totalEarned - inaczej licznik czasu liczyłby CAŁĄ dotychczasową
    // grę, a licznik zarobku tylko nową planetę, co dałoby sztucznie niskie
    // tempo (i przez to nagrodę offline) zaraz po każdym prestiżu.
    this.totalPlaytimeSeconds = 0;
    this.sellEarnings = 0;
    this.comboStacks = 0;
    this._lastPayoutAt = 0;
    SHOP_UPGRADES.forEach((u) => {
      this.upgradeLevels[u.id] = 0;
    });
    // Ulepszenia maszyn to też stan PRZEBIEGU (kupowane za gotówkę) - lecą
    // razem z resztą. Trwałe zostają wyłącznie Rdzenie i to, co za nie kupione.
    this._resetMachineUpgrades();
    this.shipMoneyContributed = {};
    this.shipMaterialsContributed = {};
    this.shipCompletedModules = [];

    // Cofa efekty zwykłych ulepszeń w INNYCH modułach do wartości domyślnych
    // (patrz ECONOMY_DEFAULT_* na górze pliku). Bez tego byłby to dokładnie
    // ten sam bug, który naprawiliśmy w _applyUpgrade() dla capacity - tylko
    // rozlany na speed/pickup/capacity naraz, i trudniejszy do zauważenia,
    // bo "działa do najbliższego prestiżu", nie "do najbliższego reloadu".
    // Wartości bazowe + TRWAŁE bonusy z Rdzeni (core_magnet/core_backpack).
    // Te dwa muszą wejść DOKŁADNIE TUTAJ, razem z resetem: gdyby doliczać je
    // gdzie indziej, reset ustawiłby gołe ECONOMY_DEFAULT_* i gracz zaczynałby
    // nową planetę bez tego, za co zapłacił Rdzeniami. To ta sama klasa błędu,
    // przed którą ostrzega komentarz wyżej - tylko w drugą stronę.
    const bonusPickup = this.getCoreValue('core_magnet') || 0;
    const bonusCapacity = this.getCoreValue('core_backpack') || 0;

    if (window.playerController) window.playerController.setSpeed(ECONOMY_DEFAULT_SPEED);
    if (window.itemManager) window.itemManager.pickupRadius = ECONOMY_DEFAULT_PICKUP_RADIUS + bonusPickup;
    if (window.stackController) {
      window.stackController.maxCapacity = ECONOMY_DEFAULT_CAPACITY + bonusCapacity;
      window.stackController.clear(); // plecak NIE leci z Tobą na nową planetę
    }

    // Modyfikator nowej planety (patrz PLANET_MODIFIERS) - losowany TU, przed
    // ustaleniem gotówki startowej, żeby ewentualny cashBonus wszedł w tę samą
    // sumę co Zapasy Startowe (jedno przypisanie do this.money, nie dwa
    // kolejne nadpisujące się nawzajem).
    this._rollPlanetModifier();

    // Zapasy Startowe (core_headstart) - jedyny trwały bonus wchodzący jako
    // gotówka NA START nowego przebiegu, a nie jako pasywny mnożnik przy
    // każdej sprzedaży (to robi core_income, patrz _getCoreIncomeMultiplier).
    const headstartDef = PRESTIGE_UPGRADES.find((u) => u.id === 'core_headstart');
    const headstartMoney = headstartDef ? headstartDef.getValue(this.prestigeLevels.core_headstart || 0) : 0;
    const modifierCash = (this.activeModifier && typeof this.activeModifier.cashBonus === 'number')
      ? this.activeModifier.cashBonus
      : 0;
    this.money = headstartMoney + modifierCash;

    this.planetNumber += 1;

    // Licznik LIFETIME dla osiągnięć - ukończona planeta = ten prestiż.
    // Osobno od planetNumber (to numer BIEŻĄCEJ planety, +1 z góry), tu
    // liczymy ile już ukończono, więc inkrement PO fakcie odlotu.
    this.stats.planetsCompleted++;
    this._checkAchievements();

    if (this.game && this.game.state) {
      this.game.state.money = this.money;
    }
    Bus.publish(Events.MONEY_COLLECTED, { amount: 0, total: this.money });

    const result = {
      coresEarned,
      totalCores: this.cores,
      planetNumber: this.planetNumber,
      modifier: this.activeModifier,
      newRecords
    };
    Bus.publish(Events.PRESTIGE_DONE, result);
    return result;
  }

  // ============================================================================
  // CODZIENNE HAKI: streak logowania + wyzwanie dnia (Faza 5)
  // ============================================================================

  /** Dzisiejsza data jako string YYYY-MM-DD w CZASIE LOKALNYM gracza (nie
   * UTC) - używamy jej zamiast znacznika czasu, żeby porównania "czy to ten
   * sam dzień" nie musiały martwić się strefą czasową ani porą dnia. */
  _todayDateStr() {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${mm}-${dd}`;
  }

  /** Różnica w PEŁNYCH dniach kalendarzowych między dwoma datami YYYY-MM-DD
   * (dodatnia, gdy dateStr2 jest późniejsza). Parsowane jako północ lokalna,
   * żeby "wczoraj o 23:59" i "dziś o 00:01" dały różnicę 1, nie ułamek. */
  _daysBetween(dateStr1, dateStr2) {
    const d1 = new Date(`${dateStr1}T00:00:00`);
    const d2 = new Date(`${dateStr2}T00:00:00`);
    return Math.round((d2 - d1) / 86400000);
  }

  /**
   * Sprawdza, czy to nowy dzień kalendarzowy od ostatniego logowania - jeśli
   * tak, aktualizuje streak (kontynuacja +1, przerwa >1 dnia = reset do 1)
   * i wypłaca nagrodę. Wołane RAZ przy starcie gry (main.js, PO wczytaniu
   * zapisu - inaczej lastLoginDateStr byłoby jeszcze puste). Bezpieczne przy
   * wielokrotnym wywołaniu tego samego dnia (np. kilka odświeżeń) - drugi
   * raz po prostu nic nie robi.
   * @returns {{streak:number, moneyReward:number, coreBonus:number}|null}
   *   null, gdy dzisiaj już sprawdzone.
   */
  checkDailyLogin() {
    const today = this._todayDateStr();
    if (this.lastLoginDateStr === today) return null;

    // BUGFIX: zupełnie nowy gracz (lastLoginDateStr jeszcze puste - pierwsze
    // uruchomienie w życiu) dostawał TEN SAM dzień-1 bonus streaka co gracz
    // wracający po przerwie (+55$ zanim jeszcze cokolwiek zrobił w grze).
    // Gra ma zaczynać się od zera - streak liczy się dopiero od PIERWSZEGO
    // PRAWDZIWEGO powrotu (jutro), więc dziś tylko zapisujemy datę/streak=1
    // bez wypłaty i bez toastu.
    const isFirstEverLogin = !this.lastLoginDateStr;
    if (isFirstEverLogin) {
      this.loginStreak = 1;
      this.lastLoginDateStr = today;
      return null;
    }

    const gap = this._daysBetween(this.lastLoginDateStr, today);
    this.loginStreak = gap === 1 ? this.loginStreak + 1 : 1;
    this.lastLoginDateStr = today;

    const rawMoneyReward = DAILY_STREAK_BASE + Math.min(this.loginStreak, DAILY_STREAK_CAP_DAYS) * DAILY_STREAK_PER_DAY;
    // Drugi poziom Rdzeni (core_daily_master) - mnożnik NA nagrodę streaka,
    // ten sam duch co core_prices na targu, tylko dla innej pętli. Domyślnie
    // getValue(0) zwraca 1 (patrz definicja), więc bez zakupu nic się nie zmienia.
    const dailyMult = this.getCoreValue('core_daily_master') || 1;
    const baseMoneyReward = Math.round(rawMoneyReward * dailyMult);
    const coreBonus = (this.loginStreak % DAILY_STREAK_CORE_INTERVAL === 0) ? 1 : 0;

    // BUGFIX: ten sam powód co w sellItem() (patrz komentarz przy
    // _addMoney) - moneyReward w evencie/toastcie musi być tym, co
    // FAKTYCZNIE wpadło na konto (po mnożniku core_income), nie kwotą
    // bazową, inaczej gracz z Wzmacniaczem Zarobku widziałby zaniżoną
    // liczbę w powiadomieniu.
    const moneyReward = this._addMoney(baseMoneyReward);
    if (coreBonus > 0) this.cores += coreBonus;

    // Najwyższy osiągnięty streak (dla osiągnięcia "Codzienny gracz") - max,
    // nie bieżący, bo przerwanie serii nie powinno "cofać" zdobytego trofeum.
    this.stats.maxLoginStreak = Math.max(this.stats.maxLoginStreak, this.loginStreak);
    this._checkAchievements();

    const result = { streak: this.loginStreak, moneyReward, coreBonus };
    Bus.publish(Events.DAILY_LOGIN, result);
    return result;
  }

  /** true, gdy surowiec szablonu 'collect' faktycznie może się w tej chwili
   * pojawić w świecie - ta sama bramka co availableTypes w items.js
   * (_spawnItem), tylko od strony EconomyManager (jedyne dane, jakie tu
   * mamy - isUnlocked/upgradeLevels). BUGFIX: bez tego filtra wyzwanie typu
   * "zbierz szkło/metal/papier" potrafiło wylosować się, zanim gracz w
   * ogóle miał gdzie/z czego ten surowiec zebrać (świeża gra ALBO świeżo
   * po prestiżu, patrz prestige() zerujące upgradeLevels) - progress
   * pozostawał na 0 do końca dnia, cel realnie nieosiągalny. */
  _isChallengeTemplateAvailable(template) {
    if (template.type !== 'collect') return true;
    switch (template.material) {
      case 'glass': return this.isUnlocked('zone_B') && this.isUnlocked('furnace_c');
      case 'metal': return this.isUnlocked('zone_C') && this.isUnlocked('furnace_c');
      case 'paper': return (this.upgradeLevels['stage_paper'] || 0) > 0;
      // Ta sama bramka co availableTypes w items.js (_spawnItem) dla
      // crystal_shard - próg strefy SAM NIE wystarcza, trzeba też pełnej
      // ochrony (Filtr + Kombinezon, albo perk hazard_immunity ze statku),
      // inaczej wyzwanie rolowałoby się, zanim gracz w ogóle mógłby
      // bezpiecznie wejść do Grani i cokolwiek zebrać.
      case 'crystal_shard': {
        const hasFullProtection = (typeof this.hasShipPerk === 'function' && this.hasShipPerk('hazard_immunity'))
          || (this.hasUpgrade('toxic_filter') && this.hasUpgrade('radiation_suit'));
        return this.isUnlocked('zone_D') && hasFullProtection;
      }
      default: return true; // trash/plastic - zawsze dostępne
    }
  }

  /** Losuje nowe wyzwanie z DAILY_CHALLENGE_TEMPLATES (po odfiltrowaniu
   * szablonów niedostępnych w obecnym stanie gry), ostemplowane dzisiejszą
   * datą. */
  _generateDailyChallenge() {
    const pool = DAILY_CHALLENGE_TEMPLATES.filter((t) => this._isChallengeTemplateAvailable(t));
    const template = pool[Math.floor(Math.random() * pool.length)];
    this.dailyChallenge = {
      dateStr: this._todayDateStr(),
      type: template.type,
      material: template.material || null,
      target: template.target,
      reward: template.reward,
      label: template.label,
      progress: 0,
      claimed: false
    };
  }

  /**
   * Jeśli obecne wyzwanie jest z innego dnia niż dziś (albo jeszcze nie
   * istnieje), losuje nowe - NIEZALEŻNIE od tego, czy poprzednie było
   * ukończone/odebrane. Nieodebrana nagroda z wczoraj po prostu przepada -
   * to świadome, standardowe zachowanie "wyzwań dnia" (presja, żeby wracać
   * i odbierać na czas), nie błąd. Wołane RAZ przy starcie gry, zaraz po
   * checkDailyLogin().
   */
  checkDailyChallenge() {
    const today = this._todayDateStr();
    if (this.dailyChallenge && this.dailyChallenge.dateStr === today) return;
    this._generateDailyChallenge();
  }

  /** Odbiera nagrodę ukończonego wyzwania. Zwraca false, gdy nie ma czego
   * odebrać (nie istnieje / niedokończone / już odebrane). */
  claimDailyChallenge() {
    const c = this.dailyChallenge;
    if (!c || c.claimed || c.progress < c.target) return false;

    c.claimed = true;
    // BUGFIX: ten sam wzorzec co sellItem()/checkDailyLogin() - nagroda w
    // evencie/toastcie to realna kwota po mnożniku core_income.
    const paidOut = this._addMoney(c.reward);

    this.stats.challengesClaimed++;
    this._checkAchievements();

    Bus.publish(Events.DAILY_CHALLENGE_CLAIMED, { reward: paidOut });
    Bus.publish(Events.DAILY_CHALLENGE_UPDATED, { ...c });
    return true;
  }

  // ============================================================================
  // PRODUKCJA OFFLINE (Faza 5)
  // ============================================================================

  /**
   * Czysta kalkulacja (BEZ efektów ubocznych - nie dodaje pieniędzy, nie
   * publikuje eventów) - wołana raz przy starcie gry (main.js), żeby
   * zdecydować, czy w ogóle jest co pokazać w modalu powitalnym.
   *
   * BUGFIX: liczyło tempo z totalEarned/totalPlaytimeSeconds - totalEarned
   * rośnie też od DEBUG.addMoney(), nagród streaka i wyzwań dnia, nie tylko
   * prawdziwej sprzedaży. Jednorazowy zastrzyk (np. DEBUG.addMoney(2000))
   * przy dopiero co rozpoczętej sesji windował tempo do absurdu i dawał
   * gigantyczną nagrodę offline. Teraz liczy z sellEarnings - rośnie
   * WYŁĄCZNIE w sellItem(), więc reprezentuje wyłącznie realny rytm
   * sprzedawania, nie jednorazowe wstrzyknięcia kasy. Dodatkowo wymaga
   * minimum OFFLINE_MIN_PLAYTIME_SECONDS realnej gry, zanim w ogóle zaufa
   * wyliczonemu tempu - kilka sekund gry i jedna sprzedaż też potrafiłyby
   * dać chwilowo zawyżony wynik.
   *
   * @param {number} elapsedMs - ile ms minęło od ostatniego zapisu (main.js
   *   liczy to z SaveManager.load(), który teraz zwraca tę wartość zamiast
   *   zwykłego true/false - patrz save.js).
   * @returns {{elapsedSeconds:number, reward:number}|null} null, gdy za
   *   krótko offline, za mało realnej gry w tym przebiegu, albo tempo
   *   sprzedaży wynosi 0 (świeży gracz, jeszcze nic nie sprzedał) - nie ma
   *   na czym oprzeć nagrody, więc lepiej nic nie pokazać niż "+0".
   */
  computeOfflineReward(elapsedMs) {
    const elapsedSeconds = Math.floor((elapsedMs || 0) / 1000);
    if (elapsedSeconds < OFFLINE_MIN_SECONDS) return null;
    if (this.totalPlaytimeSeconds < OFFLINE_MIN_PLAYTIME_SECONDS) return null;

    // Drugi poziom Rdzeni (core_offline_master) dokłada się WPROST do
    // skuteczności, zamiast osobnego mnożnika - efekt identyczny co
    // podniesienie samej stałej, tylko trwały i skalowalny z poziomami.
    const efficiency = OFFLINE_EFFICIENCY + (this.getCoreValue('core_offline_master') || 0);
    const cappedSeconds = Math.min(elapsedSeconds, OFFLINE_MAX_SECONDS);
    const rate = this.sellEarnings / this.totalPlaytimeSeconds;
    const reward = Math.round(rate * cappedSeconds * efficiency);
    if (reward <= 0) return null;

    return { elapsedSeconds: cappedSeconds, reward };
  }

  /**
   * Faktycznie wypłaca nagrodę offline - PRZYJMUJE gotową kwotę z
   * computeOfflineReward() (nie liczy jej ponownie), żeby to, co gracz
   * widział w modalu, było dokładnie tym, co dostanie, niezależnie od
   * czegokolwiek co mogłoby się zmienić między pokazaniem a kliknięciem.
   * doubled=true to hak pod "obejrzyj reklamę x2" (patrz ui.js) - na razie
   * podwaja lokalnie, docelowo wywoła prawdziwe rewarded video (Capacitor+
   * AdMob, faza pakowania pod Play Store).
   * @returns {number} realna kwota faktycznie dodana (po mnożniku core_income)
   */
  claimOfflineReward(reward, doubled = false) {
    const finalAmount = doubled ? reward * 2 : reward;
    return this._addMoney(finalAmount);
  }

  applySaveData(data) {
    if (!data) return;
    if (typeof data.money === 'number') {
      this.money = data.money;
      if (this.game && this.game.state) {
        this.game.state.money = this.money;
      }
    }
    if (typeof data.totalEarned === 'number') {
      this.totalEarned = data.totalEarned;
    }
    if (typeof data.totalPlaytimeSeconds === 'number') {
      this.totalPlaytimeSeconds = data.totalPlaytimeSeconds;
    }
    if (typeof data.sellEarnings === 'number') {
      this.sellEarnings = data.sellEarnings;
    }
    if (data.upgradeLevels && typeof data.upgradeLevels === 'object') {
      Object.keys(data.upgradeLevels).forEach((id) => {
        if (this.upgradeLevels[id] !== undefined) {
          this.upgradeLevels[id] = data.upgradeLevels[id];
          const def = SHOP_UPGRADES.find((u) => u.id === id);
          if (def) {
            this._applyUpgrade(id, def.getValue(this.upgradeLevels[id]));
          }
        }
      });
    }
    // Ulepszenia maszyn - merge per-klucz (jak stats wyżej), NIE podmiana
    // całego obiektu: zapis sprzed dodania tej funkcji (albo sprzed dodania
    // nowej maszyny) nie ma wszystkich kluczy, a podmiana zostawiłaby
    // machineUpgrades bez wpisów, których szuka getMachineUpgradeLevel.
    if (data.machineUpgrades && typeof data.machineUpgrades === 'object') {
      Object.keys(this.machineUpgrades).forEach((machineId) => {
        const saved = data.machineUpgrades[machineId];
        if (!saved) return;
        Object.keys(this.machineUpgrades[machineId]).forEach((kindId) => {
          if (typeof saved[kindId] === 'number') {
            this.machineUpgrades[machineId][kindId] = saved[kindId];
          }
        });
      });
    }
    if (data.shipMoneyContributed && typeof data.shipMoneyContributed === 'object') {
      this.shipMoneyContributed = { ...data.shipMoneyContributed };
    }
    if (data.shipMaterialsContributed && typeof data.shipMaterialsContributed === 'object') {
      this.shipMaterialsContributed = JSON.parse(JSON.stringify(data.shipMaterialsContributed));
    }
    if (Array.isArray(data.shipCompletedModules)) {
      this.shipCompletedModules = [...data.shipCompletedModules];
    }
    // --- Prestiż: pola TRWAŁE - przetrwały już jeden reset w prestige(),
    // więc tu tylko wczytujemy je z powrotem po odświeżeniu strony (ten sam
    // wzorzec co reszta tej metody, żadnej specjalnej logiki). ---------------
    if (typeof data.cores === 'number') {
      this.cores = data.cores;
    }
    if (typeof data.planetNumber === 'number') {
      this.planetNumber = data.planetNumber;
    }
    // Modyfikator planety - zapisywany jako samo id (patrz getSaveData), tu
    // odtwarzamy pełny obiekt z bieżącej definicji PLANET_MODIFIERS. Zapis
    // sprzed dodania tej funkcji (albo id, które zniknęło z puli) po prostu
    // zostaje bez modyfikatora zamiast wywalać się na undefined.
    if (typeof data.activeModifierId === 'string') {
      const def = PLANET_MODIFIERS.find((m) => m.id === data.activeModifierId);
      this.activeModifier = def ? { ...def } : null;
    }
    if (data.prestigeLevels && typeof data.prestigeLevels === 'object') {
      Object.keys(data.prestigeLevels).forEach((id) => {
        if (this.prestigeLevels[id] !== undefined) {
          this.prestigeLevels[id] = data.prestigeLevels[id];
        }
      });
    }
    // --- Codzienne haki: TEŻ trwałe (patrz komentarz przy stałych na górze
    // pliku) - wczytujemy z powrotem, a checkDailyLogin()/checkDailyChallenge()
    // (wołane zaraz po load() w main.js) same rozstrzygną, czy to nadal
    // dzisiejszy dzień czy trzeba zaktualizować streak/wylosować nowe wyzwanie.
    if (typeof data.loginStreak === 'number') {
      this.loginStreak = data.loginStreak;
    }
    if (typeof data.lastLoginDateStr === 'string') {
      this.lastLoginDateStr = data.lastLoginDateStr;
    }
    if (data.dailyChallenge && typeof data.dailyChallenge === 'object') {
      this.dailyChallenge = { ...data.dailyChallenge };
    }
    if (typeof data.tutorialStep === 'number') {
      this.tutorialStep = data.tutorialStep;
    }
    if (typeof data.tutorialDismissed === 'boolean') {
      this.tutorialDismissed = data.tutorialDismissed;
    }
    if (Array.isArray(data.unlockedIds)) {
      this.unlockedIds = new Set(data.unlockedIds);
    }
    // Skiny postaci (meta, trwałe jak unlockedIds) - 'default' zostaje w
    // Secie nawet gdy brak w zapisie (Set() startuje z nim w konstruktorze,
    // .add poniżej tylko dokłada resztę), więc stary zapis sprzed tej
    // funkcji nie zostawia gracza bez ŻADNEGO odblokowanego skina.
    if (Array.isArray(data.unlockedSkins)) {
      data.unlockedSkins.forEach((id) => this.unlockedSkins.add(id));
    }
    if (typeof data.selectedSkin === 'string' && this.unlockedSkins.has(data.selectedSkin)) {
      this.selectedSkin = data.selectedSkin;
    }
    // Lokalna tablica wyników (meta, trwała jak unlockedSkins) - filtr na
    // kształt wpisu (nie samo Array.isArray) na wypadek uszkodzonego/ręcznie
    // edytowanego zapisu, .slice na koniec dla zapisów sprzed ewentualnej
    // zmiany LEADERBOARD_MAX_ENTRIES na mniejszą wartość.
    if (Array.isArray(data.bestRunsByEarned)) {
      this.bestRunsByEarned = data.bestRunsByEarned
        .filter((e) => e && typeof e.earned === 'number' && typeof e.timeSeconds === 'number')
        .slice(0, LEADERBOARD_MAX_ENTRIES);
    }
    if (Array.isArray(data.bestRunsByTime)) {
      this.bestRunsByTime = data.bestRunsByTime
        .filter((e) => e && typeof e.earned === 'number' && typeof e.timeSeconds === 'number')
        .slice(0, LEADERBOARD_MAX_ENTRIES);
    }
    // Osiągnięcia + liczniki lifetime (meta, trwałe jak unlockedIds). Merge
    // per-klucz (nie podmiana całego obiektu), żeby zapis SPRZED dodania
    // jakiegoś licznika nie zerował go do undefined - brakujące klucze
    // zostają na zerze z konstruktora.
    if (data.stats && typeof data.stats === 'object') {
      Object.keys(this.stats).forEach((k) => {
        if (typeof data.stats[k] === 'number') this.stats[k] = data.stats[k];
      });
    }
    if (Array.isArray(data.unlockedAchievements)) {
      this.unlockedAchievements = new Set(data.unlockedAchievements);
    }
    // Domknięcie po wczytaniu - zapis SPRZED tej funkcji (albo z nowo dodanym
    // osiągnięciem, którego próg gracz już dawno przekroczył) powinien od razu
    // dostać należne trofea, nie czekać na kolejny inkrement licznika.
    this._checkAchievements();
    // Po wczytaniu domykamy odblokowania na podstawie totalEarned - kluczowe
    // dla zapisów SPRZED tej funkcji (gracz z już wysokim totalEarned
    // powinien dostać wszystkie należne odblokowania od razu, nie czekać aż
    // znów przekroczy progi). Publikuje UNLOCK_GRANTED, ale to przy starcie
    // gry, więc żaden toast się nie zgubi (ui.js już nasłuchuje).
    this._checkUnlocks();
    // Trwałe bonusy z Rdzeni (zasięg/pojemność) - MUSZĄ zostać nałożone po
    // wczytaniu, bo _applyUpgrade wyżej ustawia same wartości sklepowe.
    // Bez tego bonus znikałby po każdym odświeżeniu strony - dokładnie ten
    // sam bug, który już raz trafił się przy capacity (patrz _applyUpgrade).
    this._applyCorePassives();
  }

  getSaveData() {
    return {
      money: this.money,
      totalEarned: this.totalEarned,
      totalPlaytimeSeconds: this.totalPlaytimeSeconds,
      sellEarnings: this.sellEarnings,
      upgradeLevels: { ...this.upgradeLevels },
      machineUpgrades: JSON.parse(JSON.stringify(this.machineUpgrades)),
      shipMoneyContributed: { ...this.shipMoneyContributed },
      shipMaterialsContributed: JSON.parse(JSON.stringify(this.shipMaterialsContributed)),
      shipCompletedModules: [...this.shipCompletedModules],
      cores: this.cores,
      planetNumber: this.planetNumber,
      activeModifierId: this.activeModifier ? this.activeModifier.id : null,
      prestigeLevels: { ...this.prestigeLevels },
      loginStreak: this.loginStreak,
      lastLoginDateStr: this.lastLoginDateStr,
      dailyChallenge: this.dailyChallenge ? { ...this.dailyChallenge } : null,
      tutorialStep: this.tutorialStep,
      tutorialDismissed: this.tutorialDismissed,
      unlockedIds: Array.from(this.unlockedIds),
      stats: { ...this.stats },
      unlockedAchievements: Array.from(this.unlockedAchievements),
      selectedSkin: this.selectedSkin,
      unlockedSkins: Array.from(this.unlockedSkins),
      bestRunsByEarned: this.bestRunsByEarned.map((e) => ({ ...e })),
      bestRunsByTime: this.bestRunsByTime.map((e) => ({ ...e }))
    };
  }

  destroy() {
    // sellItem() jest wolane bezposrednio przez TradingPost (nie event) -
    // ale ITEM_PICKUP/MACHINE_RECEIVED (śledzenie wyzwania dnia) SĄ
    // subskrypcjami Bus, dodanymi w konstruktorze - trzeba je odpiąć.
    Bus.unsubscribe(Events.ITEM_PICKUP, this._onItemPickup);
    Bus.unsubscribe(Events.MACHINE_RECEIVED, this._onMachineReceived);
    if (Events.SHIP_MODULE_COMPLETED) Bus.unsubscribe(Events.SHIP_MODULE_COMPLETED, this._onShipModuleCompletedStat);
  }
}

window.EconomyManager = EconomyManager;
window.SHOP_UPGRADES = SHOP_UPGRADES;
window.ACHIEVEMENTS = ACHIEVEMENTS;
// Czytane wprost przez player.js (_bakeSkinTints) - patrz komentarz przy
// PLAYER_SKINS wyżej.
window.PLAYER_SKINS = PLAYER_SKINS;
// Do porównania w ui.js (_onPrestigeDone) - żeby dało się rozpoznać moment
// odblokowania drugiego poziomu ulepszeń bez duplikowania liczby "5" w
// dwóch plikach.
window.CORE_TIER2_UNLOCK_PLANET = CORE_TIER2_UNLOCK_PLANET;