'use strict';

/**
 * market.js
 * ------------------------------------------------------------------------
 * System giełdy: ceny przetworzonych surowców (plastic, alloy, product)
 * zmieniają się w czasie (fala sinus + szum), z widocznym trendem
 * (▲ rośnie / ▼ spada). TradingPost to fizyczny punkt na mapie - gracz
 * podchodzi w jego zasięg, a przedmioty ze stosu pasujące do jego listy
 * TRADING_POST_ACCEPTS są automatycznie sprzedawane po aktualnej cenie
 * (ten sam rytm "co interwał jeden przedmiot" co maszyny w machines.js).
 *
 * WAŻNE: to JEDYNE miejsce, w którym przetworzone surowce zamieniają się
 * w pieniądze (Faza 1 giełdy) - maszyny (machines.js) same z siebie już
 * nie płacą, tylko produkują fizyczny przedmiot. MarketManager NIE zna
 * StackController/EconomyManager bezpośrednio poza tym, czego używa
 * TradingPost - komunikacja w drugą stronę idzie przez Bus/Events
 * (Events.MARKET_UPDATED) dla ewentualnego UI.
 *
 * Zależności globalne (muszą być załadowane przed tym plikiem):
 *   - window.Bus / window.Events (m.in. PLAYER_MOVED, RESIZE, FX_PARTICLES,
 *      MARKET_UPDATED)
 *   - window.stackController (.isEmpty() / .findIndex() / .removeAt())
 *   - window.economyManager (.sellItem(typeId, unitPrice, x, y))
 *
 * Użycie w main.js:
 *   window.marketManager = new MarketManager();
 *   window.tradingPost = new TradingPost(canvasGameplay, window.marketManager);
 *   game.registerModule(window.marketManager);
 *   game.registerModule(window.tradingPost);
 */

// Co ile ms losujemy nowy mnożnik ceny.
const MARKET_UPDATE_INTERVAL_MS = 5000;
const MARKET_MIN_MULTIPLIER = 0.6;
const MARKET_MAX_MULTIPLIER = 1.6;
// Próg zmiany mnożnika, powyżej którego uznajemy trend za rosnący/spadkowy
// (poniżej - "flat", żeby strzałka nie migotała przy szumie o zero przecinek coś).
const MARKET_TREND_THRESHOLD = 0.03;

// Ceny bazowe (przy mnożniku = 1.0) dla każdego sprzedawalnego surowca.
// 'alloy' (z Pieca Hutniczego) jest najdroższy - rzadszy surowiec (metal/szkło,
// odblokowywane drogim sprzętem w Fazie 2) powinien się bardziej opłacać.
const MARKET_BASE_PRICES = {
  plastic: 8,
  product: 18,
  alloy: 26,
  // 'crystal' (z Oczyszczalni: szkło->kryształ) najdroższy z PRZETWORZONYCH
  // surowców - rafinacja dłuższa niż wytop stopu (processingDuration 3200
  // vs 2500) i odblokowana najpóźniej (PROGRESSION_UNLOCKS 'refinery_b' -
  // próg wyższy niż piec), więc powinien się najbardziej opłacać, żeby był
  // czym się zająć w późnej fazie zamiast tylko mielić stop.
  crystal: 40,
  // 'crystal_shard' (surowiec ZE ŚWIATA, Strefa D - patrz items.js).
  //
  // BALANS: było 55 - NAJWYŻSZA cena w grze, a odłamek jako JEDYNY sprzedawalny
  // surowiec nie wymaga ŻADNEGO przetwarzania (reszta - plastic/product/alloy/
  // crystal - to wyjścia maszyn). Odłamek był więc jednocześnie droższy ORAZ
  // bez limitu przepustowości: maszyny mają maxInventory 3 i czas przetwarzania
  // (patrz machines.js), więc ile stopu/kryształu wyprodukujesz na minutę jest
  // twardo ograniczone, a odłamków - tylko tym, jak szybko biegasz. Efekt: po
  // odblokowaniu Strefy D nie było ŻADNEGO powodu, żeby jeszcze kiedykolwiek
  // użyć Pieca czy Oczyszczalni - cała pętla produkcyjna gry stawała się
  // martwa.
  //
  // Teraz 30: WYŻEJ niż stop (26 - Grań ma się opłacać, to nagroda za pełne
  // wyposażenie i najdalszą wyprawę), ale NIŻEJ niż kryształ z Oczyszczalni
  // (40 - łańcuch produkcyjny zostaje najbardziej dochodowy). Realna przewaga
  // odłamka to brak kursów do maszyn, nie cena za sztukę.
  crystal_shard: 30
};

