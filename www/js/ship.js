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
  { id: 'life_support', name: 'Podtrzymywanie Życia', money: 300, materials: { plastic: 10 } },
  { id: 'navigation', name: 'Nawigacja', money: 500, materials: { plastic: 5, product: 8 } },
  { id: 'shields', name: 'Osłony', money: 800, materials: { product: 6, alloy: 8 } },
  { id: 'engine', name: 'Silnik', money: 1200, materials: { product: 4, alloy: 14 } },
  { id: 'hyperdrive', name: 'Hipernapęd', money: 2000, materials: { plastic: 5, product: 10, alloy: 12 } }
];

// Wartości puste - BYŁY emoji (ten sam powód co ITEM_TYPES.label w items.js).
// ItemRenderer._drawSpriteOrLabel (jedyny konsument, patrz draw() niżej)
// rysuje sprite/proceduralną bryłę/neutralną plakietkę, nigdy tekstu.
const SHIP_MATERIAL_ICONS = { plastic: '', product: '', alloy: '' };

const SHIP_SIZE = 220;
const SHIP_DROP_RADIUS = 90;
// Ten sam rytm co MACHINE_UNLOAD_INTERVAL_MS / TRADING_POST_SELL_INTERVAL_MS -
// jedna "porcja" dostawy na tyle ms, dopóki gracz stoi w zasięgu.
const SHIP_CONTRIBUTION_INTERVAL_MS = 200;
const SHIP_MONEY_PER_TICK = 25;

