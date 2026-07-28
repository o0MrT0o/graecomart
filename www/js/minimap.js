'use strict';

/**
 * minimap.js
 * ------------------------------------------------------------------------
 * Minimapa (ulepszenie w economy.js, id:'minimap' - BYŁO 'compass', strzałka
 * kierunkowa; zastąpione na prośbę Toma: kompas był niewidoczny/niejasny,
 * minimapa pokazuje od razu WSZYSTKO pobliskie, nie tylko jeden cel).
 *
 * Mały okrągły radar w rogu ekranu - gracz zawsze na środku (biały trójkąt,
 * obrócony wg kierunku patrzenia), a dookoła niego, przeliczone względem
 * jego pozycji:
 *   - stałe punkty zainteresowania (maszyny/statek/terminal handlowy) -
 *     kolorowe kropki, PRZYWIERAJĄCE do brzegu radaru gdy są poza zasięgiem
 *     (ten sam duch co dawna strzałka kompasu - zawsze wiadomo, w którą
 *     stronę iść, nawet daleko)
 *   - pobliskie surowce (window.itemManager.items) - drobne kropki w kolorze
 *     danego typu, widoczne TYLKO w zasięgu (nie przywierają do brzegu - przy
 *     kilkunastu przedmiotach naraz zaśmiecałoby to obwódkę)
 *
 * Osobny moduł, NIE część player.js - PlayerController świadomie nie zna
 * żadnego innego modułu (patrz nagłówek player.js), a minimapa z definicji
 * musi znać ItemManager (window.itemManager.items) - więc ta wiedza żyje
 * tutaj, nie tam.
 *
 * drawLayer = 'ui' - rysuje na ctxUI, który NIE jest przesuwany przez
 * kamerę (w przeciwieństwie do ctxGameplay) - dzięki temu radar trzyma się
 * rogu EKRANU, nie świata.
 */

// Te same wymiary świata co w game.js/items.js/machines.js/market.js/ship.js
// (własne kopie - konwencja projektu, brak współdzielonych utili).
const MINIMAP_WORLD_WIDTH = 1400;
const MINIMAP_WORLD_HEIGHT = 2000;

const MINIMAP_RADIUS = 52; // promień radaru na ekranie (px)
const MINIMAP_MARGIN = 14; // odstęp od krawędzi ekranu
// Ile px ŚWIATA mieści się w promieniu radaru - "zasięg lokalnego radaru".
// Poza tym zasięgiem surowce znikają, a stałe POI przywierają do brzegu.
const MINIMAP_WORLD_RADIUS = 620;
const MINIMAP_ITEM_DOT_SIZE = 2.2;
const MINIMAP_POI_DOT_SIZE = 4.5;
// Strzałka gracza - było 5, przez co zasłaniała kropki POI/surowców tuż obok
// siebie na środku radaru. Mniejsza, ale nadal czytelna jako grot.
const MINIMAP_PLAYER_SIZE = 3.4;
// Minimalna prędkość^2, przy której aktualizujemy kąt strzałki (patrz
// _onPlayerMoved) - poniżej traktujemy gracza jako stojącego.
const MINIMAP_HEADING_MIN_SPEED_SQ = 25;

// Stałe punkty zainteresowania - te same pozycje i kolory co w
// machines.js/market.js/ship.js (własne kopie, konwencja projektu).
const MINIMAP_POIS = [
  { xr: 0.32, yr: 0.4, color: '#66BB6A' }, // recykler
  { xr: 0.28, yr: 0.72, color: '#FFA726' }, // prasa
  { xr: 0.59, yr: 0.35, color: '#EF5350' }, // piec hutniczy
  { xr: 0.8, yr: 0.62, color: '#7E57C2' }, // oczyszczalnia (te same xr/yr co refinery_b w machines.js)
  { xr: 0.5, yr: 0.85, color: '#FFD54F' }, // terminal handlowy
  { xr: 0.18, yr: 0.55, color: '#81D4FA' } // statek
];

