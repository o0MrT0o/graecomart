'use strict';

/**
 * ship.js
 * ------------------------------------------------------------------------
 * Cel gry (Faza 3). Rozbity statek gracza, stojący w Strefie A. Gracz
 * odbudowuje 5 modułów PO KOLEI (jeden aktywny naraz) - każdy wymaga
 * pieniędzy + konkretnych ilości już istniejących przetworzonych surowców
 * (plastic/product/alloy - żaden nowy typ przedmiotu, żadna nowa maszyna).
 * Gracz staje w zasięgu, a moduł "wypełnia się" automatycznie w tym samym
 * rytmie co maszyny/terminal (co SHIP_CONTRIBUTION_INTERVAL_MS): trochę
 * pieniędzy + jeden pasujący surowiec ze stosu na tick.
 *
 * Po ukończeniu WSZYSTKICH pięciu modułów: Events.GAME_WON. ui.js łapie to
 * i pokazuje ekran wygranej - ship.js nic nie wie o DOM/UI, tylko publikuje
 * event (ten sam wzorzec co wszędzie indziej w projekcie).
 *
 * Ship NIE trzyma stanu postępu u siebie - woła metody na
 * window.economyManager (contributeShipMoney/contributeShipMaterial/
 * markShipModuleComplete/isShipModuleComplete), która to trzyma, żeby
 * automatycznie wchodziło do zapisu obok reszty stanu gracza (ten sam
 * wzorzec co TradingPost nie trzymający pieniędzy samodzielnie, tylko
 * wołający economyManager.sellItem()).
 *
 * Zależności globalne (muszą być załadowane przed tym plikiem):
 *   - window.Bus / window.Events (PLAYER_MOVED, FX_PARTICLES, FX_SHAKE,
 *      FX_POPUP, SHIP_MODULE_COMPLETED, GAME_WON)
 *   - window.stackController (.isEmpty() / .findIndex() / .removeAt())
 *   - window.economyManager (.getShipMoneyContributed() / .contributeShipMoney()
 *      / .contributeShipMaterial() / .getShipMaterialContributed() /
 *      .isShipModuleComplete() / .markShipModuleComplete())
 *
 * Użycie w main.js:
 *   window.ship = new Ship(canvasGameplay);
 *   game.registerModule(window.ship);
 */

// --- Świat (Faza 2b) - ta sama wartość co w innych plikach, własna kopia. --
const SHIP_WORLD_WIDTH = 1400;
const SHIP_WORLD_HEIGHT = 2000;

// 5 modułów statku, W TEJ KOLEJNOŚCI (budowane jeden po drugim, nie równolegle).
// materials: ile SZTUK każdego typu trzeba dostarczyć - typy to te same
// plastic/product/alloy, które gra już zna, żadnych nowych surowców/maszyn.
// Koszty rosną z każdym modułem (naturalny ramp trudności do finału).
const SHIP_MODULE_DEFINITIONS = [
  { id: 'life_support', get name() { return I18n.t('ship.module.life_support'); }, money: 300, materials: { plastic: 10 } },
  { id: 'navigation', get name() { return I18n.t('ship.module.navigation'); }, money: 500, materials: { plastic: 5, product: 8 } },
  { id: 'shields', get name() { return I18n.t('ship.module.shields'); }, money: 800, materials: { product: 6, alloy: 8 } },
  { id: 'engine', get name() { return I18n.t('ship.module.engine'); }, money: 1200, materials: { product: 4, alloy: 14 } },
  { id: 'hyperdrive', get name() { return I18n.t('ship.module.hyperdrive'); }, money: 2000, materials: { plastic: 5, product: 10, alloy: 12 } }
];

// Wartości puste - BYŁY emoji (ten sam powód co ITEM_TYPES.label w items.js).
// ItemRenderer._drawSpriteOrLabel (jedyny konsument, patrz draw() niżej)
// rysuje sprite/proceduralną bryłę/neutralną plakietkę, nigdy tekstu.
const SHIP_MATERIAL_ICONS = { plastic: '', product: '', alloy: '' };

const SHIP_DROP_RADIUS = 90;
// Ten sam rytm co MACHINE_UNLOAD_INTERVAL_MS / TRADING_POST_SELL_INTERVAL_MS -
// jedna "porcja" dostawy na tyle ms, dopóki gracz stoi w zasięgu.
const SHIP_CONTRIBUTION_INTERVAL_MS = 200;
const SHIP_MONEY_PER_TICK = 25;

