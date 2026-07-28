'use strict';

/**
 * items.js
 * ------------------------------------------------------------------------
 * Przedmioty do zbierania rozstawione w świecie gry (śmieci/surowce).
 * ItemManager pilnuje spawnu, animacji bujania oraz wykrywania pickupu.
 *
 * ItemRenderer — współdzielony renderer kart przedmiotów (świat, stos, UI).
 */

const ITEM_TYPES = [
  { id: 'trash', label: '🗑️', color: '#78909C', name: 'Śmieci', rarity: 'common' },
  { id: 'plastic', label: '♻️', color: '#42A5F5', name: 'Plastik', rarity: 'common' },
  { id: 'paper', label: '📄', color: '#FFF176', name: 'Papier', rarity: 'common' },
  { id: 'metal', label: '⚙️', color: '#B0BEC5', name: 'Metal', rarity: 'uncommon' },
  { id: 'glass', label: '💎', color: '#80DEEA', name: 'Szkło', rarity: 'uncommon' },
  { id: 'product', label: '🎁', color: '#AB47BC', name: 'Produkt', rarity: 'rare' },
  // Jedyny surowiec Strefy D (Kryształowa Grań) - patrz ITEM_TYPE_ZONE niżej.
  // Pierwszy przedmiot z rzadkością 'epic' (dotąd zdefiniowaną w ITEM_RARITY,
  // ale niewykorzystaną) - najrzadszy, najcenniejszy surowiec ze świata,
  // zgodnie z tym, że D to najtrudniej dostępna strefa (wymaga OBU strojów).
  { id: 'crystal_shard', label: '💠', color: '#9575CD', name: 'Odłamek Kryształu', rarity: 'epic' }
];

// --- Świat (Faza 2b: mapa większa niż ekran) --------------------------------
// Te same wartości co w game.js/player.js/machines.js/market.js.
const ITEM_WORLD_WIDTH = 1400;
const ITEM_WORLD_HEIGHT = 2000;

// --- Strefy mapy (Faza 2) ---------------------------------------------------
// Strefa C (Zrujnowana Fabryka / Atomowa) zajmuje górny pas całej szerokości.
// Strefa B (Toksyczne Bagno) zajmuje prawy pas, PONIŻEJ pasa Strefy C (żeby
// nie nachodziły się w prawym górnym rogu). Reszta to Strefa A (bezpieczna).
// Te same progi żyją też w player.js (hazard) i game.js (wizualia mgły/popiołu)
// - każdy plik jest samodzielny, bez współdzielonych utili (konwencja projektu).
// Liczone teraz względem ŚWIATA (ITEM_WORLD_*), nie widoku (canvas.width/height).
const ITEM_ZONE_C_TOP_RATIO = 0.32;
const ITEM_ZONE_B_RIGHT_RATIO = 0.62;
// Strefa D (Kryształowa Grań) - SAMODZIELNY róg prawy-górny (patrz identyczne
// stałe i obszerny komentarz przy GAME_ZONE_D_LEFT_RATIO w game.js).
const ITEM_ZONE_D_LEFT_RATIO = 0.78;
const ITEM_ZONE_D_BOTTOM_RATIO = 0.5;

// Który surowiec spawnuje się w której strefie. Typy nieujęte tutaj (plastic,
// product) trafiają domyślnie do Strefy A - i tak spawnują się głównie jako
// output maszyn (_spawnSpecificAt), nie przez losowy spawn w świecie.
const ITEM_TYPE_ZONE = {
  trash: 'A',
  paper: 'A',
  glass: 'B',
  metal: 'C',
  crystal_shard: 'D'
};

const ITEM_RARITY = {
  common:    { border: '#B0BEC5', glow: 'rgba(176, 190, 197, 0.55)', label: 'Zwykły' },
  uncommon:  { border: '#66BB6A', glow: 'rgba(102, 187, 106, 0.6)', label: 'Nietypowy' },
  rare:      { border: '#FFD54F', glow: 'rgba(255, 213, 79, 0.75)', label: 'Rzadki' },
  epic:      { border: '#AB47BC', glow: 'rgba(171, 71, 188, 0.75)', label: 'Epicki' }
};

