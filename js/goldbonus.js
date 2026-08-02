'use strict';

/**
 * goldbonus.js
 * ------------------------------------------------------------------------
 * Złoty Bonus - rzadki, zanikający pickup na mapie, niezależny od zwykłego
 * systemu surowców (items.js: nosisz je w plecaku, sprzedajesz na targu).
 * Ten collectuje się OD RAZU na dotyk i wypłaca gotówkę wprost (patrz
 * EconomyManager.collectGoldBonus w economy.js) - nagroda za AKTYWNE
 * granie (bieganie po mapie), nie kolejny mnożnik ekonomii w tle. Pasuje
 * do "arcade" połowy nazwy gry ("Arcade Idle") dużo lepiej niż automatyzacja
 * zakupów - wykorzystuje ruch/eksplorację zamiast ją zastępować.
 *
 * Spawnuje się WYŁĄCZNIE w Strefie A (bezpiecznej) - własna, minimalna kopia
 * granic strefy z items.js (konwencja projektu: brak współdzielonych utili),
 * żeby bonus nigdy nie wylądował w miejscu, do którego gracz nie ma jeszcze
 * bezpiecznego dostępu (strefy B/C/D wymagają odblokowań/ekwipunku).
 *
 * Ma ograniczony czas życia (GOLDBONUS_LIFETIME_MS) - znika, jeśli nikt go
 * nie zebrał, żeby był realną, pilną okazją ("biegnij TERAZ"), nie stałym
 * punktem na mapie.
 */

const GOLDBONUS_WORLD_WIDTH = 1750;
const GOLDBONUS_WORLD_HEIGHT = 2000;
const GOLDBONUS_ZONE_CORE_WIDTH = 1400;
const GOLDBONUS_ZONE_C_TOP_RATIO = 0.32;
const GOLDBONUS_ZONE_B_RIGHT_RATIO = 0.62;
const GOLDBONUS_SPAWN_MARGIN = 60;

// Losowy odstęp między bonusami (nie STAŁY interwał - stały rytm gracz
// szybko "wyliczyłby" i traktował jak kolejny automat, nie niespodziankę).
const GOLDBONUS_SPAWN_MIN_MS = 75000;
const GOLDBONUS_SPAWN_MAX_MS = 140000;
// Ile bonus stoi na mapie, zanim zniknie nieodebrany.
const GOLDBONUS_LIFETIME_MS = 22000;
// Ostatnie tyle ms życia bonusu - wizualne "miganie" ostrzegające, że zaraz
// zniknie (patrz draw()).
const GOLDBONUS_WARNING_MS = 6000;
const GOLDBONUS_PICKUP_RADIUS = 42;
const GOLDBONUS_VISUAL_SIZE = 40;
const GOLDBONUS_BOB_FREQUENCY = 2.2;
const GOLDBONUS_BOB_AMP = 5;

// Tomek: "niech nic się nie respi za maszynami czy terminalem albo
// statkiem" - kilka z nich (recykler/prasa/terminal/statek) stoją FIZYCZNIE
// wewnątrz granic Strefy A, więc bez tego bonus mógłby wylosować się
// wprost pod jednym z nich. Te same pozycje/promień co ITEM_KEEP_AWAY
// (items.js) / keepAway (game.js) - własna kopia, konwencja projektu.
const GOLDBONUS_KEEP_AWAY = [
  { xr: 0.32, yr: 0.4 }, // recykler
  { xr: 0.28, yr: 0.72 }, // prasa
  { xr: 0.5, yr: 0.85 }, // terminal handlowy
  { xr: 0.18, yr: 0.55 } // statek
  // Piec/oczyszczalnia/szlifiernia pominięte - leżą poza Strefą A (jedyną,
  // w której bonus się losuje), więc nigdy by się z nim nie zderzyły.
].map((p) => ({ x: GOLDBONUS_ZONE_CORE_WIDTH * p.xr, y: GOLDBONUS_WORLD_HEIGHT * p.yr, r: 170 }));

class GoldBonusManager {
  constructor() {
    this.active = null; // { x, y, spawnedAt, bobPhase }
    this.playerX = 0;
    this.playerY = 0;
    this.time = 0;
    this._msUntilNextSpawn = this._rollSpawnDelay();

    this._onPlayerMoved = (d) => {
      this.playerX = d.x;
      this.playerY = d.y;
    };
    Bus.subscribe(Events.PLAYER_MOVED, this._onPlayerMoved);
  }

  /** W trakcie wydarzenia sezonowego (events.js: "Deszcz Meteorytów") odstęp
   * jest o połowę krótszy - żeby "deszcz" faktycznie było czuć w rozgrywce
   * (częstsze okazje do zbierania), nie tylko widać po spadających gwiazdach
   * na niebie. */
  _rollSpawnDelay() {
    const eventActive = window.seasonalEventManager && window.seasonalEventManager.isActive();
    const factor = eventActive ? 0.5 : 1;
    return (GOLDBONUS_SPAWN_MIN_MS + Math.random() * (GOLDBONUS_SPAWN_MAX_MS - GOLDBONUS_SPAWN_MIN_MS)) * factor;
  }