// --- Wygląd (Faza kosmicznego reskinu, wersja 3): PRAWDZIWY myśliwiec z
// Kenney "Space Shooter Extension" (spaceShips_001, assets/ship_fighter.png,
// CC0). Trzecia iteracja kadłuba: rakieta (spaceRockets_002, "za ludzka")
// -> spodek/UFO (spaceStation_031) -> TA, po tym jak Tomek wysłał zrzut
// folderu Ships z paczki i powiedział "użyj tych bardziej, są ładne".
// W przeciwieństwie do dwóch poprzednich, TA bryła zostaje w NATYWNYCH
// kolorach (czerwono-biało-fioletowa, zaostrzony nos, zamaszyste skrzydła,
// fioletowy owalny kokpit) - żadnego przefarbowywania, dostała wyraźną
// pochwałę wyglądu. SHIP_FIGHTER_ASPECT to proporcje PRAWDZIWEGO pliku
// (198x188, prawie kwadratowy).
const SHIP_FIGHTER_ASPECT = 198 / 188;
const SHIP_HULL_H = 260;
// Kokpit myśliwca - pozycja/rozmiar zmierzone WPROST z pliku (bbox
// fioletowego owalu), jako ułamek szerokości/wysokości całego sprite'a.
// W_FRAC/H_FRAC lekko powiększone względem samego konturu owalu, żeby
// poświata delikatnie "przelewała się" na kadłub wokół, nie kończyła
// twardo na krawędzi kokpitu.
const SHIP_WINDOW_X_FRAC = 0.497;
const SHIP_WINDOW_Y_FRAC = 0.705;
const SHIP_WINDOW_W_FRAC = 0.22;
const SHIP_WINDOW_H_FRAC = 0.36;
// Zapala się STOPNIOWO wraz z ukończonymi modułami (litFraction w draw()) -
// statek wizualnie "budzi się do życia" w miarę postępu, zamiast być cały
// czas tym samym jednolitym kokpitem od pierwszego do ostatniego modułu.
const SHIP_WINDOW_GLOW_COLOR = '#7CFFD4';
// Stała pozycja plamy uszkodzenia (ułamek hw/hh od środka) - CELOWO nie
// losowa, żeby nie "skakała" między odświeżeniami strony. BYŁO DX:0.55
// (dolne prawe skrzydło, z dala od kokpitu) - Tomek: "ten dym co jest na
// statku niech będzie w centralnej części z tymi iskrami nie z boku".
// DX:0 wyśrodkowuje dym/sadzę/iskry poziomo (to o to poprosił - "nie z
// boku"), DY zostaje - dym/sadza teraz nakłada się częściowo na kokpit,
// ale to czyta się dramatycznie ("uszkodzenie centralnego rdzenia/kokpitu"),
// nie jak błąd.
const SHIP_DAMAGE_DX = 0;
const SHIP_DAMAGE_DY = 0.5;
// Co ile ms z uszkodzenia leci odrobina dymu - tylko dopóki statek nie jest
// naprawiony (this._won == false). Po naprawie plama + dym znikają.
const SHIP_SMOKE_INTERVAL_MS = 1100;

class Ship {
  constructor(canvas) {
    this.canvas = canvas;
    // PRZESUNIĘTE z (0.42, 0.58): ten punkt leżał niemal DOKŁADNIE na prostej
    // spawn (0.5, 0.5) -> prasa (0.28, 0.72), więc każde przejście do prasy
    // wchodziło w SHIP_DROP_RADIUS i mimowolnie odciągało pieniądze na statek.
    // Nowa pozycja - spokojny lewy kąt strefy A, >350px od najbliższego innego
    // punktu zainteresowania (recykler/prasa/terminal/spawn), więc żadna
    // rozsądna trasa między nimi już przez niego nie przechodzi.
    this.xRatio = 0.18;
    this.yRatio = 0.55;
    this.x = SHIP_WORLD_WIDTH * this.xRatio;
    this.y = SHIP_WORLD_HEIGHT * this.yRatio;
    this.h = SHIP_HULL_H;
    this.w = SHIP_HULL_H * SHIP_FIGHTER_ASPECT;

    this.playerX = 0;
    this.playerY = 0;
    this.inRange = false;
    this._tickTimer = 0;
    // Gracz musi świadomie potwierdzić wpłatę (przycisk "Wpłać" w ui.js,
    // patrz confirmContribution()) - dopóki tego nie zrobi, update() NIE
    // zdejmuje automatycznie pieniędzy/surowców, mimo stania w zasięgu.
    // Reset przy KAŻDYM opuszczeniu zasięgu (patrz update()), więc decyzję
    // trzeba podjąć na nowo przy każdym kolejnym podejściu do statku.
    this._contributing = false;
    // Dym z uszkodzenia (patrz update()/_damageWorldPos) - osobny timer od
    // _tickTimer, bo leci NIEZALEŻNIE od tego, czy gracz jest w zasięgu.
    this._smokeTimer = 0;
    // Flaga ustawiana raz, przy pierwszym update() - zeby po wczytaniu zapisu
    // (gdzie gra mogla juz byc ukonczona wczesniej) NIE pokazywac ekranu
    // wygranej ponownie przy kazdym odswiezeniu strony, tylko dogonic stan
    // wizualnie po cichu.
    this._initialSyncDone = false;
    this._won = false;

    // Timestamp (performance.now()) do kiedy okienka mają świecić wyraźnie
    // jaśniej niż normalnie - ustawiane na moment ukończenia modułu (patrz
    // update() niżej), czytane w _drawPortholes.
    this._moduleCompleteFlashUntil = 0;

    this._onPlayerMoved = (d) => {
      this.playerX = d.x;
      this.playerY = d.y;
    };
    Bus.subscribe(Events.PLAYER_MOVED, this._onPlayerMoved);

    // Faza 4 (prestiż): economyManager.prestige() zeruje shipCompletedModules,
    // ale this._won jest CACHEM tamtego stanu (patrz update() - liczony raz
    // do _initialSyncDone, potem tylko przy ukończeniu modułu), więc bez tego
    // listenera statek zostałby "zamrożony" na widoku "Gotowy do startu!" aż
    // do najbliższego odświeżenia strony, mimo że pod spodem gra już
    // poprawnie wystartowała nowy przebieg od modułu 0.
    this._onPrestigeDone = () => {
      this._won = false;
      this._tickTimer = 0;
      this._contributing = false;
    };
    if (Events.PRESTIGE_DONE) {
      Bus.subscribe(Events.PRESTIGE_DONE, this._onPrestigeDone);
    }
  }