const ITEM_SPAWN_MARGIN = 24;
const ITEM_PICKUP_RADIUS = 55;
const ITEM_VISUAL_SIZE = 36;
const ITEM_BOB_FREQUENCY = 1.8;
const ITEM_RESPAWN_THRESHOLD = 6;
const ITEM_RESPAWN_BATCH = 3;
const ITEM_SPAWN_ANIM_SPEED = 5;
const ITEM_GLOW_RADIUS_MULT = 2;
const ITEM_IDLE_PULSE_SPEED = 2.4;

// BUGFIX (przycinanie na telefonie): drawWorld/drawStack tworzyły NOWY
// createRadialGradient dla KAŻDEGO przedmiotu, KAŻDĄ klatkę - dla wszystkich
// przedmiotów na mapie (do 25) I wszystkich w plecaku gracza naraz, 60x/s.
// Kolor/rzadkość poświaty zależą tylko od TYPU przedmiotu (stałe), jedyne co
// faktycznie zmienia się w locie to PROMIEŃ (animacja pulsu/spawnu/zbliżenia)
// - więc pieczemy jedną teksturę poświaty NA KOMBINACJĘ koloru/rzadkości/alpha
// (garstka, nie setki) w stałym rozmiarze, a w draw() tylko skalujemy ją
// przez drawImage (tanie, sprzętowo przyspieszone) do aktualnego promienia.
const ITEM_GLOW_TEXTURE_SIZE = 128;
const ITEM_GLOW_TEXTURE_CACHE = {};

/**
 * Współdzielony renderer przedmiotów — używany przez ItemManager, StackController
 * oraz opcjonalnie przez UI (miniatury kart).
 */
class ItemRenderer {
  static getTypeMeta(typeId) {
    return ITEM_TYPES.find((t) => t.id === typeId) || null;
  }

  static getRarity(typeId, fallback = 'common') {
    const meta = ItemRenderer.getTypeMeta(typeId);
    return (meta && meta.rarity) || fallback;
  }

  static getRarityStyle(rarity) {
    return ITEM_RARITY[rarity] || ITEM_RARITY.common;
  }

