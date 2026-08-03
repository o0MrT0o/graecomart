'use strict';

/**
 * drone.js
 * ------------------------------------------------------------------------
 * Dron Recyklingowy (SHOP_UPGRADES: 'drone' w economy.js) - jedyna forma
 * automatyzacji w grze: lata po mapie i SAM zbiera pobliskie surowce, bez
 * wymogu, żeby gracz stał w pobliżu (w przeciwieństwie do 'pickup' - Magnesu
 * na Śmieci, który tylko poszerza zasięg PRZY graczu). Liczba dronów =
 * poziom ulepszenia, czytany NA ŻYWO co klatkę (ten sam wzorzec co
 * CrittersManager._currentDecorSetIndex w critters.js) - upgradeLevels.drone
 * zeruje się przy prestige() jak każde inne ulepszenie sklepowe, więc drony
 * znikają/pojawiają się same, bez nasłuchiwania żadnego eventu ani zmian w
 * economy.js poza samym wpisem w katalogu.
 *
 * Cel wyszukiwany jest wyłącznie wśród window.itemManager.items - TEJ SAMEJ
 * puli, z której korzysta gracz. Surowce niedostępne bez odpowiedniego
 * odblokowania (patrz _spawnItem w items.js: glass/metal/paper/crystal_shard
 * bramkowane progami/sprzętem) po prostu NIGDY tam nie trafiają, więc dron
 * nie "oszukuje" progresji - zbiera wyłącznie to, co i tak już mogło leżeć
 * na mapie i co gracz i tak mógłby podnieść sam.
 *
 * Zasięg wyszukiwania celu liczony jest od GRACZA, nie od samego drona - dron
 * ma pracować "przy Tobie", nie ulatywać na drugi koniec mapy za starym
 * surowcem, gdy gracz dawno przeszedł gdzie indziej.
 *
 * Ten sam wzorzec modułu co critters.js/ambient.js - update(delta)/draw
 * (ctxBg,ctx,ctxUI), rejestrowany w main.js przez game.registerModule().
 */

const DRONE_SPEED = 160; // px/s - nieco szybszy niż domyślna prędkość gracza (180, ale bez ulepszeń "Szybsze buty")
const DRONE_PICKUP_DIST = 24; // dystans "złapania" przedmiotu (ten sam rząd wielkości co ITEM_PICKUP_RADIUS fizycznego dotknięcia w items.js)
const DRONE_SEEK_RADIUS = 480; // maks. odległość CELU od GRACZA - dron "pracuje przy Tobie", nie na całej mapie
const DRONE_HOVER_RADIUS = 70; // promień leniwego krążenia nad graczem, gdy brak celu
const DRONE_HOVER_LIFT = 40; // px nad głową gracza, żeby krążący dron nie nakładał się na jego sylwetkę
const DRONE_SPRITE_W = 34;
const DRONE_SPRITE_H = DRONE_SPRITE_W * (90 / 124); // naturalne proporcje assets/critters/drone.png

class DroneManager {
  constructor() {
    this.drones = [];
  }

  /** Aktualny poziom ulepszenia = docelowa liczba dronów, czytany na żywo -
   * patrz nagłówek pliku (zero potrzeby nasłuchiwania eventów zakupu/prestiżu). */
  _targetCount() {
    const eco = window.economyManager;
    return (eco && eco.upgradeLevels && eco.upgradeLevels.drone) || 0;
  }

  _spawnDrone() {
    const player = window.playerController;
    return {
      x: player ? player.x : 0,
      y: player ? player.y : 0,
      targetId: null,
      hoverAngle: Math.random() * Math.PI * 2,
      bobPhase: Math.random() * Math.PI * 2
    };
  }

  /** Dodaje/usuwa drony, żeby this.drones.length zawsze zgadzało się z
   * _targetCount() - bezpieczne przy wywołaniu co klatkę (no-op, gdy liczba
   * już się zgadza). Nowe drony startują PRZY graczu, nie muszą nadlatywać
   * z daleka, żeby od razu były użyteczne. */
  _syncCount() {
    const target = this._targetCount();
    while (this.drones.length < target) this.drones.push(this._spawnDrone());
    if (this.drones.length > target) this.drones.length = target;
  }

