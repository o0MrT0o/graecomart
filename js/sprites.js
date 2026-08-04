'use strict';

/**
 * sprites.js — ładowanie sprite'ów Kenney (CC0) dla przedmiotów i maszyn.
 */

// Lista kandydatur na klucz, nie jedna sztywna ścieżka - loadAll() (niżej)
// próbuje kolejnych wariantów, aż któryś się wczyta, na wypadek gdyby
// prawdziwy układ plików na dysku różnił się od zakładanego.
//
// PORZĄDEK (Tomek: "martwe 404 przy starcie gry" - lista poprawek): pierwsze
// trzy wpisy (trash/plastic/.../machine_furnace) miały historycznie PO
// TRZY kandydatury (goła nazwa w katalogu głównym, assets/items/.../
// assets/machines/..., płaska assets/...) z czasów, gdy dokładny układ
// plików na dysku był niepewny - w praktyce od dawna trafia WYŁĄCZNIE
// druga (assets/items/.../assets/machines/...), więc pierwsza i trzecia
// generowały ~11 gwarantowanych, bezcelowych 404 przy KAŻDYM starcie gry
// (zweryfikowane bezpośrednio: `find` na dysku - tylko assets/items/* i
// assets/machines/* istnieją). Skrócone do jednej, faktycznie działającej
// ścieżki - reszta wpisów w tym pliku (dodawanych już z pewnym układem) od
// razu miała tylko jedną, ten fix tylko dogania resztę do tego samego stylu.
const SPRITE_PATH_CANDIDATES = {
  trash: ['assets/items/trash.png'],
  plastic: ['assets/items/plastic.png'],
  paper: ['assets/items/paper.png'],
  metal: ['assets/items/metal.png'],
  glass: ['assets/items/glass.png'],
  product: ['assets/items/product.png'],
  // Tomek: "te ikony kryształów itd też podmień na lepsze z tej nowej
  // paczki" - alloy/crystal/crystal_shard/crystal_gem NIE miały pliku PNG
  // w projekcie (patrz komentarze przy ItemRenderer._drawIngot/_drawCrystal/
  // _drawPolishedGem w items.js - proceduralne bryły, bo Tomek nigdy nie
  // dostarczył dla nich grafiki). _drawSpriteOrLabel już PRZED tym sprawdza
  // spriteLoader jako pierwszy wybór, więc samo dodanie kluczy tutaj
  // wystarcza - procedury zostają w kodzie jako fallback (gdyby plik się
  // nie wczytał), bez zmian w items.js. Ikony z Free-Cyberpunk-Resource-
  // Pixel-Art-32x32-Icons (ta sama paczka co trash/plastic/.../product
  // wyżej) - w tej czysto technologicznej paczce nie ma fioletowych
  // kryształów jak w starych proceduralnych bryłach, więc zamiast trzech
  // odcieni fioletu (trudnych do odróżnienia na liście cen Terminalu)
  // trzy WYRAŹNIE różne, rosnące "od surowego do wypolerowanego": różowy
  // klaster (surowy odłamek) -> pojedynczy świecący klejnot (kryształ po
  // Oczyszczalni) -> biała polerowana kula (crystal_gem, najdroższy towar
  // w grze). Bez dawnej ścieżki-widmo w katalogu głównym (patrz reszta tej
  // listy) - nowe wpisy, nie ma sensu kopiować znanego martwego wzorca.
  alloy: ['assets/items/alloy.png'],
  crystal: ['assets/items/crystal.png'],
  crystal_shard: ['assets/items/crystal_shard.png'],
  crystal_gem: ['assets/items/crystal_gem.png'],
  machine_recycle: ['assets/machines/recycle.png'],
  machine_press: ['assets/machines/press.png'],
  machine_furnace: ['assets/machines/piechutniczy.png'],
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
  // Terminal Handlowy (market.js) - Tomek: "sam wygląd terminalu trzeba
  // zmienić... ma to wyglądać jakby to był jakiś fragment technologii z
  // statku, a nie jakiś targ na obcej planecie". BYŁ procedural: ciepła
  // drewniana bryła + pasiasta czerwono-kremowa markiza (klasyczny stragan
  // targowy) - zastąpione TĄ SAMĄ techniką co maszyny (prawdziwa bryła
  // Kenney "Space Shooter Extension" + hue-shift _getRecoloredSprite):
  //   sci_terminal - płaski, żeberkowany panel (spaceStation_003) - korpus
  //                  terminala. BYŁ spaceStation_030 (bryła z jasnym
  //                  "ekranem" u góry) - ALE ten kształt zwęża się mocno na
  //                  górze (pełną szerokość ma dopiero od ~28% do ~69%
  //                  wysokości), więc prostokątny ekran cennika (draw(),
  //                  liczony jako stały margines od bryły) wystawał poza
  //                  widoczną sylwetkę w górnych rogach - Tomek: "czemu
  //                  ekran z cenami tak wystaje poza obręb". 003 wypełnia
  //                  CAŁY swój prostokąt na każdej wysokości (zero zwężenia),
  //                  więc margines zawsze mieści się w widocznej bryle.
  //   sci_antenna  - smukły maszt z kopułą (spaceStation_020) - zastępuje
  //                  markizę, sterczy nad korpusem jak antena łącznościowa.
  machine_sci_terminal: ['assets/machines/sci_terminal.png'],
  machine_sci_antenna: ['assets/machines/sci_antenna.png'],
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
  critter_ufo: ['assets/critters/ufo.png'],
  // Strzałka trendu cen na Terminalu Handlowym (market.js) - BYŁ Unicode
  // glif rysowany wprost fillText'em (▲/▼/►), teraz prawdziwa sylwetka
  // Kenney "Game Icons" (ta sama fala co Sklep/Menu - Tomek: "1" po "co
  // dalej robimy" -> Targowisko). Trzy osobne pliki (nie jeden obracany
  // ctx.rotate) - "flat"/"right" to WŁASNY kształt (chevron w prawo), nie
  // 90°-obrót "up", więc rotacja dałaby wizualnie inny (gorszy) trójkąt.
  trend_up: ['assets/ui/icons/up.png'],
  trend_down: ['assets/ui/icons/down.png'],
  trend_flat: ['assets/ui/icons/right.png'],
  // Złoty Bonus (goldbonus.js, Tomek: "daj coś fajnego z paczek") - gwiazdka
  // z Kenney "Space Shooter Remastered" (Power-ups/star_gold.png), ta sama
  // paczka co ship_fighter/fx_soot/fx_smoke_puff wyżej.
  fx_gold_star: ['assets/effects/fx_gold_star.png'],
  // Dron Recyklingowy (drone.js, SHOP_UPGRADES: 'drone' w economy.js) -
  // Kenney "Space Shooter Redux" (CC0), Enemies/enemyBlue2.png - Tomek
  // wybrał z 10 kandydatów pokazanych w galerii ("2 jest git"). Kompaktowa,
  // owadzia sylwetka z jasnym "czujnikiem" na przedzie - czyta się jako
  // mały zautomatyzowany zwiadowca, wyraźnie inna (kształt, nie tylko
  // kolor) od zielonego, ambientowego UFO (critter_ufo wyżej).
  drone: ['assets/critters/drone.png'],
  // Dekoracje Terminalu Handlowego (market.js, EconomyManager.STALL_DECORATIONS
  // w economy.js) - v2: Kenney "Space Shooter Extension", TA SAMA paczka, z
  // której pochodzi korpus/antena Terminala i bryły wszystkich pięciu maszyn
  // (machine_sci_* wyżej) - gwarantowana spójność FIKCJI, nie tylko stylu.
  // Pierwsza wersja (crate/sign/torch/flag/fence/mushroom, Platformer Pack
  // Remastered) zrewertowana na prośbę Toma - pasowała stylem, ale nie
  // światem gry ("Terminal = fragment technologii ze statku").
  stall_console: ['assets/decor/stall_console.png'],
  stall_beacon: ['assets/decor/stall_beacon.png'],
  stall_tank: ['assets/decor/stall_tank.png'],
  stall_solar: ['assets/decor/stall_solar.png'],
  stall_satellite: ['assets/decor/stall_satellite.png']
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
