'use strict';

/**
 * machines.js
 * ------------------------------------------------------------------------
 * Maszyny przetwórcze. Gracz wchodzi w zasięg maszyny (dropRadius) i co
 * MACHINE_UNLOAD_INTERVAL_MS automatycznie oddaje pasujący przedmiot ze
 * stosu (z dowolnego miejsca, nie tylko z wierzchu - patrz _resolveInteraction).
 * Po zapełnieniu maxInventory maszyna przez processingDuration ms przetwarza
 * zawartość w outputType, który trafia z powrotem do świata przez
 * ItemManager._spawnSpecificAt().
 *
 * WAŻNE (Faza 1 giełdy): maszyny same NIE dają pieniędzy po skończonej
 * produkcji - to tylko wytwarza fizyczny przedmiot w świecie. Pieniądze
 * pojawiają się dopiero, gdy gracz zaniesie ten przedmiot do TradingPost
 * (market.js) i go tam sprzeda po aktualnej cenie rynkowej.
 *
 * MachineManager NIE zna wnętrza StackController ani ItemManager - korzysta
 * wyłącznie z ich publicznego API (window.stackController / window.itemManager)
 * oraz z Bus/Events. O tym, czy dany outputType ma sens spawnować w świecie
 * (czy ktoś go w ogóle przyjmie), MachineManager pyta zarówno swoje własne
 * maszyny, JAK I window.tradingPost (jeśli istnieje) - patrz _hasAnyConsumer().
 *
 * Zależności globalne (muszą być załadowane przed tym plikiem):
 *   - window.Bus / window.Events (m.in. PLAYER_MOVED, MACHINE_RECEIVED,
 *      MACHINE_OUTPUT, FX_SHAKE, FX_PARTICLES)
 *   - window.stackController (.isEmpty() / .findIndex() / .removeAt())
 *   - window.itemManager (._spawnSpecificAt())
 *   - window.tradingPost (opcjonalnie - .acceptsType, patrz market.js)
 *
 * Użycie w main.js:
 *   window.machineManager = new MachineManager(canvasGameplay);
 *   game.registerModule(window.machineManager);
 */

// Statyczna konfiguracja maszyn - x/y jako ułamek szerokości/wysokości
// canvasu, przeliczane na piksele przy tworzeniu instancji w konstruktorze.
// w/h/maxInventory/dropRadius można nadpisać per maszyna - jeśli ich brak,
// używane są wartości domyślne poniżej.
const MACHINE_DEFINITIONS = [
  {
    // Etykieta/wygląd (Faza kosmicznego reskinu): "Recykler" -> "Reaktor
    // Recyklingowy" - id/acceptsType/outputType/processingDuration/
    // maxInventory NIETKNIĘTE (czysto wizualna zmiana), patrz bespoke
    // _drawRecycleMachine w draw() zamiast dawnego assets/machines/recycle.png.
    id: 'recycle_a',
    get label() { return I18n.t('machine.recycle_a.worldLabel'); },
    xRatio: 0.32,
    yRatio: 0.4,
    color: '#66BB6A',
    acceptsType: ['trash', 'paper'],
    outputType: 'plastic',
    // outputLabel: BYŁO emoji (patrz komentarz przy ITEM_TYPES.label w
    // items.js - ten sam powód, ta sama inertność fallbacku).
    outputLabel: '',
    outputColor: '#42A5F5',
    processingDuration: 2000,
    // BALANS: był na domyślnych MACHINE_MAX_INVENTORY=5 (nikt tego świadomie
    // nie dostroił, w przeciwieństwie do pieca niżej) - przy łańcuchu
    // trash->plastik->produkt (recykler I prasa oba x5) efektywny koszt
    // sięgał 25 śmieci za 1 produkt, a statek potrzebuje ich 28 razem ze
    // wszystkich modułów = ~800 śmieci na cały playthrough. Obniżone do 3,
    // tak jak piec hutniczy (maxInventory:3 niżej) - ten sam próg dla
    // wszystkich trzech maszyn, zamiast dwóch na domyślnej wartości i
    // jednej świadomie obniżonej.
    maxInventory: 3
  },
  {
    // "Prasa" -> "Kompresor Grawitonowy" - ten sam powód co przy recycle_a
    // wyżej, patrz bespoke _drawPressMachine.
    id: 'press_b',
    get label() { return I18n.t('machine.press_b.worldLabel'); },
    xRatio: 0.28,
    yRatio: 0.72,
    color: '#FFA726',
    acceptsType: 'plastic',
    outputType: 'product',
    outputLabel: '',
    outputColor: '#AB47BC',
    processingDuration: 3000,
    // BALANS: ten sam powód co przy recyklerze wyżej - drugi stopień
    // łańcucha, więc jego próg mnoży się z progiem recyklera. 5x5 dawało
    // 25:1, teraz 3x3 daje 9:1.
    maxInventory: 3
  },
  {
    // "Piec hutniczy" -> "Piec Plazmowy" - ten sam powód co przy recycle_a/
    // press_b wyżej, patrz bespoke _drawFurnaceMachine (zastępuje dawny
    // assets/machines/piechutniczy.png + głośny różowy fallback).
    id: 'furnace_c',
    get label() { return I18n.t('machine.furnace_c.worldLabel'); },
    xRatio: 0.59,
    yRatio: 0.35,
    color: '#EF5350',
    acceptsType: ['metal', 'glass'],
    outputType: 'alloy',
    outputLabel: '',
    outputColor: '#D4A574',
    processingDuration: 2500,
    maxInventory: 3
  },
  {
    // Oczyszczalnia (Faza progresji): rafinuje SZKŁO w KRYSZTAŁY - drugie,
    // droższe zastosowanie szkła obok Pieca (metal+szkło->stop). Szkło ma
    // więc teraz realny wybór: tańszy stop szybciej vs droższy kryształ.
    // Brak gotowego PNG w stylu recycle_a/press_b - ma WŁASNĄ bryłę złożoną z
    // prawdziwego sprite'a Kenney (_drawRefineryMachine w draw()).
    // Umieszczona w Strefie Bagiennej (x>0.62, y>0.32 - tam spawnuje szkło),
    // po przeciwnej stronie niż Piec, żeby nie zlewały się wizualnie.
    // Bramkowana progiem zarobku (PROGRESSION_UNLOCKS 'refinery_b' w
    // economy.js) - id MUSI się zgadzać, inaczej _isMachineUnlocked nie
    // zadziała.
    id: 'refinery_b',
    get label() { return I18n.t('machine.refinery_b.worldLabel'); },
    xRatio: 0.8,
    yRatio: 0.62,
    color: '#7E57C2',
    acceptsType: 'glass',
    outputType: 'crystal',
    outputLabel: '',
    outputColor: '#B388FF',
    processingDuration: 3200,
    maxInventory: 3
  },
  {
    // Szlifiernia Kryształów - jedyna maszyna FIZYCZNIE stojąca w Strefie D
    // (Kryształowa Grań, patrz GAME_ZONE_CORE_WIDTH w game.js) - xRatio > 1
    // CELOWO (1.15 * MACHINE_WORLD_WIDTH=1400 = 1610px), bo Grań to teraz
    // niezależny pas ZA starą szerokością świata, nie wycinek rdzenia jak
    // reszta maszyn. Odłamek (surowiec bez żadnego przetwarzania, patrz
    // komentarz przy crystal_shard w market.js) dostaje tu drugie,
    // wolniejsze zastosowanie obok bezpośredniej sprzedaży - ten sam duch co
    // Oczyszczalnia dla szkła. Bryła złożona z prawdziwego sprite'a Kenney,
    // patrz _drawCrystalPolisherMachine.
    id: 'crystal_polisher',
    get label() { return I18n.t('machine.crystal_polisher.worldLabel'); },
    xRatio: 1.15,
    yRatio: 0.28,
    color: '#4DD0C8',
    acceptsType: 'crystal_shard',
    outputType: 'crystal_gem',
    outputLabel: '',
    outputColor: '#E1F5FE',
    // Najdłuższy cykl w grze (rzadszy niż nawet Oczyszczalnia) - wsad to
    // odłamek epickiej rzadkości, więc wynik ma być odpowiednio powolny/cenny.
    processingDuration: 4500,
    // Mniej niż reszta maszyn (3) - odłamki są rzadkie (Strefa D + pełny
    // sprzęt), więc wymaganie zebrania 3 naraz byłoby zbyt dużym progiem
    // wejścia dla pierwszego użycia tej maszyny.
    maxInventory: 2
  }
];

// --- Świat (Faza 2b: mapa większa niż ekran) --------------------------------
// Te same wartości co w game.js/player.js/items.js/market.js. Pozycje maszyn
// (xRatio/yRatio w MACHINE_DEFINITIONS) liczone są względem TYCH stałych,
// nie względem canvas.width/height (widoku) - dlatego maszyny nie muszą już
// przeliczać pozycji przy resize okna, patrz brak _onResize poniżej.
const MACHINE_WORLD_WIDTH = 1400;
const MACHINE_WORLD_HEIGHT = 2000;

// Wartości domyślne dla maszyn, o ile definicja ich nie nadpisze.
const MACHINE_SIZE = 200;
const MACHINE_MAX_INVENTORY = 5;
const MACHINE_DROP_RADIUS = 70;
// Co ile ms (podczas stania w zasięgu) zdejmujemy jeden przedmiot ze stosu.
const MACHINE_UNLOAD_INTERVAL_MS = 150;
const MACHINE_OUTPUT_SHAKE_INTENSITY = 4;
const MACHINE_OUTPUT_SHAKE_DURATION_MS = 200;
// Co ile ms leci kłębek pary z maszyny, dopóki przetwarza (patrz update()).
const MACHINE_STEAM_INTERVAL_MS = 450;
const MACHINE_LIGHTEN_AMOUNT = 20;
// O ile px nad maszyną pojawia się jej produkt wyjściowy.
const MACHINE_OUTPUT_SPAWN_OFFSET_Y = 60;
// Rozstaw px między sztukami, gdy maszyna z ulepszeniem 'yield' wypuszcza
// więcej niż jedną naraz - bez tego leżałyby idealnie jedna na drugiej.
const MACHINE_OUTPUT_SPREAD_X = 34;
// Kapsuła dostawcza auto-załadunku (core_auto_feed) - patrz
// _drawAutoFeedPods niżej. Efemeryczna (żyje AUTO_FEED_POD_DURATION_MS),
// CELOWO nie sprite - Tomek: "z wizualizuj ale żeby dron się nie powtarzał
// z grafikami które wcześniej dodaliśmy" (drone.js ma już swój, stały,
// krążący Dron Recyklingowy).
const AUTO_FEED_POD_DURATION_MS = 420;
const AUTO_FEED_POD_ARC_HEIGHT = 46;
const AUTO_FEED_POD_SIZE = 10;
// Jednostka bazowa dla maszyn rysowanych PROCEDURALNIE (bez pliku PNG) -
// dobrana tak, żeby ich sylwetka zajmowała na ekranie tyle samo co gotowe
// sprite'y. Zmierzone wprost z assets/machines/*.png: nieprzezroczysty
// obszar to ~48-57% szerokości pliku, a rysowane są w spriteSize = m.w*1.2
// (=240), co daje ~112-136 px. Rysowanie procedualnej maszyny na pełne
// m.w/m.h (200) + lej + przenośnik dawało ~340 px, czyli prawie 3x za dużo.
const MACHINE_PROC_UNIT = 130;