  /**
   * Wołane przez UI (przycisk "Wpłać" w ui.js) po świadomej decyzji gracza -
   * dopiero od tego momentu update() zaczyna zdejmować pieniądze/surowce.
   * Bez efektu, jeśli gracz akurat nie stoi w zasięgu (nic nie powinno się
   * "uzbroić" na zapas) - i tak zostałoby wyzerowane w następnej klatce
   * update(), patrz tam.
   */
  confirmContribution() {
    if (this.inRange) this._contributing = true;
  }

  /** Czy ui.js powinno pokazać przycisk "Wpłać" - gracz w zasięgu, statek
   * jeszcze nie gotowy, jest aktywny moduł, a gracz jeszcze nie potwierdził
   * wpłaty przy TYM konkretnym podejściu. */
  needsContributionConfirm() {
    return this.inRange && !this._won && !this._contributing && this._currentModuleIndex() !== -1;
  }

  /** Indeks pierwszego NIEukończonego modułu, albo -1 gdy wszystkie gotowe. */
  _currentModuleIndex() {
    const eco = window.economyManager;
    if (!eco) return 0;
    for (let i = 0; i < SHIP_MODULE_DEFINITIONS.length; i++) {
      if (!eco.isShipModuleComplete(SHIP_MODULE_DEFINITIONS[i].id)) return i;
    }
    return -1;
  }