// Emoji do wyświetlenia na terminalu (czysto kosmetyczne, niezależne od
// ITEM_TYPES w items.js - TradingPost tylko WYŚWIETLA te ikony, nie
// spawnuje niczego).
const MARKET_ICONS = {
  plastic: '♻️',
  product: '🎁',
  alloy: '🧱',
  crystal: '🔮',
  crystal_shard: '💠'
};

class MarketManager {
  constructor() {
    this.multipliers = {};
    this.trends = {}; // 'up' | 'down' | 'flat'
    this._phase = {};
    this._timer = 0;

    Object.keys(MARKET_BASE_PRICES).forEach((id) => {
      this.multipliers[id] = 1;
      this.trends[id] = 'flat';
      // Losowy start fazy dla każdego surowca, żeby nie zmieniały się
      // wszystkie idealnie w tym samym rytmie (mniej mechaniczne wrażenie).
      this._phase[id] = Math.random() * Math.PI * 2;
    });
  }

  update(delta) {
    this._timer += delta;
    if (this._timer < MARKET_UPDATE_INTERVAL_MS) return;
    this._timer = 0;

    const mid = (MARKET_MAX_MULTIPLIER + MARKET_MIN_MULTIPLIER) / 2;
    const range = (MARKET_MAX_MULTIPLIER - MARKET_MIN_MULTIPLIER) / 2;

    Object.keys(MARKET_BASE_PRICES).forEach((id) => {
      const prev = this.multipliers[id];

      // Faza posuwa się o losowy krok - fala sinus daje płynne "trendy"
      // (kilka ticków pod rząd w tym samym kierunku), a szum na wierzchu
      // psuje idealną przewidywalność.
      this._phase[id] += 0.6 + Math.random() * 0.5;
      const wave = Math.sin(this._phase[id]);
      const noise = (Math.random() - 0.5) * 0.35;
      const next = Math.max(
        MARKET_MIN_MULTIPLIER,
        Math.min(MARKET_MAX_MULTIPLIER, mid + wave * range + noise * range)
      );

      this.multipliers[id] = next;
      const diff = next - prev;
      this.trends[id] = diff > MARKET_TREND_THRESHOLD ? 'up' : diff < -MARKET_TREND_THRESHOLD ? 'down' : 'flat';
    });

    Bus.publish(Events.MARKET_UPDATED, { prices: this.getAllPrices() });
  }

  /** Aktualna cena jednostkowa (zaokrąglona do pełnych monet), albo null dla
   * nieznanego typu.
   *
   * Uwzględnia trwałe ulepszenie "Kontrakty Handlowe" (Rdzenie, core_prices w
   * economy.js). CELOWO liczone tutaj, a nie przy samej sprzedaży: getPrice()
   * jest jedynym źródłem ceny w grze - karmi zarówno realną wypłatę
   * (_sellOne), jak i cennik pokazywany na terminalu (getListing) - więc
   * gracz widzi DOKŁADNIE tę cenę, którą dostanie. Doliczenie bonusu dopiero
   * przy wypłacie rozjechałoby te dwie liczby. */
  getPrice(typeId) {
    const base = MARKET_BASE_PRICES[typeId];
    if (base === undefined) return null;
    const eco = window.economyManager;
    const coreMult = (eco && typeof eco.getMarketPriceMultiplier === 'function')
      ? eco.getMarketPriceMultiplier()
      : 1;
    // Modyfikator planety (patrz PLANET_MODIFIERS w economy.js) - MNOŻY się z
    // coreMult wyżej, nie zastępuje go.
    const planetMult = (eco && typeof eco.getPlanetPriceMultiplier === 'function')
      ? eco.getPlanetPriceMultiplier()
      : 1;
    return Math.max(1, Math.round(base * this.multipliers[typeId] * coreMult * planetMult));
  }

