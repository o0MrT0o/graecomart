'use strict';

/**
 * critters.js
 * ------------------------------------------------------------------------
 * Drobne, czysto dekoracyjne stworzenia ożywiające mapę - motyle (Strefa A),
 * świetliki (Strefa B), wrony (Strefa C). Zero wpływu na rozgrywkę (gracz
 * nie może ich dotknąć/złapać), zero zależności od assetów - proceduralne
 * kształty rysowane Canvasem, ten sam duch co ItemRenderer._drawIngot
 * (items.js) dla stopu bez sprite'a.
 *
 * Ten sam wzorzec co AmbientManager (ambient.js): rejestrowany w main.js
 * JAKO PIERWSZY moduł gameplay (przed graczem/przedmiotami/maszynami), więc
 * stworzenia rysują się w tle, nigdy nie zasłaniają niczego interaktywnego.
 * Zależność tylko od window.game.cameraX/Y (do przycinania rysowania do
 * widoku) - nie może niczego zepsuć w istniejących systemach.
 *
 * Ruch: proste "błądzenie" wokół stałego punktu domowego (homeX/homeY) -
 * kąt lotu dryfuje losowo klatka po klatce, z miękkim zawracaniem, gdy
 * stworzenie oddali się za bardzo od domu. Bez pathfindingu, bez kolizji -
 * to tło, nie NPC.
 */

const CRITTER_WORLD_WIDTH = 1400;
const CRITTER_WORLD_HEIGHT = 2000;
// Te same progi co w items.js/game.js/ambient.js - własna kopia (konwencja projektu).
const CRITTER_ZONE_C_TOP_RATIO = 0.32;
const CRITTER_ZONE_B_RIGHT_RATIO = 0.62;

const CRITTER_COUNTS = { butterfly: 6, firefly: 7, crow: 3 };
const BUTTERFLY_COLORS = ['#F48FB1', '#FFCC80', '#CE93D8', '#81D4FA', '#FFF176'];

// BUGFIX (przycinanie na telefonie): _drawFirefly tworzyła NOWY
// createRadialGradient KAŻDĄ klatkę, dla KAŻDEGO świetlika (do 7 naraz) -
// dokładnie ten sam błąd, który ItemRenderer._getGlowTexture (items.js) już
// raz naprawił dla przedmiotów. Kolor/kształt poświaty są zawsze te same,
// jedyne co się zmienia w locie to promień (per świetlik, stały - c.size się
// nie zmienia) i jasność (blink) - więc pieczemy JEDNĄ teksturę RAZ (rozmiar
// bazowy, promień świetlika i tak wchodzi tylko jako skala przy drawImage) i
// modulujemy jasność przez globalAlpha zamiast przeliczać gradient od nowa.
const CRITTER_FIREFLY_GLOW_TEXTURE_SIZE = 128;
let _critterFireflyGlowTexture = null;
function getFireflyGlowTexture() {
  if (_critterFireflyGlowTexture) return _critterFireflyGlowTexture;
  const size = CRITTER_FIREFLY_GLOW_TEXTURE_SIZE;
  const r = size / 2;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const tctx = canvas.getContext('2d');
  const grad = tctx.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, 'rgba(223, 255, 138, 0.55)');
  grad.addColorStop(1, 'rgba(223, 255, 138, 0)');
  tctx.fillStyle = grad;
  tctx.beginPath();
  tctx.arc(r, r, r, 0, Math.PI * 2);
  tctx.fill();
  _critterFireflyGlowTexture = canvas;
  return canvas;
}

class CrittersManager {
  constructor() {
    this._time = 0;
    this.critters = [];

    const zc = CRITTER_WORLD_HEIGHT * CRITTER_ZONE_C_TOP_RATIO;
    const zb = CRITTER_WORLD_WIDTH * CRITTER_ZONE_B_RIGHT_RATIO;

    // Strefa A (łąka, lewy-dolny prostokąt) - motyle.
    for (let i = 0; i < CRITTER_COUNTS.butterfly; i++) {
      this.critters.push(this._spawn('butterfly',
        Math.random() * zb,
        zc + Math.random() * (CRITTER_WORLD_HEIGHT - zc)));
    }
    // Strefa B (bagno, prawy-dolny prostokąt) - świetliki.
    for (let i = 0; i < CRITTER_COUNTS.firefly; i++) {
      this.critters.push(this._spawn('firefly',
        zb + Math.random() * (CRITTER_WORLD_WIDTH - zb),
        zc + Math.random() * (CRITTER_WORLD_HEIGHT - zc)));
    }
    // Strefa C (popiół, górny pas) - wrony.
    for (let i = 0; i < CRITTER_COUNTS.crow; i++) {
      this.critters.push(this._spawn('crow',
        Math.random() * CRITTER_WORLD_WIDTH,
        Math.random() * zc));
    }
  }