// --- Wygląd: "statek obcych" (odświeżony wygląd) -----------------------------
// Pierścień okienek dookoła obrzeża kadłuba - zapala się STOPNIOWO wraz z
// ukończonymi modułami (litFraction w _drawPortholes), więc statek wizualnie
// "budzi się do życia" w miarę postępu, zamiast być cały czas tym samym
// jednolitym kształtem od pierwszego do ostatniego modułu.
const SHIP_PORTHOLE_COUNT = 12;
const SHIP_PORTHOLE_LIT_COLOR = '#7CFFD4';
const SHIP_PORTHOLE_UNLIT_COLOR = 'rgba(18, 22, 26, 0.65)';
// Stały kąt/szerokość wyrwy w kadłubie (radiany) - CELOWO nie losowy, żeby
// uszkodzenie nie "skakało" między odświeżeniami strony. 2.35 rad ~ 135°,
// czyli lewy-dolny bok - z dala od etykiety (góra) i kopuły (środek).
const SHIP_DAMAGE_ANGLE = 2.35;
const SHIP_DAMAGE_WIDTH = 0.85;
// Co ile ms z uszkodzenia leci odrobina dymu - tylko dopóki statek nie jest
// naprawiony (this._won == false). Po naprawie dziura + dym znikają.
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
    this.w = SHIP_SIZE;
    this.h = SHIP_SIZE * 0.7;

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

    // Nogi lądownicze - PRZED kadłubem (poza translate/rotate hull-grupy, w
    // świecie), żeby wizualnie "wchodziły w ziemię" spod spodu, a nie kręciły
    // się razem z przechyłem kadłuba.
    this._drawStruts(ctx, hw, hh);

    // Poświata po ukończeniu wszystkiego - POD kadłubem, żeby nie zasłaniać tekstu.
    if (this._won) {
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 300);
      ctx.save();
      ctx.globalAlpha = 0.22 + 0.18 * pulse;
      ctx.fillStyle = '#81D4FA';
      ctx.beginPath();
      ctx.ellipse(this.x, this.y, hw * 1.3, hh * 1.15, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Kadłub + wyrwa uszkodzenia + okienka + kopuła - wszystko w jednej
    // przechylonej "hull-grupie" (ten sam przechył -0.08 co wcześniej,
    // "rozbity" wygląd), żeby obracały się razem jako jedna bryła.
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(-0.08);

    this._drawHull(ctx, hw, hh);
    if (!this._won) this._drawDamage(ctx, hw, hh);
    this._drawPortholes(ctx, hw, hh, litFraction);
    this._drawDome(ctx, hw, hh);

    ctx.restore();

    // Etykieta.
    ctx.font = 'bold 12px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    this._drawOutlinedText(ctx, this._won ? 'Gotowy do startu!' : 'Rozbity Statek', this.x, this.y - hh - 40, '#FFFFFF');

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
   * Trzy nogi lądownicze, CELOWO niesymetryczne (różne długości/kąty) - efekt
   * krzywo wbitego wraku, nie schludnego statywu. Rysowane w świecie (przed
   * translate/rotate kadłuba), żeby zawsze "stały prosto" niezależnie od
   * przechyłu bryły nad nimi.
   */
  _drawStruts(ctx, hw, hh) {
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.strokeStyle = 'rgba(38, 42, 46, 0.9)';
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';

    const legs = [
      { fx: -hw * 0.5, fy: hh * 0.15, tx: -hw * 0.82, ty: hh * 0.95, footAngle: -0.35 },
      { fx: hw * 0.48, fy: hh * 0.2, tx: hw * 0.88, ty: hh * 0.85, footAngle: 0.3 },
      { fx: hw * 0.02, fy: hh * 0.4, tx: hw * 0.12, ty: hh * 1.05, footAngle: 0.05 }
    ];

    legs.forEach((leg) => {
      ctx.beginPath();
      ctx.moveTo(leg.fx, leg.fy);
      ctx.lineTo(leg.tx, leg.ty);
      ctx.stroke();

      ctx.save();
      ctx.translate(leg.tx, leg.ty);
      ctx.rotate(leg.footAngle);
      ctx.fillStyle = 'rgba(38, 42, 46, 0.9)';
      ctx.beginPath();
      ctx.moveTo(-9, 0);
      ctx.lineTo(9, 0);
      ctx.lineTo(0, 8);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    });

    ctx.restore();
  }

  /**
   * Kadłub - elipsa z pionowym gradientem (jaśniejsza góra = górne
   * oświetlenie, ciemniejszy dół) zamiast płaskiego koloru, żeby czytał się
   * jako metalowa bryła, nie naklejka. Paleta lekko zielonkawo-chromowa
   * (nie czysty szaro-niebieski) - obcy stop, nie ziemska blacha.
   */
  _drawHull(ctx, hw, hh) {
    const top = this._won ? '#DCF5F2' : '#8FA69C';
    const mid = this._won ? '#A9D6D1' : '#5C7269';
    const bottom = this._won ? '#6FA39C' : '#33443D';

    const grad = ctx.createLinearGradient(0, hh * 0.3 - hh * 0.55, 0, hh * 0.3 + hh * 0.55);
    grad.addColorStop(0, top);
    grad.addColorStop(0.55, mid);
    grad.addColorStop(1, bottom);

    ctx.fillStyle = grad;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(0, hh * 0.3, hw, hh * 0.55, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Cienka krawędziowa obwódka podkreślająca rant "spodka" - jaśniejsza
    // linia w 2/3 wysokości, gdzie kadłub najszerszy.
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(0, hh * 0.42, hw * 0.94, hh * 0.42, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  /**
   * Postrzępiona wyrwa w kadłubie - stały kąt (SHIP_DAMAGE_ANGLE), żeby nie
   * "skakała" między klatkami/odświeżeniami. Znika, gdy statek jest
   * naprawiony (this._won) - patrz draw().
   */
  _drawDamage(ctx, hw, hh) {
    const lx = Math.cos(SHIP_DAMAGE_ANGLE) * hw * 0.85;
    const ly = hh * 0.3 + Math.sin(SHIP_DAMAGE_ANGLE) * hh * 0.55 * 0.85;

    ctx.save();
    ctx.translate(lx, ly);
    ctx.rotate(SHIP_DAMAGE_ANGLE);
    ctx.fillStyle = 'rgba(14, 15, 17, 0.92)';
    ctx.beginPath();
    ctx.moveTo(-15, -11);
    ctx.lineTo(11, -15);
    ctx.lineTo(17, 5);
    ctx.lineTo(-5, 17);
    ctx.lineTo(-19, 6);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-7, -9);
    ctx.lineTo(-2, 5);
    ctx.moveTo(4, -11);
    ctx.lineTo(9, 2);
    ctx.stroke();
    ctx.restore();
  }

  /** Świat = kadłub + rotacja -0.08 statku, do wysyłania cząsteczek dymu
   * (Bus.publish, poza kontekstem transformowanym przez draw()). Nie
   * kompensuje rotacji -0.08 (za mały kąt, żeby było to zauważalne) - patrz
   * update(). */
  _damageWorldPos() {
    const hw = this.w / 2;
    const hh = this.h / 2;
    const lx = Math.cos(SHIP_DAMAGE_ANGLE) * hw * 0.85;
    const ly = hh * 0.3 + Math.sin(SHIP_DAMAGE_ANGLE) * hh * 0.55 * 0.85;
    return { x: this.x + lx, y: this.y + ly };
  }

  /**
   * Pierścień okienek dookoła obrzeża kadłuba - ta sama elipsa co _drawHull,
   * przeskalowana lekko do wewnątrz (0.82), żeby okienka siedziały NA
   * obrzeżu, nie poza nim. Pomija okienka wypadające w wyrwie uszkodzenia -
   * fizycznie ich tam nie ma. litFraction (0..1, z draw()) określa, ile
   * okienek świeci - statek "budzi się" wraz z ukończonymi modułami.
   */
  _drawPortholes(ctx, hw, hh, litFraction) {
    const count = SHIP_PORTHOLE_COUNT;
    const litCount = Math.round(count * litFraction);

    // Przebłysk tuż po ukończeniu modułu - okienka wyraźnie jaśniejsze przez
    // krótką chwilę, żeby ten moment było widać na samym statku, nie tylko w
    // popupie/screen shake. Ćwierćsinusoida: szczyt DOKŁADNIE w momencie
    // ukończenia, płynne wygaszanie do zera - pierwsza wersja liczyła
    // sin(t*PI), co dawało ZERO w chwili ukończenia i szczyt dopiero w
    // połowie czasu trwania, rozjeżdżając się w czasie ze wstrząsem/
    // cząsteczkami/falą uderzeniową (te odpalają się natychmiast).
    const now = performance.now();
    const flashRemaining = this._moduleCompleteFlashUntil - now;
    const flashT = flashRemaining > 0 ? Math.sin((flashRemaining / 1100) * (Math.PI / 2)) : 0;

    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2;

      if (!this._won) {
        let diff = Math.abs(angle - SHIP_DAMAGE_ANGLE);
        if (diff > Math.PI) diff = Math.PI * 2 - diff;
        if (diff < SHIP_DAMAGE_WIDTH / 2) continue;
      }

      const px = Math.cos(angle) * hw * 0.82;
      const py = hh * 0.3 + Math.sin(angle) * hh * 0.55 * 0.82;
      const isLit = i < litCount;

      if (isLit) {
        ctx.save();
        ctx.globalAlpha = 0.45 + flashT * 0.4;
        ctx.fillStyle = SHIP_PORTHOLE_LIT_COLOR;
        ctx.beginPath();
        ctx.arc(px, py, 6.5 + flashT * 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      ctx.fillStyle = isLit ? SHIP_PORTHOLE_LIT_COLOR : SHIP_PORTHOLE_UNLIT_COLOR;
      ctx.beginPath();
      ctx.arc(px, py, 3.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /**
   * Kopuła - jak wcześniej (półelipsa na wierzchu), plus dwa nowe detale:
   * cienki świecący pierścień u nasady (gdzie kopuła styka się z kadłubem -
   * "obcy" akcent, nie tylko ludzka szyba) i pulsujący rdzeń w środku,
   * niezależny od poświaty zwycięstwa - kopuła "żyje" cały czas, nie tylko
   * po naprawieniu statku.
   */
  _drawDome(ctx, hw, hh) {
    const domeCenterY = -hh * 0.05;
    const domeRX = hw * 0.45;
    const domeRY = hh * 0.4;

    // Pierścień u nasady.
    ctx.strokeStyle = this._won ? 'rgba(124, 255, 212, 0.9)' : 'rgba(124, 255, 212, 0.55)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(0, domeCenterY, domeRX * 1.05, domeRY * 1.05, 0, Math.PI, 0);
    ctx.stroke();

    // Szkło kopuły.
    ctx.fillStyle = this._won ? 'rgba(129, 212, 250, 0.9)' : 'rgba(129, 212, 250, 0.55)';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(0, domeCenterY, domeRX, domeRY, 0, Math.PI, 0);
    ctx.fill();
    ctx.stroke();

    // Pulsujący rdzeń - niezależny od poświaty zwycięstwa (this._won), więc
    // kopuła "oddycha" nawet zanim statek jest naprawiony.
    const corePulse = 0.5 + 0.5 * Math.sin(performance.now() / 450);
    ctx.save();
    ctx.globalAlpha = 0.4 + 0.35 * corePulse;
    ctx.fillStyle = '#E0FFFA';
    ctx.beginPath();
    ctx.arc(0, domeCenterY - domeRY * 0.25, 4 + corePulse * 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
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