  getTrend(typeId) {
    return this.trends[typeId] || 'flat';
  }

  getAllPrices() {
    return Object.keys(MARKET_BASE_PRICES).map((typeId) => ({
      typeId,
      icon: MARKET_ICONS[typeId] || '❓',
      price: this.getPrice(typeId),
      trend: this.getTrend(typeId)
    }));
  }
}

// ============================================================================
// TradingPost - fizyczny punkt sprzedaży na mapie
// ============================================================================

// --- Świat (Faza 2b: mapa większa niż ekran) --------------------------------
// Te same wartości co w game.js/player.js/items.js/machines.js.
const MARKET_WORLD_WIDTH = 1400;
const MARKET_WORLD_HEIGHT = 2000;

// SKALA vs CZYTELNOŚĆ: próba zejścia do 160 (żeby terminal nie był dwa razy
// większy od maszyn) zepsuła czytelność - wysokość wiersza to screenH/5, więc
// przy mniejszym korpusie font schodził do ~6 px i cennika po prostu nie dało
// się odczytać. Terminal MUSI pomieścić 5 czytelnych wierszy z ceną, więc to
// on wyznacza swój minimalny rozmiar, nie odwrotnie. Wracamy do 200 i
// zamiast kurczyć bryłę, dopasowujemy proporcje wnętrza (patrz draw():
// większy udział ekranu + minimalne rozmiary fontu).
const TRADING_POST_SIZE = 200;
const TRADING_POST_DROP_RADIUS = 80;
// Dolne ograniczniki czytelności cennika - wysokość wiersza to screenH/5,
// więc bez nich rozmiar tekstu/ikon zależy wprost od wielkości korpusu i
// przy każdym jego zmniejszeniu cennik robi się nieczytelny (tak właśnie
// zepsuło się przy próbie zejścia z 200 na 160).
const TRADING_POST_MIN_FONT = 13;
const TRADING_POST_MIN_ICON = 20;
// Ten sam rytm co MACHINE_UNLOAD_INTERVAL_MS w machines.js - jedna sprzedaż
// na tyle ms, dopóki gracz stoi w zasięgu i ma coś do sprzedania.
const TRADING_POST_SELL_INTERVAL_MS = 150;
const TRADING_POST_ACCEPTS = ['plastic', 'product', 'alloy', 'crystal', 'crystal_shard'];

class TradingPost {
  constructor(canvas, marketManager) {
    this.canvas = canvas;
    this.market = marketManager;
    this.acceptsType = TRADING_POST_ACCEPTS;

    this.xRatio = 0.5;
    this.yRatio = 0.85;
    this.x = MARKET_WORLD_WIDTH * this.xRatio;
    this.y = MARKET_WORLD_HEIGHT * this.yRatio;
    this.w = TRADING_POST_SIZE;
    // 0.85 zamiast 0.75 - to tablica z pięcioma cenami, więc potrzebuje
    // wysokości, nie szerokości. Przy 0.75 na wiersz zostawało ~20 px, czyli
    // dokładnie tyle, ile minimalna ikona - bez zapasu na tekst.
    this.h = TRADING_POST_SIZE * 0.85;

    this.playerX = 0;
    this.playerY = 0;
    this.inRange = false;
    this._sellTimer = 0;
    this._lastSaleFlash = 0; // do lekkiego "pulsu" ekranu terminala po sprzedaży

    this._onPlayerMoved = (d) => {
      this.playerX = d.x;
      this.playerY = d.y;
    };
    // Uwaga: brak nasłuchiwania Events.RESIZE celowo - pozycja terminala jest
    // teraz stała względem świata, nie widoku, patrz machines.js (ten sam wzorzec).
    Bus.subscribe(Events.PLAYER_MOVED, this._onPlayerMoved);
  }