  /** Granice Strefy A (bezpiecznej) - własna, minimalna kopia z items.js
   * (_getZoneBounds tam), tylko wariant 'A' - reszta stref temu managerowi
   * niepotrzebna. Odrzuca (do 20 prób) pozycje zbyt blisko GOLDBONUS_KEEP_AWAY. */
  _rollSpawnPosition() {
    const topH = GOLDBONUS_WORLD_HEIGHT * GOLDBONUS_ZONE_C_TOP_RATIO;
    const rightX = GOLDBONUS_ZONE_CORE_WIDTH * GOLDBONUS_ZONE_B_RIGHT_RATIO;
    const m = GOLDBONUS_SPAWN_MARGIN;
    const minX = m;
    const maxX = Math.max(m + 1, rightX - m);
    const minY = Math.max(topH + m, m);
    const maxY = Math.max(topH + m + 1, GOLDBONUS_WORLD_HEIGHT - m);

    let x; let y;
    for (let attempt = 0; attempt < 20; attempt++) {
      x = minX + Math.random() * (maxX - minX);
      y = minY + Math.random() * (maxY - minY);
      const tooClose = GOLDBONUS_KEEP_AWAY.some((k) => {
        const dx = x - k.x;
        const dy = y - k.y;
        return Math.sqrt(dx * dx + dy * dy) < k.r;
      });
      if (!tooClose) break;
    }
    return { x, y };
  }

  _spawn() {
    const pos = this._rollSpawnPosition();
    this.active = { x: pos.x, y: pos.y, spawnedAt: this.time, bobPhase: Math.random() * Math.PI * 2 };
  }

  _collect() {
    if (!window.economyManager || typeof window.economyManager.collectGoldBonus !== 'function') return;
    window.economyManager.collectGoldBonus(this.active.x, this.active.y);
    Bus.publish(Events.FX_SHOCKWAVE, { x: this.active.x, y: this.active.y, color: '#FFD700', maxRadius: 90 });
    this.active = null;
    this._msUntilNextSpawn = this._rollSpawnDelay();
  }

  update(delta) {
    this.time += delta / 1000;

    if (!this.active) {
      this._msUntilNextSpawn -= delta;
      if (this._msUntilNextSpawn <= 0) this._spawn();
      return;
    }

    // Wygasł, nikt nie zdążył - znika po cichu (bez kary, to i tak darmowy
    // bonus, nie coś gracz "stracił").
    if (this.time - this.active.spawnedAt >= GOLDBONUS_LIFETIME_MS / 1000) {
      this.active = null;
      this._msUntilNextSpawn = this._rollSpawnDelay();
      return;
    }

    const dx = this.active.x - this.playerX;
    const dy = this.active.y - this.playerY;
    if (Math.sqrt(dx * dx + dy * dy) < GOLDBONUS_PICKUP_RADIUS) {
      this._collect();
    }
  }

  /**
   * Viewport culling - ten sam wzorzec co items.js/ambient.js/critters.js.
   */
  draw(ctxBg, ctx, ctxUI) {
    if (!this.active) return;

    const camX = window.game ? window.game.cameraX : 0;
    const camY = window.game ? window.game.cameraY : 0;
    const viewW = window.innerWidth;
    const viewH = window.innerHeight;
    const margin = GOLDBONUS_VISUAL_SIZE * 3;
    const { x } = this.active;
    if (x < camX - margin || x > camX + viewW + margin) return;
    if (this.active.y < camY - margin || this.active.y > camY + viewH + margin) return;

    const ageMs = (this.time - this.active.spawnedAt) * 1000;
    const remainingMs = GOLDBONUS_LIFETIME_MS - ageMs;
    // Miganie w ostatnich GOLDBONUS_WARNING_MS - szybsze im mniej zostało.
    const flashAlpha = remainingMs < GOLDBONUS_WARNING_MS
      ? 0.55 + 0.45 * Math.sin(this.time * (10 - 6 * (remainingMs / GOLDBONUS_WARNING_MS)))
      : 1;

    const y = this.active.y + Math.sin(this.time * GOLDBONUS_BOB_FREQUENCY + this.active.bobPhase) * GOLDBONUS_BOB_AMP;
    const pulse = 1 + Math.sin(this.time * 3.4 + this.active.bobPhase) * 0.08;
    const drawSize = GOLDBONUS_VISUAL_SIZE * pulse;

    ctx.save();
    ctx.globalAlpha = flashAlpha;

    // Poświata - kilka warstw malejącej alfy zamiast shadowBlur (patrz
    // konwencja projektu - shadowBlur to jedna z najdroższych operacji
    // Canvas, unikana wszędzie indziej w grze).
    const glowR = drawSize * 1.8;
    for (let i = 3; i >= 1; i--) {
      ctx.fillStyle = `rgba(255, 213, 0, ${0.09 * i})`;
      ctx.beginPath();
      ctx.arc(x, y, glowR * (i / 3), 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = 'rgba(0, 0, 0, 0.18)';
    ctx.beginPath();
    ctx.ellipse(x, this.active.y + drawSize / 2 + 4, drawSize * 0.4, drawSize * 0.1, 0, 0, Math.PI * 2);
    ctx.fill();

    const drew = window.spriteLoader && window.spriteLoader.draw(ctx, 'fx_gold_star', x, y, drawSize);
    if (!drew) {
      // Awaryjny fallback (sprite nie wczytał się) - prosta 5-ramienna
      // gwiazdka, ten sam kształt co ikona popupu (gamefeel.js).
      ctx.fillStyle = '#FFD700';
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.4)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      const s = drawSize * 0.45;
      for (let i = 0; i < 5; i++) {
        const outerA = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
        const innerA = outerA + Math.PI / 5;
        const ox = x + Math.cos(outerA) * s;
        const oy = y + Math.sin(outerA) * s;
        const ix = x + Math.cos(innerA) * s * 0.42;
        const iy = y + Math.sin(innerA) * s * 0.42;
        if (i === 0) ctx.moveTo(ox, oy);
        else ctx.lineTo(ox, oy);
        ctx.lineTo(ix, iy);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    ctx.restore();
  }

  destroy() {
    Bus.unsubscribe(Events.PLAYER_MOVED, this._onPlayerMoved);
  }
}

window.GoldBonusManager = GoldBonusManager;
