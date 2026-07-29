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
  machine_furnace: ['piechutniczy.png', 'assets/machines/piechutniczy.png', 'assets/piechutniczy.png'],
  // Faza kosmicznego reskinu maszyn (machines.js, _drawRecycleMachine/
  // _drawPressMachine/_drawFurnaceMachine) - prawdziwe teksturki poświaty z
  // Kenney "Particle Pack" (CC0), białe/szare więc TINTOWALNE na dowolny
  // kolor akcentu maszyny tą samą techniką co skiny gracza (player.js
  // _bakeTintedCanvas) zamiast rysowanych ręcznie radialnych gradientów.
  fx_glow: ['assets/effects/fx_glow.png'],
  fx_flare: ['assets/effects/fx_flare.png'],
  fx_spark: ['assets/effects/fx_spark.png'],
  // Prawdziwe bryły z Kenney "Space Shooter Extension" (CC0) - NOWE ciała
  // Reaktora/Kompresora/Pieca Plazmowego (machines.js, druga wersja Fazy
  // kosmicznego reskinu - zamiast składania własnego "panelu" z kwadratu,
  // każda maszyna dostaje osobną, gotową bryłę stacji kosmicznej,
  // przefarbowywaną per maszyna przez _getRecoloredSprite):
  //   sci_module - moduł satelitarny (spaceStation_017) - Reaktor
  //   sci_press  - "klepsydra" dwóch zbiegających się płyt (spaceStation_012) - Kompresor
  //   sci_dome   - kopuła/pod (spaceStation_029) - Piec Plazmowy
  //   sci_core   - świecąca kula w pierścieniu (spaceBuilding_009) - wspólny
  //                akcent "rdzenia" osadzany na wszystkich trzech
  machine_sci_module: ['assets/machines/sci_module.png'],
  machine_sci_press: ['assets/machines/sci_press.png'],
  machine_sci_dome: ['assets/machines/sci_dome.png'],
  machine_sci_core: ['assets/machines/sci_core.png'],
  // Dwie ostatnie maszyny reskinu (machines.js, _drawRefineryMachine/
  // _drawCrystalPolisherMachine) - kapsuła z jasnym paskiem "okna"
  // (spaceStation_001) dla Oczyszczalni, stożek zbiegający się w oszlifowany
  // ośmiokątny klejnot (spaceStation_028) dla Szlifierni - jego naturalnie
  // fasetowany kształt pasuje tematycznie do kryształów bez żadnej edycji.
  machine_sci_capsule: ['assets/machines/sci_capsule.png'],
  machine_sci_grinder: ['assets/machines/sci_grinder.png'],
  // Myśliwiec (spaceShips_001) - kadłub Rozbitego Statku (ship.js). Trzecia
  // iteracja: rakieta (spaceRockets_002, "za ludzka") -> spodek/UFO
  // (spaceStation_031) -> TA, po tym jak Tomek wysłał zrzut folderu Ships
  // z paczki i powiedział "użyj tych bardziej, są ładne". W przeciwieństwie
  // do dwóch poprzednich, TA bryła zostaje w NATYWNYCH kolorach (czerwono-
  // biało-fioletowa) - dostał wyraźną pochwałę wyglądu, więc żadnego
  // przefarbowywania.
  ship_fighter: ['assets/ship_fighter.png'],
  // Uszkodzenie statku (ship.js, _drawDamageScorch) - fx_soot to miękka
  // plama (Particle Pack smoke_01, tonowana na ciemno-szaro) osadzona NA
  // kadłubie, fx_smoke_puff to mała kreskówkowa chmurka dymu (Kenney "Space
  // Shooter Extension", spaceEffects_009) - TEN SAM płaski styl co reszta
  // statku/maszyn (w przeciwieństwie do miękkich, malarskich teksturek
  // Particle Pack), więc kilka sztuk uniesionych nad plamą czyta się jako
  // spójny, rysunkowy dym, nie inny styl wklejony obok.
  fx_soot: ['assets/effects/fx_soot.png'],
  fx_smoke_puff: ['assets/effects/fx_smoke_puff.png'],
  // Kenney "Light Masks" (CC0) - circle_c.png, konwersja z opaque-black+szara
  // jasność (oryginalny format paczki, myślany pod blend "screen"/"lighter")
  // na przezroczysty ALPHA-mask (biały, jasność źródła = alfa) offline w
  // Pythonie - ta sama forma co fx_glow (Particle Pack), więc ten sam
  // tint-przez-source-atop działa bez zmian. Zamienia płaski pulsujący
  // ellipse pod kępkami kryształów Strefy D (game.js _drawCrystalDecor) na
  // prawdziwą, miękką poświatę z jaśniejszym rdzeniem.
  fx_light_glow: ['assets/effects/fx_light_glow.png'],
  // Wędrujące UFO (critters.js, ambient - Tomek: "dodaj tę ufo") - jedyny
  // NIE-proceduralny "critter" w grze (motyle/świetliki/wrony to kształty
  // Canvasa) - prawdziwa bryła spodka z Kenney "Alien UFO Pack" (CC0),
  // zielona (odróżnialna od niebieskiego gracza i czerwono-biało-fioletowego
  // Rozbitego Statku - czyta się jako "inny, obcy statek", nie duplikat).
  critter_ufo: ['assets/critters/ufo.png']
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