  update(delta) {
    const eco = window.economyManager;
    if (!eco) return;

    if (!this._initialSyncDone) {
      this._initialSyncDone = true;
      this._won = this._currentModuleIndex() === -1;
    }

    // Dym z uszkodzenia - dopóki statek nie jest naprawiony, LECI CAŁY CZAS
    // (nie tylko gdy gracz stoi w zasięgu - wrak dymi się sam z siebie).
    if (!this._won) {
      this._smokeTimer += delta;
      if (this._smokeTimer >= SHIP_SMOKE_INTERVAL_MS) {
        this._smokeTimer = 0;
        const dmg = this._damageWorldPos();
        Bus.publish(Events.FX_PARTICLES, { x: dmg.x, y: dmg.y, color: 'rgba(90, 95, 100, 0.55)', count: 2 });
      }
    }

    const dx = this.playerX - this.x;
    const dy = this.playerY - this.y;
    const wasInRange = this.inRange;
    this.inRange = Math.sqrt(dx * dx + dy * dy) < SHIP_DROP_RADIUS;

    // Opuszczenie zasięgu zeruje zgodę gracza - przy kolejnym podejściu
    // przycisk "Wpłać" (ui.js) musi zostać naciśnięty od nowa.
    if (wasInRange && !this.inRange) {
      this._contributing = false;
    }

    if (this._won || !this.inRange) {
      this._tickTimer = 0;
      return;
    }

    const idx = this._currentModuleIndex();
    if (idx === -1) return;

    // Gracz stoi w zasięgu, ale jeszcze NIE potwierdził wpłaty (patrz
    // confirmContribution()) - żadnych pieniędzy/surowców nie ubywa, dopóki
    // świadomie nie naciśnie przycisku w UI.
    if (!this._contributing) {
      this._tickTimer = 0;
      return;
    }

    this._tickTimer += delta;
    if (this._tickTimer < SHIP_CONTRIBUTION_INTERVAL_MS) return;
    this._tickTimer = 0;

    const def = SHIP_MODULE_DEFINITIONS[idx];
    let contributed = false;

    // Pieniądze - kawałek na tick, ograniczony do tego, ile jeszcze trzeba.
    const moneyHave = eco.getShipMoneyContributed(def.id);
    if (moneyHave < def.money) {
      const need = def.money - moneyHave;
      const paid = eco.contributeShipMoney(def.id, Math.min(SHIP_MONEY_PER_TICK, need));
      if (paid > 0) contributed = true;
    }

    // Surowiec - jeden typ na tick (pierwszy z listy, którego jeszcze brakuje).
    const stack = window.stackController;
    if (stack && !stack.isEmpty()) {
      const materialIds = Object.keys(def.materials);
      for (const typeId of materialIds) {
        const have = eco.getShipMaterialContributed(def.id, typeId);
        if (have >= def.materials[typeId]) continue;
        const stackIdx = stack.findIndex((item) => item.typeId === typeId);
        if (stackIdx !== -1) {
          stack.removeAt(stackIdx);
          eco.contributeShipMaterial(def.id, typeId);
          contributed = true;
          break;
        }
      }
    }

    if (contributed) {
      Bus.publish(Events.FX_PARTICLES, { x: this.x, y: this.y, color: '#81D4FA', count: 4 });
    }

    // Czy moduł jest teraz kompletny?
    const moneyDone = eco.getShipMoneyContributed(def.id) >= def.money;
    const materialsDone = Object.keys(def.materials).every(
      (typeId) => eco.getShipMaterialContributed(def.id, typeId) >= def.materials[typeId]
    );

    if (moneyDone && materialsDone && !eco.isShipModuleComplete(def.id)) {
      eco.markShipModuleComplete(def.id);

      // "Moment" ukończenia modułu - wyraźnie mocniejszy niż rutynowe
      // zdarzenia (np. dokarmienie maszyny), bo to jeden z tylko pięciu
      // kroków do właściwego celu gry, nie zdarza się często.
      Bus.publish(Events.FX_SHAKE, { intensity: 11, duration: 480 });

      // Dwie fale cząsteczek zamiast jednej - pierwsza natychmiast (impact),
      // druga chwilę później (echo) - czyta się bogaciej niż pojedynczy
      // wybuch, bez potrzeby nowego systemu efektów.
      Bus.publish(Events.FX_PARTICLES, { x: this.x, y: this.y, color: '#FFD54F', count: 26 });
      const flashY = this.y - (this.h / 2) * 0.4;
      setTimeout(() => {
        Bus.publish(Events.FX_PARTICLES, { x: this.x, y: flashY, color: '#81D4FA', count: 14 });
      }, 180);

      if (Events.FX_SHOCKWAVE) {
        Bus.publish(Events.FX_SHOCKWAVE, { x: this.x, y: this.y, color: '#FFD54F', maxRadius: (this.w / 2) * 2.2 });
      }

      // Timer czytany przez _drawPortholes - okienka świecą wyraźnie
      // jaśniej przez chwilę zaraz po ukończeniu, zamiast po prostu cicho
      // doświetlić się o jedno okienko więcej.
      this._moduleCompleteFlashUntil = performance.now() + 1100;

      Bus.publish(Events.FX_POPUP, {
        text: `${def.name} gotowy!`,
        // Checkmark rysowany PROCEDURALNIE nad popupem (patrz _drawPopupIcon
        // w gamefeel.js) zamiast dawnego ✅ wtopionego w text.
        icon: 'done',
        x: this.x,
        y: this.y - this.h / 2,
        duration: 2400,
        color: '#66BB6A'
      });
      Bus.publish(Events.SHIP_MODULE_COMPLETED, { moduleId: def.id, index: idx });

      if (this._currentModuleIndex() === -1) {
        this._won = true;
        Bus.publish(Events.GAME_WON, {});
      }
    }
  }