  /** Najbliższy (drona, nie gracza) niezebrany przedmiot w promieniu
   * DRONE_SEEK_RADIUS OD GRACZA, pomijając przedmioty, na które już leci
   * INNY dron (żeby dwa drony nie goniły tego samego surowca). */
  _findTarget(drone) {
    const im = window.itemManager;
    const player = window.playerController;
    if (!im || !player) return null;

    let bestId = null;
    let bestDist = Infinity;
    im.items.forEach((item) => {
      if (item.collected) return;
      const pdx = item.x - player.x;
      const pdy = item.y - player.y;
      if (Math.sqrt(pdx * pdx + pdy * pdy) > DRONE_SEEK_RADIUS) return;
      if (this.drones.some((other) => other !== drone && other.targetId === item.id)) return;

      const dx = item.x - drone.x;
      const dy = item.y - drone.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < bestDist) {
        bestDist = dist;
        bestId = item.id;
      }
    });
    return bestId;
  }

  update(delta) {
    const sec = delta / 1000;
    this._syncCount();
    if (this.drones.length === 0) return;

    const im = window.itemManager;
    const stack = window.stackController;
    const player = window.playerController;

    this.drones.forEach((d) => {
      d.bobPhase += sec * 3;

      const backpackFull = !stack || stack.isFull();
      if (backpackFull) {
        d.targetId = null;
      } else if (!d.targetId || !im || !im.items.some((i) => i.id === d.targetId && !i.collected)) {
        d.targetId = this._findTarget(d);
      }

      const target = (d.targetId && im) ? im.items.find((i) => i.id === d.targetId) : null;

      if (target) {
        const dx = target.x - d.x;
        const dy = target.y - d.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > 1) {
          d.x += (dx / dist) * DRONE_SPEED * sec;
          d.y += (dy / dist) * DRONE_SPEED * sec;
        }

        if (dist < DRONE_PICKUP_DIST && stack && !stack.isFull()) {
          target.collected = true;
          stack.addItem({
            id: target.id,
            typeId: target.typeId,
            label: target.label,
            color: target.color,
            worldX: target.x,
            worldY: target.y
          });
          Bus.publish(Events.ITEM_PICKUP, { itemId: target.id, typeId: target.typeId, x: target.x, y: target.y });
          Bus.publish(Events.FX_PARTICLES, { x: target.x, y: target.y, color: target.color, count: 6 });
          d.targetId = null;
        }
      } else if (player) {
        // Brak celu (nic w zasięgu / plecak pełny) - leniwe krążenie nad
        // graczem, żeby dron nie stał sztywno w miejscu ani nie znikał z pola
        // widzenia, kiedy chwilowo nie ma czego zbierać.
        d.hoverAngle += sec * 0.8;
        const hx = player.x + Math.cos(d.hoverAngle) * DRONE_HOVER_RADIUS;
        const hy = player.y + Math.sin(d.hoverAngle) * DRONE_HOVER_RADIUS - DRONE_HOVER_LIFT;
        const dx = hx - d.x;
        const dy = hy - d.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > 2) {
          d.x += (dx / dist) * DRONE_SPEED * 0.5 * sec;
          d.y += (dy / dist) * DRONE_SPEED * 0.5 * sec;
        }
      }
    });
  }

  /** Viewport culling - ten sam wzorzec co critters.js/ambient.js. */
  draw(ctxBg, ctx, ctxUI) {
    const camX = window.game ? window.game.cameraX : 0;
    const camY = window.game ? window.game.cameraY : 0;
    const viewW = window.innerWidth;
    const viewH = window.innerHeight;
    const margin = 60;

    this.drones.forEach((d) => {
      if (d.x < camX - margin || d.x > camX + viewW + margin) return;
      if (d.y < camY - margin || d.y > camY + viewH + margin) return;
      this._drawDrone(ctx, d);
    });
  }

  /** Sam sprite (assets/critters/drone.png, ten sam "gołe UFO bez obcego"
   * co critter_ufo w critters.js, tylko niebieski) + miękki cień na ziemi -
   * identyczny trik co _drawUfo w critters.js (elipsa NIEZALEŻNA od
   * bobbingu statku nad nią, sprzedaje wysokość lotu). */
  _drawDrone(ctx, d) {
    const bob = Math.sin(d.bobPhase) * 3;
    const w = DRONE_SPRITE_W;
    const h = DRONE_SPRITE_H;

    ctx.save();
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = 'rgba(10, 15, 10, 0.9)';
    ctx.beginPath();
    ctx.ellipse(d.x, d.y + h * 0.42, w * 0.32, w * 0.12, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    const img = window.spriteLoader && window.spriteLoader.get('drone');
    ctx.save();
    ctx.translate(d.x, d.y + bob);
    if (img && img.complete && img.naturalWidth) {
      ctx.drawImage(img, -w / 2, -h / 2, w, h);
    } else {
      // Sprite jeszcze niewczytany (rzadki, jednorazowy stan tuż po starcie
      // gry) - prosty niebieski spodek zamiast pustego miejsca.
      ctx.fillStyle = '#5C85D6';
      ctx.beginPath();
      ctx.ellipse(0, 0, w * 0.45, h * 0.4, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  destroy() {
    this.drones = [];
  }
}

window.DroneManager = DroneManager;
