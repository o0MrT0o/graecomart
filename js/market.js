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
  crystal_shard: 30,
  // 'crystal_gem' (Szlifiernia Kryształów - machines.js: crystal_shard ->
  // crystal_gem) - NAJDROŻSZY towar w grze. Odłamek sam w sobie NIE wymaga
  // przetwarzania (patrz komentarz wyżej), więc żeby Szlifiernia miała sens
  // obok bezpośredniej sprzedaży, jej wyjście musi przebić 30 na tyle, żeby
  // zrekompensować czekanie na najdłuższy cykl w grze (4500ms, machines.js)
  // i maxInventory:2. 70 = ponad dwukrotność ceny wsadu za sztukę.
  crystal_gem: 70
};

// Emoji do wyświetlenia na terminalu (czysto kosmetyczne, niezależne od
// ITEM_TYPES w items.js - TradingPost tylko WYŚWIETLA te ikony, nie
// spawnuje niczego).
// Wartości puste - BYŁY emoji (patrz komentarz przy ITEM_TYPES.label w
// items.js). ItemRenderer._drawSpriteOrLabel (jedyny faktyczny konsument
// tego pola) rysuje sprite/proceduralną bryłę/neutralną plakietkę, nigdy
// tekstu, więc te wartości i tak nigdy się nie renderują.
const MARKET_ICONS = {
  plastic: '',
  product: '',
  alloy: '',
  crystal: '',
  crystal_shard: '',
  crystal_gem: ''
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
      icon: MARKET_ICONS[typeId] || '',
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
const TRADING_POST_ACCEPTS = ['plastic', 'product', 'alloy', 'crystal', 'crystal_shard', 'crystal_gem'];

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

  /**
   * Viewport culling (ten sam wzorzec co items.js/machines.js) - jedna
   * instancja, ale rysowanie (nogi, kanistry, sprite korpusu, antena)
   * kosztuje niezależnie od tego ile ich jest, więc szkoda płacić za nią
   * na każdej klatce, gdy gracz jest na drugim końcu mapy. update() (ceny,
   * timer sprzedaży) działa zawsze, niezależnie od widoczności.
   */
  draw(ctxBg, ctx, ctxUI) {
    const camX = window.game ? window.game.cameraX : 0;
    const camY = window.game ? window.game.cameraY : 0;
    const viewW = window.innerWidth;
    const viewH = window.innerHeight;
    const margin = 150;
    if (this.x < camX - margin || this.x > camX + viewW + margin) return;
    if (this.y < camY - margin || this.y > camY + viewH + margin) return;

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

    // Korpus terminala - Tomek: "ma to wyglądać jakby to był jakiś fragment
    // technologii z statku, a nie jakiś targ na obcej planecie". BYŁ
    // procedural rounded-rect z ciepłym drewnianym gradientem (patrz stara
    // wersja w historii) - jedyny większy obiekt w grze BEZ prawdziwej bryły
    // Kenney, podczas gdy wszystkie 5 maszyn i Rozbity Statek dawno dostały
    // tę technikę. Teraz PRAWDZIWA bryła (spaceStation_030, ta sama paczka
    // "Space Shooter Extension" co maszyny) - już natywnie szaro-błękitny
    // metal z jasnym "ekranem" u góry, więc BEZ obrotu odcienia (hueDeg:0,
    // czysty przebieg funkcji przez HSL i z powrotem - matematyczny no-op na
    // samym kolorze), tylko lekki zielonkawy overlayTint spójny z diodą
    // zasilania (#69F0AE, patrz niżej) - subtelnie mocniejszy w zasięgu
    // (0.22 vs 0.12), ten sam duch co dawne jaśniejsze baseColor.inRange.
    const terminalTintAlpha = this.inRange ? 0.22 : 0.12;
    const terminalSprite = this._getRecoloredSprite('machine_sci_terminal', 0, 1, 0.08, ['#69F0AE', terminalTintAlpha]);
    if (terminalSprite) {
      ctx.drawImage(terminalSprite, this.x - hw, this.y - hh, this.w, this.h);
    } else {
      // Fallback (sprite jeszcze niewczytany) - płaski panel zamiast pustego
      // miejsca, w tonacji docelowego metalu (nie dawnego drewna).
      ctx.fillStyle = this.inRange ? '#5C7A82' : '#4A6068';
      this._traceRoundedRect(ctx, this.x - hw, this.y - hh, this.w, this.h, 12);
      ctx.fill();
    }

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
      const priceFontSize = Math.max(TRADING_POST_MIN_FONT, Math.floor(rowH * 0.62));
      ctx.font = `bold ${priceFontSize}px Arial`;
      ctx.fillStyle = '#FFD54F';
      ctx.textAlign = 'left';
      // Cena zaraz za ikoną - odstęp liczony z FAKTYCZNEJ szerokości ikony,
      // nie z rowH: odkąd ikona ma własny minimalny rozmiar, rowH przestał
      // być wiarygodną miarą tego, gdzie ikona się kończy (tekst potrafił na
      // nią nachodzić). Sześciokątny czip (_drawCreditGlyph) zamiast "$" -
      // rysowany PRZED liczbą, tekst przesunięty o jego szerokość + odstęp.
      const priceX = iconX + iconSize * 0.62;
      const glyphR = priceFontSize * 0.34;
      this._drawCreditGlyph(ctx, priceX + glyphR, rowY, glyphR, '#FFD54F');
      ctx.fillText(`${row.price}`, priceX + glyphR * 2 + 4, rowY);

      // BYŁ Unicode glif (▲/▼/►) rysowany fillText'em - teraz prawdziwa
      // sylwetka Kenney (trend_up/trend_down/trend_flat, patrz sprites.js),
      // tonowana na ten sam kolor co dawniej. Fallback na stary glif, gdyby
      // sprite jeszcze się nie wczytał (ten sam duch co reszta tinted-sprite
      // helperów w projekcie).
      const trendKey = row.trend === 'up' ? 'trend_up' : row.trend === 'down' ? 'trend_down' : 'trend_flat';
      const trendColor = row.trend === 'up' ? '#66BB6A' : row.trend === 'down' ? '#EF5350' : 'rgba(255,255,255,0.4)';
      const arrowImg = this._getTintedTrendArrow(trendKey, trendColor);
      if (arrowImg) {
        const arrowSize = priceFontSize * 0.85;
        ctx.drawImage(arrowImg, screenX + screenW - 6 - arrowSize, rowY - arrowSize / 2, arrowSize, arrowSize);
      } else {
        const arrow = row.trend === 'up' ? '▲' : row.trend === 'down' ? '▼' : '►';
        ctx.fillStyle = trendColor;
        ctx.textAlign = 'right';
        ctx.fillText(arrow, screenX + screenW - 6, rowY);
      }
    });

    // Antena łącznościowa NAD korpusem - zajmuje więcej pionowej przestrzeni
    // niż dawna płaska markiza (58px maszt vs 26+9px pasy), więc etykieta
    // niżej przesunięta wyżej (42->60/56->74), żeby maszt jej nie zasłaniał.
    this._drawAntenna(ctx, hw, hh);

    // Etykieta + status. BUGFIX: dawniej stały ciemny/na wpół przezroczysty
    // fillStyle - czytelny na trawie, ale ginący na ciemnym popiele/bagnie
    // (patrz _drawOutlinedText, ten sam wzorzec co MachineManager w
    // machines.js). Terminal stoi w Strefie A, ale gracz może podejść do
    // niego od strony innego biomu, więc kontrast musi działać wszędzie.
    ctx.font = 'bold 11px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    this._drawOutlinedText(ctx, 'Terminal Handlowy', this.x, this.y - hh - 60, '#FFFFFF');

    if (this.inRange) {
      const stack = window.stackController;
      const hasSellable = stack && !stack.isEmpty() && stack.find((item) => this.acceptsType.includes(item.typeId));
      const statusColor = hasSellable ? '#A5D6A7' : 'rgba(255, 255, 255, 0.75)';
      ctx.font = '10px Arial';
      this._drawOutlinedText(ctx, hasSellable ? 'Sprzedaję...' : 'Brak towaru do sprzedania', this.x, this.y - hh - 74, statusColor);
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
   * Trzy małe kanistry/pojemniki ładunku obok terminala - czysto dekoracyjne
   * (nie wpływają na sprzedaż), wypełniają pustą przestrzeń u podstawy.
   * BYŁY jednolicie kolorowe skrzynki (niebieska/fioletowa/piaskowa) -
   * czytały się jak skrzynki z bazaru. Teraz neutralny metalowy korpus (ten
   * sam gunmetal co fallback korpusu terminala) + kolorowy pasek "typu
   * ładunku" u góry - to samo rozróżnienie kolorem co dawniej, ale w formie
   * przemysłowego oznaczenia kanistra, nie pomalowanej na całość skrzynki.
   */
  _drawGoodsCrates(ctx, hw, hh) {
    ctx.save();
    ctx.translate(this.x, this.y);
    const crates = [
      { dx: -hw * 1.2, dy: hh * 0.5, size: 20, accent: '#4FC3F7' },
      { dx: -hw * 0.92, dy: hh * 0.78, size: 15, accent: '#BA68C8' },
      { dx: hw * 1.15, dy: hh * 0.55, size: 18, accent: '#FFB74D' }
    ];
    crates.forEach((c) => {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.2)';
      ctx.beginPath();
      ctx.ellipse(c.dx, c.dy + c.size * 0.42, c.size * 0.55, c.size * 0.16, 0, 0, Math.PI * 2);
      ctx.fill();

      const bodyColor = '#54666E';
      const grad = ctx.createLinearGradient(c.dx, c.dy - c.size / 2, c.dx, c.dy + c.size / 2);
      grad.addColorStop(0, this._lighten(bodyColor, 26));
      grad.addColorStop(1, this._lighten(bodyColor, -22));
      ctx.fillStyle = grad;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
      ctx.lineWidth = 1.5;
      this._traceRoundedRect(ctx, c.dx - c.size / 2, c.dy - c.size / 2, c.size, c.size, 3);
      ctx.fill();
      ctx.stroke();

      // Pasek typu ładunku - wąski, u góry kanistra, kolor przejęty z
      // dawnej skrzynki (rozróżnienie zostaje, tylko mniej dominujące).
      const bandH = c.size * 0.24;
      ctx.fillStyle = c.accent;
      ctx.fillRect(c.dx - c.size / 2 + 1.5, c.dy - c.size / 2 + 1.5, c.size - 3, bandH);
    });
    ctx.restore();
  }

  /**
   * Antena łącznościowa nad korpusem - ZASTĘPUJE dawną pasiastą markizę
   * straganu (Tomek: "ma wyglądać jak fragment technologii z statku").
   * Prawdziwa bryła Kenney (sci_antenna, spaceStation_020 - smukły maszt z
   * kopułą), wypełnia dokładnie tę samą pustą przestrzeń nad korpusem, którą
   * wcześniej zajmowała markiza, ale czyta się jako sprzęt, nie tkanina.
   * Mały pulsujący sygnał na szczycie masztu - ten sam duch co dioda
   * zasilania ekranu niżej (draw()), osobna kopia zgodnie z konwencją
   * projektu (nie da się dzielić lokalnej zmiennej ledPulse między metodami).
   */
  _drawAntenna(ctx, hw, hh) {
    const antennaH = 58;
    const antennaW = antennaH * (248 / 694); // proporcje natywne sci_antenna.png
    const antennaX = this.x - antennaW / 2;
    const antennaY = this.y - hh - antennaH + 5; // lekkie zachodzenie na korpus - "przykręcona", nie unosząca się

    const sprite = this._getRecoloredSprite('machine_sci_antenna', 0, 1, 0.08, ['#69F0AE', this.inRange ? 0.2 : 0.1]);
    ctx.save();
    if (sprite) {
      ctx.drawImage(sprite, antennaX, antennaY, antennaW, antennaH);
    } else {
      // Fallback - prosty maszt, żeby korpus nigdy nie został kompletnie goły.
      ctx.strokeStyle = 'rgba(180, 195, 200, 0.8)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(this.x, this.y - hh + 5);
      ctx.lineTo(this.x, antennaY);
      ctx.stroke();
    }

    // Pulsujący sygnał na szczycie masztu (niezależna faza od diody ekranu).
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 420);
    ctx.globalAlpha = 0.5 + 0.5 * pulse;
    ctx.fillStyle = '#69F0AE';
    ctx.beginPath();
    ctx.arc(this.x, antennaY + antennaH * 0.06, 2.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /**
   * Przekolorowuje PRAWDZIWY sprite Kenney (korpus/antena terminala) obracając
   * odcień piksel po pikselu w HSL, z opcjonalnym overlayTint ('source-atop')
   * nałożonym na wierzch - DOKŁADNA kopia MachineManager._getRecoloredSprite
   * (machines.js), zgodnie z konwencją "brak współdzielonych utili". Cache'
   * owana per (spriteKey, hueDeg, satMult, minSat, overlayTint).
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

  /**
   * Symbol głównej waluty na canvasie (cennik targu) - sześciokątny "czip
   * energetyczny" z wydrążonym środkiem, ten sam kształt co CREDIT_ICON_SVG
   * (ui.js/economy.js), tylko rysowany proceduralnie zamiast jako SVG w
   * DOM - to czysty canvas, więc nie da się tu wstawić gotowego znacznika.
   * fill('evenodd') (dwa subpath'y: sześciokąt + okrąg) wypala dziurę na
   * środku, zamiast rysować pełną plamę.
   */
  _drawCreditGlyph(ctx, cx, cy, radius, color) {
    const holeR = radius * (2.2 / 9);
    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI / 3) * i;
      const x = cx + radius * Math.cos(angle);
      const y = cy + radius * Math.sin(angle);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.moveTo(cx + holeR, cy);
    ctx.arc(cx, cy, holeR, 0, Math.PI * 2, true);
    ctx.closePath();
    ctx.fill('evenodd');
    ctx.restore();
  }

  /**
   * Tonuje prawdziwą strzałkę trendu (trend_up/trend_down/trend_flat,
   * Kenney "Game Icons" CC0 - patrz sprites.js) na dowolny kolor, tą samą
   * techniką "source-atop" co Game._getTintedCrystalGlow (game.js) i
   * GameFeel._getTintedGlow (gamefeel.js) - własna kopia zgodnie z
   * konwencją "brak współdzielonych utili". Cache'owana per klucz+kolor
   * (trzy strzałki x dwa kolory realnie występujące - up=zielony,
   * down=czerwony - to najwyżej kilka wpisów, nie eksploduje).
   */
  _getTintedTrendArrow(key, color) {
    this._trendArrowCache = this._trendArrowCache || {};
    const cacheKey = `${key}|${color}`;
    if (this._trendArrowCache[cacheKey]) return this._trendArrowCache[cacheKey];
    const img = window.spriteLoader && window.spriteLoader.get(key);
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
    this._trendArrowCache[cacheKey] = canvas;
    return canvas;
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