  /**
   * Viewport culling (ten sam wzorzec co items.js/machines.js/market.js) -
   * jedna instancja, ale rysowanie (kadłub z gradientem, nogi, wskaźniki
   * modułów, poświata po wygranej) kosztuje niezależnie od tego ile ich
   * jest. update() (stan ukończenia modułów) działa zawsze, niezależnie od
   * widoczności - statek ma pamiętać postęp, nawet gdy nikt na niego nie patrzy.
   */
  draw(ctxBg, ctx, ctxUI) {
    const camX = window.game ? window.game.cameraX : 0;
    const camY = window.game ? window.game.cameraY : 0;
    const viewW = window.innerWidth;
    const viewH = window.innerHeight;
    const margin = 150;
    if (this.x < camX - margin || this.x > camX + viewW + margin) return;
    if (this.y < camY - margin || this.y > camY + viewH + margin) return;

    const hw = this.w / 2;
    const hh = this.h / 2;
    const idx = this._currentModuleIndex();
    const eco = window.economyManager;
    const completedCount = eco ? eco.shipCompletedModules.length : 0;
    const litFraction = this._won ? 1 : completedCount / SHIP_MODULE_DEFINITIONS.length;

    // Strefa zasięgu.
    ctx.strokeStyle = this.inRange ? 'rgba(255, 255, 255, 0.6)' : 'rgba(255, 255, 255, 0.2)';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.arc(this.x, this.y, SHIP_DROP_RADIUS, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // Cień.
    ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
    ctx.beginPath();
    ctx.ellipse(this.x, this.y + hh + 6, hw * 0.9, hh * 0.25, 0, 0, Math.PI * 2);
    ctx.fill();

    // Poświata po ukończeniu wszystkiego - POD kadłubem, żeby nie zasłaniać tekstu.
    if (this._won) {
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 300);
      ctx.save();
      ctx.globalAlpha = 0.22 + 0.18 * pulse;
      ctx.fillStyle = '#81D4FA';
      ctx.beginPath();
      ctx.ellipse(this.x, this.y, hw * 1.6, hh * 1.05, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Kadłub + plama uszkodzenia + poświata okna - wszystko w jednej
    // przechylonej "grupie" (lekki przechył -0.06, "rozbity" wygląd), żeby
    // obracały się razem jako jedna bryła. Rakieta ma WŁASNE płetwy/nogi
    // wrysowane w sprite - osobne _drawStruts nie jest już potrzebne.
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(-0.06);

    this._drawShipBody(ctx, hw, hh, litFraction);
    if (!this._won) this._drawDamageScorch(ctx, hw, hh);

    ctx.restore();

    // Etykieta.
    ctx.font = 'bold 12px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    this._drawOutlinedText(ctx, this._won ? I18n.t('ship.readyLabel') : I18n.t('ship.wreckedLabel'), this.x, this.y - hh - 40, '#FFFFFF');

    // 5 ikon modułów - jasna/zielona = gotowa, przygaszona = jeszcze nie,
    // większa = aktualna. Proceduralne kształty (_drawModuleIcon) zamiast
    // emoji - każdy moduł to abstrakcyjne pojęcie bez odpowiednika w
    // realnym zdjęciu, więc tak jak przy sztabce stopu (items.js) rysujemy
    // prosty, rozpoznawalny kształt zamiast wracać do emoji.
    const dotSpacing = 22;
    const startX = this.x - ((SHIP_MODULE_DEFINITIONS.length - 1) * dotSpacing) / 2;
    SHIP_MODULE_DEFINITIONS.forEach((def, i) => {
      const dx = startX + i * dotSpacing;
      const isCurrent = i === idx;
      const done = eco && eco.isShipModuleComplete(def.id);
      const size = isCurrent ? 17 : 13;
      ctx.globalAlpha = done ? 1 : isCurrent ? 0.85 : 0.28;
      this._drawModuleIcon(ctx, def.id, dx, this.y - hh - 22, size, done ? '#69F0AE' : '#ECEFF1');
    });
    ctx.globalAlpha = 1;

    // Zwięzły pasek postępu aktualnego modułu - tylko gdy gracz w zasięgu.
    // Każda "część" (pieniądze + każdy surowiec) to osobno narysowana
    // ikonka (moneta/sprite/sztabka) + liczba OBOK niej, zamiast jednego
    // fillText z emoji wtopionym w napis - ten sam zabieg co wiersze cen
    // w market.js.
    if (this.inRange && !this._won && idx !== -1 && eco) {
      const def = SHIP_MODULE_DEFINITIONS[idx];
      const moneyHave = eco.getShipMoneyContributed(def.id);
      const materialTypeIds = Object.keys(def.materials);
      const parts = [{ kind: 'money', have: moneyHave, need: def.money }].concat(
        materialTypeIds.map((typeId) => ({
          kind: 'material',
          typeId,
          have: eco.getShipMaterialContributed(def.id, typeId),
          need: def.materials[typeId]
        }))
      );

      ctx.textAlign = 'center';
      ctx.font = 'bold 10px Arial';
      this._drawOutlinedText(ctx, def.name, this.x, this.y + hh + 22, '#FFF9C4');

      // Zdolność, którą ten moduł WŁĄCZY - pokazana ZANIM gracz zainwestuje.
      // Bez tego cały pomysł "buduj moduły po drodze, bo coś dają" nie
      // działa: gracz dowiadywałby się o nagrodzie dopiero PO wydaniu 800$
      // i surowców, więc nie miałby powodu, żeby zbudować moduł wcześniej
      // niż na końcu gry.
      const perkLabel = typeof eco.getShipPerkLabel === 'function' ? eco.getShipPerkLabel(def.id) : '';
      if (perkLabel) {
        ctx.font = '9px Arial';
        this._drawOutlinedText(ctx, `→ ${perkLabel}`, this.x, this.y + hh + 35, '#81D4FA');
      }

      const rowY = this.y + hh + 52;
      const partW = 44;
      let px = this.x - (parts.length * partW) / 2 + partW / 2;
      parts.forEach((p) => {
        const iconX = px - 11;
        if (p.kind === 'money') {
          this._drawCoinIcon(ctx, iconX, rowY, 15);
        } else if (typeof ItemRenderer !== 'undefined') {
          ItemRenderer._drawSpriteOrLabel(ctx, p.typeId, SHIP_MATERIAL_ICONS[p.typeId], iconX, rowY, 17);
        }
        ctx.textAlign = 'left';
        ctx.font = '10px Arial';
        this._drawOutlinedText(ctx, `${p.have}/${p.need}`, px - 1, rowY + 4, '#A5D6A7');
        px += partW;
      });
    }
  }

  /**
   * Proceduralny kształt dla jednego z 5 modułów statku - abstrakcyjne
   * pojęcia (nawigacja, osłony...) bez odpowiednika w realnym zdjęciu, więc
   * zamiast emoji rysujemy prosty, rozpoznawalny symbol. Rysowany w
   * ŚWIATOWYCH współrzędnych (x,y to środek), nie w lokalnej translacji, bo
   * kropki modułów siedzą POZA grupą kadłuba (ctx.restore() już wywołane
   * wyżej w draw()).
   */
  _drawModuleIcon(ctx, moduleId, x, y, size, color) {
    const r = size / 2;
    ctx.save();
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, size * 0.13);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    switch (moduleId) {
      case 'life_support': {
        // Krzyż medyczny w kole - uniwersalny symbol "podtrzymania życia".
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.stroke();
        const armW = size * 0.16;
        const armL = size * 0.46;
        ctx.fillRect(x - armW / 2, y - armL / 2, armW, armL);
        ctx.fillRect(x - armL / 2, y - armW / 2, armL, armW);
        break;
      }
      case 'navigation': {
        // Igła kompasu - diament.
        ctx.beginPath();
        ctx.moveTo(x, y - r);
        ctx.lineTo(x + r * 0.55, y);
        ctx.lineTo(x, y + r);
        ctx.lineTo(x - r * 0.55, y);
        ctx.closePath();
        ctx.fill();
        break;
      }
      case 'shields': {
        // Prosty kształt tarczy - zaokrąglona góra, spiczasty dół.
        ctx.beginPath();
        ctx.moveTo(x, y - r);
        ctx.quadraticCurveTo(x + r, y - r * 0.6, x + r * 0.8, y);
        ctx.quadraticCurveTo(x + r * 0.5, y + r * 0.9, x, y + r);
        ctx.quadraticCurveTo(x - r * 0.5, y + r * 0.9, x - r * 0.8, y);
        ctx.quadraticCurveTo(x - r, y - r * 0.6, x, y - r);
        ctx.closePath();
        ctx.fill();
        break;
      }
      case 'engine': {
        // Dziób rakiety - trójkąt ze skrzydłami u podstawy.
        ctx.beginPath();
        ctx.moveTo(x, y - r);
        ctx.lineTo(x + r * 0.55, y + r * 0.5);
        ctx.lineTo(x, y + r * 0.15);
        ctx.lineTo(x - r * 0.55, y + r * 0.5);
        ctx.closePath();
        ctx.fill();
        break;
      }
      case 'hyperdrive': {
        // Błyskawica.
        ctx.beginPath();
        ctx.moveTo(x + r * 0.15, y - r);
        ctx.lineTo(x - r * 0.5, y + r * 0.15);
        ctx.lineTo(x - r * 0.05, y + r * 0.15);
        ctx.lineTo(x - r * 0.2, y + r);
        ctx.lineTo(x + r * 0.5, y - r * 0.1);
        ctx.lineTo(x + r * 0.05, y - r * 0.1);
        ctx.closePath();
        ctx.fill();
        break;
      }
      default: {
        ctx.beginPath();
        ctx.arc(x, y, r * 0.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  /**
   * Prosta moneta (gradient + błysk + znak $) - używana zamiast 💰 przy
   * odczycie postępu wkładu pieniędzy w moduł, ten sam duch co _drawIngot w
   * items.js. Dopisany wyraźny "$" w środku (poprzednia wersja miała tylko
   * gradient bez żadnego znaku) - niezależnie od tego, jak dokładnie
   * postrzegany jest kolor na danym ekranie, kształt/znak jednoznacznie
   * czyta się jako moneta, nie jako niezidentyfikowana kulka.
   */
  _drawCoinIcon(ctx, x, y, size) {
    const r = size / 2;
    ctx.save();
    const grad = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.1, x, y, r);
    grad.addColorStop(0, '#FFF9C4');
    grad.addColorStop(1, '#F9A825');
    ctx.fillStyle = grad;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = 'rgba(110, 66, 6, 0.9)';
    ctx.font = `bold ${Math.round(r * 1.3)}px Arial`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('$', x, y + 0.5);
    ctx.restore();
  }

  /**
   * Tonuje fx_glow.png (Kenney Particle Pack, ta sama teksturka co poświata
   * maszyn - machines.js _drawCosmicGlow) na SHIP_WINDOW_GLOW_COLOR - jedna,
   * cache'owana raz w konstruktorze przy pierwszym użyciu (statek ma tylko
   * JEDEN akcent koloru, w przeciwieństwie do maszyn z 5 różnymi, więc nie
   * potrzeba tu całego _getRecoloredSprite/_getTintedFx z machines.js -
   * własna, dużo prostsza kopia zgodnie z konwencją "brak współdzielonych
   * utili" w tym projekcie).
   */
  _getWindowGlow() {
    if (this._windowGlowCanvas) return this._windowGlowCanvas;
    const img = window.spriteLoader && window.spriteLoader.get('fx_glow');
    if (!img || !img.complete || !img.naturalWidth) return null;
    const size = img.naturalWidth;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const tctx = canvas.getContext('2d');
    tctx.drawImage(img, 0, 0);
    tctx.globalCompositeOperation = 'source-atop';
    tctx.fillStyle = SHIP_WINDOW_GLOW_COLOR;
    tctx.fillRect(0, 0, size, size);
    this._windowGlowCanvas = canvas;
    return canvas;
  }

  /**
   * Kadłub: PRAWDZIWY myśliwiec z Kenney "Space Shooter Extension"
   * (assets/ship_fighter.png, CC0) - trzecia iteracja (patrz komentarz przy
   * SHIP_FIGHTER_ASPECT), zastępuje dawną ręcznie rysowaną elipsę "spodka" +
   * kopułę + pierścień okienek. W NATYWNYCH kolorach - bez przefarbowywania
   * (Tomek: "są ładne"), w przeciwieństwie do dwóch poprzednich wersji
   * kadłuba. Jedyna pozostała animacja to poświata NA prawdziwym kokpicie
   * sprite'a (SHIP_WINDOW_*_FRAC, zmierzone wprost z pliku, rysowana jako
   * elipsa dopasowana do owalnego konturu kokpitu) - jaśniejsza wraz z
   * litFraction (statek "budzi się" wraz z ukończonymi modułami), z krótkim
   * przebłyskiem zaraz po ukończeniu (_moduleCompleteFlashUntil, ten sam
   * wzorzec co dawny pierścień okienek rakiety/spodka).
   */
  _drawShipBody(ctx, hw, hh, litFraction) {
    const fighterImg = window.spriteLoader && window.spriteLoader.get('ship_fighter');
    if (fighterImg && fighterImg.complete && fighterImg.naturalWidth) {
      ctx.drawImage(fighterImg, -hw, -hh, hw * 2, hh * 2);
    } else {
      // Awaryjny fallback (plik się nie wczytał) - prosty szary owal,
      // wystarczający żeby statek nie zniknął całkiem z ekranu.
      ctx.fillStyle = '#8B8B93';
      ctx.beginPath();
      ctx.ellipse(0, 0, hw * 0.7, hh, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    const winCx = -hw + hw * 2 * SHIP_WINDOW_X_FRAC;
    const winCy = -hh + hh * 2 * SHIP_WINDOW_Y_FRAC;
    const winRx = hw * 2 * SHIP_WINDOW_W_FRAC * 0.5;
    const winRy = hh * 2 * SHIP_WINDOW_H_FRAC * 0.5;

    const now = performance.now();
    const flashRemaining = this._moduleCompleteFlashUntil - now;
    const flashT = flashRemaining > 0 ? Math.sin((flashRemaining / 1100) * (Math.PI / 2)) : 0;
    const baseGlow = this._won ? 1 : 0.25 + litFraction * 0.55;

    const glow = this._getWindowGlow();
    if (glow) {
      ctx.save();
      ctx.globalAlpha = baseGlow + flashT * 0.5;
      const growth = 1.3 + flashT * 0.4 + (this._won ? 0.35 * (0.5 + 0.5 * Math.sin(now / 300)) : 0);
      const gx = winRx * growth, gy = winRy * growth;
      ctx.translate(winCx, winCy);
      ctx.scale(gx, gy);
      ctx.drawImage(glow, -1, -1, 2, 2);
      ctx.restore();
    }
  }

  /**
   * Tonuje fx_soot.png (Kenney Particle Pack, miękka nieregularna plama -
   * ta sama teksturka co "smoke_01") na prawie czarno - ten sam wzorzec co
   * _getWindowGlow, osobna, dużo prostsza kopia (jeden kolor, cache'owany
   * raz) zgodnie z konwencją "brak współdzielonych utili".
   */
  _getSootStain() {
    if (this._sootCanvas) return this._sootCanvas;
    const img = window.spriteLoader && window.spriteLoader.get('fx_soot');
    if (!img || !img.complete || !img.naturalWidth) return null;
    const size = img.naturalWidth;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const tctx = canvas.getContext('2d');
    tctx.drawImage(img, 0, 0);
    tctx.globalCompositeOperation = 'source-atop';
    tctx.fillStyle = '#15130F';
    tctx.fillRect(0, 0, size, size);
    this._sootCanvas = canvas;
    return canvas;
  }

  /**
   * Uszkodzenie w stałym miejscu (SHIP_DAMAGE_DX/DY, żeby nie "skakało"
   * między odświeżeniami) - PRAWDZIWA, nieregularna plama sadzy (fx_soot,
   * przyciemniona) osadzona na kadłubie, plus dwie małe kreskówkowe chmurki
   * dymu (fx_smoke_puff, Kenney "Space Shooter Extension" - ten sam płaski
   * styl co statek/maszyny, w przeciwieństwie do malarskiej plamy sadzy pod
   * spodem) leniwie "oddychające" (skala/alpha) tuż nad nią - stały, czytelny
   * sygnał "to jest wrak", niezależny od periodycznych kłębów dymu z
   * update() (te lecą i znikają co SHIP_SMOKE_INTERVAL_MS, więc same w
   * sobie nie dawały WIDOCZNEGO "cały czas dymi się" wrażenia). Znika, gdy
   * statek jest naprawiony (this._won) - patrz draw().
   */
  _drawDamageScorch(ctx, hw, hh) {
    const dx = hw * SHIP_DAMAGE_DX, dy = hh * SHIP_DAMAGE_DY;
    const now = performance.now();

    const soot = this._getSootStain();
    ctx.save();
    if (soot) {
      const sr = hw * 0.26;
      ctx.globalAlpha = 0.8;
      ctx.drawImage(soot, dx - sr, dy - sr, sr * 2, sr * 2);
    } else {
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = '#0E0F11';
      ctx.beginPath();
      ctx.ellipse(dx, dy, hw * 0.22, hh * 0.09, 0.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    const puff = window.spriteLoader && window.spriteLoader.get('fx_smoke_puff');
    if (puff && puff.complete && puff.naturalWidth) {
      const puffs = [
        { ox: -hw * 0.03, oy: -hh * 0.14, size: hw * 0.16, phase: 0 },
        { ox: hw * 0.09, oy: -hh * 0.22, size: hw * 0.12, phase: 2.4 }
      ];
      puffs.forEach((p) => {
        const breathe = 0.5 + 0.5 * Math.sin(now * 0.0012 + p.phase);
        ctx.save();
        ctx.globalAlpha = 0.5 + breathe * 0.35;
        const s = p.size * (0.9 + breathe * 0.25);
        ctx.drawImage(puff, dx + p.ox - s / 2, dy + p.oy - breathe * hh * 0.05 - s / 2, s, s);
        ctx.restore();
      });
    }
  }

  /** Świat = kadłub + rotacja -0.06 statku, do wysyłania cząsteczek dymu
   * (Bus.publish, poza kontekstem transformowanym przez draw()). Nie
   * kompensuje rotacji -0.06 (za mały kąt, żeby było to zauważalne) - patrz
   * update(). */
  _damageWorldPos() {
    const hw = this.w / 2;
    const hh = this.h / 2;
    return { x: this.x + hw * SHIP_DAMAGE_DX, y: this.y + hh * SHIP_DAMAGE_DY };
  }

  /** Ten sam wzorzec co MachineManager._drawOutlinedText (machines.js) i
   * TradingPost._drawOutlinedText (market.js) - ciemna obwódka pod jasnym/
   * kolorowym wypełnieniem, czytelne na każdym biomie. Oczekuje, że
   * wywołujący ustawił już ctx.font/textAlign/textBaseline. */
  _drawOutlinedText(ctx, text, x, y, fillColor) {
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = fillColor;
    ctx.fillText(text, x, y);
  }

  destroy() {
    Bus.unsubscribe(Events.PLAYER_MOVED, this._onPlayerMoved);
    if (Events.PRESTIGE_DONE) {
      Bus.unsubscribe(Events.PRESTIGE_DONE, this._onPrestigeDone);
    }
  }
}

window.Ship = Ship;
window.SHIP_MODULE_DEFINITIONS = SHIP_MODULE_DEFINITIONS;