  _spawn(kind, x, y) {
    const base = {
      kind,
      x, y,
      homeX: x,
      homeY: y,
      angle: Math.random() * Math.PI * 2,
      flapPhase: Math.random() * Math.PI * 2,
      turnSeed: Math.random() * 1000
    };
    if (kind === 'butterfly') {
      return {
        ...base,
        speed: 16 + Math.random() * 14,
        wanderRadius: 90 + Math.random() * 70,
        flapSpeed: 9 + Math.random() * 4,
        color: BUTTERFLY_COLORS[Math.floor(Math.random() * BUTTERFLY_COLORS.length)],
        size: 5 + Math.random() * 2.5
      };
    }
    if (kind === 'firefly') {
      return {
        ...base,
        speed: 6 + Math.random() * 6,
        wanderRadius: 70 + Math.random() * 60,
        blinkSpeed: 1.2 + Math.random() * 1.4,
        size: 2 + Math.random() * 1.2
      };
    }
    // crow - lot szerokimi łukami, wolniejsze skręty (turnSeed skalowany niżej).
    return {
      ...base,
      speed: 30 + Math.random() * 18,
      wanderRadius: 220 + Math.random() * 140,
      flapSpeed: 2.2 + Math.random() * 0.8,
      size: 8 + Math.random() * 3
    };
  }