  static withAlpha(hex, alpha) {
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

  static _lighten(hex, amount) {
    const num = parseInt(String(hex).replace('#', ''), 16);
    if (Number.isNaN(num)) return hex;
    const r = Math.min(255, (num >> 16) + amount);
    const g = Math.min(255, ((num >> 8) & 0xFF) + amount);
    const b = Math.min(255, (num & 0xFF) + amount);
    return `rgb(${r}, ${g}, ${b})`;
  }

  static _traceRoundedRect(ctx, x, y, w, h, r) {
    if (w <= 0 || h <= 0) return;
    const radius = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(x, y, w, h, radius);
      return;
    }
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
    ctx.lineTo(x + w, y + h - radius);
    ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
    ctx.lineTo(x + radius, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
  }

  /**
   * Zwraca (i cache'uje) upieczoną teksturę poświaty dla danej kombinacji
   * kolor+kolorRzadkości+alpha - patrz komentarz przy ITEM_GLOW_TEXTURE_CACHE.
   * Pieczona RAZ na kombinację (garstka typów przedmiotów), w stałym
   * rozmiarze ITEM_GLOW_TEXTURE_SIZE - wywołujący skaluje ją drawImage'em do
   * aktualnego promienia zamiast tworzyć nowy gradient za każdym razem.
   */
  static _getGlowTexture(color, rarityGlow, innerAlpha) {
    const key = `${color}|${rarityGlow}|${innerAlpha}`;
    const cached = ITEM_GLOW_TEXTURE_CACHE[key];
    if (cached) return cached;

    const size = ITEM_GLOW_TEXTURE_SIZE;
    const r = size / 2;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const tctx = canvas.getContext('2d');

    const grad = tctx.createRadialGradient(r, r, 0, r, r, r);
    grad.addColorStop(0, ItemRenderer.withAlpha(color, innerAlpha));
    grad.addColorStop(0.5, rarityGlow);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    tctx.fillStyle = grad;
    tctx.beginPath();
    tctx.arc(r, r, r, 0, Math.PI * 2);
    tctx.fill();

    ITEM_GLOW_TEXTURE_CACHE[key] = canvas;
    return canvas;
  }

  static _drawSpriteOrLabel(ctx, typeId, label, x, y, size) {
    const key = window.spriteLoader && window.spriteLoader.spriteKeyForType(typeId);
    if (key && window.spriteLoader.draw(ctx, key, x, y, size)) return;
    // 'alloy' (stop z Pieca Hutniczego) celowo NIE ma pliku PNG w projekcie -
    // nie spawnuje się nigdy losowo w świecie jak reszta typów, tylko jako
    // output maszyny (patrz machines.js), więc nigdy nie dostał osobnego
    // sprite'a od Tomka. Zamiast wracać do emoji '🧱' rysujemy prostą
    // proceduralną sztabkę - spójne z "żadnych emotek" nawet tam, gdzie
    // brakuje prawdziwej grafiki źródłowej.
    if (typeId === 'alloy') {
      ItemRenderer._drawIngot(ctx, x, y, size);
      return;
    }
    // 'crystal' (z Oczyszczalni) i 'crystal_shard' (ze Strefy D) - ta sama
    // sytuacja co alloy wyżej: brak pliku PNG, więc dotąd leciały na emoji.
    // Poza złamaniem zasady "żadnych emotek" miały przez to WIDOCZNIE inny
    // rozmiar niż reszta ikon (fallback rysuje na size*0.52, sprite na pełnym
    // size), co najbardziej rzucało się w oczy w cenniku terminala, gdzie
    // wszystkie pięć stoi jedna pod drugą.
    if (typeId === 'crystal' || typeId === 'crystal_shard') {
      ItemRenderer._drawCrystal(ctx, x, y, size, typeId === 'crystal_shard');
      return;
    }
    ctx.font = `${size * 0.52}px "Segoe UI Emoji", Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label || '?', x, y);
  }

  /**
   * Proceduralna sztabka metalu - trapez z pionowym gradientem (jaśniejsza
   * góra, ciemniejszy dół, cienki jasny odblask u góry) zamiast płaskiego
   * koloru, żeby czytała się jako bryła, nie naklejka. Kolor bazowy ten sam,
   * co #D4A574 używane gdzie indziej dla alloy (machines.js/market.js/ship.js).
   */
  static _drawIngot(ctx, x, y, size, color = '#D4A574') {
    const w = size * 0.78;
    const h = size * 0.46;
    const skew = w * 0.16;

    // BUGFIX (przycinanie na telefonie): shadowBlur jest jedną z najdroższych
    // operacji Canvas (zwłaszcza na mobilnym WebView, często bez sprzętowego
    // przyspieszenia) - a sztabka i tak ma już gradient+obrys+odblask dający
    // wrażenie bryły, więc miękki cień był drobnym dodatkiem niewartym kosztu
    // przy przedmiocie rysowanym co klatkę. Usunięty, reszta bez zmian.
    const grad = ctx.createLinearGradient(x, y - h / 2, x, y + h / 2);
    grad.addColorStop(0, ItemRenderer._lighten(color, 45));
    grad.addColorStop(0.55, color);
    grad.addColorStop(1, ItemRenderer._lighten(color, -40));

    ctx.fillStyle = grad;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.4)';
    ctx.lineWidth = Math.max(1, size * 0.035);
    ctx.beginPath();
    ctx.moveTo(x - w / 2 + skew, y - h / 2);
    ctx.lineTo(x + w / 2 - skew, y - h / 2);
    ctx.lineTo(x + w / 2, y + h / 2);
    ctx.lineTo(x - w / 2, y + h / 2);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Cienki jasny odblask tuż pod górną krawędzią - sugeruje metaliczny połysk.
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.lineWidth = Math.max(1, size * 0.025);
    ctx.beginPath();
    ctx.moveTo(x - w / 2 + skew + 2, y - h / 2 + size * 0.08);
    ctx.lineTo(x + w / 2 - skew - 2, y - h / 2 + size * 0.08);
    ctx.stroke();
  }

  /**
   * Proceduralny szlifowany kryształ - sześciokątna bryła z liniami facetów
   * i szklanym połyskiem, tą samą paletą co dekoracje strefy D
   * (_bakeCrystalDecorTexture w game.js: #4527A0/#B39DDB/#7E57C2 + ciemny
   * obrys), żeby ikona w terminalu pasowała do tego, co gracz widzi w
   * świecie. Rysowana na pełnym `size`, nie `size*0.52` jak stary fallback
   * emoji - inaczej wyglądała mniejsza niż pozostałe ikony na liście cen.
   */
  static _drawCrystal(ctx, x, y, size, isShard = false) {
    const w = size * (isShard ? 0.46 : 0.74);
    const h = size * (isShard ? 0.88 : 0.74);

    ctx.save();
    ctx.translate(x, y);
    if (isShard) ctx.rotate(-0.12);

    const top = { x: 0, y: -h / 2 };
    const right = { x: w / 2, y: -h * 0.1 };
    const bottomRight = { x: w * 0.3, y: h / 2 };
    const bottomLeft = { x: -w * 0.3, y: h / 2 };
    const left = { x: -w / 2, y: -h * 0.1 };
    const center = { x: 0, y: h * 0.08 };

    const grad = ctx.createLinearGradient(-w / 2, -h / 2, w / 2, h / 2);
    grad.addColorStop(0, '#B39DDB');
    grad.addColorStop(0.5, '#7E57C2');
    grad.addColorStop(1, '#4527A0');

    ctx.beginPath();
    ctx.moveTo(top.x, top.y);
    ctx.lineTo(right.x, right.y);
    ctx.lineTo(bottomRight.x, bottomRight.y);
    ctx.lineTo(bottomLeft.x, bottomLeft.y);
    ctx.lineTo(left.x, left.y);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.lineWidth = Math.max(1, size * 0.035);
    ctx.stroke();

    // Linie facetów - schodzą się w jednym punkcie na środku, sprzedają
    // wrażenie oszlifowanej bryły zamiast płaskiego wielokąta.
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.25)';
    ctx.lineWidth = Math.max(1, size * 0.02);
    ctx.beginPath();
    [top, left, right, bottomLeft, bottomRight].forEach((p) => {
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(center.x, center.y);
    });
    ctx.stroke();

    // Szklany połysk wzdłuż jednej krawędzi.
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.lineWidth = Math.max(1, size * 0.025);
    ctx.beginPath();
    ctx.moveTo(top.x, top.y + size * 0.06);
    ctx.lineTo(left.x + w * 0.12, left.y + size * 0.05);
    ctx.stroke();

    ctx.restore();
  }

  static drawWorld(ctx, item, time = 0) {
    const y = item._drawY ?? item.y;
    const baseSize = item.size || ITEM_VISUAL_SIZE;
    const scale = (item.scale ?? 1) * (1 + (item.proximity || 0) * 0.1);
    const s = baseSize * scale;
    if (s <= 0) return;

    const rarity = ItemRenderer.getRarity(item.typeId);
    const rarityStyle = ItemRenderer.getRarityStyle(rarity);
    const pulse = 1 + Math.sin(time * ITEM_IDLE_PULSE_SPEED + (item.bobPhase || 0)) * 0.05;
    const drawSize = s * 1.15 * pulse;

    // BUGFIX (przycinanie na telefonie): tu i w drawStack() powstawał NOWY
    // createRadialGradient dla KAŻDEGO przedmiotu na mapie, KAŻDĄ klatkę -
    // patrz komentarz przy ITEM_GLOW_TEXTURE_CACHE. Kolor/rzadkość są STAŁE
    // per typ, więc poświata jest upieczoną teksturą, przeskalowaną
    // drawImage'em (tanie) do aktualnego (animowanego) promienia.
    const glowR = drawSize * 0.75;
    const glowTex = ItemRenderer._getGlowTexture(item.color, rarityStyle.glow, 0.35);
    ctx.drawImage(glowTex, item.x - glowR, y - glowR, glowR * 2, glowR * 2);

    ctx.fillStyle = 'rgba(0, 0, 0, 0.16)';
    ctx.beginPath();
    ctx.ellipse(item.x, item.y + drawSize / 2 + 2, drawSize * 0.45, drawSize * 0.1, 0, 0, Math.PI * 2);
    ctx.fill();

    // shadowBlur usunięty (patrz komentarz w _drawIngot) - jedna z
    // najdroższych operacji Canvas, tu wcześniej stosowana do KAŻDEGO
    // przedmiotu na mapie co klatkę. Płaski cień-elipsa powyżej i tak już
    // "kotwiczy" przedmiot do podłoża.
    ItemRenderer._drawSpriteOrLabel(ctx, item.typeId, item.label, item.x, y, drawSize);
  }

  /**
   * Rysuje przedmiot na stosie gracza.
   */
  static drawStack(ctx, item, index = 0, total = 1) {
    const size = item.size || 28;
    const rarity = ItemRenderer.getRarity(item.typeId);
    const rarityStyle = ItemRenderer.getRarityStyle(rarity);

    // Patrz komentarz w drawWorld() - upieczona tekstura zamiast nowego
    // gradientu co klatkę, dla KAŻDEGO przedmiotu w plecaku naraz.
    const glowR = size * 0.7;
    const glowTex = ItemRenderer._getGlowTexture(item.color || '#8BC34A', rarityStyle.glow, 0.3);
    ctx.drawImage(glowTex, item.x - glowR, item.y - glowR, glowR * 2, glowR * 2);

    // shadowBlur usunięty - patrz komentarz w drawWorld().
    ItemRenderer._drawSpriteOrLabel(ctx, item.typeId, item.label, item.x, item.y, size * 1.1);
  }

  /**
   * Buduje dane HTML karty do panelu ekwipunku (bez rysowania canvas).
   */
  static buildCardData(item) {
    const meta = ItemRenderer.getTypeMeta(item.typeId);
    const rarity = ItemRenderer.getRarity(item.typeId);
    const rarityStyle = ItemRenderer.getRarityStyle(rarity);
    return {
      id: item.id,
      typeId: item.typeId,
      label: item.label || (meta && meta.label) || '?',
      name: (meta && meta.name) || item.typeId || 'Przedmiot',
      color: item.color || (meta && meta.color) || '#8BC34A',
      rarity,
      rarityLabel: rarityStyle.label,
      rarityBorder: rarityStyle.border,
      spriteSrc: (window.SPRITE_PATHS && window.SPRITE_PATHS[item.typeId]) || null
    };
  }
}

class ItemManager {
  constructor(canvas) {
    this.canvas = canvas;
    this.items = [];
    this.playerX = 0;
    this.playerY = 0;
    this.pickupRadius = ITEM_PICKUP_RADIUS;
    this.time = 0;
    this.debugShowPickupRadius = false;

    // NOWE: Timery do automatycznego spawnowania z czasem
    this.spawnTimer = 0;
    this.spawnInterval = 2500; // Co 2.5s pojawia się nowy surowiec

    // Zmienione: Przy starcie losujemy z dostępnej puli (domyślnie trash), a nie na sztywno
    this._spawnBatch(8, null);
    this._spawnBatch(4, 'plastic'); // Plastik zostawiamy narzucony, żeby gracz miał coś do prasy na start

    this._onPlayerMoved = (d) => {
      this.playerX = d.x;
      this.playerY = d.y;
    };
    this._onStackAdded = () => {
      if (this.items.length < ITEM_RESPAWN_THRESHOLD) {
        // Zmienione: Po dodaniu na stos dorzucamy losowe (z puli)
        this._spawnBatch(ITEM_RESPAWN_BATCH, null); 
      }
    };

    Bus.subscribe(Events.PLAYER_MOVED, this._onPlayerMoved);
    Bus.subscribe(Events.STACK_ADDED, this._onStackAdded);
  }

  _spawnBatch(count, typeId = null) {
    for (let i = 0; i < count; i++) {
      this._spawnItem(typeId);
    }
  }

  // Uwzględnia licencję na papier ze sklepu (jedyna pozostała "licencja
  // materiałowa" - szkło/metal są teraz bramkowane przestrzennie strefami,
  // nie zakupem, patrz GDD Faza 2).
  _spawnItem(forceTypeId = null) {
    // Pula bazowa: śmieci (Strefa A) ZAWSZE dostępne od startu. Szkło (B) i
    // metal (C) dokładane TYLKO gdy odpowiednia strefa JEST odblokowana
    // (progi zarobku, patrz PROGRESSION_UNLOCKS w economy.js) ORAZ Piec
    // Hutniczy (jedyny odbiorca obu, patrz machines.js furnace_c) JEST
    // odblokowany.
    // BUGFIX: sam próg strefy NIE wystarczał - PROGRESSION_UNLOCKS ma
    // zone_B na 200$, ale furnace_c dopiero na 350$, więc między 200$ a
    // 350$ szkło już się spawnowało, mimo że gracz nie miał go jeszcze
    // gdzie oddać (TradingPost też go nie przyjmuje) - zbierał bezużyteczny
    // przedmiot, który zajmował miejsce w ograniczonym plecaku aż do
    // odblokowania pieca. zone_C (550$) jest wprawdzie PO furnace_c (350$),
    // więc metal nigdy faktycznie na to nie trafiał - ale sprawdzamy piec
    // dla obu, żeby reguła była odporna na przyszłe przetasowanie progów,
    // nie tylko "akurat dziś się zgadza".
    const eco = window.economyManager;
    const zoneBUnlocked = !eco || typeof eco.isUnlocked !== 'function' || eco.isUnlocked('zone_B');
    const zoneCUnlocked = !eco || typeof eco.isUnlocked !== 'function' || eco.isUnlocked('zone_C');
    const furnaceUnlocked = !eco || typeof eco.isUnlocked !== 'function' || eco.isUnlocked('furnace_c');
    // crystal_shard NIE ma odbiorcy-maszyny (sprzedawany wprost na targu,
    // patrz TRADING_POST_ACCEPTS w market.js), więc nie bramkujemy go maszyną
    // jak szkło/metal - ale sam próg strefy TEŻ nie wystarcza.
    //
    // BUGFIX (dokładnie ta sama klasa błędu co przy szkle wyżej): zone_D
    // odblokowuje się progiem zarobku (950$), ale BEZPIECZNIE wejść do Grani
    // można dopiero mając OBA stroje naraz (Filtr + Kombinezon, ~750$ wydane -
    // patrz _hasGearForZone('D') w player.js). Między tymi dwoma momentami
    // odłamki już się spawnowały w strefie, do której gracz owszem może wejść,
    // ale zostanie tam spowolniony i BĘDZIE TRACIŁ PRZEDMIOTY. Gorsze niż
    // bezużyteczny przedmiot w plecaku: gra kusiła najcenniejszym surowcem w
    // miejscu, które aktywnie karze za jego zbieranie. Spawnujemy więc dopiero,
    // gdy gracz faktycznie przeżyje w Grani.
    const hasFullProtection = !eco || typeof eco.hasUpgrade !== 'function'
      || (typeof eco.hasShipPerk === 'function' && eco.hasShipPerk('hazard_immunity'))
      || (eco.hasUpgrade('toxic_filter') && eco.hasUpgrade('radiation_suit'));
    const zoneDUnlocked = !eco || typeof eco.isUnlocked !== 'function' || eco.isUnlocked('zone_D');

    let availableTypes = ['trash', 'trash']; // Strefa A - zawsze
    if (zoneBUnlocked && furnaceUnlocked) availableTypes.push('glass');
    if (zoneCUnlocked && furnaceUnlocked) availableTypes.push('metal');
    if (zoneDUnlocked && hasFullProtection) availableTypes.push('crystal_shard');

    if (window.economyManager && window.economyManager.upgradeLevels
        && window.economyManager.upgradeLevels['stage_paper'] > 0) {
      availableTypes.push('paper');
    }

    // Wybieramy typ: narzucony (np. output z maszyny) ALBO losowy z dostępnych
    const typeId = forceTypeId || availableTypes[Math.floor(Math.random() * availableTypes.length)];

    const type = ITEM_TYPES.find((t) => t.id === typeId) || ITEM_TYPES[0];
    const bounds = this._getZoneBounds(ITEM_TYPE_ZONE[typeId] || 'A');

    const item = this._makeItem({
      typeId,
      label: type.label,
      color: type.color,
      x: bounds.minX + Math.random() * (bounds.maxX - bounds.minX),
      y: bounds.minY + Math.random() * (bounds.maxY - bounds.minY)
    });

    this.items.push(item);
    return item;
  }

  /**
   * Granice prostokąta danej strefy (w pikselach ŚWIATA), z marginesem od
   * krawędzi. Strefa C to górny pas, Strefa B to prawy pas PONIŻEJ pasa C,
   * Strefa A to cała reszta - patrz stałe ITEM_ZONE_*_RATIO na górze pliku.
   */
  _getZoneBounds(zone) {
    const w = ITEM_WORLD_WIDTH;
    const h = ITEM_WORLD_HEIGHT;
    const m = ITEM_SPAWN_MARGIN;
    const topH = h * ITEM_ZONE_C_TOP_RATIO;
    const rightX = w * ITEM_ZONE_B_RIGHT_RATIO;
    const dLeftX = w * ITEM_ZONE_D_LEFT_RATIO;
    const dBottomY = h * ITEM_ZONE_D_BOTTOM_RATIO;

    if (zone === 'D') {
      // SAMODZIELNY róg prawy-górny (nie wycinek pasa C) - patrz
      // ITEM_ZONE_D_LEFT_RATIO/BOTTOM_RATIO. Margines od DOLNEJ krawędzi
      // Grani też, żeby odłamki nie spawnowały się dokładnie na pofalowanej
      // granicy z bagnem (tam wizualnie już nie widać kryształowego podłoża).
      return { minX: Math.min(dLeftX + m, w - m - 1), maxX: Math.max(dLeftX + m + 1, w - m), minY: m, maxY: Math.max(m + 1, dBottomY - m) };
    }
    if (zone === 'C') {
      // Reszta pasa C, NA LEWO od Strefy D - metal zostaje wyraźnie oddzielony
      // od kryształów (patrz komentarz przy zone==='D' wyżej), zamiast dwóch
      // surowców losowo mieszających się w tym samym rogu mapy.
      return { minX: m, maxX: Math.max(m + 1, dLeftX - m), minY: m, maxY: Math.max(m + 1, topH - m) };
    }
    if (zone === 'B') {
      // Bagno zaczyna się PONIŻEJ pasa C, ale w prawym-górnym rogu siedzi
      // teraz Grań (sięga do dBottomY) - szkło spawnujemy więc dopiero pod
      // nią, inaczej trafiałoby na kryształowe podłoże.
      const bMinY = Math.max(topH + m, m);
      return { minX: Math.min(rightX + m, w - m - 1), maxX: Math.max(rightX + m + 1, w - m), minY: Math.max(bMinY, dBottomY + m), maxY: Math.max(dBottomY + m + 1, h - m) };
    }
    // Strefa A: reszta (lewa/środkowa część, poniżej pasa C, na lewo od pasa B).
    return { minX: m, maxX: Math.max(m + 1, rightX - m), minY: Math.max(topH + m, m), maxY: Math.max(topH + m + 1, h - m) };
  }

  _spawnSpecificAt(typeId, x, y, label, color) {
    const item = this._makeItem({
      typeId,
      label: label || '❓',
      color: color || '#8BC34A',
      x,
      y
    });
    this.items.push(item);
    return item;
  }

  _makeItem({ typeId, label, color, x, y }) {
    return {
      id: Math.random().toString(36).slice(2),
      typeId,
      label,
      color,
      x,
      y,
      bobPhase: Math.random() * Math.PI * 2,
      bobAmp: 3 + Math.random() * 3,
      size: ITEM_VISUAL_SIZE,
      scale: 0.01,
      proximity: 0,
      collected: false
    };
  }

  update(delta) {
    const sec = delta / 1000;
    this.time += sec;

    // NOWE: Automatyczne dodawanie śmieci co jakiś czas, żeby mapa nie była pusta
    // Modyfikator planety (patrz PLANET_MODIFIERS w economy.js) skraca/wydłuża
    // efektywny odstęp - spawnInterval samo w sobie zostaje stałe (>1 mult =
    // częściej, więc dzielimy, nie mnożymy).
    const eco = window.economyManager;
    const spawnMult = (eco && typeof eco.getPlanetSpawnMultiplier === 'function')
      ? eco.getPlanetSpawnMultiplier()
      : 1;
    this.spawnTimer += delta;
    if (this.spawnTimer >= this.spawnInterval / spawnMult) {
      this.spawnTimer = 0;
      if (this.items.length < 25) { // Maksymalny limit przedmiotów na mapie
        this._spawnItem(null);
      }
    }

    this.items.forEach((item) => {
      if (item.collected) return;

      if (item.scale < 1 || item.scale > 1) {
        if (item.scale <= 1) {
          item.scale = Math.min(1.15, item.scale + sec * ITEM_SPAWN_ANIM_SPEED);
        } else {
          item.scale = Math.max(1, item.scale - sec * ITEM_SPAWN_ANIM_SPEED * 0.5);
        }
      }

      item._drawY = item.y + Math.sin(this.time * ITEM_BOB_FREQUENCY + item.bobPhase) * item.bobAmp;

      const dx = item.x - this.playerX;
      const dy = item.y - this.playerY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      
      // Proximity do animacji powiększania
      item.proximity = Math.max(0, 1 - dist / this.pickupRadius);

      // NOWE: Płynny magnes zamiast natychmiastowego teleportu
      if (dist < this.pickupRadius && window.stackController && !window.stackController.isFull()) {
        
        // Płynne zasysanie przedmiotu w stronę gracza (lerp)
        const pullFactor = 10 * sec; 
        item.x -= dx * pullFactor;
        item.y -= dy * pullFactor;

        // Jeśli fizycznie dotknął gracza, podnosimy na stos
        if (dist < 22) {
          item.collected = true;
          window.stackController.addItem({
            id: item.id,
            typeId: item.typeId,
            label: item.label,
            color: item.color,
            worldX: item.x,
            worldY: item.y
          });
          Bus.publish(Events.ITEM_PICKUP, { itemId: item.id, typeId: item.typeId, x: item.x, y: item.y });
          Bus.publish(Events.FX_PARTICLES, { x: item.x, y: item.y, color: item.color, count: 8 });
        }
      }
    });

    if (this.items.some((i) => i.collected)) {
      this.items = this.items.filter((i) => !i.collected);
    }
  }

  draw(ctxBg, ctx, ctxUI) {
    this.items.forEach((item) => {
      ItemRenderer.drawWorld(ctx, item, this.time);

      if (this.debugShowPickupRadius) {
        ctx.strokeStyle = 'rgba(255, 255, 0, 0.2)';
        ctx.beginPath();
        ctx.arc(item.x, item.y, this.pickupRadius, 0, Math.PI * 2);
        ctx.stroke();
      }
    });
  }

  destroy() {
    Bus.unsubscribe(Events.PLAYER_MOVED, this._onPlayerMoved);
    Bus.unsubscribe(Events.STACK_ADDED, this._onStackAdded);
  }
}

window.ItemManager = ItemManager;
window.ItemRenderer = ItemRenderer;
window.ITEM_TYPES = ITEM_TYPES;
window.ITEM_RARITY = ITEM_RARITY;