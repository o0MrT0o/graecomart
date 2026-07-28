'use strict';

/**
 * sprites.js — ładowanie sprite'ów Kenney (CC0) dla przedmiotów i maszyn.
 */

// BUGFIX: ścieżki miały prefiks 'assets/items/' i 'assets/machines/', ale
// prawdziwe pliki leżą płasko obok index.html (ten sam poziom co js/) -
// dlatego KAŻDY sprite w grze failował na wczytaniu (onerror, po cichu) i
// wszystko - przedmioty na mapie, w plecaku, ciała maszyn - renderowało się
// przez emoji-fallback w ItemRenderer._drawSpriteOrLabel (items.js) albo
// przez różowy "Brak pliku PNG!" (machines.js, dla pieca hutniczego).
// Lista kandydatur na klucz, nie jedna sztywna ścieżka. Poprzedni fix
// (usunięcie prefiksu 'assets/items/'/'assets/machines/') założył, że pliki
// leżą płasko obok index.html, bo tak wyglądały uploadowane do projektu -
// ale to była zgadywanka: 404 z Live Server pokazało, że płaska ścieżka
// TEŻ nie trafia. Zamiast zgadywać po raz drugi, loadAll() (niżej) próbuje
// WSZYSTKICH wariantów po kolei dla każdego pliku i bierze pierwszy, który
// się wczyta - działa niezależnie od tego, którego układu Tomek faktycznie
// używa na dysku, i nie wymaga już zgadywania.
const SPRITE_PATH_CANDIDATES = {
  trash: ['trash.png', 'assets/items/trash.png', 'assets/trash.png'],
  plastic: ['plastic.png', 'assets/items/plastic.png', 'assets/plastic.png'],
  paper: ['paper.png', 'assets/items/paper.png', 'assets/paper.png'],
  metal: ['metal.png', 'assets/items/metal.png', 'assets/metal.png'],
  glass: ['glass.png', 'assets/items/glass.png', 'assets/glass.png'],
  product: ['product.png', 'assets/items/product.png', 'assets/product.png'],
  machine_recycle: ['recycle.png', 'assets/machines/recycle.png', 'assets/recycle.png'],
  machine_press: ['press.png', 'assets/machines/press.png', 'assets/press.png'],
  machine_furnace: ['piechutniczy.png', 'assets/machines/piechutniczy.png', 'assets/piechutniczy.png']
};

// Zgodność wsteczna - ItemRenderer.buildCardData() (items.js) czyta stąd
// POJEDYNCZĄ ścieżkę (pierwszego kandydata) do podglądu karty w UI.
const SPRITE_PATHS = {};
Object.keys(SPRITE_PATH_CANDIDATES).forEach((key) => {
  SPRITE_PATHS[key] = SPRITE_PATH_CANDIDATES[key][0];
});

class SpriteLoader {
  constructor() {
    this._images = {};
    this.ready = false;
  }

  /**
   * Próbuje kolejnych ścieżek z listy dla JEDNEGO obrazka, aż któraś się
   * wczyta - albo żadna. Reużywa ten sam Image() między próbami (kolejne
   * przypisanie .src po prostu wywołuje kolejną próbę wczytania, znów
   * odpalając onload/onerror) zamiast tworzyć nowy obiekt za każdym razem.
   */
  _loadWithFallbacks(candidates) {
    return new Promise((resolve) => {
      const img = new Image();
      let i = 0;
      img.onload = () => resolve(img);
      img.onerror = () => {
        i++;
        if (i >= candidates.length) {
          resolve(null);
          return;
        }
        img.src = candidates[i];
      };
      img.src = candidates[0];
    });
  }

  loadAll() {
    const entries = Object.entries(SPRITE_PATH_CANDIDATES);
    return Promise.all(entries.map(([key, candidates]) =>
      this._loadWithFallbacks(candidates).then((img) => {
        if (img) {
          this._images[key] = img;
        } else {
          console.warn(`[SpriteLoader] Brak sprite'a '${key}' pod żadną z: ${candidates.join(', ')}`);
        }
      })
    )).then(() => {
      this.ready = true;
    });
  }

  get(key) {
    return this._images[key] || null;
  }

  has(key) {
    const img = this._images[key];
    return !!(img && img.complete && img.naturalWidth);
  }

  draw(ctx, key, x, y, size) {
    const img = this.get(key);
    if (!img || !img.complete || !img.naturalWidth) return false;
    ctx.drawImage(img, x - size / 2, y - size / 2, size, size);
    return true;
  }

  spriteKeyForType(typeId) {
    return SPRITE_PATH_CANDIDATES[typeId] ? typeId : null;
  }

  spriteKeyForMachine(machineId) {
    if (machineId === 'recycle_a') return 'machine_recycle';
    if (machineId === 'press_b') return 'machine_press';
    if (machineId === 'furnace_c') return 'machine_furnace';
    return null;
  }
}

window.SpriteLoader = SpriteLoader;
window.SPRITE_PATHS = SPRITE_PATHS;
window.SPRITE_PATH_CANDIDATES = SPRITE_PATH_CANDIDATES;