class MachineManager {
  constructor(canvas) {
    this.canvas = canvas;
    this.playerX = 0;
    this.playerY = 0;
    this.inRange = null; // maszyna w zasięgu gracza

    this.machines = MACHINE_DEFINITIONS.map((def) => ({
      id: def.id,
      label: def.label,
      x: MACHINE_WORLD_WIDTH * def.xRatio,
      y: MACHINE_WORLD_HEIGHT * def.yRatio,
      w: def.w ?? MACHINE_SIZE,
      h: def.h ?? MACHINE_SIZE,
      color: def.color,
      acceptsType: def.acceptsType,
      outputType: def.outputType,
      outputLabel: def.outputLabel,
      outputColor: def.outputColor,
      inventory: 0,
      maxInventory: def.maxInventory ?? MACHINE_MAX_INVENTORY,
      processing: false,
      processingProgress: 0,
      processingDuration: def.processingDuration,
      dropRadius: def.dropRadius ?? MACHINE_DROP_RADIUS,
      // Odmierza subtelne "kłębki pary" podczas przetwarzania (patrz update())
      // - bez tego wielosekundowy pasek postępu był jedynym sygnałem, że coś
      // się dzieje, a reszta maszyny stała wizualnie martwa aż do końca.
      steamTimer: 0,
      // Timer auto-załadunku (core_auto_feed) - WŁASNY per maszyna, w
      // przeciwieństwie do this._unloadTimer wyżej (jeden, dzielony,
      // wyłącznie dla maszyny w zasięgu gracza) - auto-feed działa
      // niezależnie na WSZYSTKICH maszynach naraz, więc każda liczy sama.
      autoUnloadTimer: 0
    }));

    this._onPlayerMoved = (d) => {
      this.playerX = d.x;
      this.playerY = d.y;
    };
    // Uwaga: brak nasłuchiwania Events.RESIZE celowo - pozycje maszyn są
    // teraz stałe względem świata (MACHINE_WORLD_WIDTH/HEIGHT), a nie
    // widoku, więc resize okna nie wymaga już ich przeliczania.
    Bus.subscribe(Events.PLAYER_MOVED, this._onPlayerMoved);

    // Timer auto-unloadu (odmierza MACHINE_UNLOAD_INTERVAL_MS między
    // kolejnymi zdjęciami przedmiotu ze stosu).
    this._unloadTimer = 0;
    // Maszyny w zasięgu gracza w BIEŻĄCEJ klatce (nie tylko ta aktywna) -
    // draw() używa tego, żeby każda pobliska maszyna mogła niezależnie
    // pokazać, czego potrzebuje.
    this.nearby = [];

    // Kapsuły dostawcze auto-załadunku - efemeryczne, patrz stała
    // AUTO_FEED_POD_DURATION_MS i _drawAutoFeedPods niżej.
    this._autoFeedPods = [];

    // Piec hutniczy szedł wcześniej OSOBNYM, ręcznym torem ładowania (this.
    // furnaceImg, jedna sztywna ścieżka) - usunięte na rzecz wspólnego
    // SpriteLoadera (sprites.js), który od teraz próbuje KILKU kandydatur
    // ścieżki, nie jednej (patrz SPRITE_PATH_CANDIDATES.machine_furnace).
    // Draw() niżej nadal ma dla furnace_c osobny, GŁOŚNY fallback (różowy
    // kwadrat) zamiast standardowego cichego przejścia na gradient - żeby
    // brak akurat TEGO pliku było od razu widać, nie zlewało się z resztą.
  }