class MinimapManager {
  constructor() {
    this.drawLayer = 'ui';
    this.playerX = MINIMAP_WORLD_WIDTH / 2;
    this.playerY = MINIMAP_WORLD_HEIGHT / 2;
    // Kąt (rad) FAKTYCZNEGO kierunku marszu - liczony z wektora prędkości
    // (vx/vy z PLAYER_MOVED), nie z this.facing. facing to tylko -1/1 (w którą
    // stronę patrzy sprite), więc dawał wyłącznie odbicie lewo/prawo: idąc w
    // górę albo w dół strzałka wyglądała identycznie jak idąc w bok. Teraz
    // pełne 360°. Startowo "w górę" (-PI/2), żeby przed pierwszym ruchem
    // strzałka nie leżała na boku.
    this.heading = -Math.PI / 2;

    // Canvas (w przeciwieństwie do reszty HUD w ui.js, który jest DOM i ma
    // dostęp wprost do CSS) NIE rozumie env(safe-area-inset-*) - ale style.css
    // już wystawia te wartości jako zmienne CSS (--safe-top/--safe-right,
    // patrz :root), więc odczytujemy je RAZ tutaj (i przy każdym resize -
    // obrót ekranu potrafi przenieść wcięcie na inną krawędź) zamiast liczyć
    // getComputedStyle() w KAŻDEJ klatce (kosztowne, 60x/s bez potrzeby -
    // wcięcie ekranu nie zmienia się między klatkami).
    this._safeTop = 0;
    this._safeRight = 0;
    this._refreshSafeInsets();
    this._onResize = () => this._refreshSafeInsets();
    window.addEventListener('resize', this._onResize);

    this._onPlayerMoved = (d) => {
      this.playerX = d.x;
      this.playerY = d.y;
      // Kąt aktualizujemy TYLKO gdy gracz faktycznie idzie - przy zatrzymaniu
      // vx/vy zjeżdżają do ~0 i atan2(0,0) skoczyłoby na 0 rad (w prawo),
      // czyli strzałka obracałaby się sama po puszczeniu joysticka. Próg
      // odsiewa też drobny jitter martwej strefy joysticka.
      const vx = d.vx || 0;
      const vy = d.vy || 0;
      if (vx * vx + vy * vy > MINIMAP_HEADING_MIN_SPEED_SQ) {
        this.heading = Math.atan2(vy, vx);
      }
    };
    Bus.subscribe(Events.PLAYER_MOVED, this._onPlayerMoved);
  }

  _refreshSafeInsets() {
    if (typeof document === 'undefined' || !document.documentElement) return;
    const style = getComputedStyle(document.documentElement);
    const top = parseFloat(style.getPropertyValue('--safe-top'));
    const right = parseFloat(style.getPropertyValue('--safe-right'));
    this._safeTop = Number.isFinite(top) ? top : 0;
    this._safeRight = Number.isFinite(right) ? right : 0;
  }

  update(delta) {
    // Brak stanu do naliczania - draw() liczy wszystko na bieżąco, czytając
    // window.itemManager.items wprost (ten sam wzorzec co dawny compass.js).
  }

