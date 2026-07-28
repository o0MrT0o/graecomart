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

const SHOP_UPGRADES = [
  {
    id: 'capacity',
    icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="#E8EAF6" stroke-width="2"><rect x="5" y="9" width="14" height="12" rx="3"/><path d="M9 9 V6 a3 3 0 0 1 6 0 v3"/><rect x="9.5" y="12.5" width="5" height="4" rx="1" fill="#E8EAF6" stroke="none"/></svg>',
    name: 'Większy plecak',
    description: '+2 miejsca na stosie',
    baseCost: 40,
    costScale: 1.65,
    maxLevel: 5,
    getValue(level) {
      return 10 + level * 2;
    }
  },
  {
    id: 'speed',
    icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="#E8EAF6" stroke-width="2.2" stroke-linecap="round"><path d="M3 7 H9"/><path d="M2 12 H13"/><path d="M3 17 H9"/><path d="M14 6 L21 12 L14 18 Z" fill="#E8EAF6" stroke="none"/></svg>',
    name: 'Szybsze buty',
    description: '+15% prędkości ruchu',
    baseCost: 60,
    costScale: 1.8,
    maxLevel: 4,
    getValue(level) {
      return 180 * (1 + level * 0.15);
    }
  },
  {
    id: 'pickup',
    icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="26" height="26" fill="none" stroke-width="2.4" stroke-linecap="round"><path d="M6 4 V13 a6 6 0 0 0 12 0 V4" stroke="#E8EAF6"/><path d="M6 4 H10" stroke="#EF5350"/><path d="M14 4 H18" stroke="#64B5F6"/></svg>',
    name: 'Magnes na śmieci',
    description: '+10 px zasięgu podnoszenia',
    baseCost: 35,
    costScale: 1.5,
    maxLevel: 3,
    getValue(level) {
      return 55 + level * 10;
    }
  },
  {
    id: 'stage_paper',
    icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="#E8EAF6" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"><path d="M6 3 H15 L19 7 V21 H6 Z"/><path d="M15 3 V7 H19"/><path d="M9 12 H16 M9 16 H15"/></svg>',
    name: 'Licencja: Papier',
    description: 'Odblokowuje papierowe odpady na mapie',
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
    icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="#E8EAF6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14 Q4 5 12 5 Q20 5 20 14"/><path d="M3 14 H21"/><circle cx="12" cy="9.5" r="2" fill="#FFD54F" stroke="none"/></svg>',
    name: 'Kask z Latarką',
    description: 'Mniejsza kara prędkości w strefach skażenia bez pełnej ochrony',
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
    icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="#E8EAF6" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"><path d="M8 3 V12.5 Q8 14 9.5 14.5 L17 17 Q19 17.7 19 19 Q19 20 17.5 20 H6 Q5 20 5 19 V3 Z"/><path d="M8 12 H13"/></svg>',
    name: 'Robocze Buty',
    description: 'Więcej czasu, zanim stracisz przedmiot w hazardzie bez pełnej ochrony',
    baseCost: 100,
    costScale: 1.0,
    maxLevel: 1,
    getValue(level) {
      return level;
    }
  },
  {
    id: 'toxic_filter',
    icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="#E8EAF6" stroke-width="2" stroke-linejoin="round"><path d="M4 11 Q4 6 12 6 Q20 6 20 11 Q20 16 12 17.5 Q4 16 4 11 Z"/><circle cx="9" cy="11" r="1.6" fill="#E8EAF6" stroke="none"/><circle cx="15" cy="11" r="1.6" fill="#E8EAF6" stroke="none"/></svg>',
    name: 'Filtr Toksyn',
    description: 'Bez spowolnienia ani utraty przedmiotów w Strefie Skażenia (szkło)',
    baseCost: 250,
    costScale: 1.0,
    maxLevel: 1,
    getValue(level) {
      return level;
    }
  },
  {
    id: 'radiation_suit',
    icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="26" height="26"><circle cx="12" cy="12" r="10" fill="#FFC107"/><path d="M12 12 L12 4 A8 8 0 0 1 18.93 8 Z" fill="#212121"/><path d="M12 12 L12 4 A8 8 0 0 1 18.93 8 Z" fill="#212121" transform="rotate(120 12 12)"/><path d="M12 12 L12 4 A8 8 0 0 1 18.93 8 Z" fill="#212121" transform="rotate(240 12 12)"/><circle cx="12" cy="12" r="2" fill="#212121"/></svg>',
    name: 'Kombinezon Radiacyjny',
    description: 'Bez spowolnienia ani utraty przedmiotów w Strefie Atomowej (metal)',
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
    icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="#E8EAF6" stroke-width="1.6" stroke-linejoin="round"><circle cx="12" cy="12" r="9.5"/><path d="M8 5 L8 17 L16 19 L16 7 Z"/><path d="M8 5 L16 7" stroke-dasharray="1.5 1.5"/><circle cx="12" cy="12" r="1.4" fill="#FFD54F" stroke="none"/></svg>',
    name: 'Minimapa',
    description: 'Mały radar w rogu ekranu - pokazuje pobliskie maszyny, statek, terminal i surowce',
    baseCost: 350,
    costScale: 1.0,
    maxLevel: 1,
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
    icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="#FFD54F" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M9.5 10.5 Q9.5 9 12 9 Q14.5 9 14.5 10.7 Q14.5 12 12 12.5 Q9.5 13 9.5 14.8 Q9.5 17 12 17 Q14.5 17 14.5 15.5"/><path d="M12 8 V9 M12 17 V18"/><path d="M12 1.5 L14.2 5 H9.8 Z" fill="#FFD54F" stroke="none"/></svg>',
    name: 'Wzmacniacz Zarobku',
    description: '+10% do każdej wypłaty, na zawsze - NIE zeruje się na nowej planecie',
    baseCost: 3,
    costScale: 1.7,
    maxLevel: 10,
    getValue(level) {
      return 1 + level * 0.1;
    }
  },
  {
    id: 'core_headstart',
    icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="#81D4FA" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"><path d="M12 3 C16 6 17 11 15 16 L9 16 C7 11 8 6 12 3 Z" fill="#81D4FA" fill-opacity="0.25"/><path d="M9 16 L7 20 M15 16 L17 20 M10.5 16 L10.5 21 M13.5 16 L13.5 21"/><circle cx="12" cy="9.5" r="1.6" fill="#81D4FA" stroke="none"/></svg>',
    name: 'Zapasy Startowe',
    description: '+200 gotówki na start każdej nowej planety',
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
    icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="#66BB6A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5 V12 l3 2"/><path d="M19 5.5 L21 3.5 M5 5.5 L3 3.5"/></svg>',
    name: 'Turbo Maszyn',
    description: 'Wszystkie maszyny przetwarzają o 8% szybciej za poziom',
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
    icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="#EF5350" stroke-width="2" stroke-linecap="round"><path d="M7 4 v7 a5 5 0 0 0 10 0 V4"/><path d="M7 4 h4 M13 4 h4" stroke-width="2.4"/><path d="M7 9 h4 M13 9 h4" stroke="#B0BEC5"/></svg>',
    name: 'Magnes Kwantowy',
    description: '+12 px zasięgu podnoszenia za poziom - działa od razu na nowej planecie',
    baseCost: 2,
    costScale: 1.55,
    maxLevel: 6,
    getValue(level) {
      return level * 12;
    }
  },
  {
    id: 'core_prices',
    icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="#FFD54F" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17 L9 11 L13 15 L21 7"/><path d="M15 7 h6 v6"/></svg>',
    name: 'Kontrakty Handlowe',
    description: '+6% do ceny KAŻDEGO surowca na targu za poziom',
    baseCost: 4,
    costScale: 1.7,
    maxLevel: 8,
    getValue(level) {
      return 1 + level * 0.06;
    }
  },
  {
    id: 'core_backpack',
    icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="#AB47BC" stroke-width="2" stroke-linejoin="round"><rect x="5" y="8" width="14" height="13" rx="3"/><path d="M9 8 V6 a3 3 0 0 1 6 0 v2"/><path d="M9 13 h6" stroke-width="2.2"/><path d="M12 11 v4" stroke-width="2.2"/></svg>',
    name: 'Wymiarowy Plecak',
    description: '+3 miejsca na stosie na start każdej nowej planety',
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
    icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="#FF7043" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.5 C9 6 7 9 7 13 a5 5 0 0 0 10 0 C17 10.5 15.5 9.5 15.5 9.5 C15.7 12 14 13 14 13 C15 8.5 12 2.5 12 2.5 Z" fill="#FF7043" fill-opacity="0.3"/></svg>',
    name: 'Mistrz Combo',
    description: '+1 do maks. poziomu combo za poziom - dłuższe serie sprzedaży, zanim mnożnik przestanie rosnąć',
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
    icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="#26C6DA" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 13 A10 10 0 0 1 13 3" fill="#26C6DA" fill-opacity="0.15"/><path d="M3 13 L10.5 20.5"/><circle cx="3" cy="13" r="1.8" fill="#26C6DA" stroke="none"/><path d="M13 3 V9 M13 3 H19" stroke-dasharray="1.6 1.6"/><circle cx="19" cy="17" r="2.4"/></svg>',
    name: 'Zdalne Zarządzanie',
    description: '+5% skuteczności produkcji offline za poziom',
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
    icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="#EC407A" stroke-width="2" stroke-linejoin="round"><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 9.5 H20"/><path d="M8 3 V6.5 M16 3 V6.5" stroke-linecap="round"/><path d="M12 12 L13 14.2 L15.4 14.5 L13.6 16.2 L14.1 18.6 L12 17.3 L9.9 18.6 L10.4 16.2 L8.6 14.5 L11 14.2 Z" fill="#EC407A" stroke="none"/></svg>',
    name: 'Stały Bywalec',
    description: '+8% do nagrody za passę codziennego logowania za poziom',
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
    icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="#7E57C2" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="10.5" cy="10.5" r="7"/><path d="M15.5 15.5 L21 21"/><path d="M10.5 7 L11.4 9.6 L14 10.5 L11.4 11.4 L10.5 14 L9.6 11.4 L7 10.5 L9.6 9.6 Z" fill="#7E57C2" stroke="none"/></svg>',
    name: 'Głębsza Analiza',
    description: '+10% Rdzeni z każdego odlotu za poziom',
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
    name: 'Przyspieszenie',
    description: 'Skraca czas przetwarzania o 12%',
    icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="#4FC3F7" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 L5 13 h5 l-1 9 8-11 h-5 Z" fill="#4FC3F7" fill-opacity="0.25"/></svg>',
    maxLevel: 4,
    // Mnożnik czasu: 1.0 -> 0.52 przy maksie (prawie 2x szybciej).
    getValue(level) {
      return 1 - level * 0.12;
    }
  },
  {
    id: 'yield',
    name: 'Zwiększona Produkcja',
    description: '+1 sztuka na każdym cyklu przetwarzania',
    icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="#FFB74D" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8 L12 4 l8 4 v8 l-8 4 -8-4 Z" fill="#FFB74D" fill-opacity="0.2"/><path d="M12 4 v16 M4 8 l8 4 8-4"/></svg>',
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
  refinery_b: 340
};
// Nazwy maszyn do UI - własna kopia etykiet z MACHINE_DEFINITIONS (machines.js),
// zgodnie z konwencją projektu (brak współdzielonych utili).
const MACHINE_UPGRADE_LABELS = {
  recycle_a: 'Recykler',
  press_b: 'Prasa',
  furnace_c: 'Piec',
  refinery_b: 'Oczyszczalnia'
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
// 40% aktywnego tempa (nie 100%) - to bonus za sam fakt wracania, nie
// zamiennik grania. Pułap 8h chroni przed absurdalnymi liczbami z
// zostawionej karty na tydzień, ale wciąż zostawia sensowną nagrodę za noc.
const OFFLINE_MIN_SECONDS = 120; // ponizej tego nie pokazujemy modala (np. szybkie odswiezenie)
const OFFLINE_MAX_SECONDS = 8 * 3600;
const OFFLINE_EFFICIENCY = 0.4;
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
  { type: 'collect', material: 'trash', target: 20, reward: 90, label: 'Zbierz 20x Śmieci' },
  { type: 'collect', material: 'plastic', target: 15, reward: 100, label: 'Zbierz 15x Plastiku' },
  { type: 'collect', material: 'paper', target: 15, reward: 100, label: 'Zbierz 15x Papieru' },
  { type: 'collect', material: 'glass', target: 10, reward: 110, label: 'Zbierz 10x Szkła' },
  { type: 'collect', material: 'metal', target: 10, reward: 110, label: 'Zbierz 10x Metalu' },
  { type: 'earn', target: 180, reward: 100, label: 'Zarób 180$' },
  { type: 'earn', target: 400, reward: 200, label: 'Zarób 400$' },
  { type: 'process', target: 15, reward: 90, label: 'Nakarm maszyny 15 razy' },
  { type: 'process', target: 30, reward: 160, label: 'Nakarm maszyny 30 razy' },
  { type: 'sell', target: 20, reward: 110, label: 'Sprzedaj 20 przedmiotów' },
  { type: 'sell', target: 40, reward: 190, label: 'Sprzedaj 40 przedmiotów' }
];

// --- Osiągnięcia (meta-progresja) -------------------------------------------
// Trwałe wyróżnienia za łączne (LIFETIME - nie zerowane prestiżem) dokonania,
// ten sam duch co PROGRESSION_UNLOCKS/streak: dają graczowi długoterminowe
// cele PONAD pojedynczy przebieg ("dobiłem do 3 planet", "przetworzyłem 1000
// surowców"), żeby było po co wracać nawet gdy jedna planeta jest już
// "ograna". Każde jest czysto danymi: `stat` wskazuje licznik w this.stats,
// `target` to próg - system nie ma logiki per-osiągnięcie, tylko sprawdza
// stat >= target (patrz _checkAchievements). Dzięki temu dodanie nowego to
// jedna linijka tutaj, zero nowego kodu. Ikony emoji (nie SVG jak sklep) -
// osiągnięcia to "trofea", cieplejszy, bardziej nagradzający rejestr niż
// funkcjonalne ikony narzędzi w sklepie.
const ACHIEVEMENTS = [
  { id: 'first_pickup', icon: '🌱', name: 'Pierwszy krok', desc: 'Zbierz pierwszy surowiec', stat: 'itemsCollected', target: 1 },
  { id: 'collector_100', icon: '♻️', name: 'Recyklingowicz', desc: 'Zbierz łącznie 100 surowców', stat: 'itemsCollected', target: 100 },
  { id: 'collector_1000', icon: '🌍', name: 'Strażnik planety', desc: 'Zbierz łącznie 1000 surowców', stat: 'itemsCollected', target: 1000 },
  { id: 'feeder_50', icon: '🏭', name: 'Taśmowa produkcja', desc: 'Nakarm maszyny 50 razy', stat: 'machinesFed', target: 50 },
  { id: 'feeder_500', icon: '⚙️', name: 'Król fabryki', desc: 'Nakarm maszyny 500 razy', stat: 'machinesFed', target: 500 },
  { id: 'earn_500', icon: '💵', name: 'Pierwsze zarobki', desc: 'Zarób łącznie 500$', stat: 'lifetimeEarned', target: 500 },
  { id: 'earn_10000', icon: '🤑', name: 'Magnat odpadów', desc: 'Zarób łącznie 10 000$', stat: 'lifetimeEarned', target: 10000 },
  { id: 'shopper_10', icon: '🛒', name: 'Zakupoholik', desc: 'Kup 10 ulepszeń', stat: 'upgradesBought', target: 10 },
  { id: 'first_planet', icon: '🚀', name: 'Odlot', desc: 'Ukończ pierwszą planetę', stat: 'planetsCompleted', target: 1 },
  { id: 'planets_3', icon: '🌌', name: 'Podróżnik', desc: 'Ukończ 3 planety', stat: 'planetsCompleted', target: 3 },
  { id: 'modules_5', icon: '🔧', name: 'Mechanik', desc: 'Ukończ 5 modułów statku', stat: 'shipModulesCompleted', target: 5 },
  { id: 'streak_3', icon: '🔥', name: 'Codzienny gracz', desc: 'Zaloguj się 3 dni z rzędu', stat: 'maxLoginStreak', target: 3 },
  { id: 'challenges_5', icon: '📅', name: 'Wyzwaniowiec', desc: 'Odbierz 5 wyzwań dnia', stat: 'challengesClaimed', target: 5 }
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
// Start: tylko łąka (Strefa A) + Recykler. Reszta otwiera się progami.
// Progi celowo niskie na początku (pierwsze odblokowanie szybko, żeby od
// razu było czuć że "coś się dzieje"), potem rozstawione szerzej.
//
// kind: 'machine' (bramka w machines.js) albo 'zone' (bramka spawnu w items.js).
// zone odblokowuje JEDNOCZEŚNIE spawn surowca I sens wejścia tam (piec).
const PROGRESSION_UNLOCKS = [
  { id: 'press_b', kind: 'machine', threshold: 60, name: 'Prasa', desc: 'Przetwarza plastik w produkty' },
  { id: 'zone_B', kind: 'zone', threshold: 200, name: 'Strefa Bagienna', desc: 'Szkło + dostęp do wraku' },
  { id: 'furnace_c', kind: 'machine', threshold: 350, name: 'Piec Hutniczy', desc: 'Wytapia stop z metalu i szkła' },
  { id: 'zone_C', kind: 'zone', threshold: 550, name: 'Strefa Atomowa', desc: 'Metal - najcenniejszy surowiec' },
  // Oczyszczalnia - odblokowana najpóźniej (po wszystkich strefach), bo daje
  // najdroższy produkt (kryształ, patrz MARKET_BASE_PRICES). Wypełnia lukę w
  // progresji między ostatnią strefą (550$) a pierwszym modułem statku (800$),
  // dając konkretny nowy cel zamiast tylko mielenia w kółko.
  { id: 'refinery_b', kind: 'machine', threshold: 750, name: 'Oczyszczalnia', desc: 'Rafinuje szkło w drogie kryształy' },
  // Strefa D (Kryształowa Grań) - NAJPÓŹNIEJSZE odblokowanie ze wszystkich.
  // W przeciwieństwie do B/C nie wystarczy próg zarobku - _hasGearForZone('D')
  // w player.js dodatkowo wymaga OBU strojów ochronnych naraz (Filtr +
  // Kombinezon), więc to naturalna "nagroda za pełne wyposażenie" pod koniec
  // przebiegu, nie kolejny przystanek po drodze.
  { id: 'zone_D', kind: 'zone', threshold: 950, name: 'Kryształowa Grań', desc: 'Odłamki Kryształu - wymaga PEŁNEJ ochrony (Filtr + Kombinezon)' }
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
  life_support: { perk: 'hazard_grace', label: 'Strefy skażone odbierają przedmioty 2x wolniej' },
  navigation: { perk: 'free_minimap', label: 'Minimapa za darmo' },
  shields: { perk: 'hazard_immunity', label: 'Pełna odporność na strefy skażone' },
  engine: { perk: 'speed_boost', label: '+25% prędkości ruchu na stałe' },
  hyperdrive: { perk: null, label: 'Statek gotowy do odlotu!' }
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
    icon: '🌾',
    name: 'Obfite Złoża',
    desc: 'Surowce pojawiają się o 40% częściej, ale targ płaci o 15% mniej',
    spawnMult: 1.4,
    priceMult: 0.85
  },
  {
    id: 'scarce',
    icon: '🏜️',
    name: 'Jałowa Gleba',
    desc: 'Surowce pojawiają się o 30% rzadziej, za to targ płaci o 25% więcej',
    spawnMult: 0.7,
    priceMult: 1.25
  },
  {
    id: 'efficient_factory',
    icon: '⚙️',
    name: 'Sprawna Fabryka',
    desc: 'Wszystkie maszyny przetwarzają o 20% szybciej',
    machineSpeedMult: 0.8
  },
  {
    id: 'rusty_gear',
    icon: '🔩',
    name: 'Zardzewiały Sprzęt',
    desc: 'Maszyny przetwarzają o 15% wolniej, ale surowce pojawiają się o 25% częściej',
    machineSpeedMult: 1.15,
    spawnMult: 1.25
  },
  {
    id: 'gold_rush',
    icon: '💰',
    name: 'Gorączka Złota',
    desc: 'Targ płaci o 20% więcej za wszystko',
    priceMult: 1.2
  },
  {
    id: 'soft_landing',
    icon: '🛬',
    name: 'Miękkie Lądowanie',
    desc: '+150$ gotówki na start tej planety',
    cashBonus: 150
  }
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
      maxLoginStreak: 0
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
   * JEDYNY powód, dla którego EconomyManager musi być zarejestrowany w
   * game.registerModule() (main.js) - nalicza totalPlaytimeSeconds, używane
   * przez computeOfflineReward() (Faza 5) do wyliczenia tempa zarobku.
   * Wszystko inne w tej klasie jest event-driven/Date.now()-based i update()
   * by nie potrzebowało (patrz komentarz przy comboStacks w konstruktorze).
   */
  update(delta) {
    this.totalPlaytimeSeconds += delta / 1000;
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

    const comboSuffix = this.comboStacks > 0 ? ` 🔥x${this.comboStacks + 1}` : '';
    Bus.publish(Events.FX_POPUP, {
      text: `+$${paidOut}${comboSuffix}`,
      x,
      y,
      duration: 900,
      color: this.comboStacks >= comboMax ? '#FF7043' : '#FFD700'
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
   * i dolicza trwały mnożnik core_income, jeśli gracz go wykupił - mnożnik
   * wchodzi PRZED zapisaniem do totalEarned, żeby kolejne przebiegi z
   * wykupionym Wzmacniaczem szybciej generowały kolejne Rdzenie (celowa
   * spirala postępu, standard w grach z prestiżem).
   */
  _addMoney(amount, x, y) {
    const base = Math.max(0, Math.round(amount));
    if (base <= 0) return 0;

    const value = Math.round(base * this._getCoreIncomeMultiplier());

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
      text: 'Ulepszenie!',
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
   * planety zawsze się opłaca. Współczynniki NIEZBALANSOWANE/nietestowane -
   * do podkręcenia po zagraniu, ta sama zasada co reszta liczb w tej grze.
   *
   * Drugi poziom Rdzeni (core_prestige_boost) mnoży WYNIK pierwiastka, nie
   * totalEarned pod nim - inaczej rósłby wolniej niż liniowo (sam
   * pierwiastek), co przeczyłoby opisowi "+10% Rdzeni za poziom".
   */
  previewPrestigeCores() {
    const boostMult = this.getCoreValue('core_prestige_boost') || 1;
    return Math.max(1, Math.floor((Math.sqrt(this.totalEarned) / 10) * boostMult));
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
      text: 'Trwałe ulepszenie!',
      duration: 1200,
      color: '#81D4FA'
    });

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
  prestige() {
    if (!this.isReadyToPrestige()) return null;

    const coresEarned = this.previewPrestigeCores();
    this.cores += coresEarned;

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
      modifier: this.activeModifier
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

    const gap = this.lastLoginDateStr ? this._daysBetween(this.lastLoginDateStr, today) : 1;
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

  /** Losuje nowe wyzwanie z DAILY_CHALLENGE_TEMPLATES, ostemplowane dzisiejszą datą. */
  _generateDailyChallenge() {
    const template = DAILY_CHALLENGE_TEMPLATES[Math.floor(Math.random() * DAILY_CHALLENGE_TEMPLATES.length)];
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
   *   na czym oprzeć nagrody, więc lepiej nic nie pokazać niż "+0$".
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
      unlockedAchievements: Array.from(this.unlockedAchievements)
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
// Do porównania w ui.js (_onPrestigeDone) - żeby dało się rozpoznać moment
// odblokowania drugiego poziomu ulepszeń bez duplikowania liczby "5" w
// dwóch plikach.
window.CORE_TIER2_UNLOCK_PLANET = CORE_TIER2_UNLOCK_PLANET;