  _getDist() {
    const dx = this.playerX - this.x;
    const dy = this.playerY - this.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  update(delta) {
    this.inRange = this._getDist() < TRADING_POST_DROP_RADIUS;
    this._lastSaleFlash = Math.max(0, this._lastSaleFlash - delta);

    const stack = window.stackController;
    if (!this.inRange || !stack || stack.isEmpty()) {
      this._sellTimer = 0;
      return;
    }

    this._sellTimer += delta;
    if (this._sellTimer < TRADING_POST_SELL_INTERVAL_MS) return;
    this._sellTimer = 0;

    const idx = stack.findIndex((item) => this.acceptsType.includes(item.typeId));
    if (idx === -1) return;

    const item = stack.removeAt(idx);
    if (!item) return;

    const price = this.market.getPrice(item.typeId);
    if (price === null) return;

    if (window.economyManager) {
      window.economyManager.sellItem(item.typeId, price, this.x, this.y - this.h / 2);
    }
    Bus.publish(Events.FX_PARTICLES, { x: this.x, y: this.y, color: '#FFD54F', count: 5 });
    this._lastSaleFlash = 220;
  }

  draw(ctxBg, ctx, ctxUI) {
    const hw = this.w / 2;
    const hh = this.h / 2;

    // Strefa zasięgu (ten sam język wizualny co maszyny w machines.js).
    ctx.strokeStyle = this.inRange ? 'rgba(255, 255, 255, 0.6)' : 'rgba(255, 255, 255, 0.2)';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.arc(this.x, this.y, TRADING_POST_DROP_RADIUS, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // Nogi + skrzynki towaru - PRZED cieniem/korpusem, w świecie (nie w
    // przechylonej/przesuniętej grupie), żeby zawsze stały prosto na ziemi -
    // ten sam wzorzec co _drawStruts w ship.js.
    this._drawLegs(ctx, hw, hh);
    this._drawGoodsCrates(ctx, hw, hh);

    // Cień korpusu.
    ctx.fillStyle = 'rgba(0, 0, 0, 0.22)';
    ctx.beginPath();
    ctx.ellipse(this.x, this.y + hh + 4, hw * 0.85, hh * 0.2, 0, 0, Math.PI * 2);
    ctx.fill();

    // Korpus terminala - pionowy gradient (jaśniejsza góra) zamiast płaskiego
    // koloru, żeby czytał się jako bryła, ten sam zabieg co MachineManager.
    // shadowBlur usunięty (patrz ten sam BUGFIX w items.js) - jedna z
    // najdroższych operacji Canvas, tu rysowana co klatkę bez powodu (terminal
    // ma już cień-elipsę poniżej, patrz wyżej).
    ctx.save();
    // SPÓJNOŚĆ: było #37474F / #2B353A - prawie czerń, przez co terminal
    // czytał się jak panel interfejsu położony na mapie, a nie jak obiekt z
    // tego samego świata co maszyny. Sprite'y maszyn stoją na wyraźnych,
    // przygaszonych barwach (zieleń/błękit/czerwień), więc stragan dostaje
    // ciepłe drewno - inny materiał niż metal maszyn (bo to nie maszyna),
    // ale ta sama jasność i nasycenie.
    const baseColor = this.inRange ? '#8A6244' : '#7A5539';
    const bodyGrad = ctx.createLinearGradient(this.x, this.y - hh, this.x, this.y + hh);
    bodyGrad.addColorStop(0, this._lighten(baseColor, 22));
    bodyGrad.addColorStop(0.55, baseColor);
    bodyGrad.addColorStop(1, this._lighten(baseColor, -18));
    ctx.fillStyle = bodyGrad;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.lineWidth = 2;
    this._traceRoundedRect(ctx, this.x - hw, this.y - hh, this.w, this.h, 12);
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // Cienka listwa dekoracyjna tuż pod górną krawędzią korpusu - drobny
    // przemysłowy detal, ten sam duch co żeberka wentylacyjne w machines.js.
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(this.x - hw + 8, this.y - hh + 10);
    ctx.lineTo(this.x + hw - 8, this.y - hh + 10);
    ctx.stroke();

    // Ekran - lekki puls (jaśniejszy) na chwilę po sprzedaży, teraz z
    // wyraźną ramką/bezelem, żeby czytał się jako WYŚWIETLACZ, nie
    // po prostu drugi kolorowy prostokąt na pierwszym.
    const screenPad = 12;
    const screenX = this.x - hw + screenPad;
    const screenY = this.y - hh + screenPad;
    const screenW = this.w - screenPad * 2;
    const screenH = this.h - screenPad * 2 - 22;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    this._traceRoundedRect(ctx, screenX - 3, screenY - 3, screenW + 6, screenH + 6, 8);
    ctx.fill();
    const flashT = this._lastSaleFlash / 220;
    ctx.fillStyle = `rgba(${Math.round(20 + 40 * flashT)}, ${Math.round(60 + 80 * flashT)}, ${Math.round(50 + 40 * flashT)}, 0.95)`;
    this._traceRoundedRect(ctx, screenX, screenY, screenW, screenH, 6);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 1;
    this._traceRoundedRect(ctx, screenX, screenY, screenW, screenH, 6);
    ctx.stroke();

    // Mała dioda "zasilania" w rogu ekranu - żywszy detal, pulsuje wolno
    // niezależnie od sprzedaży.
    const ledPulse = 0.5 + 0.5 * Math.sin(performance.now() / 500);
    ctx.save();
    ctx.globalAlpha = 0.5 + 0.5 * ledPulse;
    ctx.fillStyle = '#69F0AE';
    ctx.beginPath();
    ctx.arc(screenX + screenW - 8, screenY + 8, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Wiersze cen: prawdziwa grafika przedmiotu (sprite/ingot zamiast emoji -
    // ItemRenderer._drawSpriteOrLabel, items.js), cena, strzałka trendu.
    const rows = this.market.getAllPrices();
    const rowH = screenH / rows.length;
    ctx.textBaseline = 'middle';
    rows.forEach((row, i) => {
      const rowY = screenY + rowH * i + rowH / 2;
      // Ikona też z dolnym ogranicznikiem - przy rowH ~15 px wychodziło
      // 10 px, czyli plamka bez rozpoznawalnego kształtu surowca.
      const iconSize = Math.max(TRADING_POST_MIN_ICON, rowH * 0.8);
      const iconX = screenX + 8 + iconSize / 2;

      if (typeof ItemRenderer !== 'undefined') {
        ItemRenderer._drawSpriteOrLabel(ctx, row.typeId, row.icon, iconX, rowY, iconSize);
      } else {
        ctx.textAlign = 'left';
        ctx.font = `${Math.floor(rowH * 0.55)}px Arial`;
        ctx.fillStyle = '#E8F5E9';
        ctx.fillText(row.icon, screenX + 6, rowY);
      }

      // CZYTELNOŚĆ: było rowH*0.4 bez dolnego ogranicznika - przy 5 wierszach
      // dawało to ~8 px, a po chwilowym zmniejszeniu korpusu ~6 px, czyli
      // cennika nie dało się odczytać (a to główna informacja, po którą gracz
      // tu przychodzi). Większy udział wysokości wiersza + twardy minimum.
      ctx.font = `bold ${Math.max(TRADING_POST_MIN_FONT, Math.floor(rowH * 0.62))}px Arial`;
      ctx.fillStyle = '#FFD54F';
      ctx.textAlign = 'left';
      // Cena zaraz za ikoną - odstęp liczony z FAKTYCZNEJ szerokości ikony,
      // nie z rowH: odkąd ikona ma własny minimalny rozmiar, rowH przestał
      // być wiarygodną miarą tego, gdzie ikona się kończy (tekst potrafił na
      // nią nachodzić).
      ctx.fillText(`$${row.price}`, iconX + iconSize * 0.62, rowY);

      const arrow = row.trend === 'up' ? '▲' : row.trend === 'down' ? '▼' : '►';
      ctx.fillStyle = row.trend === 'up' ? '#66BB6A' : row.trend === 'down' ? '#EF5350' : 'rgba(255,255,255,0.4)';
      ctx.textAlign = 'right';
      ctx.fillText(arrow, screenX + screenW - 6, rowY);
    });

    // Markiza (daszek) NAD korpusem - główny element, który wypełnia pustkę
    // nad terminalem i najmocniej sygnalizuje "stoisko handlowe" na pierwszy
    // rzut oka, zanim gracz w ogóle przeczyta etykietę.
    this._drawAwning(ctx, hw, hh);

    // Etykieta + status. BUGFIX: dawniej stały ciemny/na wpół przezroczysty
    // fillStyle - czytelny na trawie, ale ginący na ciemnym popiele/bagnie
    // (patrz _drawOutlinedText, ten sam wzorzec co MachineManager w
    // machines.js). Terminal stoi w Strefie A, ale gracz może podejść do
    // niego od strony innego biomu, więc kontrast musi działać wszędzie.
    ctx.font = 'bold 11px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    this._drawOutlinedText(ctx, 'Terminal Handlowy', this.x, this.y - hh - 42, '#FFFFFF');

    if (this.inRange) {
      const stack = window.stackController;
      const hasSellable = stack && !stack.isEmpty() && stack.find((item) => this.acceptsType.includes(item.typeId));
      const statusColor = hasSellable ? '#A5D6A7' : 'rgba(255, 255, 255, 0.75)';
      ctx.font = '10px Arial';
      this._drawOutlinedText(ctx, hasSellable ? 'Sprzedaję...' : 'Brak towaru do sprzedania', this.x, this.y - hh - 56, statusColor);
    }
  }

  /**
   * Dwie nogi lądownicze/wsporcze - rysowane w ŚWIECIE (przed jakąkolwiek
   * translacją korpusu), więc zawsze stoją prosto, ten sam wzorzec co
   * Ship._drawStruts (ship.js).
   */
  _drawLegs(ctx, hw, hh) {
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.strokeStyle = 'rgba(20, 24, 27, 0.9)';
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    [-0.55, 0.55].forEach((t) => {
      ctx.beginPath();
      ctx.moveTo(t * hw * 0.85, hh * 0.55);
      ctx.lineTo(t * hw * 1.05, hh + 10);
      ctx.stroke();
    });
    ctx.restore();
  }

  /**
   * Trzy małe skrzynki/worki towaru obok terminala - kolory nawiązują do
   * sprzedawanych surowców (plastik/produkt/stop), czysto dekoracyjne
   * (nie wpływają na sprzedaż), ale wypełniają pustą przestrzeń u podstawy
   * i wzmacniają wrażenie "tu się handluje", zanim gracz w ogóle podejdzie
   * blisko.
   */
  _drawGoodsCrates(ctx, hw, hh) {
    ctx.save();
    ctx.translate(this.x, this.y);
    const crates = [
      { dx: -hw * 1.2, dy: hh * 0.5, size: 20, color: '#42A5F5' },
      { dx: -hw * 0.92, dy: hh * 0.78, size: 15, color: '#AB47BC' },
      { dx: hw * 1.15, dy: hh * 0.55, size: 18, color: '#D4A574' }
    ];
    crates.forEach((c) => {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.2)';
      ctx.beginPath();
      ctx.ellipse(c.dx, c.dy + c.size * 0.42, c.size * 0.55, c.size * 0.16, 0, 0, Math.PI * 2);
      ctx.fill();

      const grad = ctx.createLinearGradient(c.dx, c.dy - c.size / 2, c.dx, c.dy + c.size / 2);
      grad.addColorStop(0, this._lighten(c.color, 30));
      grad.addColorStop(1, this._lighten(c.color, -25));
      ctx.fillStyle = grad;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.lineWidth = 1.5;
      this._traceRoundedRect(ctx, c.dx - c.size / 2, c.dy - c.size / 2, c.size, c.size, 3);
      ctx.fill();
      ctx.stroke();
    });
    ctx.restore();
  }

  /**
   * Pasiasta markiza nad korpusem, z zębatym (postrzępionym) dolnym
   * brzegiem - klasyczny wizualny skrót dla "stoiska handlowego", dużo
   * czytelniejszy z daleka niż sam ciemny korpus. Dwie rozpórki łączą ją
   * wizualnie z korpusem, żeby nie wyglądała jak oddzielny, unoszący się
   * obiekt.
   */
  _drawAwning(ctx, hw, hh) {
    const roofW = hw * 2.2;
    const roofH = 26;
    const roofY = this.y - hh - roofH - 8;
    const roofTop = this.x - roofW / 2;
    const stripeCount = 8;
    const stripeW = roofW / stripeCount;
    const scallopH = 9;

    ctx.save();

    // Rozpórki łączące markizę z korpusem.
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(this.x - hw * 0.65, this.y - hh);
    ctx.lineTo(roofTop + 6, roofY + roofH);
    ctx.moveTo(this.x + hw * 0.65, this.y - hh);
    ctx.lineTo(roofTop + roofW - 6, roofY + roofH);
    ctx.stroke();

    // Pasy markizy + zębaty dół każdego pasa.
    // SPÓJNOŚĆ: było #FFB300 / #37474F - jaskrawy żółty na prawie czarnym,
    // czyli najwyższy kontrast w całej grze (czytało się jak taśma
    // ostrzegawcza BHP, nie jak markiza straganu). Trzy sprite'y maszyn
    // (assets/machines/*.png) trzymają się przygaszonych, płaskich barw bez
    // czerni - stragan dostaje więc ciepłą czerwień i kość słoniową, ten sam
    // klasyczny duet markizy, ale w tej samej rodzinie tonalnej co reszta.
    for (let i = 0; i < stripeCount; i++) {
      const sx = roofTop + i * stripeW;
      ctx.fillStyle = i % 2 === 0 ? '#D9614F' : '#F2E6D0';
      ctx.fillRect(sx, roofY, stripeW, roofH);
      ctx.beginPath();
      ctx.moveTo(sx, roofY + roofH);
      ctx.lineTo(sx + stripeW / 2, roofY + roofH + scallopH);
      ctx.lineTo(sx + stripeW, roofY + roofH);
      ctx.closePath();
      ctx.fill();
    }

    // Górna obwódka + cień pod spodem, żeby markiza "siedziała" na korpusie.
    // Obwódka w kolorze ciepłego drewna zamiast białej - biel na jasnej
    // kości słoniowej i tak jest niewidoczna, a na czerwieni odcinała się
    // ostrzej niż cokolwiek na sprite'ach maszyn.
    ctx.strokeStyle = 'rgba(120, 82, 60, 0.55)';
    ctx.lineWidth = 2;
    ctx.strokeRect(roofTop, roofY, roofW, roofH);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.2)';
    ctx.fillRect(roofTop, roofY + roofH, roofW, 3);

    ctx.restore();
  }

  /** Ten sam wzorzec co MachineManager._lighten (machines.js) - proste
   * rozjaśnianie/przyciemnianie koloru hex bez konwersji do HSL. */
  _lighten(hex, amount) {
    const num = parseInt(String(hex).replace('#', ''), 16);
    const r = Math.max(0, Math.min(255, (num >> 16) + amount));
    const g = Math.max(0, Math.min(255, ((num >> 8) & 0xFF) + amount));
    const b = Math.max(0, Math.min(255, (num & 0xFF) + amount));
    return `rgb(${r}, ${g}, ${b})`;
  }

  /** Ten sam wzorzec co MachineManager._drawOutlinedText (machines.js) -
   * ciemna obwódka pod jasnym/kolorowym wypełnieniem, czytelne na każdym
   * biomie. Oczekuje, że wywołujący ustawił już ctx.font/textAlign/textBaseline. */
  _drawOutlinedText(ctx, text, x, y, fillColor) {
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = fillColor;
    ctx.fillText(text, x, y);
  }

  /** Ten sam fallback co MachineManager._traceRoundedRect (machines.js). */
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

  destroy() {
    Bus.unsubscribe(Events.PLAYER_MOVED, this._onPlayerMoved);
  }
}

window.MarketManager = MarketManager;
window.TradingPost = TradingPost;