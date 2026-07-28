'use strict';

/**
 * ambient.js
 * ------------------------------------------------------------------------
 * Otoczkowe cząsteczki tła zależne od biomu - czysto dekoracyjna "atmosfera"
 * mapy, nic nie wpływa na rozgrywkę. Osobny moduł (registerModule w main.js),
 * rysuje na warstwie GAMEPLAY pod wszystkim innym (rejestrowany PRZED resztą
 * modułów), więc pyłki/opary są w tle, nie zasłaniają gracza/przedmiotów.
 *
 * Zero zależności od assetów (wszystko rysowane proceduralnie przez Canvas),
 * zero od innych modułów poza odczytem window.game.cameraX/Y - dzięki temu
 * nie może niczego zepsuć w istniejących systemach.
 *
 * Trzy biomy (te same granice co items.js/game.js - własne kopie stałych
 * zgodnie z konwencją projektu, brak współdzielonych utili):
 *   - Strefa A (łąka): powolne, jasne pyłki dryfujące do góry (jak kurz w słońcu)
 *   - Strefa B (bagno, prawy-dół): bąbelki/opary unoszące się z mokradła
 *   - Strefa C (popiół, góra): iskry/popiół leniwie opadające
 *
 * Cząsteczki żyją tylko w widocznym obszarze (+margines) i są RECYKLINGOWANE
 * (po wyjściu z ekranu wracają z drugiej strony), więc jest ich stała, mała
 * liczba niezależnie od rozmiaru świata - brak narastającego kosztu.
 */

// Granice stref - MUSZĄ zgadzać się z GAME_ZONE_*/ITEM_ZONE_* w game.js/items.js.
const AMBIENT_ZONE_C_TOP_RATIO = 0.32;
const AMBIENT_ZONE_B_RIGHT_RATIO = 0.62;
// Strefa D (Kryształowa Grań) - SAMODZIELNY róg prawy-górny (patrz identyczne
// stałe i obszerny komentarz przy GAME_ZONE_D_LEFT_RATIO w game.js).
const AMBIENT_ZONE_D_LEFT_RATIO = 0.78;
const AMBIENT_ZONE_D_BOTTOM_RATIO = 0.5;

const AMBIENT_WORLD_WIDTH = 1400;
const AMBIENT_WORLD_HEIGHT = 2000;

// Ile cząsteczek na biom żyje jednocześnie. Mało - to subtelne tło, nie
// śnieżyca. Każda jest recyklingowana, więc to też górny limit kosztu.
const AMBIENT_COUNT_PER_ZONE = 18;

class AmbientManager {
  constructor() {
    // Każda cząsteczka: { x, y, vx, vy, size, alpha, phase, zone }.
    // Pozycje w WSPÓŁRZĘDNYCH ŚWIATA (nie ekranu) - rysowane wewnątrz
    // translacji kamery w game.js draw(), jak wszystko inne na tej warstwie.
    this.particles = [];
    this._time = 0;

    const zc = AMBIENT_WORLD_HEIGHT * AMBIENT_ZONE_C_TOP_RATIO;
    const zb = AMBIENT_WORLD_WIDTH * AMBIENT_ZONE_B_RIGHT_RATIO;

    // Strefa C (popiół) - cały górny pas.
    for (let i = 0; i < AMBIENT_COUNT_PER_ZONE; i++) {
      this.particles.push(this._spawn('C',
        Math.random() * AMBIENT_WORLD_WIDTH,
        Math.random() * zc));
    }
    // Strefa B (bagno) - prawy-dolny prostokąt (poniżej C, na prawo od granicy B).
    for (let i = 0; i < AMBIENT_COUNT_PER_ZONE; i++) {
      this.particles.push(this._spawn('B',
        zb + Math.random() * (AMBIENT_WORLD_WIDTH - zb),
        zc + Math.random() * (AMBIENT_WORLD_HEIGHT - zc)));
    }
    // Strefa A (łąka) - lewy-dolny (poniżej C, na lewo od granicy B).
    for (let i = 0; i < AMBIENT_COUNT_PER_ZONE; i++) {
      this.particles.push(this._spawn('A',
        Math.random() * zb,
        zc + Math.random() * (AMBIENT_WORLD_HEIGHT - zc)));
    }
    // Strefa D (Kryształowa Grań) - SAMODZIELNY róg prawy-górny (sięga niżej
    // niż pas C, aż do AMBIENT_ZONE_D_BOTTOM_RATIO) - fioletowe iskierki
    // wypełniają CAŁY ten róg, dodatkowy sygnał "tu jest osobna kraina".
    const zd = AMBIENT_WORLD_WIDTH * AMBIENT_ZONE_D_LEFT_RATIO;
    const zdBottom = AMBIENT_WORLD_HEIGHT * AMBIENT_ZONE_D_BOTTOM_RATIO;
    for (let i = 0; i < AMBIENT_COUNT_PER_ZONE; i++) {
      this.particles.push(this._spawn('D',
        zd + Math.random() * (AMBIENT_WORLD_WIDTH - zd),
        Math.random() * zdBottom));
    }
  }

