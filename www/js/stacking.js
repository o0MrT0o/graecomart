'use strict';

/**
 * stacking.js
 * ------------------------------------------------------------------------
 * System zbierania przedmiotów "na plecach" gracza (mechanika stack-em-up).
 * Przedmiot dodany przez addItem() leci (animacja easeOutCubic) z miejsca
 * podniesienia do pozycji nad głową gracza, a po dotarciu na miejsce zaczyna
 * kiwać się proceduralnie w rytm ruchu / bezwładności gracza.
 *
 * Wizualnie stos ma tę samą miękką, kolorową poświatę pod przedmiotami co
 * ItemManager (items.js, Krok 8) - dla spójności, żeby przedmiot nie tracił
 * "swiecenia" w momencie wskoczenia na stos.
 *
 * StackController NIE zna ItemManager ani MachineManager - komunikuje się
 * wyłącznie przez Bus/Events. Inne moduły (items.js, machines.js) korzystają
 * z instancji przez window.stackController i jej publicznego API:
 *   isFull() / isEmpty() / addItem(item) / removeItem() / peekItem()
 *
 * Zależności globalne (muszą być załadowane przed tym plikiem):
 *   - window.Bus     (EventBus: subscribe(name, cb) / publish(name, data))
 *   - window.Events  (m.in. Events.PLAYER_MOVED, Events.STACK_ADDED,
 *                      Events.STACK_REMOVED, Events.UPGRADE_BOUGHT)
 *
 * Użycie w main.js:
 *   window.stackController = new StackController();
 *   game.registerModule(window.stackController);
 */

// Ile px nad głową gracza zaczyna się stos (element o indeksie 0).
const STACK_BASE_OFFSET_Y = 45;
// Odstęp pionowy (px) między kolejnymi elementami stosu.
const STACK_ITEM_SPACING = 22;
// Prędkość animacji "lotu" przedmiotu do stosu - większe = szybciej.
const STACK_FLY_SPEED = 6;
// Rozmiar rysowanego przedmiotu na stosie (px).
const STACK_ITEM_SIZE = 28;
// Promień miękkiej poświaty pod przedmiotem, jako mnożnik rozmiaru ikony
// (ta sama stała co ITEM_GLOW_RADIUS_MULT w items.js - spójny wygląd).
const STACK_GLOW_RADIUS_MULT = 1.7;

class StackController {
  constructor() {
    // Stos LIFO. Każdy element:
    // { id, typeId, label, color, x, y, t, animating, stackIndex, ...reszta z item }
    this.items = [];
    this.maxCapacity = 10;

    // Pozycja / prędkość gracza - aktualizowane WYŁĄCZNIE przez
    // Events.PLAYER_MOVED (StackController nigdy nie odpytuje
    // PlayerController bezpośrednio).
    this.playerX = 0;
    this.playerY = 0;
    this.playerVX = 0;
    this.playerVY = 0;

    // --- Animacja kiwania (proceduralna, po dolocie na miejsce) -----------
    this.swayTime = 0;
    this.swayAmplitude = 8; // px
    this.swayFrequency = 2.5;

    // Referencje zbindowane raz - potrzebne do poprawnego unsubscribe()
    // w destroy().
    this._onPlayerMoved = (d) => {
      this.playerX = d.x;
      this.playerY = d.y;
      this.playerVX = d.vx;
      this.playerVY = d.vy;
    };
    this._onUpgradeBought = (d) => {
      if (d.upgradeId === 'capacity' && typeof d.value === 'number') {
        // Doliczamy TRWAŁY bonus z Rdzeni (core_backpack) - ten listener jest
        // NIEZALEŻNY od _applyUpgrade w economy.js (patrz komentarz tam) i
        // odpala się przy każdym zakupie, więc samo przypisanie d.value
        // kasowałoby bonus, za który gracz zapłacił Rdzeniami.
        const eco = window.economyManager;
        const bonus = (eco && typeof eco.getCoreValue === 'function')
          ? (eco.getCoreValue('core_backpack') || 0)
          : 0;
        this.maxCapacity = d.value + bonus;
      }
    };

    Bus.subscribe(Events.PLAYER_MOVED, this._onPlayerMoved);
    Bus.subscribe(Events.UPGRADE_BOUGHT, this._onUpgradeBought);
  }

  isFull() {
    return this.items.length >= this.maxCapacity;
  }

  isEmpty() {
    return this.items.length === 0;
  }

  /**
   * Dodaje przedmiot pod wierzch stosu — aktualny wierzch zostaje na miejscu.
   */
  addItem(item) {
    if (this.isFull()) return false;

    const stackItem = {
      ...item,
      x: item.worldX ?? this.playerX,
      y: item.worldY ?? this.playerY,
      t: 0,
      animating: true,
      stackIndex: 0
    };

    if (this.items.length === 0) {
      this.items.push(stackItem);
    } else {
      this.items.splice(this.items.length - 1, 0, stackItem);
    }

    Bus.publish(Events.STACK_ADDED, { size: this.items.length });
    return true;
  }

  /**
   * Zdejmuje przedmiot z wierzchu stosu (LIFO - ostatnio dodany pierwszy).
   * @returns {object|null} zdjęty przedmiot albo null, gdy stos jest pusty.
   */
  removeItem() {
    if (this.isEmpty()) return null;
    const item = this.items.pop();
    Bus.publish(Events.STACK_REMOVED, { size: this.items.length });
    return item;
  }

  /** Podgląd wierzchu stosu bez zdejmowania (np. sprawdzenie typeId). */
  peekItem() {
    return this.items[this.items.length - 1] || null;
  }

