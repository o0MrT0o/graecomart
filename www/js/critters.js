'use strict';

/**
 * critters.js
 * ------------------------------------------------------------------------
 * Drobne, czysto dekoracyjne stworzenia ożywiające mapę - motyle (Strefa A),
 * świetliki (Strefa B), wrony (Strefa C), kryształowe iskry (Strefa D). Zero
 * wpływu na rozgrywkę (gracz nie może ich dotknąć/złapać), zero zależności
 * od assetów - proceduralne kształty rysowane Canvasem, ten sam duch co
 * ItemRenderer._drawIngot (items.js) dla stopu bez sprite'a.
 *
 * Kolory motyli/świetlików/wron są KLUCZOWANE aktywną planetą (patrz
 * BUTTERFLY_COLOR_SETS/FIREFLY_COLOR_SETS/CROW_COLOR_SETS i
 * _currentDecorSetIndex niżej - ta sama funkcja co Game._currentDecorSetIndex
 * w game.js, własna kopia zgodnie z konwencją) - inna paleta na zimowym i
 * pustynnym świecie, tak jak reszta dekoracji. Iskry Strefy D mają jedną,
 * stałą fioletową paletę NIEZALEŻNIE od planety - sama Grań nie reskinuje
 * się między planetami (patrz komentarz przy getWispGlowTexture).
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

// UFO (jedyne stworzenie NIE zamknięte w jednej strefie - "gość" przelatujący
// nad całą mapą) roams PEŁNEJ szerokości świata (GAME_WORLD_WIDTH w game.js),
// nie samego "rdzenia" A/B/C jak reszta - własna kopia zgodnie z konwencją.
const CRITTER_UFO_WORLD_WIDTH = 1750;
const CRITTER_UFO_WORLD_HEIGHT = 2000;

const CRITTER_COUNTS = { butterfly: 6, firefly: 7, crow: 3, ufo: 1, wisp: 5 };

// Palety KLUCZOWANE ZESTAWEM DEKORACJI (DECOR_SETS w game.js: 0=domyślny,
// 1=zimowy, 2=pustynny - patrz _currentDecorSetIndex niżej, ta sama
// deterministyczna funkcja planetNumber->indeks co w game.js, własna kopia
// zgodnie z konwencją projektu). BUGFIX (Tomek: "stworzonka nie reagują na
// zmianę planety") - motyle/świetliki/wrony miały STAŁE kolory niezależnie
// od tego, czy gracz jest na zimowym czy pustynnym świecie, mimo że reszta
// (dekoracje, tekstury, paproć) dostała już per-planetową paletę.
const BUTTERFLY_COLOR_SETS = [
  ['#F48FB1', '#FFCC80', '#CE93D8', '#81D4FA', '#FFF176'], // domyślny - łąka
  ['#B3E5FC', '#E1F5FE', '#B2EBF2', '#CFD8DC', '#E8EAF6'], // zimowy - lodowe/srebrne tony
  ['#FFAB91', '#FFE082', '#FFCC80', '#D7CCC8', '#F8BBD0']  // pustynny - piaskowe/terakotowe tony
];
const FIREFLY_COLOR_SETS = [
  { glow: 'rgba(223, 255, 138, 0.55)', body: '#F4FFB0' }, // domyślny - żółto-zielona poświata
  { glow: 'rgba(179, 229, 252, 0.55)', body: '#E1F5FE' }, // zimowy - blady błękit (mróz)
  { glow: 'rgba(255, 204, 128, 0.55)', body: '#FFE0B2' }  // pustynny - ciepła bursztynowa poświata
];
const CROW_COLOR_SETS = [
  'rgba(158, 151, 172, 0.95)', // domyślny - fioletowawy szary
  'rgba(203, 219, 232, 0.95)', // zimowy - blady niebiesko-biały (śnieżny ptak)
  'rgba(191, 149, 115, 0.95)'  // pustynny - ciepły piaskowy brąz
];

// BUGFIX (przycinanie na telefonie): _drawFirefly tworzyła NOWY
// createRadialGradient KAŻDĄ klatkę, dla KAŻDEGO świetlika (do 7 naraz) -
// dokładnie ten sam błąd, który ItemRenderer._getGlowTexture (items.js) już
// raz naprawił dla przedmiotów. Kolor/kształt poświaty są zawsze te same w
// obrębie JEDNEJ planety, jedyne co się zmienia w locie to promień (per
// świetlik, stały - c.size się nie zmienia) i jasność (blink) - więc
// pieczemy JEDNĄ teksturę NA ZESTAW (lazy, dopiero gdy dana planeta faktycznie
// się pojawi - nie wszystkie 3 z góry) i modulujemy jasność przez globalAlpha
// zamiast przeliczać gradient od nowa. Tablica indeksowana _currentDecorSetIndex(),
// nie pojedyncza zmienna jak poprzednio - inny kolor na każdą planetę.
const CRITTER_FIREFLY_GLOW_TEXTURE_SIZE = 128;
const _critterFireflyGlowTextures = [];
function getFireflyGlowTexture(setIndex) {
  if (_critterFireflyGlowTextures[setIndex]) return _critterFireflyGlowTextures[setIndex];
  const size = CRITTER_FIREFLY_GLOW_TEXTURE_SIZE;
  const r = size / 2;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const tctx = canvas.getContext('2d');
  const glowColor = (FIREFLY_COLOR_SETS[setIndex] || FIREFLY_COLOR_SETS[0]).glow;
  const grad = tctx.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, glowColor);
  grad.addColorStop(1, glowColor.replace(/[\d.]+\)$/, '0)'));
  tctx.fillStyle = grad;
  tctx.beginPath();
  tctx.arc(r, r, r, 0, Math.PI * 2);
  tctx.fill();
  _critterFireflyGlowTextures[setIndex] = canvas;
  return canvas;
}

// Poświata kryształowej iskry (Strefa D) - NIEZALEŻNA od DECOR_SETS (Grań ma
// tę samą tożsamość kolorystyczną - fiolet/błękit kryształu, patrz
// _bakeCrystalDecorTexture w game.js - na KAŻDEJ planecie, nie reskinuje się
// jak reszta stref), więc jedna stała teksura wystarczy, bez tablicy per-set.
const CRITTER_WISP_GLOW_TEXTURE_SIZE = 128;
let _critterWispGlowTexture = null;
function getWispGlowTexture() {
  if (_critterWispGlowTexture) return _critterWispGlowTexture;
  const size = CRITTER_WISP_GLOW_TEXTURE_SIZE;
  const r = size / 2;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const tctx = canvas.getContext('2d');
  const grad = tctx.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, 'rgba(179, 136, 255, 0.55)');
  grad.addColorStop(1, 'rgba(179, 136, 255, 0)');
  tctx.fillStyle = grad;
  tctx.beginPath();
  tctx.arc(r, r, r, 0, Math.PI * 2);
  tctx.fill();
  _critterWispGlowTexture = canvas;
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
    // Cała mapa (bez podziału na strefy) - UFO, "gość" przelatujący ponad
    // wszystkim, w tym Strefą D (Kryształowa Grań), której reszta stworzeń
    // w ogóle nie odwiedza (żadne z powyższych spawnów nie sięga poza
    // CRITTER_WORLD_WIDTH=1400).
    for (let i = 0; i < CRITTER_COUNTS.ufo; i++) {
      this.critters.push(this._spawn('ufo',
        Math.random() * CRITTER_UFO_WORLD_WIDTH,
        Math.random() * CRITTER_UFO_WORLD_HEIGHT));
    }
    // BUGFIX (Tomek: "Strefa D jest uboga, żadnych stworzeń jak w pozostałych
    // strefach"): Kryształowa Grań (pas na PEŁNEJ wysokości na prawo od
    // CRITTER_WORLD_WIDTH, patrz obszerny komentarz przy GAME_ZONE_CORE_WIDTH
    // w game.js) miała dotąd tylko przelatujące co jakiś czas UFO (gościa
    // znad CAŁEJ mapy) - żadnego WŁASNEGO stworzenia jak motyle/świetliki/
    // wrony w A/B/C. Kryształowe iskry - jedyne stworzenie zamknięte w tym
    // pasie, jak reszta powyżej.
    for (let i = 0; i < CRITTER_COUNTS.wisp; i++) {
      this.critters.push(this._spawn('wisp',
        CRITTER_WORLD_WIDTH + Math.random() * (CRITTER_UFO_WORLD_WIDTH - CRITTER_WORLD_WIDTH),
        Math.random() * CRITTER_WORLD_HEIGHT));
    }
  }

  /** Który zestaw kolorów stworzeń (BUTTERFLY_COLOR_SETS/FIREFLY_COLOR_SETS/
   * CROW_COLOR_SETS) jest teraz aktywny - DOKŁADNIE ta sama funkcja co
   * Game._currentDecorSetIndex (własna kopia, konwencja projektu: brak
   * współdzielonych utili), żeby stworzenia zawsze pasowały kolorem do tej
   * samej planety co dekoracje/tekstury terenu. Brak economyManager (bardzo
   * wczesne wywołanie) -> zestaw 0, tak samo jak w game.js. */
  _currentDecorSetIndex() {
    const planetNumber = (window.economyManager && window.economyManager.planetNumber) || 1;
    return (planetNumber - 1) % 3;
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
        // Indeks w palecie, NIE gotowy kolor - żeby zmiana planety (patrz
        // BUTTERFLY_COLOR_SETS/_currentDecorSetIndex) od razu przemalowała
        // WSZYSTKIE motyle, zamiast zamrażać kolor wylosowany raz przy
        // starcie sesji (przed pierwszym prestige'em).
        colorIndex: Math.floor(Math.random() * BUTTERFLY_COLOR_SETS[0].length),
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
    if (kind === 'crow') {
      // Lot szerokimi łukami, wolniejsze skręty (turnSeed skalowany niżej).
      return {
        ...base,
        speed: 30 + Math.random() * 18,
        wanderRadius: 220 + Math.random() * 140,
        flapSpeed: 2.2 + Math.random() * 0.8,
        size: 8 + Math.random() * 3
      };
    }
    if (kind === 'wisp') {
      // Ten sam duch co świetlik (poświata + mruganie), ale wolniejsza,
      // "magiczna" - Strefa D to niebezpieczny hazard bez odpowiedniego
      // sprzętu (patrz ZONE_HAZARD_* w player.js), iskry mają czytać się
      // jako spokojne/eteryczne, nie żywe robactwo.
      return {
        ...base,
        speed: 5 + Math.random() * 5,
        wanderRadius: 60 + Math.random() * 50,
        blinkSpeed: 0.9 + Math.random() * 1,
        size: 2 + Math.random() * 1.4
      };
    }
    // ufo - bardzo wolny, spokojny dryf (wanderRadius obejmuje praktycznie
    // całą mapę, więc w praktyce prawie nigdy nie "zawraca do domu" - po
    // prostu leniwie przemierza całość). flapPhase tu NIE macha skrzydłami
    // (brak ich), tylko steruje powolnym pionowym "bobbingiem" w _drawUfo.
    return {
      ...base,
      speed: 14 + Math.random() * 6,
      wanderRadius: 700,
      flapSpeed: 0.6 + Math.random() * 0.2,
      size: 1
    };
  }

  update(delta) {
    const sec = delta / 1000;
    this._time += sec;

    this.critters.forEach((c) => {
      // Losowy dryf kierunku - amplituda różna per gatunek (motyl fruwa
      // erratycznie, wrona leci szerokimi, spokojnymi łukami, UFO dryfuje
      // niemal po linii prostej - "spokojny gość", nie żywe stworzenie).
      const jitter = c.kind === 'butterfly' ? 2.4
        : c.kind === 'crow' ? 0.5
        : c.kind === 'ufo' ? 0.2
        : 1.1;
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
      else if (c.kind === 'ufo') this._drawUfo(ctx, c);
      else if (c.kind === 'wisp') this._drawCrystalWisp(ctx, c);
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

    const palette = BUTTERFLY_COLOR_SETS[this._currentDecorSetIndex()] || BUTTERFLY_COLOR_SETS[0];
    ctx.fillStyle = palette[c.colorIndex % palette.length];
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
    const setIndex = this._currentDecorSetIndex();
    const colors = FIREFLY_COLOR_SETS[setIndex] || FIREFLY_COLOR_SETS[0];
    const blink = 0.35 + 0.65 * Math.max(0, Math.sin(this._time * c.blinkSpeed + c.turnSeed));
    const glowR = c.size * 5;
    const glowTexture = getFireflyGlowTexture(setIndex);

    ctx.save();
    ctx.globalAlpha = blink;
    ctx.drawImage(glowTexture, c.x - glowR, c.y - glowR, glowR * 2, glowR * 2);

    ctx.globalAlpha = 0.7 + blink * 0.3;
    ctx.fillStyle = colors.body;
    ctx.beginPath();
    ctx.arc(c.x, c.y, c.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /** Kryształowa iskra - jedyne stworzenie zamknięte w Strefie D (Kryształowa
   * Grań), ten sam duch co świetlik (cache'owana poświata + drobne jądro,
   * patrz getWispGlowTexture), ale w fioletowo-błękitnej palecie kryształu
   * (NIEZALEŻNEJ od planety, patrz komentarz przy getWispGlowTexture) i z
   * czteroramiennym "twinkle" zamiast okrągłego jądra świetlika - czytelnie
   * inny kształt na pierwszy rzut oka, nie tylko inny kolor. */
  _drawCrystalWisp(ctx, c) {
    const blink = 0.35 + 0.65 * Math.max(0, Math.sin(this._time * c.blinkSpeed + c.turnSeed));
    const glowR = c.size * 6;
    const glowTexture = getWispGlowTexture();

    ctx.save();
    ctx.globalAlpha = blink;
    ctx.drawImage(glowTexture, c.x - glowR, c.y - glowR, glowR * 2, glowR * 2);

    ctx.globalAlpha = 0.75 + blink * 0.25;
    ctx.fillStyle = '#E9DFFF';
    ctx.translate(c.x, c.y);
    const s = c.size * 1.8;
    ctx.beginPath();
    ctx.moveTo(0, -s);
    ctx.lineTo(s * 0.28, -s * 0.28);
    ctx.lineTo(s, 0);
    ctx.lineTo(s * 0.28, s * 0.28);
    ctx.lineTo(0, s);
    ctx.lineTo(-s * 0.28, s * 0.28);
    ctx.lineTo(-s, 0);
    ctx.lineTo(-s * 0.28, -s * 0.28);
    ctx.closePath();
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
    // Reszta palety (CROW_COLOR_SETS) per-planetowa (patrz komentarz przy
    // niej) - dobrana z tą samą zasadą kontrastu wobec przebarwionego popiołu.
    ctx.fillStyle = CROW_COLOR_SETS[this._currentDecorSetIndex()] || CROW_COLOR_SETS[0];
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

  /**
   * JEDYNE stworzenie rysowane prawdziwym sprite'em (shipGreen_manned.png,
   * Kenney "Alien UFO Pack" CC0) zamiast kształtu Canvasa - reszta
   * critters.js jest proceduralna (patrz nagłówek pliku), ale Tomek poprosił
   * konkretnie o TĘ grafikę ("dodaj tę ufo"/"dodaj na górę ten klosz") -
   * "_manned" to WŁAŚNIE wariant z przezroczystym kloszem/kokpitem i obcym
   * widocznym w środku (zamiast gołego spodka bez klosza z pierwszej wersji).
   * Mniejszy niż pierwsza wersja (w=46->30, Tomek: "niech będzie mniejsze").
   * Cień-elipsa na "ziemi" (bez transformacji, niezależnie od bobbingu statku
   * nad nim) sprzedaje wysokość lotu - ten sam trik co cienie dekoracji
   * sprite'owych w game.js (_drawDecorations). Delikatny pionowy bobbing (sin
   * z flapPhase) + bardzo lekkie przechylenie w stronę ruchu (nie pełny obrót
   * do c.angle, bo grafika NIE jest czystym widokiem z góry - przechylenie ma
   * tylko sugerować manewrowanie, nie łamać czytelności kształtu).
   */
  _drawUfo(ctx, c) {
    const bob = Math.sin(c.flapPhase) * 4;
    const w = 30;
    const h = w * (123 / 124);

    // BUGFIX: h*0.9 było dobrane pod STARY, spłaszczony sprite (68/124 -
    // spodek bez klosza). "_manned" jest prawie kwadratowy (klosz + kokpit
    // zajmują górną połowę), więc dolna krawędź spodka wypada bliżej
    // h*0.48 (tuż przy dolnej krawędzi obrazka), NIE h*0.9 - to drugie
    // rzucałoby cień daleko pod statkiem, w oderwaniu od niego.
    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = 'rgba(10, 15, 10, 0.9)';
    ctx.beginPath();
    ctx.ellipse(c.x, c.y + h * 0.48, w * 0.32, w * 0.1, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    const img = window.spriteLoader && window.spriteLoader.get('critter_ufo');
    ctx.save();
    ctx.translate(c.x, c.y + bob);
    ctx.rotate(Math.cos(c.angle) * 0.08);
    if (img && img.complete && img.naturalWidth) {
      ctx.drawImage(img, -w / 2, -h / 2, w, h);
    } else {
      // Sprite jeszcze niewczytany (rzadki, jednorazowy stan tuż po starcie
      // gry) - prosty zielony spodek zamiast pustego miejsca.
      ctx.fillStyle = '#66BB6A';
      ctx.beginPath();
      ctx.ellipse(0, 0, w * 0.45, h * 0.4, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  destroy() {
    this.critters = [];
  }
}

window.CrittersManager = CrittersManager;
