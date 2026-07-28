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
    id: 'recycle_a',
    label: 'Recykler',
    xRatio: 0.32,
    yRatio: 0.4,
    color: '#66BB6A',
    acceptsType: ['trash', 'paper'],
    outputType: 'plastic',
    outputLabel: '♻️',
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
    id: 'press_b',
    label: 'Prasa',
    xRatio: 0.28,
    yRatio: 0.72,
    color: '#FFA726',
    acceptsType: 'plastic',
    outputType: 'product',
    outputLabel: '🎁',
    outputColor: '#AB47BC',
    processingDuration: 3000,
    // BALANS: ten sam powód co przy recyklerze wyżej - drugi stopień
    // łańcucha, więc jego próg mnoży się z progiem recyklera. 5x5 dawało
    // 25:1, teraz 3x3 daje 9:1.
    maxInventory: 3
  },
  {
    id: 'furnace_c',
    label: 'Piec hutniczy',
    xRatio: 0.59,
    yRatio: 0.35,
    color: '#EF5350',
    acceptsType: ['metal', 'glass'],
    outputType: 'alloy',
    outputLabel: '🧱',
    outputColor: '#D4A574',
    processingDuration: 2500,
    maxInventory: 3
  },
  {
    // Oczyszczalnia (Faza progresji): rafinuje SZKŁO w KRYSZTAŁY - drugie,
    // droższe zastosowanie szkła obok Pieca (metal+szkło->stop). Szkło ma
    // więc teraz realny wybór: tańszy stop szybciej vs droższy kryształ.
    // Brak własnego PNG - rysuje się procedualnym fallbackiem (gradient +
    // emoji outputu, patrz draw()), tak jak każda maszyna bez sprite'a.
    // Umieszczona w Strefie Bagiennej (x>0.62, y>0.32 - tam spawnuje szkło),
    // po przeciwnej stronie niż Piec, żeby nie zlewały się wizualnie.
    // Bramkowana progiem zarobku (PROGRESSION_UNLOCKS 'refinery_b' w
    // economy.js) - id MUSI się zgadzać, inaczej _isMachineUnlocked nie
    // zadziała.
    id: 'refinery_b',
    label: 'Oczyszczalnia',
    xRatio: 0.8,
    yRatio: 0.62,
    color: '#7E57C2',
    acceptsType: 'glass',
    outputType: 'crystal',
    outputLabel: '🔮',
    outputColor: '#B388FF',
    processingDuration: 3200,
    maxInventory: 3
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
      steamTimer: 0
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

      // Przedmiot w świecie spawnujemy TYLKO, jeśli ktokolwiek go faktycznie
      // przyjmuje - inna maszyna (np. plastik -> prasa) ALBO TradingPost
      // (np. gotowy produkt -> sprzedaż). Jeśli nikt go nie przyjmuje,
      // dorzucanie go do świata tylko zapychałoby plecak przedmiotem bez
      // żadnego dalszego zastosowania.
      if (window.itemManager && this._hasAnyConsumer(m.outputType)) {
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

      // --- LOGIKA RYSOWANIA GRAFIKI DLA PIECA HUTNICZEGO ---
      if (m.id === 'furnace_c') {
        if (!(spriteKey && window.spriteLoader.draw(ctx, spriteKey, m.x, m.y, spriteSize))) {
          // Różowy kwadrat informacyjny widoczny TYLKO, gdy żadna z kandydatur
          // ścieżki (sprites.js: SPRITE_PATH_CANDIDATES.machine_furnace) się
          // nie wczytała - celowo głośniejszy niż standardowy fallback reszty
          // maszyn (gradient+żeberka), żeby brak akurat TEGO pliku rzucał się
          // w oczy, a nie zlewał się z resztą jako "normalnie wygląda".
          ctx.fillStyle = '#FF00FF';
          this._traceRoundedRect(ctx, m.x - hw, m.y - hh, m.w, m.h, 10);
          ctx.fill();
          ctx.fillStyle = '#FFFFFF';
          ctx.font = 'bold 12px Arial';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('Brak pliku PNG!', m.x, m.y);
        }
      }
      // --- LOGIKA RYSOWANIA GRAFIKI DLA OCZYSZCZALNI ---
      // Brak pliku PNG w projekcie (jak Piec Hutniczy WYŻEJ, ale bez własnej
      // grafiki źródłowej od Tomka) - w przeciwieństwie do reszty maszyn bez
      // sprite'a NIE korzysta z generycznego fallbacku niżej (płaski gradient
      // + "żeberka" + emoji na środku wyglądały jak placeholder obok trzech
      // prawdziwych sprite'ów - patrz _drawRefineryMachine). Bespoke
      // proceduralna bryła w TYM SAMYM języku wizualnym co reszta maszyn
      // (lej/hopper na górze, "okienko" procesu, panel kontrolny, przenośnik).
      else if (m.id === 'refinery_b') {
        this._drawRefineryMachine(ctx, m, isActive);
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

        // Cienkie "zeberka" wentylacyjne pod emoji - drobny przemyslowy detal,
        // odrozniajacy korpus maszyny od zwyklego kolorowego prostokata.
        ctx.fillStyle = 'rgba(0, 0, 0, 0.15)';
        for (let i = -2; i <= 2; i++) {
          ctx.fillRect(m.x + i * (hw * 0.22) - 2, m.y + hh * 0.32, 3, hh * 0.32);
        }

        ctx.font = '28px Arial';
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'center';
        ctx.fillText(m.outputLabel, m.x, m.y - hh * 0.12);
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
          statusText = 'Przetwarzam…';
          statusColor = '#FF8A80';
        } else if (m.inventory >= m.maxInventory) {
          statusText = 'Pełna';
          statusColor = '#FF8A80';
        } else {
          statusText = 'Przyjmuje:';
          statusColor = '#A5D6A7';
          showMaterials = true;
        }
      } else if (isNearby) {
        statusText = 'Chce:';
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
   * Oczyszczalnia - bespoke proceduralna bryła (brak pliku PNG w projekcie),
   * w TYM SAMYM języku wizualnym co trzy prawdziwe sprite'y (Recykler/Prasa/
   * Piec): lej z surowcem u góry, korpus z gradientem, "okienko" pokazujące
   * sam proces, panel kontrolny (gauge + lampki), przenośnik z gotowym
   * produktem z boku. Generyczny fallback reszty maszyn (płaski gradient +
   * "żeberka" + wycentrowane emoji) obok trzech prawdziwych sprite'ów
   * wyglądał jak niedokończony placeholder - stąd osobna metoda zamiast
   * dorzucenia kolejnego warunku do tamtego bloku.
   */
  _drawRefineryMachine(ctx, m, isActive) {
    // SKALA: trzy prawdziwe sprite'y (recycle/press/piechutniczy.png) zajmują
    // na ekranie ~120x120 px - zmierzone wprost z nieprzezroczystego obszaru
    // PNG-ów przeskalowanego przez spriteSize (m.w*1.2). Pierwsza wersja tej
    // maszyny rysowała korpus na pełne m.w/m.h (200) PLUS lej nad nim i
    // przenośnik z boku, czyli ~340x310 px - prawie trzykrotnie więcej niż
    // sąsiedzi. To była GŁÓWNA przyczyna, dla której odstawała, ważniejsza
    // niż kolory. Wszystko liczymy więc od U (jednostki), nie od m.w.
    const U = MACHINE_PROC_UNIT;
    const cx = m.x;
    const cy = m.y;
    const now = performance.now();

    // Paleta: przygaszona, bez czerni. PNG-i NIE mają twardych, ciemnych
    // konturów ani nasyconych kolorów - mają płaskie plamy z delikatnym
    // cieniowaniem. Poprzednia wersja miała jaskrawy fiolet + wyraźny ciemny
    // obrys, przez co czytała się jak naklejka obok tamtych.
    const body = isActive ? this._lighten('#8E6BC4', MACHINE_LIGHTEN_AMOUNT) : '#8E6BC4';
    const bodyDark = this._lighten(body, -34);
    const metal = '#8A94A6';
    const metalDark = '#6C7585';

    // --- Lej u góry (ten sam trapez co u sąsiadów) ---
    const hopW = U * 0.62, hopNeck = U * 0.24;
    const hopTop = cy - U * 0.62, hopBot = cy - U * 0.34;
    ctx.fillStyle = metal;
    ctx.beginPath();
    ctx.moveTo(cx - hopW / 2, hopTop);
    ctx.lineTo(cx + hopW / 2, hopTop);
    ctx.lineTo(cx + hopNeck / 2, hopBot);
    ctx.lineTo(cx - hopNeck / 2, hopBot);
    ctx.closePath();
    ctx.fill();
    // Cieniowany bok leja - lekka bryłowatość, tak jak w PNG-ach.
    ctx.fillStyle = metalDark;
    ctx.beginPath();
    ctx.moveTo(cx + hopW * 0.16, hopTop);
    ctx.lineTo(cx + hopW / 2, hopTop);
    ctx.lineTo(cx + hopNeck / 2, hopBot);
    ctx.lineTo(cx + hopNeck * 0.1, hopBot);
    ctx.closePath();
    ctx.fill();

    // Szkło czekające na wsyp - wystaje z leja, jak butelki u Recyklera.
    ['#8ED8E8', '#C3EAF2'].forEach((col, i) => {
      ctx.fillStyle = col;
      const gx = cx + (i === 0 ? -U * 0.14 : U * 0.1);
      const gy = hopTop - U * 0.03;
      ctx.beginPath();
      ctx.moveTo(gx, gy - U * 0.09);
      ctx.lineTo(gx + U * 0.05, gy + U * 0.03);
      ctx.lineTo(gx - U * 0.05, gy + U * 0.03);
      ctx.closePath();
      ctx.fill();
    });

    // --- Korpus: zaokrąglony prostokąt, jaśniejsza lewa / ciemniejsza prawa
    // strona (to samo proste cieniowanie co w PNG-ach, zamiast gradientu). ---
    const bw = U * 0.78, bh = U * 0.72;
    const bx = cx - bw / 2, by = cy - U * 0.34;
    ctx.fillStyle = body;
    this._traceRoundedRect(ctx, bx, by, bw, bh, U * 0.07);
    ctx.fill();
    ctx.save();
    this._traceRoundedRect(ctx, bx, by, bw, bh, U * 0.07);
    ctx.clip();
    ctx.fillStyle = bodyDark;
    ctx.fillRect(bx + bw * 0.62, by, bw * 0.38, bh);
    ctx.restore();

    // --- Okienko procesu: bulgocząca kadź. Mniejsze i wtopione w korpus,
    // nie dominujące jak wcześniej. ---
    const ww = bw * 0.5, wh = bh * 0.42;
    const wx = cx - ww / 2 - bw * 0.06, wy = by + bh * 0.16;
    ctx.fillStyle = '#3B2E57';
    this._traceRoundedRect(ctx, wx - 2, wy - 2, ww + 4, wh + 4, 4);
    ctx.fill();
    ctx.save();
    this._traceRoundedRect(ctx, wx, wy, ww, wh, 3);
    ctx.clip();
    ctx.fillStyle = '#B9A0DE';
    ctx.fillRect(wx, wy, ww, wh);
    for (let i = 0; i < 3; i++) {
      const t = ((now * (0.0004 + i * 0.00008) + i * 0.4) % 1);
      ctx.globalAlpha = 0.5 * (1 - t);
      ctx.fillStyle = '#FFFFFF';
      ctx.beginPath();
      ctx.arc(wx + ww * (0.25 + i * 0.25), wy + wh * (1 - t), 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    // --- Panel z kolorowymi kwadracikami - dokładnie ten detal, który mają
    // wszystkie trzy PNG-owe maszyny (u nich po prawej stronie korpusu). ---
    const px0 = bx + bw * 0.72, py0 = by + bh * 0.2, ps = U * 0.055;
    [['#E8574B', 0], ['#F2C14E', 1], ['#63C267', 2]].forEach(([col, i]) => {
      ctx.fillStyle = col;
      ctx.fillRect(px0, py0 + i * ps * 1.7, ps, ps);
    });

    // --- Przenośnik po prawej (jak u sąsiadów) + gotowy kryształ. ---
    const beltY = cy + U * 0.2, beltX = cx + bw * 0.42, beltW = U * 0.34, beltH = U * 0.1;
    ctx.fillStyle = metal;
    this._traceRoundedRect(ctx, beltX, beltY - beltH / 2, beltW, beltH, beltH / 2);
    ctx.fill();
    ctx.fillStyle = metalDark;
    [beltX + beltH * 0.5, beltX + beltW - beltH * 0.5].forEach((rx) => {
      ctx.beginPath();
      ctx.arc(rx, beltY, beltH * 0.3, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.fillStyle = '#C9A6F0';
    const kx = beltX + beltW * 0.55, ky = beltY - beltH * 0.75;
    ctx.beginPath();
    ctx.moveTo(kx, ky - U * 0.07);
    ctx.lineTo(kx + U * 0.045, ky);
    ctx.lineTo(kx, ky + U * 0.05);
    ctx.lineTo(kx - U * 0.045, ky);
    ctx.closePath();
    ctx.fill();

    // --- Nóżki - PNG-i stoją na krótkich podporach, nie na samym korpusie. ---
    ctx.fillStyle = metalDark;
    [-bw * 0.3, bw * 0.22].forEach((dx) => {
      ctx.fillRect(cx + dx, by + bh, U * 0.08, U * 0.06);
    });
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
        this._drawOutlinedText(ctx, `🔒 za ${Math.ceil(next.remaining)}$`, m.x, m.y - hh - 8, '#FFD54F');
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