  draw(ctxBg, ctx, ctxUI) {
    const eco = window.economyManager;
    if (!eco || typeof eco.hasUpgrade !== 'function') return;
    // Minimapa działa, gdy KUPIONA w sklepie ALBO gdy gracz ukończył moduł
    // Nawigacji statku (ten daje ją za darmo - patrz SHIP_MODULE_PERKS w
    // economy.js, free_minimap).
    const bought = eco.hasUpgrade('minimap');
    const fromShip = typeof eco.hasShipPerk === 'function' && eco.hasShipPerk('free_minimap');
    if (!bought && !fromShip) return;

    // Górny-prawy róg - PRZECIWNY niż saldo/stos (game-ui__top, zawsze
    // górny-lewy, patrz style.css) i z dala od dolnego game-ui__fab-row
    // (Sklep/Statek/Wycisz) i dolnego Menu - nic stałego w HUD tam nie
    // stoi. this._safeTop/_safeRight (patrz _refreshSafeInsets) odsuwają
    // radar spod wcięcia/paska systemowego, którego canvas sam z siebie
    // nie widzi (w przeciwieństwie do DOM-owego HUD w ui.js).
    // window.innerWidth, NIE ctxUI.canvas.width - od fixu DPR w game.js
    // (resize()) to ostatnie to fizyczne piksele bufora (dpr-krotnie
    // większe niż ekran), a HUD rysowany na tym samym, skalowanym przez
    // ctx.setTransform kontekście operuje w logicznych pikselach CSS.
    const cx = window.innerWidth - MINIMAP_MARGIN - MINIMAP_RADIUS - this._safeRight;
    const cy = MINIMAP_MARGIN + MINIMAP_RADIUS + this._safeTop;
    const scale = MINIMAP_RADIUS / MINIMAP_WORLD_RADIUS;

    ctxUI.save();

    // Tło + obwódka.
    ctxUI.fillStyle = 'rgba(15, 23, 20, 0.72)';
    ctxUI.beginPath();
    ctxUI.arc(cx, cy, MINIMAP_RADIUS, 0, Math.PI * 2);
    ctxUI.fill();
    ctxUI.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    ctxUI.lineWidth = 2;
    ctxUI.stroke();

    // Kropki POI/surowców przycięte do wnętrza koła - osobny save/clip, żeby
    // obwódka wyżej i gracz na środku niżej NIE były przycinane razem z nimi.
    ctxUI.save();
    ctxUI.beginPath();
    ctxUI.arc(cx, cy, MINIMAP_RADIUS - 1, 0, Math.PI * 2);
    ctxUI.clip();

    MINIMAP_POIS.forEach((poi) => {
      const wx = MINIMAP_WORLD_WIDTH * poi.xr;
      const wy = MINIMAP_WORLD_HEIGHT * poi.yr;
      this._drawDot(ctxUI, cx, cy, wx, wy, scale, poi.color, MINIMAP_POI_DOT_SIZE, true);
    });

    const items = window.itemManager && window.itemManager.items;
    if (items) {
      const maxDistSq = MINIMAP_WORLD_RADIUS * MINIMAP_WORLD_RADIUS;
      items.forEach((item) => {
        if (item.collected) return;
        const dx = item.x - this.playerX;
        const dy = item.y - this.playerY;
        if (dx * dx + dy * dy > maxDistSq) return;
        const meta = typeof ItemRenderer !== 'undefined' ? ItemRenderer.getTypeMeta(item.typeId) : null;
        const color = (meta && meta.color) || '#FFFFFF';
        this._drawDot(ctxUI, cx, cy, item.x, item.y, scale, color, MINIMAP_ITEM_DOT_SIZE, false);
      });
    }

    ctxUI.restore();

    // Gracz - zawsze DOKŁADNIE na środku (wszystko inne jest względem NIEGO
    // przeliczone), mały grot obrócony wg FAKTYCZNEGO kierunku marszu
    // (this.heading, patrz _onPlayerMoved) - jedyny element radaru, który sam
    // się porusza/obraca. Wcześniej było scale(-1,1) wg this.facing, czyli
    // tylko odbicie lewo/prawo - marsz w górę i w dół wyglądał identycznie.
    ctxUI.save();
    ctxUI.translate(cx, cy);
    ctxUI.rotate(this.heading);
    ctxUI.fillStyle = '#FFFFFF';
    ctxUI.strokeStyle = 'rgba(0, 0, 0, 0.55)';
    ctxUI.lineWidth = 1;
    ctxUI.beginPath();
    // Grot wzdłuż lokalnej osi +X (0 rad = w prawo), bo taką konwencję ma
    // atan2(vy,vx) - obrót o heading ustawia go dokładnie w stronę marszu.
    // Wcięcie z tyłu (zamiast płaskiej podstawy) czytelniej pokazuje kierunek
    // przy tym małym rozmiarze.
    ctxUI.moveTo(MINIMAP_PLAYER_SIZE * 1.9, 0);
    ctxUI.lineTo(-MINIMAP_PLAYER_SIZE, MINIMAP_PLAYER_SIZE);
    ctxUI.lineTo(-MINIMAP_PLAYER_SIZE * 0.4, 0);
    ctxUI.lineTo(-MINIMAP_PLAYER_SIZE, -MINIMAP_PLAYER_SIZE);
    ctxUI.closePath();
    ctxUI.fill();
    ctxUI.stroke();
    ctxUI.restore();

    ctxUI.restore();
  }

  /**
   * Rysuje kropkę POI/przedmiotu względem gracza, przeskalowaną do promienia
   * radaru. clampToEdge=true dla stałych POI (statek/maszyny/terminal) - gdy
   * są poza zasięgiem, "przywierają" do brzegu koła zamiast znikać (gracz
   * zawsze wie, w którą stronę iść, ten sam duch co dawna strzałka kompasu).
   * Przedmioty (clampToEdge=false) są już odfiltrowane PRZED wywołaniem
   * (patrz draw()), więc poza zasięgiem po prostu nic nie rysujemy - inaczej
   * kilkanaście surowców naraz zaklejałoby cały brzeg radaru kropkami.
   */
  _drawDot(ctx, cx, cy, wx, wy, scale, color, size, clampToEdge) {
    let dx = (wx - this.playerX) * scale;
    let dy = (wy - this.playerY) * scale;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const edge = MINIMAP_RADIUS - 6;

    if (dist > edge) {
      if (!clampToEdge) return;
      const factor = edge / dist;
      dx *= factor;
      dy *= factor;
    }

    ctx.fillStyle = color;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx + dx, cy + dy, size, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  destroy() {
    Bus.unsubscribe(Events.PLAYER_MOVED, this._onPlayerMoved);
    window.removeEventListener('resize', this._onResize);
  }
}

window.MinimapManager = MinimapManager;