  /**
   * Czyści CAŁY stos jednym wywołaniem (np. reset plecaka przy prestiżu w
   * economy.js - patrz EconomyManager.prestige()). W przeciwieństwie do
   * removeItem() (LIFO, jeden na raz, jedno STACK_REMOVED na sztukę) usuwa
   * wszystko naraz i publikuje STACK_REMOVED RAZ z size:0, żeby UI odświeżył
   * się jednym susem zamiast N osobnych aktualizacji.
   */
  clear() {
    if (this.items.length === 0) return;
    this.items = [];
    Bus.publish(Events.STACK_REMOVED, { size: 0 });
  }

  /**
   * Znajduje indeks najwyższego (najbliższego wierzchowi) przedmiotu na
   * stosie spełniającego predicate(item). Dzięki temu maszyna (machines.js)
   * może wyciągnąć pasujący surowiec z DOWOLNEGO miejsca w plecaku, a nie
   * tylko z wierzchu - gracz nie musi już pamiętać kolejności podnoszenia
   * ani biegać między maszynami, żeby "odkopać" właściwy przedmiot.
   * @returns {number} indeks w this.items, albo -1 gdy brak dopasowania.
   */
  findIndex(predicate) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (predicate(this.items[i])) return i;
    }
    return -1;
  }

  /** Podgląd (bez zdejmowania) przedmiotu spod findIndex(predicate). */
  find(predicate) {
    const idx = this.findIndex(predicate);
    return idx === -1 ? null : this.items[idx];
  }

  /**
   * Zdejmuje przedmiot spod KONKRETNEGO indeksu (nie tylko z wierzchu stosu)
   * - tak, jakby gracz wyciągnął jedną rzecz spośród innych na plecach.
   * @returns {object|null} zdjęty przedmiot albo null, gdy indeks jest zły.
   */
  removeAt(index) {
    if (index < 0 || index >= this.items.length) return null;
    const [item] = this.items.splice(index, 1);
    Bus.publish(Events.STACK_REMOVED, { size: this.items.length });
    return item;
  }

  update(delta) {
    const sec = delta / 1000;
    this.swayTime += sec;

    // --- Animacja lotu (easeOutCubic) do docelowej pozycji w stosie -------
    this.items.forEach((item, i) => {
      item.stackIndex = i; // odświeżane co klatkę - poprawne też po removeItem()
      if (!item.animating) return;

      item.t = Math.min(1, item.t + sec * STACK_FLY_SPEED);
      const eased = 1 - Math.pow(1 - item.t, 3);

      const targetX = this.playerX;
      const targetY = this.playerY - STACK_BASE_OFFSET_Y - i * STACK_ITEM_SPACING;

      item.x += (targetX - item.x) * eased * 0.3;
      item.y += (targetY - item.y) * eased * 0.3;

      if (item.t >= 1) item.animating = false;
    });

    // --- Proceduralne kiwanie po dolocie (kołysanie + bezwładność) --------
    const sway = Math.sin(this.swayTime * this.swayFrequency);
    const inertiaX = -this.playerVX * 0.04; // przeciwnie do kierunku ruchu
    const inertiaY = -this.playerVY * 0.02;
    const count = Math.max(1, this.items.length);

    this.items.forEach((item, i) => {
      if (item.animating) return;
      const heightFactor = i / count;
      item.x = this.playerX + inertiaX * heightFactor + sway * this.swayAmplitude * heightFactor;
      item.y = this.playerY - STACK_BASE_OFFSET_Y - i * STACK_ITEM_SPACING + inertiaY * heightFactor;
    });
  }

  draw(ctxBg, ctx, ctxUI) {
    const total = this.items.length;
    this.items.forEach((item, i) => {
      ItemRenderer.drawStack(ctx, { ...item, size: STACK_ITEM_SIZE }, i, total);
    });
  }

  /**
   * Buduje ścieżkę zaokrąglonego kwadratu na canvasie. Używa natywnego
   * ctx.roundRect, jeśli przeglądarka je obsługuje; w przeciwnym razie
   * ręcznie odtwarza tę samą krzywą co PlayerController._roundRect
   * (player.js), żeby wygląd przedmiotów na stosie pozostał identyczny
   * na starszych przeglądarkach zamiast spadać do zwykłego prostokąta.
   */
  _traceRoundedSquare(ctx, x, y, w, h, r) {
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
   * Konwertuje kolor hex (#RRGGBB lub #RGB) na rgba(...) z podanym kanalem
   * alpha - potrzebne do gradientu poswiaty. Ten sam helper co w items.js
   * (kazdy plik jest samodzielny, bez wspoldzielonych utili - konwencja
   * z reszty projektu).
   */
  _withAlpha(hex, alpha) {
    if (typeof hex !== 'string' || hex[0] !== '#' || (hex.length !== 7 && hex.length !== 4)) {
      return `rgba(255, 255, 255, ${alpha})`;
    }
    let r; let g; let b;
    if (hex.length === 7) {
      r = parseInt(hex.slice(1, 3), 16);
      g = parseInt(hex.slice(3, 5), 16);
      b = parseInt(hex.slice(5, 7), 16);
    } else {
      r = parseInt(hex[1] + hex[1], 16);
      g = parseInt(hex[2] + hex[2], 16);
      b = parseInt(hex[3] + hex[3], 16);
    }
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  /**
   * Usuwa subskrypcje z Bus. Przydatne przy restarcie gry / tworzeniu nowej
   * instancji, żeby nie zostawiać "wiszących" nasłuchiwaczy po starym
   * StackControllerze (analogicznie do destroy() w player.js).
   */
  destroy() {
    Bus.unsubscribe(Events.PLAYER_MOVED, this._onPlayerMoved);
    Bus.unsubscribe(Events.UPGRADE_BOUGHT, this._onUpgradeBought);
  }
}

window.StackController = StackController;