  update(delta) {
    const sec = delta / 1000;
    this._time += sec;

    this.critters.forEach((c) => {
      // Losowy dryf kierunku - amplituda różna per gatunek (motyl fruwa
      // erratycznie, wrona leci szerokimi, spokojnymi łukami).
      const jitter = c.kind === 'butterfly' ? 2.4 : c.kind === 'crow' ? 0.5 : 1.1;
      c.angle += (Math.sin(this._time * 0.7 + c.turnSeed) * jitter) * sec;

      // Miękkie zawracanie do domu, gdy oddali się za bardzo - im dalej za
      // promień, tym mocniej kąt lotu jest "ciągnięty" w stronę domu.
      const dx = c.homeX - c.x;
      const dy = c.homeY - c.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > c.wanderRadius) {
        const homeAngle = Math.atan2(dy, dx);
        let diff = homeAngle - c.angle;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        c.angle += diff * Math.min(1, sec * 2);
      }

      c.x += Math.cos(c.angle) * c.speed * sec;
      c.y += Math.sin(c.angle) * c.speed * sec;
      c.flapPhase += (c.flapSpeed || 4) * sec;
    });
  }

  draw(ctxBg, ctx, ctxUI) {
    const camX = window.game ? window.game.cameraX : 0;
    const camY = window.game ? window.game.cameraY : 0;
    // window.innerWidth/innerHeight - patrz identyczny komentarz w ambient.js
    // (ten sam fix DPR w game.js zmienił znaczenie ctx.canvas.width/height).
    const viewW = window.innerWidth;
    const viewH = window.innerHeight;
    const margin = 60;

    this.critters.forEach((c) => {
      if (c.x < camX - margin || c.x > camX + viewW + margin) return;
      if (c.y < camY - margin || c.y > camY + viewH + margin) return;

      if (c.kind === 'butterfly') this._drawButterfly(ctx, c);
      else if (c.kind === 'firefly') this._drawFirefly(ctx, c);
      else this._drawCrow(ctx, c);
    });
  }

  /** Dwa "skrzydła" (elipsy) po obu stronach ciała, spłaszczane sin(flapPhase)
   * dla efektu trzepotania - obrócone w kierunku lotu (c.angle). */
  _drawButterfly(ctx, c) {
    const flap = Math.abs(Math.sin(c.flapPhase));
    const s = c.size;

    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(c.angle + Math.PI / 2);
    ctx.globalAlpha = 0.9;

    ctx.fillStyle = c.color;
    [-1, 1].forEach((side) => {
      ctx.save();
      ctx.scale(side, 1);
      ctx.beginPath();
      ctx.ellipse(s * 0.55, -s * 0.15, s * (0.35 + flap * 0.35), s * 0.6, 0.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    });

    ctx.fillStyle = 'rgba(40, 30, 20, 0.85)';
    ctx.beginPath();
    ctx.ellipse(0, 0, s * 0.1, s * 0.55, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /** Miękka pulsująca poświata - jaśniejsza przy szczycie "mrugnięcia".
   * Poświata to cache'owana tekstura (patrz getFireflyGlowTexture) skalowana
   * drawImage'em do promienia TEGO świetlika - globalAlpha=blink daje
   * dokładnie ten sam efekt co dawne `0.55 * blink` w gradiencie (globalAlpha
   * mnoży istniejącą alfę źródła), bez przeliczania gradientu co klatkę. */
  _drawFirefly(ctx, c) {
    const blink = 0.35 + 0.65 * Math.max(0, Math.sin(this._time * c.blinkSpeed + c.turnSeed));
    const glowR = c.size * 5;
    const glowTexture = getFireflyGlowTexture();

    ctx.save();
    ctx.globalAlpha = blink;
    ctx.drawImage(glowTexture, c.x - glowR, c.y - glowR, glowR * 2, glowR * 2);

    ctx.globalAlpha = 0.7 + blink * 0.3;
    ctx.fillStyle = '#F4FFB0';
    ctx.beginPath();
    ctx.arc(c.x, c.y, c.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /**
   * Wypełniona sylwetka "M" (dwa skrzydła + korpus) - wolne trzepotanie,
   * ciemna, płaska barwa (popielata Strefa C, kontrast z jasnym niebem).
   *
   * BUGFIX ("ptaki latają do góry nogami"): dawniej całą sylwetkę obracało
   * ctx.rotate(c.angle) o pełny kąt lotu - skrzydła leżą wzdłuż LOKALNEJ osi
   * X, więc obrót o kąt lotu ustawiał rozpiętość skrzydeł RÓWNOLEGLE do
   * kierunku ruchu zamiast prostopadle do niego, a przy locie w lewo
   * (angle ~180°) sylwetka (asymetryczna góra/dół: dzióbki skrzydeł w górę,
   * korpus w dół) obracała się o pół obrotu - czyli faktycznie do góry
   * nogami. Kształt jest już symetryczny lewo-prawo, więc wcale nie
   * potrzebuje obrotu, żeby czytać się poprawnie w KAŻDYM kierunku lotu -
   * po prostu go nie obracamy.
   *
   * BUGFIX ("ptaki nie pasują do reszty"): dawniej sam CIENKI KONTUR (jeden
   * stroke() bez wypełnienia) - obok wypełnionego motyla (ciało+skrzydła w
   * kolorze) i świetlika (poświata+ciało) wyglądał jak druciana ramka, nie
   * stworzenie. Skrzydła są teraz WYPEŁNIONYM kształtem (nie samą kreską) -
   * ten sam "domknięty poligon" co reszta - z cieńszym, jaśniejszym
   * obrysem na krawędzi natarcia dla odrobiny objętości. Kształt nadal
   * dokładnie symetryczny lewo-prawo (patrz BUGFIX wyżej) - bezpieczny
   * bez rotacji w każdym kierunku lotu.
   */
  _drawCrow(ctx, c) {
    const flap = Math.sin(c.flapPhase) * 0.5;
    const s = c.size;
    const tipY = -flap * s * 0.7;

    ctx.save();
    ctx.translate(c.x, c.y);

    // BUGFIX (kontrast): pierwsza wypełniona wersja użyła prawie czarnego
    // koloru (26,24,30) - realistyczne dla wrony, ale krążą one głównie nad
    // Strefą C (popiół, TEŻ prawie czarny - patrz ash.png), więc sylwetka
    // ginęła w tle niemal całkowicie, nawet po pierwszej próbie rozjaśnienia
    // (72,68,80 wciąż za blisko tonu popiołu). Wyraźnie jaśniejszy,
    // fioletowawy szary - czyta się jako "ptak o zmierzchu", nie realistyczna
    // czerń, ale ZAWSZE odróżnialny od podłoża pod nim, na każdej strefie.
    ctx.fillStyle = 'rgba(158, 151, 172, 0.95)';
    ctx.beginPath();
    ctx.moveTo(-s, tipY);
    ctx.quadraticCurveTo(-s * 0.4, s * 0.32, 0, s * 0.02);
    ctx.quadraticCurveTo(s * 0.4, s * 0.32, s, tipY);
    ctx.quadraticCurveTo(s * 0.55, s * 0.06, 0, s * 0.24);
    ctx.quadraticCurveTo(-s * 0.55, s * 0.06, -s, tipY);
    ctx.closePath();
    ctx.fill();

    // Ciemny kontur wokół całej sylwetki - domyka kształt niezależnie od
    // tego, jak jasne/ciemne akurat jest tło pod spodem (trawa/bagno/popiół).
    ctx.strokeStyle = 'rgba(8, 7, 12, 0.85)';
    ctx.lineWidth = Math.max(1, s * 0.1);
    ctx.lineJoin = 'round';
    ctx.stroke();

    // Jaśniejszy akcent na krawędzi natarcia skrzydeł - odróżnia je od
    // reszty sylwetki, ten sam duch co jasne brzegi płatków motyla.
    ctx.strokeStyle = 'rgba(232, 228, 238, 0.85)';
    ctx.lineWidth = Math.max(1, s * 0.1);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-s, tipY);
    ctx.quadraticCurveTo(-s * 0.4, s * 0.32, 0, s * 0.02);
    ctx.quadraticCurveTo(s * 0.4, s * 0.32, s, tipY);
    ctx.stroke();

    ctx.restore();
  }

  destroy() {
    this.critters = [];
  }
}

window.CrittersManager = CrittersManager;