  _spawn(zone, x, y) {
    if (zone === 'C') {
      // Iskry/popiół - powolne opadanie z lekkim bocznym dryfem.
      return {
        zone, x, y,
        vx: (Math.random() - 0.5) * 6,
        vy: 8 + Math.random() * 10,
        size: 1.2 + Math.random() * 1.8,
        alpha: 0.25 + Math.random() * 0.4,
        phase: Math.random() * Math.PI * 2
      };
    }
    if (zone === 'B') {
      // Bąbelki/opary - unoszą się do góry, wolno.
      return {
        zone, x, y,
        vx: (Math.random() - 0.5) * 4,
        vy: -(6 + Math.random() * 8),
        size: 1.5 + Math.random() * 2.5,
        alpha: 0.12 + Math.random() * 0.22,
        phase: Math.random() * Math.PI * 2
      };
    }
    if (zone === 'D') {
      // Kryształowe iskierki - powolny, prawie nieruchomy dryf w górę
      // (jakby unosiły się z samego gruntu), wolniejszy niż opary Strefy B -
      // ma czytać się jako "magiczny pył", nie bąbelki.
      return {
        zone, x, y,
        vx: (Math.random() - 0.5) * 2,
        vy: -(2 + Math.random() * 4),
        size: 1.2 + Math.random() * 2,
        alpha: 0.2 + Math.random() * 0.35,
        phase: Math.random() * Math.PI * 2
      };
    }
    // Strefa A - jasne pyłki, bardzo powolny dryf w górę (kurz w słońcu).
    return {
      zone, x, y,
      vx: (Math.random() - 0.5) * 5,
      vy: -(3 + Math.random() * 5),
      size: 1 + Math.random() * 1.6,
      alpha: 0.18 + Math.random() * 0.3,
      phase: Math.random() * Math.PI * 2
    };
  }

  update(delta) {
    const sec = delta / 1000;
    this._time += sec;

    const zc = AMBIENT_WORLD_HEIGHT * AMBIENT_ZONE_C_TOP_RATIO;
    const zb = AMBIENT_WORLD_WIDTH * AMBIENT_ZONE_B_RIGHT_RATIO;
    const zd = AMBIENT_WORLD_WIDTH * AMBIENT_ZONE_D_LEFT_RATIO;
    const zdBottom = AMBIENT_WORLD_HEIGHT * AMBIENT_ZONE_D_BOTTOM_RATIO;

    this.particles.forEach((p) => {
      // Delikatne sinusoidalne kołysanie boczne - żeby ruch nie był idealnie
      // liniowy (martwy), tylko lekko "pływał".
      p.x += (p.vx + Math.sin(this._time * 0.8 + p.phase) * 3) * sec;
      p.y += p.vy * sec;

      // Recykling - gdy cząsteczka wypłynie poza swój biom, wraca z
      // przeciwnej strony (zawijanie), żeby pole było zawsze wypełnione, a
      // liczba cząsteczek stała. Granice liczone per-strefa.
      let minX, maxX, minY, maxY;
      if (p.zone === 'D') { minX = zd; maxX = AMBIENT_WORLD_WIDTH; minY = 0; maxY = zdBottom; }
      else if (p.zone === 'C') { minX = 0; maxX = zd; minY = 0; maxY = zc; }
      else if (p.zone === 'B') { minX = zb; maxX = AMBIENT_WORLD_WIDTH; minY = zc; maxY = AMBIENT_WORLD_HEIGHT; }
      else { minX = 0; maxX = zb; minY = zc; maxY = AMBIENT_WORLD_HEIGHT; }

      if (p.x < minX) p.x = maxX;
      else if (p.x > maxX) p.x = minX;
      if (p.y < minY) p.y = maxY;
      else if (p.y > maxY) p.y = minY;
    });
  }

  draw(ctxBg, ctx, ctxUI) {
    // Rysujemy tylko to, co w pobliżu widoku - reszta i tak jest za kamerą.
    // window.game.cameraX/Y to lewy-górny róg widoku w świecie.
    const camX = window.game ? window.game.cameraX : 0;
    const camY = window.game ? window.game.cameraY : 0;
    // window.innerWidth/innerHeight, NIE ctx.canvas.width/height - od fixu
    // DPR w game.js (resize()) to ostatnie to fizyczne piksele bufora
    // (dpr-krotnie większe niż ekran), a cząsteczki żyją w tych samych
    // logicznych pikselach CSS co kamera/pozycje świata.
    const viewW = window.innerWidth;
    const viewH = window.innerHeight;
    const margin = 40;

    ctx.save();
    this.particles.forEach((p) => {
      if (p.x < camX - margin || p.x > camX + viewW + margin) return;
      if (p.y < camY - margin || p.y > camY + viewH + margin) return;

      // Migotanie - alpha lekko pulsuje, żeby cząsteczki "żyły".
      const flicker = 0.7 + 0.3 * Math.sin(this._time * 2 + p.phase);
      ctx.globalAlpha = p.alpha * flicker;

      if (p.zone === 'C') {
        // Iskra - ciepły pomarańcz.
        ctx.fillStyle = '#FF8A50';
      } else if (p.zone === 'B') {
        // Opar - chłodny, lekko zielonkawy.
        ctx.fillStyle = '#A5D6C0';
      } else if (p.zone === 'D') {
        // Kryształowa iskierka - jasny fiolet (zgodny z _bakeCrystalGroundTexture/
        // _bakeCrystalDecorTexture w game.js).
        ctx.fillStyle = '#D1C4E9';
      } else {
        // Pyłek łąki - ciepłe, jasne złoto.
        ctx.fillStyle = '#FFF3C0';
      }

      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.restore();
  }

  destroy() {
    this.particles = [];
  }
}

window.AmbientManager = AmbientManager;