  _getDistTo(m) {
    const dx = this.playerX - m.x;
    const dy = this.playerY - m.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  _getMachinesInRange() {
    return this.machines
      .filter((m) => this._isMachineUnlocked(m) && this._getDistTo(m) < m.dropRadius)
      .sort((a, b) => this._getDistTo(a) - this._getDistTo(b));
  }

  /** Zablokowana maszyna (jeszcze nieodblokowana progiem zarobku w
   * economy.js) jest wykluczona z interakcji - nie przyjmuje surowca, nie
   * wchodzi w zasięg - ale NADAL się rysuje (jako zamknięta, patrz draw),
   * żeby gracz WIDZIAŁ że coś tam będzie, i miał po co zarabiać. */
  _isMachineUnlocked(m) {
    const eco = window.economyManager;
    if (!eco || typeof eco.isUnlocked !== 'function') return true;
    return eco.isUnlocked(m.id);
  }

  _findMachineForType(typeId) {
    return this.machines.find((m) => this._machineAccepts(m, typeId)) || null;
  }

  /**
   * Czy KTOKOLWIEK (jakaś maszyna albo TradingPost z market.js) przyjmie
   * dany typ - decyduje, czy w ogóle warto spawnować go jako przedmiot
   * w świecie. Bez tego sprawdzenia przedmiot bez żadnego odbiorcy zapychałby
   * plecak na stałe (nikt by go nigdy nie zdjął).
   */
  _hasAnyConsumer(typeId) {
    if (this._findMachineForType(typeId)) return true;
    if (window.tradingPost && Array.isArray(window.tradingPost.acceptsType)) {
      return window.tradingPost.acceptsType.includes(typeId);
    }
    return false;
  }

  /** Sprawdza czy dana maszyna przyjmuje typeId - acceptsType może być
   * stringiem, 'any', albo tablicą kilku dopuszczalnych typów (np. piec
   * hutniczy przyjmuje ['metal', 'glass']). */
  _machineAccepts(machine, typeId) {
    if (!machine) return false;
    if (machine.acceptsType === 'any') return true;
    if (Array.isArray(machine.acceptsType)) return machine.acceptsType.includes(typeId);
    return machine.acceptsType === typeId;
  }

  /**
   * Szuka najbliższej pobliskiej maszyny, dla której GDZIEKOLWIEK w stosie
   * (nie tylko na wierzchu) znajdzie się pasujący przedmiot. Zwraca też
   * indeks tego przedmiotu, żeby update() nie musiał szukać drugi raz.
   * Kolejność podnoszenia przestaje mieć znaczenie - jeśli gracz ma gdzieś
   * w plecaku coś, co ta maszyna przyjmuje, maszyna to znajdzie.
   */
  _resolveInteraction(nearby) {
    const stack = window.stackController;
    if (!stack || stack.isEmpty()) {
      return { active: null, matchIndex: -1 };
    }
    for (const m of nearby) {
      const idx = stack.findIndex((item) => this._machineAccepts(m, item.typeId));
      if (idx !== -1) return { active: m, matchIndex: idx };
    }
    return { active: null, matchIndex: -1 };
  }

  _canAcceptItem(machine, item) {
    if (!machine || !item) return false;
    return this._machineAccepts(machine, item.typeId);
  }

  _canFeedMachine(machine) {
    return machine && !machine.processing && machine.inventory < machine.maxInventory;
  }

  update(delta) {
    const nearby = this._getMachinesInRange();
    this.nearby = nearby;

    const interaction = this._resolveInteraction(nearby);
    this.inRange = interaction.active;

    if (this.inRange) {
      const m = this.inRange;
      if (this._canFeedMachine(m)) {
        this._unloadTimer += delta;
        if (this._unloadTimer >= MACHINE_UNLOAD_INTERVAL_MS) {
          this._unloadTimer = 0;
          window.stackController.removeAt(interaction.matchIndex);
          m.inventory++;
          Bus.publish(Events.MACHINE_RECEIVED, { machineId: m.id });
          Bus.publish(Events.FX_PARTICLES, { x: m.x, y: m.y, color: m.color, count: 4 });

          if (m.inventory >= m.maxInventory && !m.processing) {
            m.processing = true;
            m.processingProgress = 0;
            m.steamTimer = 0;
          }
        }
      } else {
        this._unloadTimer = 0;
      }
    } else {
      this._unloadTimer = 0;
    }

    // Auto-załadunek (core_auto_feed, Rdzenie) - Tomek: gra ma automatyzować
    // pętlę, nie tylko przyspieszać ręczną grę. Działa na WSZYSTKICH
    // odblokowanych maszynach RÓWNOLEGLE (nie tylko this.inRange), ale
    // pomija tę, którą gracz akurat ręcznie karmi w tej klatce - stanie przy
    // maszynie ma zostać wyraźnie najszybszą opcją, automat dostaje
    // "resztę". Tempo: MACHINE_UNLOAD_INTERVAL_MS / skuteczność, czyli
    // WOLNIEJ niż ręczne karmienie przy skuteczności <1 (zawsze, patrz
    // getValue w PRESTIGE_UPGRADES - sufit to 0.72, nigdy 1+).
    const autoFeedEff = this._getAutoFeedEfficiency();
    if (autoFeedEff > 0) {
      const stack = window.stackController;
      if (stack && !stack.isEmpty()) {
        this.machines.forEach((m) => {
          if (this.inRange && m.id === this.inRange.id) return;
          if (!this._isMachineUnlocked(m) || !this._canFeedMachine(m)) {
            m.autoUnloadTimer = 0;
            return;
          }
          const idx = stack.findIndex((item) => this._machineAccepts(m, item.typeId));
          if (idx === -1) {
            m.autoUnloadTimer = 0;
            return;
          }

          m.autoUnloadTimer += delta;
          const interval = MACHINE_UNLOAD_INTERVAL_MS / autoFeedEff;
          if (m.autoUnloadTimer < interval) return;
          m.autoUnloadTimer = 0;

          window.stackController.removeAt(idx);
          m.inventory++;
          Bus.publish(Events.MACHINE_RECEIVED, { machineId: m.id });
          // Mniej cząsteczek niż ręczne karmienie (4) - subtelniejszy,
          // "ambientowy" sygnał w tle, nie ma przyciągać uwagi tak jak akcja
          // gracza.
          Bus.publish(Events.FX_PARTICLES, { x: m.x, y: m.y, color: m.color, count: 2 });
          // Kapsuła dostawcza gracz -> maszyna (patrz _drawAutoFeedPods) -
          // startuje z OSTATNIEJ znanej pozycji gracza (this.playerX/Y,
          // aktualizowane przez PLAYER_MOVED), nie z pozycji maszyny.
          this._autoFeedPods.push({ x0: this.playerX, y0: this.playerY, x1: m.x, y1: m.y, t: 0, color: m.color });

          if (m.inventory >= m.maxInventory && !m.processing) {
            m.processing = true;
            m.processingProgress = 0;
            m.steamTimer = 0;
          }
        });
      }
    }

    // Odmierzanie/sprzątanie kapsuł dostawczych - czysto wizualne, więc
    // osobny, prosty krok zamiast wplatania w pętlę auto-załadunku wyżej
    // (kapsuła leci NIEZALEŻNIE od tego, czy maszyna w międzyczasie coś
    // jeszcze zrobi).
    if (this._autoFeedPods.length > 0) {
      this._autoFeedPods.forEach((p) => { p.t += delta; });
      this._autoFeedPods = this._autoFeedPods.filter((p) => p.t < AUTO_FEED_POD_DURATION_MS);
    }

    // Przetwarzanie maszyn.
    this.machines.forEach((m) => {
      if (!m.processing) return;

      // Kłębki "pary" co MACHINE_STEAM_INTERVAL_MS, dopóki maszyna pracuje -
      // ciągły sygnał "coś się dzieje" przez cały wielosekundowy cykl, nie
      // tylko pasek postępu + wybuch na samym końcu. Osobny timer od
      // processingProgress, żeby częstotliwość nie zależała od długości
      // cyklu konkretnej maszyny.
      m.steamTimer += delta;
      if (m.steamTimer >= MACHINE_STEAM_INTERVAL_MS) {
        m.steamTimer = 0;
        Bus.publish(Events.FX_PARTICLES, {
          x: m.x + (Math.random() - 0.5) * m.w * 0.3,
          y: m.y - m.h * 0.35,
          color: '#CFD8DC',
          count: 2
        });
      }

      m.processingProgress += delta;
      // Trwałe ulepszenie "Turbo Maszyn" (Rdzenie, core_machine_speed) skraca
      // cykl KAŻDEJ maszyny. Czytane na bieżąco zamiast wpisywane raz w
      // m.processingDuration - dzięki temu zakup działa natychmiast, a prestiż
      // (który czyści ulepszenia sklepowe, ale NIE Rdzenie) nie wymaga żadnego
      // dodatkowego kodu, żeby efekt przetrwał. Ten sam wzorzec co
      // _getShipSpeedMult w player.js - patrz komentarz tam.
      if (m.processingProgress < m.processingDuration * this._getSpeedMultiplier(m.id)) return;

      m.processing = false;
      m.inventory = 0;
      m.processingProgress = 0;

      // machineX/machineY w payloadzie - przydatne np. dla gamefeel/UI, które
      // mogą chcieć zareagować na konkretnej pozycji. UWAGA: ten event NIE
      // nalicza już pieniędzy (Faza 1 giełdy) - economy.js go nie słucha.
      Bus.publish(Events.MACHINE_OUTPUT, {
        machineId: m.id,
        itemType: m.outputType,
        machineX: m.x,
        machineY: m.y
      });
      Bus.publish(Events.FX_SHAKE, {
        intensity: MACHINE_OUTPUT_SHAKE_INTENSITY,
        duration: MACHINE_OUTPUT_SHAKE_DURATION_MS
      });

      // Auto-eksport (core_auto_sell, Rdzenie) - TYLKO dla gotowego produktu
      // BEZ dalszego odbiorcy-maszyny (_findMachineForType null), czyli
      // ostatniego ogniwa łańcucha, które i tak trafiłoby prosto do
      // TradingPost. Półprodukty (np. plastik->prasa) NIGDY się tak nie
      // sprzedają - musiałyby zniknąć z łańcucha, zamiast popłynąć dalej.
      // Sprzedaje WPROST przez economyManager.autoSellItem() (cena razy
      // skuteczność, patrz PRESTIGE_UPGRADES) - żadnego fizycznego itemu w
      // świecie, więc żadnego noszenia do Terminalu.
      const autoSellEff = this._getAutoSellEfficiency();
      const sellsAtTerminal = window.tradingPost
        && Array.isArray(window.tradingPost.acceptsType)
        && window.tradingPost.acceptsType.includes(m.outputType);
      const hasMachineConsumer = !!this._findMachineForType(m.outputType);

      if (autoSellEff > 0 && sellsAtTerminal && !hasMachineConsumer && window.marketManager && window.economyManager) {
        const count = this._getYield(m.id);
        const basePrice = window.marketManager.getPrice(m.outputType);
        for (let i = 0; i < count; i++) {
          window.economyManager.autoSellItem(
            m.outputType,
            Math.round(basePrice * autoSellEff),
            m.x,
            m.y - MACHINE_OUTPUT_SPAWN_OFFSET_Y
          );
        }
        Bus.publish(Events.FX_PARTICLES, { x: m.x, y: m.y - MACHINE_OUTPUT_SPAWN_OFFSET_Y, color: '#4DB6AC', count: 4 });
      } else if (window.itemManager && this._hasAnyConsumer(m.outputType)) {
        // Przedmiot w świecie spawnujemy TYLKO, jeśli ktokolwiek go faktycznie
        // przyjmuje - inna maszyna (np. plastik -> prasa) ALBO TradingPost
        // (np. gotowy produkt -> sprzedaż). Jeśli nikt go nie przyjmuje,
        // dorzucanie go do świata tylko zapychałoby plecak przedmiotem bez
        // żadnego dalszego zastosowania.
        //
        // Ulepszenie 'yield' (MACHINE_UPGRADE_KINDS w economy.js) - z jednego
        // cyklu wypada więcej niż jedna sztuka. Rozrzucamy je lekko na boki,
        // żeby nie wylądowały dokładnie jedna na drugiej i dało się je
        // rozróżnić/pozbierać.
        const count = this._getYield(m.id);
        for (let i = 0; i < count; i++) {
          const spreadX = count > 1 ? (i - (count - 1) / 2) * MACHINE_OUTPUT_SPREAD_X : 0;
          window.itemManager._spawnSpecificAt(
            m.outputType,
            m.x + spreadX,
            m.y - MACHINE_OUTPUT_SPAWN_OFFSET_Y,
            m.outputLabel,
            m.outputColor
          );
        }
      }
    });
  }

  /**
   * Viewport culling (ten sam wzorzec co items.js/ambient.js/critters.js) -
   * maszyna poza kadrem (+margines) pomija CAŁY swój draw (obrys zasięgu,
   * cień, sprite, pasek postępu) - tylko kilka maszyn w grze, ale każda ma
   * niebagatelny koszt rysowania, a gracz i tak zwykle widzi naraz 1-2 z nich.
   * Margines pokrywa dropRadius (do 90px) + zapas na płynne wjeżdżanie w
   * kadr. update() (przetwarzanie/timery) działa zawsze, niezależnie od
   * widoczności - maszyna ma produkować, nawet gdy gracz na nią nie patrzy.
   */
  draw(ctxBg, ctx, ctxUI) {
    const camX = window.game ? window.game.cameraX : 0;
    const camY = window.game ? window.game.cameraY : 0;
    const viewW = window.innerWidth;
    const viewH = window.innerHeight;
    const margin = 150;

    this.machines.forEach((m) => {
      if (m.x < camX - margin || m.x > camX + viewW + margin) return;
      if (m.y < camY - margin || m.y > camY + viewH + margin) return;

      // Zablokowana maszyna - przygaszona sylwetka z kłódką, zamiast pełnej
      // działającej maszyny. Widoczna (gracz wie że coś tu będzie i po co
      // zarabiać), ale wyraźnie "jeszcze nie". Rysujemy i KOŃCZYMY dla tej
      // maszyny - żadnego zasięgu/progressu/statusu jak przy aktywnych.
      if (!this._isMachineUnlocked(m)) {
        this._drawLockedMachine(ctx, m);
        return;
      }

      const isActive = this.inRange && this.inRange.id === m.id;
      const isNearby = this.nearby.some((n) => n.id === m.id);
      const hw = m.w / 2;
      const hh = m.h / 2;

      // Strefa zrzutu (okrąg przerywany).
      ctx.strokeStyle = isActive ? 'rgba(255, 255, 255, 0.6)' : isNearby ? 'rgba(255, 213, 79, 0.35)' : 'rgba(255, 255, 255, 0.2)';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.arc(m.x, m.y, m.dropRadius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);

      // Cień - prosty, ciasny, tuż pod nominalnym pudełkiem maszyny (m.w/m.h).
      // Celowo konserwatywny (raczej bliżej niż dalej) - zbyt daleki/duży
      // cień rzuca się w oczy dużo bardziej niż odrobinę za ciasny.
      ctx.fillStyle = 'rgba(0, 0, 0, 0.22)';
      ctx.beginPath();
      ctx.ellipse(m.x, m.y + hh + 8, hw * 0.55, hh * 0.15, 0, 0, Math.PI * 2);
      ctx.fill();

      // Sprite maszyny (Kenney CC0) + fallback.
      const spriteSize = m.w * 1.2;
      const spriteKey = window.spriteLoader && window.spriteLoader.spriteKeyForMachine(m.id);
      // Uwaga: bez ctx.shadow* tutaj - druga, natywna warstwa cienia canvasu
      // nakładała się na powyższą ręczną elipsę i dawała rozmyty, zdublowany,
      // za duży efekt. Jedna, kontrolowana elipsa wystarczy.
      ctx.save();

      // --- LOGIKA RYSOWANIA GRAFIKI DLA REAKTORA RECYKLINGOWEGO ---
      // Faza kosmicznego reskinu: dawniej assets/machines/recycle.png (sprite
      // przez generyczną ścieżkę niżej) - teraz bespoke proceduralna bryła w
      // tym samym stylu co Oczyszczalnia/Szlifiernia, żeby WSZYSTKIE maszyny
      // wyglądały spójnie "kosmicznie", nie tylko te dwie bez własnego PNG-a.
      if (m.id === 'recycle_a') {
        this._drawRecycleMachine(ctx, m, isActive);
      }
      // --- LOGIKA RYSOWANIA GRAFIKI DLA KOMPRESORA GRAWITONOWEGO ---
      else if (m.id === 'press_b') {
        this._drawPressMachine(ctx, m, isActive);
      }
      // --- LOGIKA RYSOWANIA GRAFIKI DLA PIECA PLAZMOWEGO ---
      // Zastępuje dawny assets/machines/piechutniczy.png ORAZ jego głośny
      // różowy fallback ("Brak pliku PNG!") - ten drugi stał się martwym
      // kodem, bo ta maszyna nie próbuje już w ogóle sprite'a.
      else if (m.id === 'furnace_c') {
        this._drawFurnaceMachine(ctx, m, isActive);
      }
      // --- LOGIKA RYSOWANIA GRAFIKI DLA OCZYSZCZALNI ---
      // Bryła złożona z prawdziwego sprite'a Kenney + świecącego rdzenia,
      // ten sam duch co reszta maszyn reskinu - patrz _drawRefineryMachine.
      else if (m.id === 'refinery_b') {
        this._drawRefineryMachine(ctx, m, isActive);
      }
      // --- LOGIKA RYSOWANIA GRAFIKI DLA SZLIFIERNI KRYSZTAŁÓW ---
      // Ten sam powód co Oczyszczalnia wyżej - brak pliku PNG, więc bespoke
      // proceduralna bryła zamiast generycznego fallbacku (który obok 3
      // prawdziwych sprite'ów i Oczyszczalni wyglądałby jak niedokończony
      // placeholder - patrz komentarz przy _drawRefineryMachine).
      else if (m.id === 'crystal_polisher') {
        this._drawCrystalPolisherMachine(ctx, m, isActive);
      }
      // --- LOGIKA DLA POZOSTAŁYCH MASZYN ---
      else if (!(spriteKey && window.spriteLoader.draw(ctx, spriteKey, m.x, m.y, spriteSize))) {
        const baseColor = isActive ? this._lighten(m.color, MACHINE_LIGHTEN_AMOUNT) : m.color;

        // Pionowy gradient zamiast plaskiego wypelnienia - gora jasniejsza
        // (gorne oswietlenie), dol ciemniejszy - daje wrazenie bryly zamiast
        // naklejki na plaskim kolorze.
        const grad = ctx.createLinearGradient(m.x, m.y - hh, m.x, m.y + hh);
        grad.addColorStop(0, this._lighten(baseColor, 20));
        grad.addColorStop(0.55, baseColor);
        grad.addColorStop(1, this._lighten(baseColor, -25));

        ctx.fillStyle = grad;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
        ctx.lineWidth = 2;
        this._traceRoundedRect(ctx, m.x - hw, m.y - hh, m.w, m.h, 10);
        ctx.fill();
        ctx.stroke();

        // Cienkie "zeberka" wentylacyjne pod plakietka wyjscia - drobny
        // przemyslowy detal, odrozniajacy korpus maszyny od zwyklego
        // kolorowego prostokata.
        ctx.fillStyle = 'rgba(0, 0, 0, 0.15)';
        for (let i = -2; i <= 2; i++) {
          ctx.fillRect(m.x + i * (hw * 0.22) - 2, m.y + hh * 0.32, 3, hh * 0.32);
        }

        // Plakietka wyjscia - BYLO ctx.fillText(m.outputLabel) z emoji per
        // maszyne (♻️/🎁/🧱/🔮/✨) - w praktyce nieosiagalne dla recycle_a/
        // press_b (maja prawdziwe sprite'y w assets/machines/), wiec to
        // czysto awaryjna sciezka. Neutralny, kolorowy kwadracik (kolor
        // wyjscia maszyny) zamiast tekstu/emoji.
        const badgeR = hh * 0.16;
        ctx.fillStyle = m.outputColor;
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)';
        ctx.lineWidth = 1.5;
        this._traceRoundedRect(ctx, m.x - badgeR, m.y - hh * 0.12 - badgeR, badgeR * 2, badgeR * 2, badgeR * 0.4);
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();

      // Pasek postępu przetwarzania.
      if (m.processing) {
        // Ten sam mnożnik co w update() - inaczej pasek dobiegałby do końca
        // wcześniej (albo później) niż maszyna faktycznie kończy pracę.
        const prog = m.processingProgress / (m.processingDuration * this._getSpeedMultiplier(m.id));
        ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
        ctx.fillRect(m.x - hw + 6, m.y + hh - 14, m.w - 12, 8);
        ctx.fillStyle = '#FFD700';
        ctx.fillRect(m.x - hw + 6, m.y + hh - 14, (m.w - 12) * prog, 8);
      }

      // Kropki zapełnienia.
      for (let i = 0; i < m.maxInventory; i++) {
        ctx.fillStyle = i < m.inventory ? '#FFD700' : 'rgba(0, 0, 0, 0.2)';
        ctx.beginPath();
        ctx.arc(m.x - (m.maxInventory / 2 - 0.5 - i) * 12, m.y + hh - 24, 4, 0, Math.PI * 2);
        ctx.fill();
      }

      // Etykieta. BUGFIX: dawniej stały ciemny fillStyle (rgba(0,0,0,0.7))
      // - czytelny na jasnej trawie, ale ginący na ciemnym popiele/bagnie
      // (patrz _drawOutlinedText). Dotyczy zwłaszcza Pieca Hutniczego, który
      // stoi tuż przy zbiegu wszystkich trzech biomów.
      ctx.font = 'bold 11px Arial';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      this._drawOutlinedText(ctx, m.label, m.x, m.y - hh - 6, '#FFFFFF');

      // Status nad maszyną - liczony NIEZALEŻNIE dla każdej, więc kilka
      // pobliskich maszyn może jednocześnie pokazywać, czego potrzebują
      // (a nie tylko jedna "wybrana" jak w poprzednim systemie przekierowań).
      let statusText = '';
      let statusColor = '#A5D6A7';
      let statusBold = false;
      let showMaterials = false;
      if (isActive) {
        statusBold = true;
        if (m.processing) {
          statusText = I18n.t('machine.status.processing');
          statusColor = '#FF8A80';
        } else if (m.inventory >= m.maxInventory) {
          statusText = I18n.t('machine.status.full');
          statusColor = '#FF8A80';
        } else {
          statusText = I18n.t('machine.status.accepting');
          statusColor = '#A5D6A7';
          showMaterials = true;
        }
      } else if (isNearby) {
        statusText = I18n.t('machine.status.wants');
        statusColor = 'rgba(255, 255, 255, 0.55)';
        showMaterials = true;
      }

      if (statusText) {
        ctx.font = statusBold ? 'bold 10px Arial' : '10px Arial';
        if (showMaterials) {
          // BUGFIX: był `${statusText}: ${m.acceptsHint}` - m.acceptsHint to
          // string z emoji WTOPIONYMI w tekst (np. '🗑️ śmieci lub 📄
          // papier'). Teraz prefiks rysuje się jako tekst, a materiały jako
          // OSOBNE, prawdziwe grafiki obok - ten sam zabieg co pasek
          // postępu statku (ship.js) i wiersze cen terminala (market.js).
          this._drawAcceptsHint(ctx, statusText, m, statusColor, m.y - hh - 20);
        } else {
          this._drawOutlinedText(ctx, statusText, m.x, m.y - hh - 20, statusColor);
        }
      }
    });

    // Kapsuły dostawcze auto-załadunku - NA KOŃCU, po wszystkich maszynach,
    // żeby zawsze leciały NAD nimi, niezależnie które akurat rysowały się
    // ostatnie w pętli wyżej.
    this._drawAutoFeedPods(ctx, camX, camY, viewW, viewH, margin);
  }

  /**
   * Kapsuły dostawcze auto-załadunku (core_auto_feed) - Tomek: "zwizualizuj
   * ale żeby dron się nie powtarzał z grafikami które wcześniej dodaliśmy".
   * Pierwsza wersja była procedural rombem - Tomek obejrzał 10 kandydatów z
   * Kenney "Space Shooter Extension" (TA SAMA paczka co Terminal/maszyny/
   * dekoracje straganu) i wybrał małą rakietkę (Missiles/spaceMissiles_040,
   * patrz sprites.js: autofeed_pod) - CELOWO nie z rodziny Drona
   * Recyklingowego (drone.js, "Space Shooter Redux", stały krążący sprite
   * zbierający surowce ŚWIAT -> plecak) - ta kapsuła leci przeciwnym
   * kierunkiem (gracz -> maszyna) i żyje tylko AUTO_FEED_POD_DURATION_MS,
   * nie jest stałym towarzyszem.
   */
  _drawAutoFeedPods(ctx, camX, camY, viewW, viewH, margin) {
    if (this._autoFeedPods.length === 0) return;
    const img = window.spriteLoader && window.spriteLoader.get('autofeed_pod');
    const spriteReady = img && img.complete && img.naturalWidth;

    this._autoFeedPods.forEach((p) => {
      if (p.x1 < camX - margin || p.x1 > camX + viewW + margin) return;
      if (p.y1 < camY - margin || p.y1 > camY + viewH + margin) return;

      const t = Math.min(1, p.t / AUTO_FEED_POD_DURATION_MS);
      // Łuk (paraboliczny lob) zamiast prostej linii - czyta się jako
      // "rzut/transfer", nie ślizganie się po ziemi.
      const x = p.x0 + (p.x1 - p.x0) * t;
      const yLinear = p.y0 + (p.y1 - p.y0) * t;
      const arc = Math.sin(t * Math.PI) * AUTO_FEED_POD_ARC_HEIGHT;
      const y = yLinear - arc;

      const alpha = Math.min(1, t * 6, (1 - t) * 6);
      if (alpha <= 0) return;

      // Kierunek lotu = pochodna toru (linia + łuk), nie stały kąt do celu -
      // na szczycie paraboli rakietka leci niemal poziomo, nie pod tym samym
      // kątem co przy starcie/lądowaniu. +PI/2, bo sprite ma nos "w górę".
      const dx = p.x1 - p.x0;
      const dy = (p.y1 - p.y0) - Math.PI * Math.cos(t * Math.PI) * AUTO_FEED_POD_ARC_HEIGHT;
      const angle = Math.atan2(dy, dx) + Math.PI / 2;

      ctx.save();

      // Krótki, przygasający ślad ZA rakietką (w stronę p0), w kolorze
      // DOCELOWEJ maszyny - jedyne miejsce, gdzie ten kolor teraz żyje
      // (sprite ma własne, stałe barwy), więc dalej widać "do której
      // maszyny", tylko jako smuga zamiast wypełnienia kształtu.
      for (let i = 1; i <= 3; i++) {
        const tt = Math.max(0, t - i * 0.045);
        const gx = p.x0 + (p.x1 - p.x0) * tt;
        const gy = p.y0 + (p.y1 - p.y0) * tt - Math.sin(tt * Math.PI) * AUTO_FEED_POD_ARC_HEIGHT;
        const r = AUTO_FEED_POD_SIZE * (0.42 - i * 0.08);
        ctx.globalAlpha = alpha * (0.4 - i * 0.09);
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(gx, gy, r, 0, Math.PI * 2);
        ctx.fill();
      }

      // Poświata NEUTRALNA (biała) - ten sam powód co przy poprzedniej
      // wersji: kolorowa łuna dla zielonego Reaktora Recyklingowego
      // (#66BB6A) ginęła na trawie. Biała czyta się na KAŻDYM biomie.
      ctx.globalAlpha = alpha * 0.75;
      const grad = ctx.createRadialGradient(x, y, 0, x, y, AUTO_FEED_POD_SIZE * 2.4);
      grad.addColorStop(0, 'rgba(255, 255, 255, 0.85)');
      grad.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(x, y, AUTO_FEED_POD_SIZE * 2.4, 0, Math.PI * 2);
      ctx.fill();

      ctx.globalAlpha = alpha;
      if (spriteReady) {
        const h = AUTO_FEED_POD_SIZE * 2.4;
        const w = h * (img.naturalWidth / img.naturalHeight);
        ctx.translate(x, y);
        ctx.rotate(angle);
        ctx.drawImage(img, -w / 2, -h / 2, w, h);
      } else {
        // Sprite jeszcze niewczytany (rzadki stan tuż po starcie gry) -
        // prosty jasny romb zamiast pustego miejsca, ten sam fallback-duch
        // co reszta gry (np. _drawAntenna w market.js).
        ctx.fillStyle = '#FFFFFF';
        ctx.beginPath();
        ctx.moveTo(x, y - AUTO_FEED_POD_SIZE);
        ctx.lineTo(x + AUTO_FEED_POD_SIZE * 0.7, y);
        ctx.lineTo(x, y + AUTO_FEED_POD_SIZE);
        ctx.lineTo(x - AUTO_FEED_POD_SIZE * 0.7, y);
        ctx.closePath();
        ctx.fill();
      }

      ctx.restore();
    });
  }

  /**
   * Rysuje prefiks ("Przyjmuje:"/"Chce:") + prawdziwe grafiki akceptowanych
   * materiałów OBOK tekstu, wyśrodkowane razem nad maszyną. acceptsType
   * bywa tablicą (kilka materiałów, słowo "lub" między ikonami) albo
   * pojedynczym stringiem - normalizujemy do tablicy na starcie. Wymaga
   * ctx.font już ustawionego przez wywołującego (do pomiaru szerokości
   * prefiksu i rysowania "lub").
   */
  _drawAcceptsHint(ctx, prefix, m, color, y) {
    const types = Array.isArray(m.acceptsType) ? m.acceptsType : [m.acceptsType];
    const iconSize = 15;
    const gap = 4;
    const orText = 'lub';

    ctx.textAlign = 'left';
    const prefixW = ctx.measureText(prefix).width;
    const orW = ctx.measureText(orText).width;

    let totalW = prefixW + gap;
    types.forEach((_, i) => {
      totalW += iconSize + gap;
      if (i < types.length - 1) totalW += orW + gap * 2;
    });

    let x = m.x - totalW / 2;

    this._drawOutlinedText(ctx, prefix, x, y, color);
    x += prefixW + gap;

    types.forEach((typeId, i) => {
      if (typeof ItemRenderer !== 'undefined') {
        ItemRenderer._drawSpriteOrLabel(ctx, typeId, '?', x + iconSize / 2, y - 4, iconSize);
      }
      x += iconSize + gap;
      if (i < types.length - 1) {
        this._drawOutlinedText(ctx, orText, x, y, 'rgba(255, 255, 255, 0.55)');
        x += orW + gap * 2;
      }
    });

    ctx.textAlign = 'center';
  }

  /**
   * Tonuje jedną z trzech prawdziwych teksturek poświaty z Kenney "Particle
   * Pack" (assets/effects/fx_glow|fx_flare|fx_spark.png, białe/szare na
   * przezroczystym tle) na dowolny kolor akcentu - ta sama technika
   * "source-atop" co tintowanie skinów gracza (player.js
   * _bakeTintedCanvas), tylko tutaj bez osobnego kroku "spritesReady", bo
   * spriteLoader.loadAll() kończy się PRZED skonstruowaniem MachineManager
   * (patrz main.js: startGame() woła się dopiero w .then()) - więc obrazki
   * są już gotowe przy pierwszym wywołaniu. Wynik cache'owany per
   * (spriteKey, kolor), żeby nie kompozytować tego samego tinta co klatkę.
   */
  _getTintedFx(spriteKey, hexColor) {
    this._fxTintCache = this._fxTintCache || {};
    const cacheKey = `${spriteKey}|${hexColor}`;
    if (this._fxTintCache[cacheKey]) return this._fxTintCache[cacheKey];
    const img = window.spriteLoader && window.spriteLoader.get(spriteKey);
    if (!img || !img.complete || !img.naturalWidth) return null;
    const size = img.naturalWidth;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const tctx = canvas.getContext('2d');
    tctx.drawImage(img, 0, 0);
    tctx.globalCompositeOperation = 'source-atop';
    tctx.fillStyle = hexColor;
    tctx.fillRect(0, 0, size, size);
    this._fxTintCache[cacheKey] = canvas;
    return canvas;
  }

  /**
   * Przekolorowuje PRAWDZIWY sprite Kenney (assets/machines/sci_panel.png -
   * korpus "Sci-Fi RTS/Space Shooter Extension", i sci_core.png - świecący
   * rdzeń) na kolor akcentu maszyny, obracając odcień (hue) piksel po
   * pikselu w HSL - zamiast rysować korpus/rdzeń ręcznie jak w poprzedniej
   * wersji reskinu, TERAZ to prawdziwa grafika z paczki, tylko przefarbowana
   * na zielono/fioletowo/czerwono dla każdej maszyny. Piksele o niskiej
   * saturacji (rama, cień) są celowo POMIJANE (zostają neutralnie szare) -
   * inaczej obrót odcienia farbowałby też metalową ramkę na dziwny odcień
   * zamiast tylko właściwej, nasyconej powierzchni. Nie użyto ctx.filter
   * (prostsze, ale barwi WSZYSTKO łącznie z ramką) - ta ręczna wersja była
   * zweryfikowana wizualnie (patrz historia sesji) i cache'owana per
   * (spriteKey, hueDeg, satMult, minSat), bo liczy się raz na maszynę, nie
   * co klatkę.
   *
   * minSat MUSI być dobrany per sprite, nie jedna stała dla obu: metalowa
   * rama sci_panel.png (tło ekranu, saturacja ~0.08-0.16) powinna się
   * przefarbować RAZEM z resztą korpusu (niski próg), ale metalowy PIERŚCIEŃ
   * wokół sci_core.png ma PRAWIE tę samą saturację (~0.16) co żywy
   * pomarańczowy środek (~0.85) - niski próg farbował więc też pierścień na
   * dziwny róż/fiolet zamiast zostawić go neutralnie szarym. Stąd wywołania
   * dla rdzenia (patrz _drawRecycleMachine/_drawPressMachine/
   * _drawFurnaceMachine) proszą o wyższy próg (~0.4), który łapie już tylko
   * nasycony środek.
   *
   * overlayTint (opcjonalny [kolor, alpha]) - "klepsydra" Kompresora
   * (sci_press.png) jest PRAWIE idealnie szara (saturacja bliska 0), więc
   * obrót odcienia nie ma czego chwycić - d===0 dla piksela r=g=b oznacza
   * matematycznie NIEOKREŚLONY odcień, żaden próg tego nie naprawi. Zamiast
   * tego dokładamy jeden przebieg 'source-atop' (TA SAMA technika co
   * _getTintedFx/player.js _bakeTintedCanvas - restrykcyjnie tylko tam,
   * gdzie już jest jakaś alpha, więc przezroczyste tło NIE dostaje koloru)
   * przy alpha<1, żeby oryginalne cieniowanie częściowo prześwitywało spod
   * tinta zamiast robić się płaskim jednolitym kolorem.
   */
  _getRecoloredSprite(spriteKey, hueDeg, satMult, minSat = 0.08, overlayTint = null) {
    this._fxRecolorCache = this._fxRecolorCache || {};
    const cacheKey = `${spriteKey}|${hueDeg}|${satMult}|${minSat}|${overlayTint ? overlayTint.join(',') : ''}`;
    if (this._fxRecolorCache[cacheKey]) return this._fxRecolorCache[cacheKey];
    const img = window.spriteLoader && window.spriteLoader.get(spriteKey);
    if (!img || !img.complete || !img.naturalWidth) return null;
    const w = img.naturalWidth, h = img.naturalHeight;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const tctx = canvas.getContext('2d');
    tctx.drawImage(img, 0, 0);
    const imageData = tctx.getImageData(0, 0, w, h);
    const data = imageData.data;
    const hueShift = hueDeg / 360;
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];
      if (a === 0) continue;
      const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const l = (max + min) / 2;
      const d = max - min;
      if (d === 0) continue;
      let s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (s < minSat) continue;
      let h2;
      if (max === r) h2 = ((g - b) / d + (g < b ? 6 : 0)) / 6;
      else if (max === g) h2 = ((b - r) / d + 2) / 6;
      else h2 = ((r - g) / d + 4) / 6;
      h2 = (h2 + hueShift) % 1;
      if (h2 < 0) h2 += 1;
      s = Math.min(1, s * satMult);
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      const hue2rgb = (t) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
      };
      data[i] = Math.round(hue2rgb(h2 + 1 / 3) * 255);
      data[i + 1] = Math.round(hue2rgb(h2) * 255);
      data[i + 2] = Math.round(hue2rgb(h2 - 1 / 3) * 255);
    }
    tctx.putImageData(imageData, 0, 0);
    if (overlayTint) {
      const [color, alpha] = overlayTint;
      tctx.globalCompositeOperation = 'source-atop';
      tctx.globalAlpha = alpha;
      tctx.fillStyle = color;
      tctx.fillRect(0, 0, w, h);
      tctx.globalAlpha = 1;
      tctx.globalCompositeOperation = 'source-over';
    }
    this._fxRecolorCache[cacheKey] = canvas;
    return canvas;
  }

  /**
   * Wspólny motyw "kosmicznej poświaty" pod maszyną - prawdziwa, miękka
   * teksturka blasku (fx_glow, Kenney Particle Pack CC0) tonowana na kolor
   * akcentu maszyny, zamiast ręcznie rysowanego radialnego gradientu. Jeden
   * z niewielu wspólnych helperów w tym pliku (obok _lighten/
   * _traceRoundedRect) - każda z trzech maszyn niżej (Reaktor/Kompresor/
   * Piec Plazmowy) woła go z innym kolorem/promieniem. Fallback na dawny
   * ręczny gradient, gdyby plik z jakiegoś powodu się nie wczytał.
   */
  _drawCosmicGlow(ctx, cx, cy, r, hexColor, alpha) {
    const tinted = this._getTintedFx('fx_glow', hexColor);
    ctx.save();
    if (tinted) {
      ctx.globalAlpha = alpha * 2.2;
      ctx.drawImage(tinted, cx - r, cy - r, r * 2, r * 2);
    } else {
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      grad.addColorStop(0, `${hexColor}${Math.round(alpha * 255).toString(16).padStart(2, '0')}`);
      grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /**
   * Wspólny motyw "orbitującego pierścienia" (jak spłaszczony pierścień
   * planety) - cienka przerywana elipsa wokół korpusu maszyny, z kreskami
   * "płynącymi" po obwodzie (animacja przez lineDashOffset, nie przez
   * ctx.rotate - taniej liczyć, a efekt "orbitowania" wychodzi ten sam).
   * rx/ry kontrolują rozmiar/spłaszczenie (pochylenie pierścienia), speed
   * jak szybko kreski płyną, dash długość pojedynczej kreski.
   */
  _drawCosmicRing(ctx, cx, cy, rx, ry, color, speed, dash) {
    const now = performance.now();
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1, ry / rx);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.4;
    ctx.setLineDash([dash, dash * 0.9]);
    ctx.lineDashOffset = -(now * speed);
    ctx.beginPath();
    ctx.arc(0, 0, rx, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // Dwie jasne "iskry" krążące po obwodzie pierścienia - prawdziwa
    // teksturka rozbłysku (fx_flare, Kenney Particle Pack) tonowana na
    // kolor pierścienia, zamiast rysowanego ręcznie kółka - sama przerywana
    // linia czytała się zbyt statycznie z daleka, to daje wyraźny, świecący
    // sygnał "coś tu orbituje", nawet gdy gracz nie stoi tuż obok maszyny.
    const orbitAngle = now * speed * 90;
    const flare = this._getTintedFx('fx_flare', color);
    const flareSize = rx * 0.34;
    ctx.globalAlpha = 0.95;
    [orbitAngle, orbitAngle + Math.PI].forEach((a) => {
      const fx = Math.cos(a) * rx, fy = Math.sin(a) * rx;
      if (flare) {
        ctx.drawImage(flare, fx - flareSize / 2, fy - flareSize / 2, flareSize, flareSize);
      } else {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(fx, fy, 2.6, 0, Math.PI * 2);
        ctx.fill();
      }
    });
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  /**
   * Wspólny "połysk szkła" na okrągłych iluminatorach trzech maszyn niżej -
   * cienki, jasny półksiężyc w górnym-lewym rogu okna, jakby światło odbijało
   * się od wypukłej szyby. Rysowany NA WIERZCHU zawartości okna (po ctx.
   * restore() z clipu), więc nie przeszkadza animacji w środku.
   */
  _drawGlassHighlight(ctx, cx, cy, r) {
    ctx.save();
    ctx.globalAlpha = 0.28;
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = r * 0.22;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.72, Math.PI * 1.05, Math.PI * 1.55);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Reaktor Recyklingowy (dawniej Recykler, assets/machines/recycle.png) -
   * pierwsza z trzech maszyn "Fazy kosmicznego reskinu, wersja 2". Zamiast
   * składania własnego korpusu z prymitywów (poprzednia wersja - hopper/
   * korpus/okienko rysowane ręcznie), bryła to teraz CAŁA, gotowa stacja
   * kosmiczna z Kenney "Space Shooter Extension" (spaceStation_017,
   * assets/machines/sci_module.png, CC0) - moduł satelitarny z panelami
   * "słonecznymi" (przefarbowanymi tu na zielono) i centralnym hubem, na
   * który nakładany jest świecący rdzeń (sci_core.png). Własny, stożkowaty
   * czubek modułu pełni rolę leja - osobny, rysowany ręcznie hopper nie jest
   * już potrzebny. Poświata + orbitujący pierścień (_drawCosmicGlow/
   * _drawCosmicRing) to wspólny akcent łączący wszystkie maszyny reskinu.
   */
  _drawRecycleMachine(ctx, m, isActive) {
    const U = MACHINE_PROC_UNIT;
    const cx = m.x;
    const cy = m.y;
    const now = performance.now();

    const hull = isActive ? this._lighten('#4B5563', MACHINE_LIGHTEN_AMOUNT) : '#4B5563';
    const hullDark = this._lighten(hull, -34);
    const accent = '#66BB6A';
    const accentGlow = '#A8FF9E';

    this._drawCosmicGlow(ctx, cx, cy - U * 0.05, U * 0.95, accent, 0.28);
    this._drawCosmicRing(ctx, cx, cy - U * 0.02, U * 0.66, U * 0.2, 'rgba(168, 255, 158, 0.55)', 0.0007, 6);

    // --- Moduł: PRAWDZIWA bryła Kenney (sci_module.png, proporcje źródła
    // 344x577) przefarbowana na zielono, przeskalowana tak, by całość mieściła
    // się w tej samej "działce" co reszta maszyn (~U wysokości). ---
    const modH = U * 1.25;
    const modW = modH * (344 / 577);
    const modTop = cy - U * 0.7;
    const modLeft = cx - modW / 2;
    const moduleSprite = this._getRecoloredSprite('machine_sci_module', -69, 1.7);
    if (moduleSprite) {
      ctx.drawImage(moduleSprite, modLeft, modTop, modW, modH);
    } else {
      ctx.fillStyle = hull;
      this._traceRoundedRect(ctx, modLeft, modTop, modW, modH, U * 0.1);
      ctx.fill();
    }

    // --- Rdzeń: świecąca kula (sci_core.png) przefarbowana na zielono,
    // osadzona na hubie modułu (tam, gdzie łączą się panele "słoneczne") -
    // z delikatnym "oddychaniem" skalą, żeby było widać że maszyna żyje. ---
    const hubCx = cx, hubCy = modTop + modH * 0.335;
    const breath = 1 + 0.05 * Math.sin(now * 0.004);
    const coreR = modW * 0.24 * breath;
    const coreSprite = this._getRecoloredSprite('machine_sci_core', 106, 1.25, 0.4);
    if (coreSprite) {
      ctx.drawImage(coreSprite, hubCx - coreR, hubCy - coreR, coreR * 2, coreR * 2);
    } else {
      ctx.fillStyle = accentGlow;
      ctx.beginPath();
      ctx.arc(hubCx, hubCy, coreR * 0.6, 0, Math.PI * 2);
      ctx.fill();
    }
    // Okruchy śmieci wciągane spiralnie w rdzeń (rozkład materii) - kilka
    // realnych iskierek (fx_flare) zamiast rysowanych ręcznie kwadracików.
    const flareBit = this._getTintedFx('fx_flare', accentGlow);
    if (flareBit) {
      for (let i = 0; i < 3; i++) {
        const t = ((now * 0.0006 + i * 0.3) % 1);
        const a = t * Math.PI * 6 + i;
        const r = coreR * (1 - t) * 1.3;
        const bitSize = coreR * 0.3 * t;
        ctx.globalAlpha = 0.9 * t;
        ctx.drawImage(flareBit, hubCx + Math.cos(a) * r - bitSize / 2, hubCy + Math.sin(a) * r - bitSize / 2, bitSize, bitSize);
      }
      ctx.globalAlpha = 1;
    }
    this._drawGlassHighlight(ctx, hubCx, hubCy, coreR);
  }

  /**
   * Kompresor Grawitonowy (dawniej Prasa, assets/machines/press.png) - druga
   * z trzech maszyn "Fazy kosmicznego reskinu, wersja 2". Bryła to prawdziwa
   * "klepsydra" z Kenney "Space Shooter Extension" (spaceStation_012,
   * assets/machines/sci_press.png, CC0) - dwie płyty zbiegające się ku
   * wspólnemu punktowi w środku, więc kształt SAM w sobie czyta się jako
   * "kompresja".
   *
   * PRZEBUDOWANE (Tomek: "usprawnij o wiele jego wygląd bo słabo wygląda") -
   * porównanie z resztą maszyn pokazało DWIE realne przyczyny: (1) to
   * najmniejsza bryła z całej piątki (pressW był U*1.05, podczas gdy
   * refinery/furnace/recycler mają 1.15-1.25) oraz (2) sci_press.png to
   * NAJPŁASZSZY sprite w paczce - dwa jednotonowe szare trapezoidy bez
   * naturalnego cieniowania, jakie mają dome/capsule/grinder reszty maszyn
   * (sprawdzone wprost - powiększony podgląd pliku), więc satMult=1.7
   * (najwyższy ze wszystkich pięciu) tylko podkręcał tę płaskość w stronę
   * "neonowego plastiku" zamiast metalu. Naprawione: (1) większa bryła +
   * postument (ten sam wzorzec co _drawFurnaceMachine, wcześniej Kompresor
   * jako JEDYNY z pięciu "unosił się" bez podstawy), (2) niższy satMult
   * (1.25, zgodnie z resztą) + WŁASNE rysowane rim-lighty na krawędziach
   * klepsydry (fejkowe cieniowanie tam, gdzie sprite go nie ma), (3) rdzeń
   * dostał wirujące, WCIĄGANE DO ŚRODKA iskry (spirala malejącego promienia,
   * ten sam trik co spiralne okruchy Reaktora, tylko odwrócony kierunek -
   * "grawiton" powinien WCIĄGAĆ, nie tylko świecić) zamiast martwego
   * okresowego błysku między emiterami widocznego tylko ~35% czasu.
   */
  _drawPressMachine(ctx, m, isActive) {
    const U = MACHINE_PROC_UNIT;
    const cx = m.x;
    const cy = m.y;
    const now = performance.now();

    const hull = isActive ? this._lighten('#4B5563', MACHINE_LIGHTEN_AMOUNT) : '#4B5563';
    const hullDark = this._lighten(hull, -34);
    const accent = '#AB47BC';
    const accentGlow = '#E1BEE7';

    this._drawCosmicGlow(ctx, cx, cy - U * 0.05, U * 1.05, accent, 0.3);
    this._drawCosmicRing(ctx, cx, cy - U * 0.02, U * 0.72, U * 0.22, 'rgba(225, 190, 231, 0.55)', -0.0005, 6);

    // --- Klepsydra: PRAWDZIWA bryła Kenney (sci_press.png), teraz w tej
    // samej skali co reszta maszyn (było wyraźnie najmniejsze z pięciu) i z
    // łagodniejszym satMult (1.25 zamiast 1.7 - mniej "neonowego plastiku",
    // bliżej metalicznego tonu refinery/furnace). ---
    const pressW = U * 1.2;
    const pressH = pressW * (88 / 96);
    const pressTop = cy - pressH / 2 - U * 0.05;
    const pressLeft = cx - pressW / 2;
    const pressSprite = this._getRecoloredSprite('machine_sci_press', 100, 1.25, 0.08, [accent, 0.5]);
    if (pressSprite) {
      ctx.drawImage(pressSprite, pressLeft, pressTop, pressW, pressH);
    } else {
      ctx.fillStyle = hull;
      this._traceRoundedRect(ctx, pressLeft, pressTop, pressW, pressH, U * 0.1);
      ctx.fill();
    }

    // Rim-lighty na skośnych krawędziach klepsydry - sci_press.png jest
    // płaskim jednotonowym szarym kształtem BEZ własnego cieniowania (w
    // przeciwieństwie do dome/capsule/grinder reszty maszyn), więc bez tego
    // czytał się jako naklejka, nie bryła. Cztery krótkie, jasne kreski
    // wzdłuż zbiegających się do środka krawędzi obu płyt, w kolorze akcentu.
    ctx.save();
    ctx.globalAlpha = isActive ? 0.55 : 0.4;
    ctx.strokeStyle = accentGlow;
    ctx.lineWidth = Math.max(1, U * 0.012);
    ctx.lineCap = 'round';
    const rimInset = pressW * 0.06;
    const rimMidY = pressTop + pressH * 0.5;
    [-1, 1].forEach((side) => {
      const outerX = cx + side * (pressW / 2 - rimInset);
      const innerX = cx + side * (pressW * 0.14);
      ctx.beginPath();
      ctx.moveTo(outerX, pressTop + pressH * 0.1);
      ctx.lineTo(innerX, rimMidY);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(innerX, rimMidY);
      ctx.lineTo(outerX, pressTop + pressH * 0.9);
      ctx.stroke();
    });
    ctx.restore();

    // Postument pod klepsydrą - JEDYNA z pięciu maszyn, która dotąd
    // "unosiła się" bez podstawy (furnace/recycler/refinery/crystal_polisher
    // wszystkie stoją na czymś). Ten sam wzorzec co _drawFurnaceMachine.
    const pedW = pressW * 0.5, pedH = U * 0.15;
    ctx.fillStyle = hullDark;
    this._traceRoundedRect(ctx, cx - pedW / 2, pressTop + pressH - U * 0.03, pedW, pedH, U * 0.03);
    ctx.fill();

    // --- Rdzeń: świecąca kula (sci_core.png) przefarbowana na fioletowo,
    // ściskana rytmicznie w pionie (skala Y) w punkcie zbiegu płyt - motyw
    // "kompresji polem grawitacyjnym" przeniesiony na animację skali
    // prawdziwej grafiki. ---
    const winCx = cx, winCy = pressTop + pressH * 0.5;
    const squeeze = 0.8 + 0.2 * Math.abs(Math.sin(now * 0.0025));
    const winR = pressW * 0.24;
    const coreSprite = this._getRecoloredSprite('machine_sci_core', 275, 1.25, 0.4);
    if (coreSprite) {
      ctx.save();
      ctx.translate(winCx, winCy);
      ctx.scale(1, squeeze);
      ctx.drawImage(coreSprite, -winR, -winR, winR * 2, winR * 2);
      ctx.restore();
    } else {
      ctx.fillStyle = accentGlow;
      ctx.beginPath();
      ctx.arc(winCx, winCy, winR * 0.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // Iskry WCIĄGANE grawitacyjnie do rdzenia (promień malejący z czasem w
    // pętli, nie stały orbit jak u Reaktora/Pieca) - "grawiton" ma coś
    // POCHŁANIAĆ, nie tylko świecić. Ciągłe (nie warunkowe jak dawny błysk
    // widoczny ~35% czasu), więc maszyna zawsze czyta się jako aktywna.
    const inflowSpark = this._getTintedFx('fx_flare', accentGlow);
    if (inflowSpark) {
      for (let i = 0; i < 4; i++) {
        const t = ((now * 0.0009 + i * 0.25) % 1);
        const a = i * (Math.PI / 2) + now * 0.0015;
        const r = winR * 1.9 * (1 - t);
        const bitSize = winR * 0.32 * t;
        ctx.globalAlpha = 0.85 * t;
        ctx.drawImage(inflowSpark, winCx + Math.cos(a) * r - bitSize / 2, winCy + Math.sin(a) * r * 0.7 - bitSize / 2, bitSize, bitSize);
      }
      ctx.globalAlpha = 1;
    }
    this._drawGlassHighlight(ctx, winCx, winCy, winR);

    // --- Dwa emitery nad klepsydrą, teraz z własną poświatą (nie płaskie
    // kropki) + STAŁE, delikatne pole energii między nimi (zamiast dawnego
    // warunkowego błysku) - czyta się jako źródło pola napędzającego
    // kompresję, nie migający defekt. ---
    const emY = pressTop - U * 0.02;
    const emL = cx - pressW * 0.3, emR = cx + pressW * 0.3;
    [emL, emR].forEach((ex) => {
      const eGrad = ctx.createRadialGradient(ex, emY, 0, ex, emY, U * 0.09);
      eGrad.addColorStop(0, accentGlow);
      eGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = eGrad;
      ctx.beginPath();
      ctx.arc(ex, emY, U * 0.09, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = hullDark;
      ctx.beginPath();
      ctx.arc(ex, emY, U * 0.045, 0, Math.PI * 2);
      ctx.fill();
    });
    const spark = this._getTintedFx('fx_spark', accentGlow);
    const fieldPulse = 0.35 + 0.25 * Math.abs(Math.sin(now * 0.004));
    ctx.globalAlpha = fieldPulse;
    if (spark) {
      const sparkW = emR - emL, sparkH = sparkW * 0.7;
      ctx.drawImage(spark, emL, emY - sparkH / 2, sparkW, sparkH);
    } else {
      ctx.strokeStyle = accentGlow;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(emL, emY);
      ctx.quadraticCurveTo(cx, emY - U * 0.06 * Math.sin(now * 0.05), emR, emY);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /**
   * Piec Plazmowy (dawniej Piec hutniczy, assets/machines/piechutniczy.png) -
   * trzecia z maszyn "Fazy kosmicznego reskinu, wersja 2". Bryła to teraz
   * prawdziwa kopuła/pod z Kenney "Space Shooter Extension"
   * (spaceStation_029, assets/machines/sci_dome.png, CC0) - osadzona na
   * niewielkim, rysowanym ręcznie postumencie, z rdzeniem (sci_core.png,
   * natywny pomarańcz bliski akcentowi pieca) widocznym w jej "ustach" jak
   * mini-słońce w komorze plazmy.
   */
  _drawFurnaceMachine(ctx, m, isActive) {
    const U = MACHINE_PROC_UNIT;
    const cx = m.x;
    const cy = m.y;
    const now = performance.now();

    const hull = isActive ? this._lighten('#4B3A3E', MACHINE_LIGHTEN_AMOUNT) : '#4B3A3E';
    const hullDark = this._lighten(hull, -34);
    const accent = '#EF5350';
    const accentGlow = '#FFAB91';

    this._drawCosmicGlow(ctx, cx, cy - U * 0.05, U * 0.95, accent, 0.3);
    this._drawCosmicRing(ctx, cx, cy - U * 0.02, U * 0.68, U * 0.22, 'rgba(255, 171, 145, 0.55)', 0.0006, 7);

    // --- Kopuła: PRAWDZIWA bryła Kenney (sci_dome.png) - jej naturalny
    // srebrny odcień zostaje (dome nie potrzebuje przefarbowania, kontrastuje
    // ładnie z pomarańczem rdzenia w środku), osadzona na postumencie. ---
    const domeW = U * 1.15;
    const domeH = domeW * (116 / 248);
    const domeTop = cy - domeH / 2 - U * 0.08;
    const domeLeft = cx - domeW / 2;
    const domeSprite = window.spriteLoader && window.spriteLoader.get('machine_sci_dome');
    if (domeSprite && domeSprite.complete && domeSprite.naturalWidth) {
      ctx.drawImage(domeSprite, domeLeft, domeTop, domeW, domeH);
    } else {
      ctx.fillStyle = hull;
      this._traceRoundedRect(ctx, domeLeft, domeTop, domeW, domeH, U * 0.1);
      ctx.fill();
    }
    // Postument pod kopułą.
    const pedW = domeW * 0.55, pedH = U * 0.16;
    ctx.fillStyle = hullDark;
    this._traceRoundedRect(ctx, cx - pedW / 2, domeTop + domeH - U * 0.04, pedW, pedH, U * 0.03);
    ctx.fill();

    // --- Rdzeń: PRAWDZIWY sprite Kenney (sci_core.png) - jego natywny
    // pomarańcz leży już blisko akcentu pieca, więc obrót odcienia jest
    // subtelny - pulsujący promień (mini-słońce) widoczny w "ustach" kopuły
    // + dwie orbitujące iskry (prawdziwa teksturka fx_flare). ---
    const winCx = cx, winCy = domeTop + domeH * 0.82;
    const pulse2 = 1 + 0.08 * Math.sin(now * 0.005);
    const winR = domeW * 0.19 * pulse2;
    const coreSprite = this._getRecoloredSprite('machine_sci_core', -16, 1.1, 0.4);
    if (coreSprite) {
      ctx.drawImage(coreSprite, winCx - winR, winCy - winR, winR * 2, winR * 2);
    } else {
      ctx.fillStyle = accentGlow;
      ctx.beginPath();
      ctx.arc(winCx, winCy, winR * 0.5, 0, Math.PI * 2);
      ctx.fill();
    }
    const orbitSpark = this._getTintedFx('fx_flare', '#FFE0B2');
    if (orbitSpark) {
      const sparkSize = winR * 0.42;
      for (let i = 0; i < 2; i++) {
        const a = now * 0.003 * (i === 0 ? 1 : -1.3) + i * Math.PI;
        const r = winR * 0.9;
        const sx = winCx + Math.cos(a) * r, sy = winCy + Math.sin(a) * r * 0.5;
        ctx.drawImage(orbitSpark, sx - sparkSize / 2, sy - sparkSize / 2, sparkSize, sparkSize);
      }
    }
    this._drawGlassHighlight(ctx, winCx, winCy, winR);
  }

  /**
   * Oczyszczalnia - CZWARTA maszyna "Fazy kosmicznego reskinu, wersja 2"
   * (po Reaktorze/Kompresorze/Piecu). Bryła to teraz prawdziwa kapsuła z
   * Kenney "Space Shooter Extension" (spaceStation_001,
   * assets/machines/sci_capsule.png, CC0) - podłużny moduł z jasnym paskiem
   * "okna" na całej długości, przefarbowany na fioletowo (overlay - kapsuła
   * jest prawie pozbawiona saturacji, jak klepsydra Kompresora, więc hue-
   * rotate sam nie wystarczy). Rdzeń (sci_core.png) osadzony na środku paska.
   */
  _drawRefineryMachine(ctx, m, isActive) {
    const U = MACHINE_PROC_UNIT;
    const cx = m.x;
    const cy = m.y;
    const now = performance.now();

    const hull = isActive ? this._lighten('#4B4359', MACHINE_LIGHTEN_AMOUNT) : '#4B4359';
    const hullDark = this._lighten(hull, -34);
    const accent = '#8E6BC4';
    const accentGlow = '#D5C4F0';

    this._drawCosmicGlow(ctx, cx, cy - U * 0.05, U * 0.95, accent, 0.28);
    this._drawCosmicRing(ctx, cx, cy - U * 0.02, U * 0.66, U * 0.2, 'rgba(213, 196, 240, 0.55)', 0.00055, 6);

    // --- Lej u góry, ze szkłem czekającym na wsyp. ---
    // --- Kapsuła: PRAWDZIWA bryła Kenney (sci_capsule.png) przefarbowana na
    // fioletowo overlayem (jak klepsydra Kompresora - prawie bez saturacji). ---
    const capW = U * 1.2;
    const capH = capW * (72 / 168);
    const capTop = cy - capH / 2;
    const capLeft = cx - capW / 2;
    const capsuleSprite = this._getRecoloredSprite('machine_sci_capsule', -69, 1.5, 0.08, [accent, 0.55]);
    if (capsuleSprite) {
      ctx.drawImage(capsuleSprite, capLeft, capTop, capW, capH);
    } else {
      ctx.fillStyle = hull;
      this._traceRoundedRect(ctx, capLeft, capTop, capW, capH, U * 0.08);
      ctx.fill();
    }

    // --- Rdzeń: świecąca kula (sci_core.png) przefarbowana na fioletowo,
    // osadzona na środku paska "okna" kapsuły - z "oddychaniem" skalą. ---
    const winCx = cx, winCy = capTop + capH * 0.5;
    const breath = 1 + 0.05 * Math.sin(now * 0.0035);
    const winR = capH * 0.62 * breath;
    const coreSprite = this._getRecoloredSprite('machine_sci_core', 250, 1.25, 0.4);
    if (coreSprite) {
      ctx.drawImage(coreSprite, winCx - winR, winCy - winR, winR * 2, winR * 2);
    } else {
      ctx.fillStyle = accentGlow;
      ctx.beginPath();
      ctx.arc(winCx, winCy, winR * 0.5, 0, Math.PI * 2);
      ctx.fill();
    }
    this._drawGlassHighlight(ctx, winCx, winCy, winR);
  }

  /**
   * Szlifiernia Kryształów - PIĄTA i ostatnia maszyna "Fazy kosmicznego
   * reskinu, wersja 2". Bryła to prawdziwy stożek zbiegający się w oszlifowany
   * ośmiokątny klejnot z Kenney "Space Shooter Extension" (spaceStation_028,
   * assets/machines/sci_grinder.png, CC0) - naturalnie fasetowany kształt
   * pasuje tematycznie do kryształu BEZ ŻADNEJ edycji. OBRÓCONY -90° (patrz
   * niżej) - pionowo, szeroką podstawą u dołu i klejnotem u góry, żeby nie
   * czytał się jak duplikat poziomej kapsuły Oczyszczalni. Stożek zostaje
   * neutralnie metalowy (saturacja=0, hue-rotate nie ma czego chwycić), ale
   * klejnot dostaje turkusowy tint przez osobny, PRZYCIĘTY (clipowany) drugi
   * drawImage - jedyny sposób pomalować TYLKO fragment sprite'a, skoro
   * _getRecoloredSprite działa na całym obrazku naraz.
   */
  _drawCrystalPolisherMachine(ctx, m, isActive) {
    const U = MACHINE_PROC_UNIT;
    const cx = m.x;
    const cy = m.y;
    const now = performance.now();

    const hull = isActive ? this._lighten('#39514F', MACHINE_LIGHTEN_AMOUNT) : '#39514F';
    const hullDark = this._lighten(hull, -34);
    const accent = '#4DD0C8';
    const accentGlow = '#E1F5FE';

    this._drawCosmicGlow(ctx, cx, cy - U * 0.05, U * 0.95, accent, 0.3);
    this._drawCosmicRing(ctx, cx, cy - U * 0.02, U * 0.68, U * 0.22, 'rgba(225, 245, 254, 0.55)', 0.00065, 7);

    // --- Szlifierka: PRAWDZIWA bryła Kenney (sci_grinder.png), OBRÓCONA
    // -90° - w oryginale to poziomy stożek zbiegający w klejnot PO PRAWEJ
    // (patrz komentarz w _getRecoloredSprite), ale poziomo za bardzo
    // przypominał kapsułę Oczyszczalni obok. Pionowo (szeroka podstawa u
    // dołu, klejnot na czubku u góry) czyta się jak zamontowany, szlifowany
    // kryształ - inna sylwetka niż reszta maszyn, więc łatwiej odróżnić na
    // pierwszy rzut oka. Stożek zostaje metalowy (saturacja=0), tylko
    // klejnot (ostatnie ~38% oryginalnej DŁUGOŚCI, czyli teraz górna część)
    // dostaje turkusowy tint przez osobny, przycięty (clip) drugi drawImage. ---
    const grindLen = U * 1.1;
    const grindThick = grindLen * (89 / 164);
    const rock = Math.sin(now * 0.003) * 0.025;
    const grinderNative = window.spriteLoader && window.spriteLoader.get('machine_sci_grinder');
    const grinderTinted = this._getRecoloredSprite('machine_sci_grinder', 150, 1.4, 0.08, [accent, 0.6]);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-Math.PI / 2 + rock);
    if (grinderNative && grinderNative.complete && grinderNative.naturalWidth) {
      ctx.drawImage(grinderNative, -grindLen / 2, -grindThick / 2, grindLen, grindThick);
      if (grinderTinted) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(grindLen * 0.12, -grindThick / 2, grindLen * 0.38, grindThick);
        ctx.clip();
        ctx.drawImage(grinderTinted, -grindLen / 2, -grindThick / 2, grindLen, grindThick);
        ctx.restore();
      }
    } else {
      ctx.fillStyle = hull;
      this._traceRoundedRect(ctx, -grindLen / 2, -grindThick / 2, grindLen, grindThick, U * 0.06);
      ctx.fill();
    }
    ctx.restore();

    // --- Rdzeń: świecąca kula (sci_core.png) przefarbowana turkusowo,
    // osadzona na klejnocie (teraz u GÓRY po obrocie) - iskrzy, jakby
    // właśnie się szlifował. ---
    const winCx = cx, winCy = cy - grindLen * 0.32;
    const pulse = 1 + 0.07 * Math.sin(now * 0.006);
    const winR = grindThick * 0.34 * pulse;
    const coreSprite = this._getRecoloredSprite('machine_sci_core', 163, 1.2, 0.4);
    if (coreSprite) {
      ctx.drawImage(coreSprite, winCx - winR, winCy - winR, winR * 2, winR * 2);
    } else {
      ctx.fillStyle = accentGlow;
      ctx.beginPath();
      ctx.arc(winCx, winCy, winR * 0.5, 0, Math.PI * 2);
      ctx.fill();
    }
    const sparkle = this._getTintedFx('fx_flare', '#FFFFFF');
    if (sparkle) {
      const s = winR * 0.7 * (0.5 + 0.5 * Math.sin(now * 0.008));
      ctx.globalAlpha = 0.8;
      ctx.drawImage(sparkle, winCx - s / 2, winCy - s / 2, s, s);
      ctx.globalAlpha = 1;
    }
    this._drawGlassHighlight(ctx, winCx, winCy, winR);
  }

  /**
   * Rysuje tekst z ciemną obwódką pod kolorowym wypełnieniem - czytelne na
   * KAŻDYM tle (trawa/bagno/popiół), w przeciwieństwie do stałego koloru,
   * który na jednym biomie wygląda dobrze, a na drugim ginie. Oczekuje, że
   * wywołujący ustawił już ctx.font/textAlign/textBaseline. Tylko dla
   * właściwego tekstu (nazwy/statusy) - NIE dla dużych emoji na korpusie
   * maszyny (te i tak stoją na kolorowym tle maszyny, nie na biomie, a
   * grube obwódki psują ich wygląd).
   */
  _drawOutlinedText(ctx, text, x, y, fillColor) {
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = fillColor;
    ctx.fillText(text, x, y);
  }

  /**
   * Rysuje zablokowaną (jeszcze nieodblokowaną) maszynę: ciemna, przygaszona
   * sylwetka pudełka + kłódka + ile zarobku brakuje. Cel: gracz WIDZI, że
   * jest tam coś do odblokowania (motywacja, żeby zarabiać dalej), bez
   * zdradzania szczegółów działania. Ile brakuje bierzemy z getNextUnlock()
   * economy.js - pokazujemy licznik TYLKO dla maszyny, która jest AKURAT
   * następna w kolejce (dla dalszych w kolejce sam znak kłódki), żeby nie
   * zasypać ekranu liczbami dla czegoś odległego.
   */
  _drawLockedMachine(ctx, m) {
    const hw = m.w / 2;
    const hh = m.h / 2;

    // Cień jak przy normalnej maszynie, żeby "stała" na ziemi tak samo.
    ctx.fillStyle = 'rgba(0, 0, 0, 0.18)';
    ctx.beginPath();
    ctx.ellipse(m.x, m.y + hh + 8, hw * 0.55, hh * 0.15, 0, 0, Math.PI * 2);
    ctx.fill();

    // Przygaszone pudełko - ciemna sylwetka zamiast kolorowej maszyny.
    ctx.save();
    ctx.fillStyle = 'rgba(40, 44, 52, 0.72)';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 4]);
    this._traceRoundedRect(ctx, m.x - hw, m.y - hh, m.w, m.h, 10);
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);

    // Kłódka (proceduralna, zero assetów) - pałąk + korpus.
    const lx = m.x;
    const ly = m.y - 2;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(lx, ly - 6, 6, Math.PI, 0);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.82)';
    this._traceRoundedRect(ctx, lx - 9, ly - 2, 18, 14, 3);
    ctx.fill();
    ctx.restore();

    // Ile brakuje - tylko dla NASTĘPNEGO w kolejce odblokowania.
    const eco = window.economyManager;
    if (eco && typeof eco.getNextUnlock === 'function') {
      const next = eco.getNextUnlock();
      if (next && next.id === m.id) {
        ctx.font = 'bold 10px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        // Bez prefiksu 🔒 (kłódka już narysowana proceduralnie tuż nad tym
        // tekstem, patrz wyżej) i bez symbolu waluty - to czysty canvas
        // fillText, nie DOM, więc nie da się tu wstawić CREDIT_ICON_SVG
        // (ui.js) jak w reszcie gry; złoty kolor + kontekst (mała podpowiedź
        // "ile brakuje" nad zablokowaną maszyną) wystarczą bez symbolu.
        this._drawOutlinedText(ctx, I18n.t('machine.lockedCost', { amount: Math.ceil(next.remaining) }), m.x, m.y - hh - 8, '#FFD54F');
      }
    }
  }

  /**
   * Rozjaśnia kolor hex o `amount` na kanał (proste dodawanie, bez konwersji
   * do HSL) - wystarczające do podświetlenia aktywnej maszyny.
   */
  /**
   * Mnożnik czasu przetwarzania - iloczyn DWÓCH niezależnych źródeł:
   *   1. "Turbo Maszyn" (Rdzenie, core_machine_speed) - globalne, trwałe,
   *      przeżywa prestiż,
   *   2. "Przyspieszenie" kupione dla TEJ KONKRETNEJ maszyny (za gotówkę,
   *      MACHINE_UPGRADE_KINDS) - zerowane prestiżem.
   * Mnożą się, więc oba zakupy mają sens jednocześnie (celowo - tak samo jak
   * Silnik statku i Szybsze buty w player.js).
   * 1 = brak ulepszeń, mniej niż 1 = szybciej.
   */
  _getSpeedMultiplier(machineId) {
    const eco = window.economyManager;
    if (!eco) return 1;
    const global = typeof eco.getMachineSpeedMultiplier === 'function'
      ? eco.getMachineSpeedMultiplier()
      : 1;
    // Modyfikator planety (patrz PLANET_MODIFIERS w economy.js) - MNOŻY się z
    // global/perMachine wyżej/niżej, nie zastępuje ich.
    const planet = typeof eco.getPlanetMachineSpeedMultiplier === 'function'
      ? eco.getPlanetMachineSpeedMultiplier()
      : 1;
    const perMachine = (machineId && typeof eco.getMachineUpgradeValue === 'function')
      ? eco.getMachineUpgradeValue(machineId, 'speed')
      : 1;
    return global * planet * perMachine;
  }

  /** Ile sztuk wypada z JEDNEGO cyklu tej maszyny (ulepszenie 'yield'). */
  _getYield(machineId) {
    const eco = window.economyManager;
    if (!eco || typeof eco.getMachineUpgradeValue !== 'function') return 1;
    return Math.max(1, Math.round(eco.getMachineUpgradeValue(machineId, 'yield')));
  }

  /** Skuteczność auto-załadunku (core_auto_feed, Rdzenie) - 0 = brak
   * ulepszenia (mechanizm całkiem wyłączony), do 0.72 na maksie. Ten sam
   * odczyt "na bieżąco" co _getSpeedMultiplier - działa natychmiast po
   * zakupie, przetrwa prestiż (Rdzenie nie są zerowane). */
  _getAutoFeedEfficiency() {
    const eco = window.economyManager;
    if (!eco || typeof eco.getCoreValue !== 'function') return 0;
    const v = eco.getCoreValue('core_auto_feed');
    return typeof v === 'number' ? v : 0;
  }

  /** Skuteczność auto-eksportu (core_auto_sell, Rdzenie) - mnożnik ceny przy
   * automatycznej sprzedaży, patrz gałąź autoSellEff w update(). */
  _getAutoSellEfficiency() {
    const eco = window.economyManager;
    if (!eco || typeof eco.getCoreValue !== 'function') return 0;
    const v = eco.getCoreValue('core_auto_sell');
    return typeof v === 'number' ? v : 0;
  }

  _lighten(hex, amount) {
    const num = parseInt(hex.replace('#', ''), 16);
    const r = Math.max(0, Math.min(255, (num >> 16) + amount));
    const g = Math.max(0, Math.min(255, ((num >> 8) & 0xFF) + amount));
    const b = Math.max(0, Math.min(255, (num & 0xFF) + amount));
    return `rgb(${r}, ${g}, ${b})`;
  }

  /**
   * Buduje ścieżkę zaokrąglonego prostokąta - ten sam fallback co
   * StackController._traceRoundedSquare (stacking.js, Krok 7), na wypadek
   * braku natywnego ctx.roundRect w starszych przeglądarkach.
   */
  _traceRoundedRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(x, y, w, h, r);
      return;
    }
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

  /**
   * Usuwa subskrypcję z Bus. Przydatne przy restarcie gry / tworzeniu nowej
   * instancji, analogicznie do destroy() w player.js / stacking.js / items.js.
   */
  destroy() {
    Bus.unsubscribe(Events.PLAYER_MOVED, this._onPlayerMoved);
  }
}

window.MachineManager = MachineManager;