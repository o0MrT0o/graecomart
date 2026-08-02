'use strict';

/**
 * ui.js
 * ------------------------------------------------------------------------
 * Modularny system UI oparty na komponentach DOM + integracja z Bus/Events.
 *
 * Komponenty: UIPanel, UIButton, MoneyDisplay, StackDisplay,
 * ShopPanel, NotificationManager, TooltipManager, UIManager.
 */

const UI_BREAKPOINT_NARROW = 640;

// Ikony HUD - Tomek: "ogarnij ikonę kasy i samą kasę... ikonę plecaka
// też" - dawny hand-drawn kolorowy pieniążek (kółka+łuk "$") i konturowy
// "diament" jako plecak nie pasowały już do reszty gry po przejściu na
// prawdziwe assety Kenney. MONEY_ICON_SVG teraz woreczek z monetami
// ("pouch", Kenney Board Game Icons) przez ten sam mechanizm .ui-icon co
// ikony paneli (CSS mask + kolor z kontekstu - tu wymuszony na złoty przez
// .ui-money__icon .ui-icon w style.css, żeby zostać przy ustalonym
// kojarzeniu "pieniądze = złoto"). STACK_ICON_SVG to teraz prawdziwy
// sprite plecaka (Kenney Generic Items, assets/ui/backpack.png) w
// NATYWNYCH kolorach (zielony) zamiast maski - to osobna, kolorowa
// ilustracja jak sprite'y maszyn/statku, nie jednokolorowa sylwetka.
const MONEY_ICON_SVG = '<span class="ui-icon ui-icon--pouch" aria-hidden="true"></span>';
const STACK_ICON_SVG = '<img class="ui-backpack-icon" src="assets/ui/backpack.png" alt="" aria-hidden="true">';

// --- Biblioteka ikon UI (SVG, nie emoji) -------------------------------------
// Reszta emoji w UI (nawigacja/panele/toasty/ustawienia) - ten sam powód co
// MONEY_ICON_SVG/STACK_ICON_SVG wyżej, viewBox 24x24, proste kreski.
// Grupowane tutaj zamiast rozrzucone przy każdym miejscu użycia -
// część z nich (np. CORE_ICON_SVG, CLOSE_ICON_SVG) pojawia się dziesiątki
// razy w tym pliku, więc jedna stała + wstawienie w template stringu jest
// jedynym sensownym podejściem.
// Sklep/Menu/Statek (fab) + Wpłać/Leć dalej (accent) - pierwsza wersja tych
// ikon (dawno temu) to ręcznie rysowane SOLIDNE sylwetki fill="currentColor"
// (nie cienkie kreski) - dobrane celowo pod grube, płaskocieniowane
// przyciski Kenney (style.css .ui-btn), okienka/otwory (rakieta, tryb,
// moneta) wycięte fill-rule="evenodd", żeby ikona wyglądała poprawnie na
// KAŻDYM tle przycisku bez osobnej wersji na kontekst.
// CART/GEAR/PAY PODMIENIONE (razem z resztą tej fali - Tomek: "wszystkie
// ikony w sklepie i w menu niech będą zgodne z resztą z gry") na prawdziwe
// sylwetki Kenney - ten sam .ui-icon (maska CSS + currentColor) mechanizm,
// który już utrzymywał dopasowanie koloru do tła przycisku (fab/accent) w
// poprzedniej, ręcznie rysowanej wersji, więc zero regresji w dopasowaniu
// barw, tylko realny asset zamiast narysowanego od zera kształtu. PAY (był
// "$" wycięty evenodd) na zwykłą monetę (coin.png) - ostatni MIEJSCA symbol
// dolara w kodzie, reszta dawno zastąpiona sześciokątnym "czipem"
// (CREDIT_ICON_SVG). ROCKET zostaje custom SVG - żadna z dostępnych paczek
// Kenney nie miała prostej, jednokolorowej sylwetki rakiety pasującej do
// tej samej maski/rozmiaru co reszta (tylko szczegółowe, kolorowe bryły
// statków, nie sylwetki-ikony).
const CART_ICON_SVG = '<span class="ui-icon ui-icon--cart" aria-hidden="true"></span>';
const ROCKET_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path fill-rule="evenodd" d="M12 2c3.5 2.8 4.6 7.3 3 12.2H9C7.4 9.3 8.5 4.8 12 2ZM13.7 9A1.7 1.7 0 1 1 10.3 9A1.7 1.7 0 1 1 13.7 9Z"/><path d="M9 14.5 6.4 17.8 7.4 18.4 9.8 15.7Z"/><path d="M15 14.5 17.6 17.8 16.6 18.4 14.2 15.7Z"/><path d="M10 15v4.3l2 1.7 2-1.7V15Z"/></svg>';
const GEAR_ICON_SVG = '<span class="ui-icon ui-icon--gear" aria-hidden="true"></span>';
const PAY_ICON_SVG = '<span class="ui-icon ui-icon--coin" aria-hidden="true"></span>';
// TROPHY/WRENCH/UNLOCK/SPEAKER/RECYCLE_RESET/INFO (niżej) - PODMIENIONE z
// ręcznie rysowanych SVG na prawdziwe sylwetki z Kenney "Game Icons" (CC0),
// ta sama paczka co przyciski (style.css .ui-btn/.ui-icon). Technika: CSS
// mask (patrz .ui-icon w style.css) zamiast fill="currentColor" na <svg> -
// PNG-sylwetka jako maska na tle background-color:currentColor, więc nadal
// automatycznie dopasowuje kolor do kontekstu (biały tytuł panelu,
// przyciemniony tekst wiersza Menu). Same stałe (span zamiast svg) -
// WSZYSTKIE miejsca wołające ${TROPHY_ICON_SVG} itd. zostają bez zmian.
const TROPHY_ICON_SVG = '<span class="ui-icon ui-icon--trophy" aria-hidden="true"></span>';
const CLOSE_ICON_SVG = '<span class="ui-icon ui-icon--cross" aria-hidden="true"></span>';
const CHECK_ICON_SVG = '<span class="ui-icon ui-icon--checkmark" aria-hidden="true"></span>';
// Symbol waluty Rdzeni (Rdzenie/Cores) - zastępuje ⚡ używane dotąd JAKO
// TEKST wewnątrz wielu stringów ("⚡${cost}") - wstawiany bezpośrednio w
// template literały (wszystkie miejsca użycia i tak trafiają do innerHTML,
// nie textContent).
const CORE_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="13" height="13" style="vertical-align:-2px" fill="#81D4FA" stroke="none"><path d="M13 2 4 14h6l-1 8 9-12h-6Z"/></svg>';
// Symbol głównej waluty (pieniądze) - Tomek: "zamieńmy dolar na coś
// bardziej pasującego do gry... sci-fi/kosmici". Zastępuje "$" używane
// dotąd JAKO TEKST wewnątrz dziesiątek stringów w całej grze ("180$",
// "+50$", "za 200$" itd.) - sześciokątny "czip energetyczny" z wydrążonym
// świecącym rdzeniem pośrodku (fill-rule evenodd), złoty jak reszta
// oznaczeń pieniędzy (--ui-gold), ten sam duch co CORE_ICON_SVG wyżej
// (osobna waluta, inny kształt/kolor - błyskawica dla Rdzeni, sześciokąt
// dla pieniędzy). WSTAWIANY JAKO SUFIKS (`${amount}${CREDIT_ICON_SVG}`),
// nie prefiks jak CORE_ICON_SVG - dokładnie tam, gdzie dotąd stało "$".
const CREDIT_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" style="vertical-align:-2px" fill="#FFD54F" stroke="none"><path fill-rule="evenodd" d="M21 12 16.5 19.79 7.5 19.79 3 12 7.5 4.21 16.5 4.21Z M14.2 12A2.2 2.2 0 1 1 9.8 12A2.2 2.2 0 1 1 14.2 12Z"/></svg>';
// LOCK PODMIENIONY (był ten sam cienki, ręcznie rysowany kłódkowy kontur co
// reszta tej fali - patrz komentarz przy CART/GEAR/PAY wyżej) - dodany
// niedawno (kłódka "za mało kasy"), ale od razu na docelowej ikonie
// (locked.png), więc CAŁA historia zmiany tu nieaktualna, brak osobnego
// komentarza "przed/po".
const LOCK_ICON_SVG = '<span class="ui-icon ui-icon--locked" aria-hidden="true"></span>';
const UNLOCK_ICON_SVG = '<span class="ui-icon ui-icon--unlocked" aria-hidden="true"></span>';
const SPEAKER_ICON_SVG = '<span class="ui-icon ui-icon--audio-on" aria-hidden="true"></span>';
// CHART/BOOK/SPARKLE/PARTY/FLAME/SHIRT (niżej) - ta sama fala co CART/GEAR/
// PAY/LOCK wyżej: prawdziwe sylwetki Kenney zamiast ręcznie rysowanych
// SVG. Stały kolor akcentu KAŻDEGO z nich (dawniej stroke/fill="#hex" w
// samym SVG) przeniesiony na inline style="color:#hex" na spanie - .ui-icon
// czyta currentColor z KONTEKSTU (patrz komentarz przy TROPHY_ICON_SVG),
// więc bez tego wszystkie przejęłyby kolor otaczającego tekstu i straciłyby
// swój rozpoznawalny odcień (fioletowa gwiazdka, pomarańczowy płomień itd).
// PLANET zostaje custom SVG - kenney_planets.zip to surowe "części"
// (światła/szumy/tekstury) do procedualnego składania planet w tle, nie
// gotowe, proste ikonki pod maskę UI.
const CHART_ICON_SVG = '<span class="ui-icon ui-icon--chart" aria-hidden="true" style="color:#90CAF9"></span>';
const BOOK_ICON_SVG = '<span class="ui-icon ui-icon--book" aria-hidden="true" style="color:#CE93D8"></span>';
const RECYCLE_RESET_ICON_SVG = '<span class="ui-icon ui-icon--reset" aria-hidden="true"></span>';
const INFO_ICON_SVG = '<span class="ui-icon ui-icon--information" aria-hidden="true"></span>';
const SPARKLE_ICON_SVG = '<span class="ui-icon ui-icon--star" aria-hidden="true" style="color:#CE93D8"></span>';
const PARTY_ICON_SVG = '<span class="ui-icon ui-icon--award" aria-hidden="true" style="color:#FFD54F"></span>';
const WRENCH_ICON_SVG = '<span class="ui-icon ui-icon--wrench" aria-hidden="true"></span>';
const PLANET_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#B39DDB" stroke-width="1.8"><circle cx="11" cy="12" r="6" fill="#B39DDB" fill-opacity="0.25"/><ellipse cx="11" cy="12" rx="10" ry="3.2" transform="rotate(-18 11 12)"/></svg>';
const FLAME_ICON_SVG = '<span class="ui-icon ui-icon--fire" aria-hidden="true" style="color:#FF7043"></span>';
const SHIRT_ICON_SVG = '<span class="ui-icon ui-icon--brush" aria-hidden="true" style="color:#90CAF9"></span>';

// --- Bazowy komponent -------------------------------------------------------

class UIComponent {
  constructor(root) {
    this.root = root;
    this.el = null;
  }

  mount(parent) {
    if (!this.el) this.render();
    if (parent && this.el.parentNode !== parent) {
      parent.appendChild(this.el);
    }
    return this.el;
  }

  render() {
    throw new Error('UIComponent.render() must be implemented');
  }

  destroy() {
    if (this.el && this.el.parentNode) {
      this.el.parentNode.removeChild(this.el);
    }
    this.el = null;
  }
}

// --- Przycisk ---------------------------------------------------------------

class UIButton extends UIComponent {
  // sound - klucz w AudioManager (audio.js) grany PRZED onClick. Domyślnie
  // 'ui_click' (zwykłe tapnięcie) - jedyny wyjątek to przycisk Dźwięk w Menu
  // (SettingsPanel._buildSoundRow), który dostaje 'ui_switch' (osobny,
  // wyraźnie "przełączający" dźwięk z Kenney UI Pack - ten sam pack co
  // tekstury przycisków, patrz style.css .ui-btn) - w końcu to jedyny
  // przycisk w grze, który faktycznie działa jak fizyczny przełącznik
  // (włącz/wyłącz), nie jednorazowa akcja.
  // denied - WYGLĄDA jak disabled (ta sama klasa CSS .ui-btn--disabled), ale
  // W ODRÓŻNIENIU od disabled NIE ustawia natywnego <button disabled> -
  // przeglądarka w ogóle nie emituje eventu 'click' na natywnie wyłączonym
  // przycisku, więc "za mało pieniędzy/Rdzeni" (Tomek: "dźwięki UI/error
  // feedback") potrzebuje przycisku, który DALEJ reaguje na tap, tylko zamiast
  // onClick gra dźwięk odmowy (audio.js 'error') i nic nie robi. disabled
  // zostaje bez zmian dla przypadków prawdziwie nieinteraktywnych (reszta gry).
  constructor({ label, icon, variant = 'primary', onClick, disabled = false, denied = false, title = '', sound = 'ui_click' }) {
    super();
    this.label = label;
    this.icon = icon;
    this.variant = variant;
    this.onClick = onClick;
    this.disabled = disabled;
    this.denied = denied;
    this.title = title;
    this.sound = sound;
    this._handler = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.denied) {
        if (window.audioManager) window.audioManager.play('error');
        return;
      }
      if (!this.disabled && typeof this.onClick === 'function') {
        if (window.audioManager) window.audioManager.play(this.sound);
        this.onClick(e);
      }
    };
  }

  render() {
    this.el = document.createElement('button');
    this.el.type = 'button';
    this.el.className = `ui-btn ui-btn--${this.variant}`;
    if (this.title) this.el.title = this.title;
    this.el.innerHTML = `${this.icon ? `<span class="ui-btn__icon">${this.icon}</span>` : ''}<span class="ui-btn__label">${this.label}</span>`;
    this.el.addEventListener('click', this._handler);
    this.setDisabled(this.disabled);
    if (this.denied) this.el.classList.add('ui-btn--disabled');
    return this.el;
  }

  setDisabled(disabled) {
    this.disabled = disabled;
    if (this.el) {
      this.el.disabled = disabled;
      this.el.classList.toggle('ui-btn--disabled', disabled);
    }
  }

  /** Podmienia tekst etykiety bez przebudowy całego przycisku (np. "Ładowanie..."
   * na czas oczekiwania na reklamę - patrz OfflineRewardModal._watchAdAndClaim). */
  setLabel(label) {
    this.label = label;
    if (this.el) {
      const labelEl = this.el.querySelector('.ui-btn__label');
      // innerHTML (nie textContent) - etykiety podmieniane w locie mogą
      // zawierać CREDIT_ICON_SVG (np. OfflineRewardModal._watchAdAndClaim
      // przywraca "x2 (+X[ikona])" po nieudanej reklamie) - oba wołające
      // miejsca w projekcie przekazują tylko wewnętrzne, bezpieczne teksty,
      // nigdy dane od użytkownika.
      if (labelEl) labelEl.innerHTML = label;
    }
  }

  destroy() {
    if (this.el) this.el.removeEventListener('click', this._handler);
    super.destroy();
  }
}

// --- Panel ------------------------------------------------------------------

class UIPanel extends UIComponent {
  constructor({ id, className = '', title, icon, collapsible = false }) {
    super();
    this.id = id;
    this.className = className;
    this.title = title;
    this.icon = icon;
    this.collapsible = collapsible;
    this.collapsed = false;
    this.bodyEl = null;
  }

  render() {
    this.el = document.createElement('section');
    this.el.className = `ui-panel ${this.className}`.trim();
    if (this.id) this.el.id = this.id;

    const header = document.createElement('header');
    header.className = 'ui-panel__header';
    header.innerHTML = `
      <span class="ui-panel__title">${this.icon ? `<span class="ui-panel__icon">${this.icon}</span>` : ''}${this.title || ''}</span>
      ${this.collapsible ? '<button type="button" class="ui-panel__toggle" aria-label="Zwiń/rozwiń">▾</button>' : ''}
    `;

    this.bodyEl = document.createElement('div');
    this.bodyEl.className = 'ui-panel__body';

    this.el.appendChild(header);
    this.el.appendChild(this.bodyEl);

    if (this.collapsible) {
      const toggle = header.querySelector('.ui-panel__toggle');
      toggle.addEventListener('click', () => this.toggleCollapse());
    }

    return this.el;
  }

  toggleCollapse() {
    this.collapsed = !this.collapsed;
    this.el.classList.toggle('ui-panel--collapsed', this.collapsed);
  }

  setBodyContent(nodeOrHtml) {
    if (!this.bodyEl) return;
    if (typeof nodeOrHtml === 'string') {
      this.bodyEl.innerHTML = nodeOrHtml;
    } else {
      this.bodyEl.innerHTML = '';
      this.bodyEl.appendChild(nodeOrHtml);
    }
  }
}

// --- Wyświetlacz pieniędzy --------------------------------------------------

class MoneyDisplay extends UIComponent {
  constructor() {
    super();
    this.value = 0;
    this.displayValue = 0;
    this._animating = false;
  }

  render() {
    this.el = document.createElement('div');
    this.el.className = 'ui-money';
    this.el.innerHTML = `
      <span class="ui-money__icon" aria-hidden="true">${MONEY_ICON_SVG}</span>
      <div class="ui-money__content">
        <span class="ui-money__value">0</span>
      </div>
    `;
    this.valueEl = this.el.querySelector('.ui-money__value');
    return this.el;
  }

  setValue(value, animate = true) {
    this.value = value;
    if (!animate) {
      this.displayValue = value;
      this._animating = false;
      this._updateText();
      return;
    }
    if (Math.abs(this.value - this.displayValue) < 0.5) {
      this.displayValue = value;
      this._animating = false;
    } else {
      this._animating = true;
    }
    this._updateText();
  }

  update(delta) {
    if (!this._animating) return;
    const diff = this.value - this.displayValue;
    if (Math.abs(diff) < 0.5) {
      this.displayValue = this.value;
      this._animating = false;
    } else {
      this.displayValue += diff * Math.min(1, delta / 180);
    }
    this._updateText();
  }

  _updateText() {
    if (this.valueEl) {
      // Bez ikony waluty tutaj (w przeciwieństwie do reszty gry) - ta sama
      // pigułka ma już .ui-money__icon (woreczek z monetami) po lewej,
      // druga ikonka obok samej liczby byłaby zbędnym powtórzeniem.
      this.valueEl.textContent = Math.floor(this.displayValue).toLocaleString('pl-PL');
    }
  }

  pulse() {
    if (this.el) {
      this.el.classList.remove('ui-money--pulse');
      void this.el.offsetWidth;
      this.el.classList.add('ui-money--pulse');
    }
  }
}

// --- Wyświetlacz stosu -----------------------------------------------------

class StackDisplay extends UIComponent {
  constructor() {
    super();
    this.size = 0;
    this.max = 10;
  }

  render() {
    this.el = document.createElement('div');
    this.el.className = 'ui-stack';
    this.el.innerHTML = `
      <span class="ui-stack__icon" aria-hidden="true">${STACK_ICON_SVG}</span>
      <div class="ui-stack__content">
        <span class="ui-stack__value">0 / 10</span>
      </div>
      <div class="ui-stack__bar"><div class="ui-stack__fill"></div></div>
    `;
    this.valueEl = this.el.querySelector('.ui-stack__value');
    this.fillEl = this.el.querySelector('.ui-stack__fill');
    return this.el;
  }

  setStack(size, max) {
    this.size = size;
    this.max = max || 10;
    const pct = this.max > 0 ? Math.min(100, (this.size / this.max) * 100) : 0;
    if (this.valueEl) {
      this.valueEl.textContent = `${this.size} / ${this.max}`;
    }
    if (this.fillEl) {
      this.fillEl.style.width = `${pct}%`;
      this.fillEl.classList.toggle('ui-stack__fill--full', this.size >= this.max);
    }
  }
}

// Ikona schowka/listy zadań - SVG zamiast emoji, ten sam duch co ikony
// sklepu w economy.js (żadnego nowego motywu emoji, skoro reszta gry
// świadomie z nich rezygnuje).
const CHALLENGE_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="#FFD54F" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4 V2.5 M15 4 V2.5"/><path d="M8 12 L10.5 14.5 L16 9"/></svg>';

/**
 * Wyzwanie dnia - reużywa DOKŁADNIE te same klasy CSS co StackDisplay
 * (.ui-stack*) - ten sam wizualny język "pigułki z paskiem postępu", zero
 * nowego CSS. Klikalne TYLKO gdy ukończone i nieodebrane (economy.js
 * .claimDailyChallenge() pilnuje właściwej logiki, tu tylko UI).
 */
class ChallengeDisplay extends UIComponent {
  constructor(onClaim) {
    super();
    this.onClaim = onClaim;
    this.challenge = null;
  }

  render() {
    this.el = document.createElement('div');
    this.el.className = 'ui-goal';
    this.el.innerHTML = `
      <span class="ui-goal__icon" aria-hidden="true">${CHALLENGE_ICON_SVG}</span>
      <span class="ui-goal__text">—</span>
      <div class="ui-goal__bar"><div class="ui-goal__fill"></div></div>
    `;
    this.textEl = this.el.querySelector('.ui-goal__text');
    this.fillEl = this.el.querySelector('.ui-goal__fill');
    this.el.addEventListener('click', () => {
      if (this._claimable() && typeof this.onClaim === 'function') this.onClaim();
    });
    return this.el;
  }

  _claimable() {
    const c = this.challenge;
    return !!(c && !c.claimed && c.progress >= c.target);
  }

  setChallenge(challenge) {
    this.challenge = challenge;
    if (!this.textEl || !challenge) return;

    const claimable = this._claimable();
    const pct = challenge.target > 0 ? Math.min(100, (challenge.progress / challenge.target) * 100) : 0;

    // Krótszy tekst niż w starej, grubej pigułce - slim pasek ma jedną linię
    // z ellipsis, więc "Zbierz 20x Śmieci (3/20)" musi się zmieścić bez
    // osobnej etykiety "Wyzwanie dnia" (ikonka schowka ją zastępuje).
    // innerHTML (nie textContent) - CHECK_ICON_SVG w gałęzi "odebrane"
    // wymaga renderowania jako znaczniki, nie surowy tekst. Pozostałe dwie
    // gałęzie to i tak zwykły, bezpieczny (deweloperski) tekst.
    this.textEl.innerHTML = challenge.claimed
      ? `Wyzwanie odebrane ${CHECK_ICON_SVG}`
      : claimable
        ? `Odbierz +${challenge.reward}${CREDIT_ICON_SVG}!`
        : `${challenge.label} (${challenge.progress}/${challenge.target})`;

    if (this.fillEl) {
      this.fillEl.style.width = `${pct}%`;
    }
    this.el.classList.toggle('ui-goal--ready', claimable);
  }
}

// Ikona "czas/postęp do celu" dla paska "co dalej" - był zegar (ręcznie
// rysowany), teraz klepsydra (Kenney Board Game Icons) - ta sama fala
// ujednolicenia co CART/GEAR/CLOSE/CHECK/LOCK wyżej.
const NEXT_UNLOCK_ICON_SVG = '<span class="ui-icon ui-icon--hourglass" aria-hidden="true" style="color:#FFD54F"></span>';

/**
 * Pasek "co dalej" - pokazuje postęp łącznego zarobku do NASTĘPNEGO
 * progresywnego odblokowania (nowej strefy/maszyny). Bezpośrednia
 * odpowiedź na "martwo, nie wiem po co gram" - gracz zawsze widzi
 * konkretny, bliski cel ("jeszcze 140 do Pieca") zamiast grać w próżnię.
 * Reużywa klasy .ui-stack* (jak ChallengeDisplay) - zero nowego CSS.
 * Chowa się całkiem, gdy wszystko odblokowane (nie ma już "co dalej").
 */
class UnlockProgressDisplay extends UIComponent {
  constructor() {
    super();
  }

  render() {
    this.el = document.createElement('div');
    this.el.className = 'ui-goal';
    this.el.innerHTML = `
      <span class="ui-goal__icon" aria-hidden="true">${NEXT_UNLOCK_ICON_SVG}</span>
      <span class="ui-goal__text">—</span>
      <div class="ui-goal__bar"><div class="ui-goal__fill"></div></div>
    `;
    this.textEl = this.el.querySelector('.ui-goal__text');
    this.fillEl = this.el.querySelector('.ui-goal__fill');
    return this.el;
  }

  /** next = wynik economyManager.getNextUnlock() albo null (wszystko odblokowane). */
  setNext(next) {
    if (!this.el) return;

    if (!next) {
      // Wszystko odblokowane - pasek znika, żeby nie zajmować miejsca "pustym" celem.
      this.el.style.display = 'none';
      return;
    }
    this.el.style.display = '';

    const pct = next.threshold > 0 ? Math.min(100, (next.current / next.threshold) * 100) : 0;
    if (this.textEl) {
      // innerHTML (nie textContent) - CREDIT_ICON_SVG wymaga renderowania
      // jako znacznik, nie surowy tekst (ten sam powód co ChallengeDisplay
      // wyżej). next.name to wewnętrzna nazwa strefy/maszyny, nie dane
      // użytkownika, więc bezpieczne do wstawienia bez sanityzacji.
      this.textEl.innerHTML = `${next.name} — jeszcze ${Math.ceil(next.remaining)}${CREDIT_ICON_SVG}`;
    }
    if (this.fillEl) {
      this.fillEl.style.width = `${pct}%`;
    }
  }
}

// --- Panel sklepu (bottom sheet, domyślnie ukryty) --------------------------

class ShopPanel {
  constructor(economyManager, onPurchase) {
    this.economyManager = economyManager;
    this.onPurchase = onPurchase;
    this.el = null;
    this.bodyEl = null;
    this.isOpen = false;

    this._onKeyDown = (e) => {
      if (e.key === 'Escape' && this.isOpen) this.close();
    };
  }

  mount(parent) {
    if (!this.el) this._render();
    if (parent && this.el.parentNode !== parent) parent.appendChild(this.el);
    return this.el;
  }

  _render() {
    this.el = document.createElement('div');
    this.el.className = 'ui-shop';

    const backdrop = document.createElement('div');
    backdrop.className = 'ui-shop-backdrop';
    backdrop.addEventListener('click', () => this.close());

    const sheet = document.createElement('div');
    sheet.className = 'ui-shop-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', 'Sklep');
    sheet.innerHTML = `
      <div class="ui-shop-sheet__handle"></div>
      <header class="ui-shop-sheet__header">
        <span class="ui-shop-sheet__title"><span aria-hidden="true">${CART_ICON_SVG}</span> Sklep</span>
        <button type="button" class="ui-shop-sheet__close" aria-label="Zamknij sklep">${CLOSE_ICON_SVG}</button>
      </header>
      <div class="ui-shop-sheet__body"></div>
    `;
    sheet.querySelector('.ui-shop-sheet__close').addEventListener('click', () => this.close());
    // Kliknięcie w sam arkusz nie powinno zamykać (tylko backdrop) - zatrzymujemy
    // propagację, żeby nie "przebijało" do backdropu pod spodem.
    sheet.addEventListener('click', (e) => e.stopPropagation());

    this.bodyEl = sheet.querySelector('.ui-shop-sheet__body');

    this.el.appendChild(backdrop);
    this.el.appendChild(sheet);

    this.refresh();
  }

  open() {
    if (!this.el) this._render();
    this.isOpen = true;
    this.el.classList.add('ui-shop--open');
    document.addEventListener('keydown', this._onKeyDown);
    this.refresh();
  }

  close() {
    this.isOpen = false;
    if (this.el) this.el.classList.remove('ui-shop--open');
    document.removeEventListener('keydown', this._onKeyDown);
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  refresh() {
    if (!this.bodyEl || !this.economyManager) return;
    const catalog = this.economyManager.getShopCatalog();
    const money = this.economyManager.getMoney();

    // Dwie sekcje: powtarzalne ulepszenia statystyk (maxLevel > 1) vs
    // jednorazowe odblokowania - licencje na surowce ORAZ sprzęt ochronny
    // do stref (maxLevel === 1) - to naprawdę dwie różne kategorie decyzji,
    // więc rozdzielenie ich niesie informację, a nie tylko dekoruje listę.
    // Kryterium to maxLevel, nie prefiks id - toxic_filter/radiation_suit
    // nie zaczynają się od "stage_", ale są tą samą kategorią co licencje.
    const upgrades = catalog.filter((item) => item.maxLevel > 1);
    const licenses = catalog.filter((item) => item.maxLevel === 1);

    // Trzecia sekcja: ulepszenia KONKRETNYCH maszyn (patrz
    // MACHINE_UPGRADE_KINDS w economy.js). Osobno od dwóch powyżej, bo to
    // inna kategoria decyzji - nie "co mam", tylko "którą maszynę rozwijam".
    // getMachineUpgradeCatalog() zwraca tylko ODBLOKOWANE maszyny, więc na
    // starcie to jedna pozycja, a nie ściana ośmiu.
    const machineUpgrades = (typeof this.economyManager.getMachineUpgradeCatalog === 'function')
      ? this.economyManager.getMachineUpgradeCatalog()
      : [];

    this.bodyEl.innerHTML = '';
    if (upgrades.length > 0) this.bodyEl.appendChild(this._buildSection('Ulepszenia', upgrades, money));
    if (licenses.length > 0) this.bodyEl.appendChild(this._buildSection('Licencje i sprzęt', licenses, money));
    if (machineUpgrades.length > 0) {
      this.bodyEl.appendChild(this._buildSection('Maszyny', machineUpgrades, money));
    }
  }

  _buildSection(title, items, money) {
    const section = document.createElement('div');
    section.className = 'ui-shop-section';

    const heading = document.createElement('h3');
    heading.className = 'ui-shop-section__title';
    heading.textContent = title;
    section.appendChild(heading);

    const list = document.createElement('div');
    list.className = 'ui-shop-list';
    items.forEach((item) => list.appendChild(this._buildRow(item, money)));
    section.appendChild(list);

    return section;
  }

  _buildRow(item, money) {
    const row = document.createElement('article');
    row.className = 'ui-shop-item';
    if (item.maxed) row.classList.add('ui-shop-item--maxed');

    const canBuy = !item.maxed && item.cost !== null && money >= item.cost;
    if (canBuy) row.classList.add('ui-shop-item--afford');

    const progressHtml = item.maxLevel > 1
      ? `<div class="ui-shop-item__progress">
           <div class="ui-shop-item__dots">${this._levelDots(item.level, item.maxLevel)}</div>
           <span class="ui-shop-item__level-text">${item.level}/${item.maxLevel}</span>
         </div>`
      : '';

    // Zdolność dana przez moduł statku - mówimy to WPROST zamiast pokazywać
    // suchy "MAX" (gracz nigdy tego nie kupił, więc "MAX" byłby mylący) i
    // zamiast po cichu sprzedawać duplikat, jak działo się wcześniej.
    const descText = item.fromShip
      ? 'Masz to już dzięki modułowi statku'
      : item.description;

    row.innerHTML = `
      <div class="ui-shop-item__icon" aria-hidden="true">${item.icon}</div>
      <div class="ui-shop-item__info">
        <span class="ui-shop-item__name">${item.name}</span>
        <span class="ui-shop-item__desc">${descText}</span>
        ${progressHtml}
      </div>
      <div class="ui-shop-item__action"></div>
    `;

    const actionEl = row.querySelector('.ui-shop-item__action');
    if (item.maxed) {
      const badge = document.createElement('span');
      badge.className = 'ui-shop-item__maxed';
      // innerHTML (nie textContent) - jedyny sposób, żeby ROCKET_ICON_SVG
      // wyrenderował się jako ikona, a nie jako surowy tekst znaczników.
      badge.innerHTML = item.fromShip ? `${ROCKET_ICON_SVG} ZE STATKU` : 'MAX';
      actionEl.appendChild(badge);
    } else {
      // Kłódka PRZED ceną, TYLKO gdy nie stać (denied) - dźwięk odmowy
      // (UIButton `denied`, patrz audio.js 'error') mówi "nie" dopiero PO
      // kliknięciu; kłódka daje ten sam sygnał OD RAZU, bez tapnięcia.
      const costLabel = canBuy ? `${item.cost}${CREDIT_ICON_SVG}` : `${LOCK_ICON_SVG} ${item.cost}${CREDIT_ICON_SVG}`;
      const btn = new UIButton({
        label: costLabel,
        variant: canBuy ? 'accent' : 'ghost',
        denied: !canBuy,
        title: canBuy ? 'Kup ulepszenie' : 'Za mało pieniędzy',
        onClick: () => {
          // Ulepszenia maszyn mają WŁASNĄ metodę zakupu (kupuje się je per
          // maszyna, patrz buyMachineUpgrade w economy.js) - rozpoznajemy je
          // po obecności machineId, nie po parsowaniu item.id.
          const bought = item.machineId
            ? this.economyManager.buyMachineUpgrade(item.machineId, item.kindId)
            : this.economyManager.buyUpgrade(item.id);
          if (bought) {
            this.refresh();
            if (typeof this.onPurchase === 'function') this.onPurchase(item);
          }
        }
      });
      actionEl.appendChild(btn.mount());
    }

    row.dataset.tooltip = `${item.name}: ${item.description}`;
    return row;
  }

  _levelDots(level, maxLevel) {
    let dots = '';
    for (let i = 0; i < maxLevel; i++) {
      dots += `<span class="ui-shop-item__dot ${i < level ? 'ui-shop-item__dot--filled' : ''}"></span>`;
    }
    return dots;
  }

  destroy() {
    document.removeEventListener('keydown', this._onKeyDown);
    if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
  }
}

// --- Panel statku / prestiżu (bottom sheet, domyślnie ukryty) ---------------
// Faza 4. Reużywa DOKŁADNIE te same klasy CSS co ShopPanel (.ui-shop*) - to
// ten sam wizualny język (arkusz wysuwany od dołu), więc zero nowego CSS w
// style.css. Otwierany na dwa sposoby: automatycznie na Events.GAME_WON
// (moment ukończenia 5. modułu) oraz ręcznie przez shipToggleBtn w
// UIManager (widoczny tylko gdy gracz stoi w zasięgu statku).
//
// Treść ma dwie części:
//   1. Karta akcji na górze - "gotowy do odlotu" (z podglądem nagrody i
//      przyciskiem prestiżu) ALBO "w naprawie" (X/5 modułów), zależnie od
//      economyManager.isReadyToPrestige().
//   2. Katalog trwałych ulepszeń (economyManager.getCoreShopCatalog()) -
//      ten sam format co ShopPanel._buildRow, tylko płacony Rdzeniami, nie
//      pieniędzmi - stąd osobna metoda _buildRow (inny licznik/inna metoda
//      zakupu), a nie zwykłe wywołanie ShopPanel.prototype._buildRow.
// Ikony SVG zamiast emoji - ten sam duch co reszta nowych elementów UI w tej
// turze (żaden nowy motyw emoji, skoro reszta gry świadomie z nich rezygnuje).
const OFFLINE_MOON_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" fill="#FFD54F"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5Z"/></svg>';
const OFFLINE_PLAY_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';

/**
 * Modal powitalny "byłeś offline X" (Faza 5). Reużywa te same klasy CSS co
 * ShopPanel/PrestigePanel (.ui-shop*) - zero nowego CSS. W przeciwieństwie do
 * nich NIE ma przycisku w fabRow do ponownego otwarcia - to jednorazowy
 * pokaz zaraz po starcie (main.js woła open() wprost, jeśli
 * computeOfflineReward() zwróciło coś sensownego), nie coś do czego gracz
 * wraca. Backdrop celowo NIE zamyka po kliknięciu w tło - to nagroda do
 * świadomego odebrania, nie coś, co ma zniknąć od przypadkowego stuknięcia.
 */
class OfflineRewardModal {
  constructor(economyManager, onClaimed) {
    this.economyManager = economyManager;
    this.onClaimed = onClaimed;
    this.el = null;
    this.bodyEl = null;
    this.data = null; // { elapsedSeconds, reward }
    this._claimed = false;
    this.isOpen = false;

    this._onKeyDown = (e) => {
      if (e.key === 'Escape' && this.isOpen) this.close();
    };
  }

  mount(parent) {
    if (!this.el) this._render();
    if (parent && this.el.parentNode !== parent) parent.appendChild(this.el);
    return this.el;
  }

  _render() {
    this.el = document.createElement('div');
    this.el.className = 'ui-shop';

    const backdrop = document.createElement('div');
    backdrop.className = 'ui-shop-backdrop';

    const sheet = document.createElement('div');
    sheet.className = 'ui-shop-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', 'Witaj z powrotem');
    sheet.innerHTML = `
      <div class="ui-shop-sheet__handle"></div>
      <header class="ui-shop-sheet__header">
        <span class="ui-shop-sheet__title"><span aria-hidden="true">${OFFLINE_MOON_ICON_SVG}</span> Witaj z powrotem</span>
        <button type="button" class="ui-shop-sheet__close" aria-label="Zamknij">${CLOSE_ICON_SVG}</button>
      </header>
      <div class="ui-shop-sheet__body"></div>
    `;
    sheet.querySelector('.ui-shop-sheet__close').addEventListener('click', () => this.close());
    sheet.addEventListener('click', (e) => e.stopPropagation());

    this.bodyEl = sheet.querySelector('.ui-shop-sheet__body');
    this.el.appendChild(backdrop);
    this.el.appendChild(sheet);
  }

  _formatDuration(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return h > 0 ? `${h}h ${m}min` : `${m}min`;
  }

  /** Otwiera modal z konkretnym wynikiem computeOfflineReward() (economy.js). */
  open(data) {
    if (!this.el) this._render();
    this.data = data;
    this._claimed = false;
    this._renderBody();
    this.isOpen = true;
    this.el.classList.add('ui-shop--open');
    document.addEventListener('keydown', this._onKeyDown);
  }

  close() {
    this.isOpen = false;
    if (this.el) this.el.classList.remove('ui-shop--open');
    document.removeEventListener('keydown', this._onKeyDown);
  }

  _renderBody() {
    if (!this.bodyEl || !this.data) return;
    this.bodyEl.innerHTML = '';

    const section = document.createElement('div');
    section.className = 'ui-shop-section';

    const card = document.createElement('div');
    card.className = 'ui-shop-item';
    card.style.gridTemplateColumns = '1fr';

    if (this._claimed) {
      card.innerHTML = `
        <div class="ui-shop-item__info">
          <span class="ui-shop-item__name">Odebrano ${CHECK_ICON_SVG}</span>
          <span class="ui-shop-item__desc">Miłej gry!</span>
        </div>
      `;
    } else {
      card.innerHTML = `
        <div class="ui-shop-item__info">
          <span class="ui-shop-item__name">Byłeś offline ${this._formatDuration(this.data.elapsedSeconds)}</span>
          <span class="ui-shop-item__desc">Twoja ekonomia pracowała w tle. Zarobek: <strong style="color:#FFD700">+${this.data.reward}${CREDIT_ICON_SVG}</strong></span>
        </div>
      `;
      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex; gap:8px; margin-top:10px; flex-wrap:wrap;';

      const claimBtn = new UIButton({
        label: `Odbierz +${this.data.reward}${CREDIT_ICON_SVG}`,
        variant: 'accent',
        onClick: () => this._claim(false)
      });
      this._adBtn = new UIButton({
        icon: OFFLINE_PLAY_ICON_SVG,
        label: `x2 (+${this.data.reward * 2}${CREDIT_ICON_SVG})`,
        variant: 'ghost',
        onClick: () => this._watchAdAndClaim()
      });
      actions.appendChild(claimBtn.mount());
      actions.appendChild(this._adBtn.mount());
      card.querySelector('.ui-shop-item__info').appendChild(actions);
    }

    section.appendChild(card);
    this.bodyEl.appendChild(section);
  }

  _claim(doubled) {
    if (this._claimed || !this.data) return;
    this._claimed = true;
    const paidOut = this.economyManager.claimOfflineReward(this.data.reward, doubled);
    this._renderBody();
    if (typeof this.onClaimed === 'function') this.onClaimed(paidOut);
    setTimeout(() => this.close(), 1400);
  }

  /**
   * window.adManager (ads.js) sam wie, czy jesteśmy w prawdziwej apce
   * Capacitor (prawdziwe rewarded video) czy w zwykłej przeglądarce
   * (fallback udający sukces) - ui.js nie musi tego rozróżniać, tylko
   * czeka na wynik. gotReward=false (gracz zamknął reklamę przed końcem) =
   * NIE przyznajemy podwojenia, guzik po prostu wraca do normalnego stanu.
   *
   * Mimo preloadu (main.js woła adManager.preload() jak najwcześniej -
   * patrz komentarz tam) reklama CZASEM i tak każe chwilę poczekać (słabszy
   * internet, preload nie zdążył) - przycisk pokazuje to wprost zamiast
   * wyglądać na zawieszony, i blokuje się, żeby gracz nie klikał kilka razy.
   */
  _watchAdAndClaim() {
    if (this._claimed) return;
    if (!window.adManager || typeof window.adManager.showRewarded !== 'function') {
      // ads.js jeszcze niewgrany - ostatnia linia obrony, żeby guzik nie
      // był po prostu martwy podczas stopniowego wdrażania plików.
      console.warn('[OfflineRewardModal] Brak window.adManager - wgraj ads.js.');
      this._claim(true);
      return;
    }
    const btn = this._adBtn;
    if (btn) {
      btn.setDisabled(true);
      btn.setLabel('Ładowanie…');
    }
    window.adManager.showRewarded((gotReward) => {
      if (gotReward) {
        this._claim(true);
        return;
      }
      // Reklama nie dala nagrody (zamknieta przedwczesnie / blad ladowania)
      // - przywracamy przycisk do normalnego stanu, zeby gracz mogl sprobowac ponownie.
      if (btn) {
        btn.setDisabled(false);
        btn.setLabel(`x2 (+${this.data.reward * 2}${CREDIT_ICON_SVG})`);
      }
    });
  }

  destroy() {
    document.removeEventListener('keydown', this._onKeyDown);
    if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
  }
}

class PrestigePanel {
  constructor(economyManager, onAction) {
    this.economyManager = economyManager;
    this.onAction = onAction; // wołane po KAŻDEJ udanej akcji (prestiż LUB zakup)
    this.el = null;
    this.bodyEl = null;
    this.isOpen = false;

    this._onKeyDown = (e) => {
      if (e.key === 'Escape' && this.isOpen) this.close();
    };
  }

  mount(parent) {
    if (!this.el) this._render();
    if (parent && this.el.parentNode !== parent) parent.appendChild(this.el);
    return this.el;
  }

  _render() {
    this.el = document.createElement('div');
    this.el.className = 'ui-shop';

    const backdrop = document.createElement('div');
    backdrop.className = 'ui-shop-backdrop';
    backdrop.addEventListener('click', () => this.close());

    const sheet = document.createElement('div');
    sheet.className = 'ui-shop-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', 'Statek');
    sheet.innerHTML = `
      <div class="ui-shop-sheet__handle"></div>
      <header class="ui-shop-sheet__header">
        <span class="ui-shop-sheet__title"><span aria-hidden="true">${ROCKET_ICON_SVG}</span> Statek</span>
        <button type="button" class="ui-shop-sheet__close" aria-label="Zamknij">${CLOSE_ICON_SVG}</button>
      </header>
      <div class="ui-shop-sheet__body"></div>
    `;
    sheet.querySelector('.ui-shop-sheet__close').addEventListener('click', () => this.close());
    sheet.addEventListener('click', (e) => e.stopPropagation());

    this.bodyEl = sheet.querySelector('.ui-shop-sheet__body');

    this.el.appendChild(backdrop);
    this.el.appendChild(sheet);

    this.refresh();
  }

  open() {
    if (!this.el) this._render();
    this.isOpen = true;
    this.el.classList.add('ui-shop--open');
    document.addEventListener('keydown', this._onKeyDown);
    this.refresh();
  }

  close() {
    this.isOpen = false;
    if (this.el) this.el.classList.remove('ui-shop--open');
    document.removeEventListener('keydown', this._onKeyDown);
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  refresh() {
    if (!this.bodyEl || !this.economyManager) return;

    this.bodyEl.innerHTML = '';
    const modifierCard = this._buildModifierCard();
    if (modifierCard) this.bodyEl.appendChild(modifierCard);
    this.bodyEl.appendChild(this._buildPrestigeCard());

    const catalog = this.economyManager.getCoreShopCatalog();
    if (catalog.length > 0) {
      const title = `${CORE_ICON_SVG} Trwałe ulepszenia — masz ${this.economyManager.cores}`;
      this.bodyEl.appendChild(this._buildSection(title, catalog));
    }
  }

  /**
   * Karta akcji na górze panelu. Reużywa stylu .ui-shop-item (padding/tło/
   * obramowanie), ale nadpisuje grid na jedną kolumnę inline'em - to NIE
   * jest pozycja katalogu (3-kolumnowa: ikona/info/akcja), tylko pojedyncza
   * większa karta z opisem i przyciskiem pod spodem.
   */
  _buildPrestigeCard() {
    const wrap = document.createElement('div');
    wrap.className = 'ui-shop-section';

    const eco = this.economyManager;
    const ready = eco.isReadyToPrestige();
    const completed = eco.shipCompletedModules.length;
    const total = (window.SHIP_MODULE_DEFINITIONS && window.SHIP_MODULE_DEFINITIONS.length) || 5;

    const card = document.createElement('div');
    card.className = 'ui-shop-item';
    card.style.gridTemplateColumns = '1fr';

    if (ready) {
      const preview = eco.previewPrestigeCores();
      card.innerHTML = `
        <div class="ui-shop-item__info">
          <span class="ui-shop-item__name">${PLANET_ICON_SVG} Gotowy do odlotu!</span>
          <span class="ui-shop-item__desc">Odlot resetuje bieżący przebieg (pieniądze, ulepszenia, plecak, postęp statku) w zamian za ${CORE_ICON_SVG} ${preview} Rdzeni na zawsze.</span>
        </div>
      `;
      const actionWrap = document.createElement('div');
      actionWrap.style.marginTop = '10px';
      const btn = new UIButton({
        icon: ROCKET_ICON_SVG,
        label: `Leć dalej (+${preview} Rdzeni)`,
        variant: 'accent',
        onClick: () => {
          // Nieodwracalne i niszczy bieżący postęp - potwierdzenie zamiast
          // pozwalać jednemu przypadkowemu tapnięciu skasować cały przebieg
          // (to samo ryzyko, o które Tom pytał przy pozycji statku).
          // window.confirm() to NATYWNY dialog przeglądarki - renderuje
          // WYŁĄCZNIE zwykły tekst (nie HTML/SVG), stąd zwykłe słowo "Rdzeni"
          // bez ikony, w przeciwieństwie do reszty tego panelu.
          const ok = window.confirm(
            `Na pewno lecisz dalej? Stracisz bieżący przebieg (pieniądze, ulepszenia, plecak) w zamian za ${eco.previewPrestigeCores()} Rdzeni.`
          );
          if (!ok) return;
          const result = eco.prestige();
          if (result && typeof this.onAction === 'function') this.onAction('prestige', result);
        }
      });
      actionWrap.appendChild(btn.mount());
      card.querySelector('.ui-shop-item__info').appendChild(actionWrap);
    } else {
      card.innerHTML = `
        <div class="ui-shop-item__info">
          <span class="ui-shop-item__name">${WRENCH_ICON_SVG} Statek w naprawie</span>
          <span class="ui-shop-item__desc">Ukończ wszystkie moduły, żeby odlecieć na nową planetę. Postęp: ${completed}/${total}.</span>
        </div>
      `;
    }

    wrap.appendChild(card);
    return wrap;
  }

  /**
   * Karta aktywnego modyfikatora BIEŻĄCEJ planety (patrz PLANET_MODIFIERS w
   * economy.js) - null na pierwszej planecie (zanim gracz choć raz poleci
   * dalej), więc refresh() wtedy pomija tę kartę zamiast pokazywać pustkę.
   * Czysto informacyjna (bez przycisku) - modyfikator losuje się sam w
   * prestige(), gracz go tylko widzi.
   */
  _buildModifierCard() {
    const mod = this.economyManager.getActiveModifier
      ? this.economyManager.getActiveModifier()
      : null;
    if (!mod) return null;

    const wrap = document.createElement('div');
    wrap.className = 'ui-shop-section';

    const card = document.createElement('div');
    card.className = 'ui-shop-item';
    card.style.gridTemplateColumns = '1fr';
    card.innerHTML = `
      <div class="ui-shop-item__info">
        <span class="ui-shop-item__name">${mod.icon} Modyfikator planety: ${mod.name}</span>
        <span class="ui-shop-item__desc">${mod.desc}</span>
      </div>
    `;
    wrap.appendChild(card);
    return wrap;
  }

  _buildSection(title, items) {
    const section = document.createElement('div');
    section.className = 'ui-shop-section';

    const heading = document.createElement('h3');
    heading.className = 'ui-shop-section__title';
    // innerHTML (nie textContent, w przeciwieństwie do ShopPanel/SettingsPanel
    // ._buildSection) - jedyny wołający (refresh() wyżej) osadza tu
    // CORE_ICON_SVG w środku stringu, więc surowy tekst pokazałby znaczniki
    // zamiast ikony. Bezpieczne - jedyny caller to stały, deweloperski string.
    heading.innerHTML = title;
    section.appendChild(heading);

    const list = document.createElement('div');
    list.className = 'ui-shop-list';
    items.forEach((item) => list.appendChild(this._buildRow(item)));
    section.appendChild(list);

    return section;
  }

  /** Jak ShopPanel._buildRow, ale płatne Rdzeniami (economyManager.cores)
   * przez buyCoreUpgrade(), nie pieniędzmi przez buyUpgrade(). */
  _buildRow(item) {
    const row = document.createElement('article');
    row.className = 'ui-shop-item';
    if (item.maxed) row.classList.add('ui-shop-item--maxed');

    const cores = this.economyManager.cores;
    const canBuy = !item.maxed && item.cost !== null && cores >= item.cost;
    if (canBuy) row.classList.add('ui-shop-item--afford');

    const progressHtml = item.maxLevel > 1
      ? `<div class="ui-shop-item__progress">
           <div class="ui-shop-item__dots">${this._levelDots(item.level, item.maxLevel)}</div>
           <span class="ui-shop-item__level-text">${item.level}/${item.maxLevel}</span>
         </div>`
      : '';

    row.innerHTML = `
      <div class="ui-shop-item__icon" aria-hidden="true">${item.icon}</div>
      <div class="ui-shop-item__info">
        <span class="ui-shop-item__name">${item.name}</span>
        <span class="ui-shop-item__desc">${item.description}</span>
        ${progressHtml}
      </div>
      <div class="ui-shop-item__action"></div>
    `;

    const actionEl = row.querySelector('.ui-shop-item__action');
    if (item.maxed) {
      const badge = document.createElement('span');
      badge.className = 'ui-shop-item__maxed';
      badge.textContent = 'MAX';
      actionEl.appendChild(badge);
    } else {
      // Kłódka gdy nie stać - patrz identyczny komentarz w ShopPanel._buildRow.
      const costLabel = canBuy ? `${CORE_ICON_SVG}${item.cost}` : `${LOCK_ICON_SVG} ${CORE_ICON_SVG}${item.cost}`;
      const btn = new UIButton({
        label: costLabel,
        variant: canBuy ? 'accent' : 'ghost',
        denied: !canBuy,
        title: canBuy ? 'Kup trwałe ulepszenie' : 'Za mało Rdzeni',
        onClick: () => {
          if (this.economyManager.buyCoreUpgrade(item.id)) {
            this.refresh();
            if (typeof this.onAction === 'function') this.onAction('coreUpgrade', item);
          }
        }
      });
      actionEl.appendChild(btn.mount());
    }

    row.dataset.tooltip = `${item.name}: ${item.description}`;
    return row;
  }

  _levelDots(level, maxLevel) {
    let dots = '';
    for (let i = 0; i < maxLevel; i++) {
      dots += `<span class="ui-shop-item__dot ${i < level ? 'ui-shop-item__dot--filled' : ''}"></span>`;
    }
    return dots;
  }

  destroy() {
    document.removeEventListener('keydown', this._onKeyDown);
    if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
  }
}

// --- Panel Menu/Ustawień (bottom sheet, domyślnie ukryty) -------------------
// "Pełnoprawne menu z dodatkowymi opcjami jak w grze mobilnej" - dźwięk,
// ponowne uruchomienie samouczka, reset postępu, wersja gry. Reużywa
// DOKŁADNIE te same klasy CSS co ShopPanel/PrestigePanel (.ui-shop*) - ten
// sam wizualny język (arkusz wysuwany od dołu), zero nowego CSS w style.css.
// Ręcznie zsynchronizowane z "version" w package.json - projekt nie ma kroku
// budowania, który wstrzykiwałby to do bundla, więc to zwykła stała jak
// wszystkie inne duplikowane wartości w projekcie.
const SETTINGS_APP_VERSION = '1.0.0';

class SettingsPanel {
  /** onChange - wołane po KAŻDEJ akcji w panelu (na razie tylko dźwięk) -
   * zostaje jako ogólny hak na przyszłość, choć obecnie żaden wywołujący go
   * nie potrzebuje (dawniej synchronizował ikonę osobnego przycisku Wycisz
   * w fabRow - ten przycisk usunięty, patrz komentarz w UIManager._render:
   * dźwięk włącza/wyłącza się TYLKO stąd, z Menu, nie z ekranu gry). */
  constructor(onChange, onOpenAchievements, onOpenSkins, onOpenStats) {
    this.onChange = onChange;
    this.onOpenAchievements = onOpenAchievements;
    this.onOpenSkins = onOpenSkins;
    this.onOpenStats = onOpenStats;
    this.el = null;
    this.bodyEl = null;
    this.isOpen = false;

    this._onKeyDown = (e) => {
      if (e.key === 'Escape' && this.isOpen) this.close();
    };
  }

  mount(parent) {
    if (!this.el) this._render();
    if (parent && this.el.parentNode !== parent) parent.appendChild(this.el);
    return this.el;
  }

  _render() {
    this.el = document.createElement('div');
    this.el.className = 'ui-shop';

    const backdrop = document.createElement('div');
    backdrop.className = 'ui-shop-backdrop';
    backdrop.addEventListener('click', () => this.close());

    const sheet = document.createElement('div');
    sheet.className = 'ui-shop-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', 'Menu');
    sheet.innerHTML = `
      <div class="ui-shop-sheet__handle"></div>
      <header class="ui-shop-sheet__header">
        <span class="ui-shop-sheet__title"><span aria-hidden="true">${GEAR_ICON_SVG}</span> Menu</span>
        <button type="button" class="ui-shop-sheet__close" aria-label="Zamknij menu">${CLOSE_ICON_SVG}</button>
      </header>
      <div class="ui-shop-sheet__body"></div>
    `;
    sheet.querySelector('.ui-shop-sheet__close').addEventListener('click', () => this.close());
    sheet.addEventListener('click', (e) => e.stopPropagation());

    this.bodyEl = sheet.querySelector('.ui-shop-sheet__body');

    this.el.appendChild(backdrop);
    this.el.appendChild(sheet);

    this.refresh();
  }

  open() {
    if (!this.el) this._render();
    this.isOpen = true;
    this.el.classList.add('ui-shop--open');
    document.addEventListener('keydown', this._onKeyDown);
    this.refresh();
  }

  close() {
    this.isOpen = false;
    if (this.el) this.el.classList.remove('ui-shop--open');
    document.removeEventListener('keydown', this._onKeyDown);
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  refresh() {
    if (!this.bodyEl) return;
    this.bodyEl.innerHTML = '';
    this.bodyEl.appendChild(this._buildSection('Postęp', [this._buildAchievementsRow(), this._buildSkinsRow(), this._buildStatsRow()]));
    this.bodyEl.appendChild(this._buildSection('Preferencje', [this._buildSoundRow(), this._buildTutorialRow(), this._buildFpsRow()]));
    this.bodyEl.appendChild(this._buildSection('Dane', [this._buildResetRow()]));
    this.bodyEl.appendChild(this._buildSection('O grze', [this._buildAboutRow()]));
  }

  /** Wiersz "Osiągnięcia" - pokazuje ile zdobyto (X/Y) i otwiera osobny
   * panel (AchievementsPanel). Zamyka Menu przy otwarciu - tylko jeden
   * bottom-sheet naraz (patrz onOpenAchievements w UIManager). */
  _buildAchievementsRow() {
    const eco = window.economyManager;
    const catalog = (eco && typeof eco.getAchievementsCatalog === 'function') ? eco.getAchievementsCatalog() : [];
    const unlocked = catalog.filter((a) => a.unlocked).length;
    const bonusPct = (eco && typeof eco.getAchievementIncomeBonusPercent === 'function') ? eco.getAchievementIncomeBonusPercent() : 0;
    const btn = new UIButton({
      label: 'Pokaż',
      variant: 'ghost',
      onClick: () => {
        this.close();
        if (typeof this.onOpenAchievements === 'function') this.onOpenAchievements();
      }
    });
    return this._buildRow(TROPHY_ICON_SVG, 'Osiągnięcia', `Zdobyte: ${unlocked}/${catalog.length} — bonus zarobku: +${bonusPct}%`, btn.mount());
  }

  /** Wiersz "Skiny" - ten sam wzorzec co Osiągnięcia wyżej, otwiera osobny
   * panel (SkinsPanel, patrz onOpenSkins w UIManager). */
  _buildSkinsRow() {
    const eco = window.economyManager;
    const catalog = (eco && typeof eco.getSkinCatalog === 'function') ? eco.getSkinCatalog() : [];
    const unlocked = catalog.filter((s) => s.unlocked).length;
    const btn = new UIButton({
      label: 'Pokaż',
      variant: 'ghost',
      onClick: () => {
        this.close();
        if (typeof this.onOpenSkins === 'function') this.onOpenSkins();
      }
    });
    return this._buildRow(SHIRT_ICON_SVG, 'Skiny', `Odblokowane: ${unlocked}/${catalog.length}`, btn.mount());
  }

  /** Wiersz "Statystyki" - ten sam wzorzec co Osiągnięcia/Skiny wyżej,
   * otwiera osobny panel (StatsPanel, patrz onOpenStats w UIManager). */
  _buildStatsRow() {
    const btn = new UIButton({
      label: 'Pokaż',
      variant: 'ghost',
      onClick: () => {
        this.close();
        if (typeof this.onOpenStats === 'function') this.onOpenStats();
      }
    });
    return this._buildRow(CHART_ICON_SVG, 'Statystyki', 'Podsumowanie postępów w grze', btn.mount());
  }

  /** Ten sam trzykolumnowy układ (ikona/opis/akcja) co ShopPanel._buildRow,
   * tylko bez ceny/poziomów - tu akcja to zawsze pojedynczy przycisk. */
  _buildRow(icon, name, desc, actionEl) {
    const row = document.createElement('article');
    row.className = 'ui-shop-item';
    row.innerHTML = `
      <div class="ui-shop-item__icon" aria-hidden="true">${icon}</div>
      <div class="ui-shop-item__info">
        <span class="ui-shop-item__name">${name}</span>
        <span class="ui-shop-item__desc">${desc}</span>
      </div>
      <div class="ui-shop-item__action"></div>
    `;
    if (actionEl) row.querySelector('.ui-shop-item__action').appendChild(actionEl);
    return row;
  }

  _buildSection(title, rows) {
    const section = document.createElement('div');
    section.className = 'ui-shop-section';

    const heading = document.createElement('h3');
    heading.className = 'ui-shop-section__title';
    heading.textContent = title;
    section.appendChild(heading);

    const list = document.createElement('div');
    list.className = 'ui-shop-list';
    rows.forEach((row) => list.appendChild(row));
    section.appendChild(list);

    return section;
  }

  _buildSoundRow() {
    const muted = !!(window.audioManager && window.audioManager.muted);
    const btn = new UIButton({
      label: muted ? 'Włącz' : 'Wyłącz',
      variant: 'ghost',
      sound: 'ui_switch',
      onClick: () => {
        if (!window.audioManager) return;
        window.audioManager.toggleMute();
        this.refresh();
        if (typeof this.onChange === 'function') this.onChange();
      }
    });
    return this._buildRow(SPEAKER_ICON_SVG, 'Dźwięk', 'Włącz lub wycisz efekty dźwiękowe gry', btn.mount());
  }

  /** Nakładka FPS/jakości (DEBUG.fps() w main.js) - dotąd dostępna tylko z
   * konsoli JS, więc bezużyteczna na telefonie bez podłączenia do komputera.
   * Ten przycisk daje ten sam efekt jednym dotknięciem: liczba FPS, czas
   * klatki i aktualny krok adaptacyjnej jakości wprost na ekranie - dokładnie
   * to, czego trzeba, żeby zdiagnozować zacinanie na urządzeniu gracza. */
  _buildFpsRow() {
    const btn = new UIButton({
      label: 'Pokaż',
      variant: 'ghost',
      onClick: () => {
        if (window.DEBUG && typeof window.DEBUG.fps === 'function') window.DEBUG.fps();
        this.close();
      }
    });
    return this._buildRow(CHART_ICON_SVG, 'Licznik FPS', 'Nakładka z liczbą klatek/s i jakością renderowania', btn.mount());
  }

  /** Uruchamia samouczek od pierwszego kroku - jeśli poprzednia instancja
   * jeszcze żyje (mało prawdopodobne, skoro dismissed/ukończony samouczek
   * sam się usuwa z DOM, ale na wszelki wypadek), najpierw ją sprzątamy,
   * żeby nie zostały dwie subskrypcje Bus naraz. */
  _buildTutorialRow() {
    const btn = new UIButton({
      label: 'Pokaż',
      variant: 'ghost',
      onClick: () => {
        const eco = window.economyManager;
        if (!eco) return;
        eco.tutorialStep = 0;
        eco.tutorialDismissed = false;
        if (window.tutorialManager && typeof window.tutorialManager.destroy === 'function') {
          window.tutorialManager.destroy();
        }
        window.tutorialManager = new TutorialManager(eco);
        if (window.saveManager) window.saveManager.save();
        this.close();
      }
    });
    return this._buildRow(BOOK_ICON_SVG, 'Samouczek', 'Pokaż od nowa krótkie wprowadzenie do gry', btn.mount());
  }

  /** Ten sam wzorzec potwierdzenia (window.confirm) co nieodwracalny "Leć
   * dalej" w PrestigePanel - reset postępu jest tak samo nieodwracalny.
   * Sama operacja to dokładnie DEBUG.resetSave() z main.js, tylko dostępna
   * bez konsoli. */
  _buildResetRow() {
    const btn = new UIButton({
      label: 'Resetuj',
      variant: 'ghost',
      onClick: () => {
        const ok = window.confirm(
          'Na pewno zresetować CAŁY postęp? Ta operacja jest nieodwracalna - stracisz pieniądze, ulepszenia, statek i Rdzenie.'
        );
        if (!ok) return;
        try {
          localStorage.removeItem(SAVE_STORAGE_KEY);
        } catch (e) {
          // localStorage niedostępny - i tak nie ma czego kasować.
        }
        location.reload();
      }
    });
    return this._buildRow(RECYCLE_RESET_ICON_SVG, 'Reset postępu', 'Kasuje cały zapis i zaczyna grę od nowa - nieodwracalne', btn.mount());
  }

  _buildAboutRow() {
    return this._buildRow(INFO_ICON_SVG, 'Eco Mart', `Wersja ${SETTINGS_APP_VERSION}`, null);
  }

  destroy() {
    document.removeEventListener('keydown', this._onKeyDown);
    if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
  }
}

// --- Panel Osiągnięć (bottom sheet, domyślnie ukryty) -----------------------
// Otwierany z Menu (SettingsPanel). Reużywa te same klasy CSS co reszta
// bottom-sheetów (.ui-shop*) - zero nowego CSS. Lista osiągnięć z
// EconomyManager.getAchievementsCatalog(): zdobyte na górze (pełny kolor +
// ✓), reszta przygaszona z paskiem postępu (ile/próg). Osiągnięcia to
// czysty odczyt stanu - panel nie ma żadnej akcji zakupu/kliknięcia w
// pozycje, tylko przegląd.
class AchievementsPanel {
  constructor(economyManager) {
    this.economyManager = economyManager;
    this.el = null;
    this.bodyEl = null;
    this.isOpen = false;

    this._onKeyDown = (e) => {
      if (e.key === 'Escape' && this.isOpen) this.close();
    };
  }

  mount(parent) {
    if (!this.el) this._render();
    if (parent && this.el.parentNode !== parent) parent.appendChild(this.el);
    return this.el;
  }

  _render() {
    this.el = document.createElement('div');
    this.el.className = 'ui-shop';

    const backdrop = document.createElement('div');
    backdrop.className = 'ui-shop-backdrop';
    backdrop.addEventListener('click', () => this.close());

    const sheet = document.createElement('div');
    sheet.className = 'ui-shop-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', 'Osiągnięcia');
    sheet.innerHTML = `
      <div class="ui-shop-sheet__handle"></div>
      <header class="ui-shop-sheet__header">
        <span class="ui-shop-sheet__title"><span aria-hidden="true">${TROPHY_ICON_SVG}</span> Osiągnięcia</span>
        <button type="button" class="ui-shop-sheet__close" aria-label="Zamknij osiągnięcia">${CLOSE_ICON_SVG}</button>
      </header>
      <div class="ui-shop-sheet__body"></div>
    `;
    sheet.querySelector('.ui-shop-sheet__close').addEventListener('click', () => this.close());
    sheet.addEventListener('click', (e) => e.stopPropagation());

    this.bodyEl = sheet.querySelector('.ui-shop-sheet__body');

    this.el.appendChild(backdrop);
    this.el.appendChild(sheet);

    this.refresh();
  }

  open() {
    if (!this.el) this._render();
    this.isOpen = true;
    this.el.classList.add('ui-shop--open');
    document.addEventListener('keydown', this._onKeyDown);
    this.refresh();
  }

  close() {
    this.isOpen = false;
    if (this.el) this.el.classList.remove('ui-shop--open');
    document.removeEventListener('keydown', this._onKeyDown);
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  refresh() {
    if (!this.bodyEl || !this.economyManager) return;
    const catalog = this.economyManager.getAchievementsCatalog();
    const unlocked = catalog.filter((a) => a.unlocked).length;
    const bonusPct = typeof this.economyManager.getAchievementIncomeBonusPercent === 'function'
      ? this.economyManager.getAchievementIncomeBonusPercent()
      : 0;

    this.bodyEl.innerHTML = '';

    const section = document.createElement('div');
    section.className = 'ui-shop-section';
    const heading = document.createElement('h3');
    heading.className = 'ui-shop-section__title';
    heading.textContent = `Zdobyte: ${unlocked} / ${catalog.length} — bonus zarobku: +${bonusPct}%`;
    section.appendChild(heading);

    const list = document.createElement('div');
    list.className = 'ui-shop-list';
    catalog.forEach((a) => list.appendChild(this._buildRow(a)));
    section.appendChild(list);

    this.bodyEl.appendChild(section);
  }

  /** Wiersz osiągnięcia - reużywa .ui-shop-item (ikona/info/akcja). Zdobyte:
   * pełny kolor + badge ✓ w kolumnie akcji. Niezdobyte: przygaszone (klasa
   * --maxed daje opacity) + pasek postępu (ten sam .ui-shop-item__progress
   * co poziomy w sklepie, tylko liczbowo ile/próg). */
  _buildRow(a) {
    const row = document.createElement('article');
    row.className = 'ui-shop-item';
    if (!a.unlocked) row.classList.add('ui-shop-item--maxed');

    const pct = a.target > 0 ? Math.min(100, (a.progress / a.target) * 100) : 0;
    const progressHtml = a.unlocked
      ? ''
      : `<div class="ui-shop-item__progress">
           <div class="ui-shop-item__bar"><div class="ui-shop-item__bar-fill" style="width:${pct}%"></div></div>
           <span class="ui-shop-item__level-text">${a.progress}/${a.target}</span>
         </div>`;

    row.innerHTML = `
      <div class="ui-shop-item__icon" aria-hidden="true">${a.icon}</div>
      <div class="ui-shop-item__info">
        <span class="ui-shop-item__name">${a.name}</span>
        <span class="ui-shop-item__desc">${a.desc}</span>
        <span class="ui-shop-item__reward">${PAY_ICON_SVG} +1% do zarobku (na stałe)</span>
        ${progressHtml}
      </div>
      <div class="ui-shop-item__action">${a.unlocked ? `<span class="ui-shop-item__done" aria-label="Zdobyte">${CHECK_ICON_SVG}</span>` : ''}</div>
    `;
    return row;
  }

  destroy() {
    document.removeEventListener('keydown', this._onKeyDown);
    if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
  }
}

// --- Statystyki ----------------------------------------------------------------
// Ta sama struktura co AchievementsPanel wyżej (bottom sheet, .ui-shop-item
// wiersze) - czysty przegląd liczników z EconomyManager.getStatsCatalog(),
// bez paska postępu/odblokowań (to już robi panel Osiągnięć) - tylko
// ikona/etykieta/aktualna wartość.
class StatsPanel {
  constructor(economyManager) {
    this.economyManager = economyManager;
    this.el = null;
    this.bodyEl = null;
    this.isOpen = false;

    this._onKeyDown = (e) => {
      if (e.key === 'Escape' && this.isOpen) this.close();
    };
  }

  mount(parent) {
    if (!this.el) this._render();
    if (parent && this.el.parentNode !== parent) parent.appendChild(this.el);
    return this.el;
  }

  _render() {
    this.el = document.createElement('div');
    this.el.className = 'ui-shop';

    const backdrop = document.createElement('div');
    backdrop.className = 'ui-shop-backdrop';
    backdrop.addEventListener('click', () => this.close());

    const sheet = document.createElement('div');
    sheet.className = 'ui-shop-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', 'Statystyki');
    sheet.innerHTML = `
      <div class="ui-shop-sheet__handle"></div>
      <header class="ui-shop-sheet__header">
        <span class="ui-shop-sheet__title"><span aria-hidden="true">${CHART_ICON_SVG}</span> Statystyki</span>
        <button type="button" class="ui-shop-sheet__close" aria-label="Zamknij statystyki">${CLOSE_ICON_SVG}</button>
      </header>
      <div class="ui-shop-sheet__body"></div>
    `;
    sheet.querySelector('.ui-shop-sheet__close').addEventListener('click', () => this.close());
    sheet.addEventListener('click', (e) => e.stopPropagation());

    this.bodyEl = sheet.querySelector('.ui-shop-sheet__body');

    this.el.appendChild(backdrop);
    this.el.appendChild(sheet);

    this.refresh();
  }

  open() {
    if (!this.el) this._render();
    this.isOpen = true;
    this.el.classList.add('ui-shop--open');
    document.addEventListener('keydown', this._onKeyDown);
    this.refresh();
  }

  close() {
    this.isOpen = false;
    if (this.el) this.el.classList.remove('ui-shop--open');
    document.removeEventListener('keydown', this._onKeyDown);
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  refresh() {
    if (!this.bodyEl || !this.economyManager || typeof this.economyManager.getStatsCatalog !== 'function') return;
    const catalog = this.economyManager.getStatsCatalog();

    this.bodyEl.innerHTML = '';

    const section = document.createElement('div');
    section.className = 'ui-shop-section';

    const list = document.createElement('div');
    list.className = 'ui-shop-list';
    catalog.forEach((s) => list.appendChild(this._buildRow(s)));
    section.appendChild(list);

    this.bodyEl.appendChild(section);
  }

  /** Wiersz statystyki - reużywa .ui-shop-item (ikona/info/akcja), akcja
   * to zawsze sama wartość licznika zamiast przycisku - panel jest
   * czysto informacyjny. */
  _buildRow(s) {
    const row = document.createElement('article');
    row.className = 'ui-shop-item';
    row.innerHTML = `
      <div class="ui-shop-item__icon" aria-hidden="true">${s.icon}</div>
      <div class="ui-shop-item__info">
        <span class="ui-shop-item__name">${s.label}</span>
      </div>
      <div class="ui-shop-item__action"><span class="ui-shop-item__stat-value">${s.value}</span></div>
    `;
    return row;
  }

  destroy() {
    document.removeEventListener('keydown', this._onKeyDown);
    if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
  }
}

// --- Skiny postaci -----------------------------------------------------------
// Ta sama struktura co AchievementsPanel wyżej (bottom sheet, .ui-shop-item
// wiersze) - czysto kosmetyczny katalog (economy.js: PLAYER_SKINS/
// getSkinCatalog/buySkin/selectSkin), płatny Rdzeniami jak drugi poziom
// ulepszeń w PrestigePanel.
class SkinsPanel {
  constructor(economyManager) {
    this.economyManager = economyManager;
    this.el = null;
    this.bodyEl = null;
    this.isOpen = false;

    this._onKeyDown = (e) => {
      if (e.key === 'Escape' && this.isOpen) this.close();
    };
  }

  mount(parent) {
    if (!this.el) this._render();
    if (parent && this.el.parentNode !== parent) parent.appendChild(this.el);
    return this.el;
  }

  _render() {
    this.el = document.createElement('div');
    this.el.className = 'ui-shop';

    const backdrop = document.createElement('div');
    backdrop.className = 'ui-shop-backdrop';
    backdrop.addEventListener('click', () => this.close());

    const sheet = document.createElement('div');
    sheet.className = 'ui-shop-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', 'Skiny');
    sheet.innerHTML = `
      <div class="ui-shop-sheet__handle"></div>
      <header class="ui-shop-sheet__header">
        <span class="ui-shop-sheet__title"><span aria-hidden="true">${SHIRT_ICON_SVG}</span> Skiny</span>
        <button type="button" class="ui-shop-sheet__close" aria-label="Zamknij skiny">${CLOSE_ICON_SVG}</button>
      </header>
      <div class="ui-shop-sheet__body"></div>
    `;
    sheet.querySelector('.ui-shop-sheet__close').addEventListener('click', () => this.close());
    sheet.addEventListener('click', (e) => e.stopPropagation());

    this.bodyEl = sheet.querySelector('.ui-shop-sheet__body');

    this.el.appendChild(backdrop);
    this.el.appendChild(sheet);

    this.refresh();
  }

  open() {
    if (!this.el) this._render();
    this.isOpen = true;
    this.el.classList.add('ui-shop--open');
    document.addEventListener('keydown', this._onKeyDown);
    this.refresh();
  }

  close() {
    this.isOpen = false;
    if (this.el) this.el.classList.remove('ui-shop--open');
    document.removeEventListener('keydown', this._onKeyDown);
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  refresh() {
    if (!this.bodyEl || !this.economyManager) return;
    const catalog = this.economyManager.getSkinCatalog();

    this.bodyEl.innerHTML = '';

    const section = document.createElement('div');
    section.className = 'ui-shop-section';
    const heading = document.createElement('h3');
    heading.className = 'ui-shop-section__title';
    heading.innerHTML = `${CORE_ICON_SVG} Masz ${this.economyManager.cores}`;
    section.appendChild(heading);

    const list = document.createElement('div');
    list.className = 'ui-shop-list';
    catalog.forEach((s) => list.appendChild(this._buildRow(s)));
    section.appendChild(list);

    this.bodyEl.appendChild(section);
  }

  /**
   * Podgląd - MAŁY <canvas> z rzeczywistą postacią gracza w tym kolorze
   * (nie tylko kolorowa plamka), narysowany z JUŻ upieczonej tintowanej
   * kopii sprite'a (player.js: _tintedSprites, patrz _bakeSkinTints) - ten
   * sam obrazek, który gracz zobaczy w świecie po wybraniu tego skina.
   * Zwraca null, gdy sprite jeszcze się nie wczytał (rzadkie - wtedy
   * _buildRow rysuje zwykłe kółko w kolorze tint zamiast podglądu).
   */
  _buildPreviewCanvas(skin) {
    const pc = window.playerController;
    const srcImg = skin.tint && pc && pc._tintedSprites[skin.id]
      ? pc._tintedSprites[skin.id].static
      : (pc && pc._spriteLoaded ? pc._spriteImg : null);
    if (!srcImg || !srcImg.width) return null;

    const canvas = document.createElement('canvas');
    canvas.width = 40;
    canvas.height = 40;
    canvas.className = 'ui-shop-item__skin-preview';
    const ctx = canvas.getContext('2d');
    const scale = Math.min(40 / srcImg.width, 40 / srcImg.height) * 0.9;
    const w = srcImg.width * scale;
    const h = srcImg.height * scale;
    ctx.drawImage(srcImg, (40 - w) / 2, (40 - h) / 2, w, h);
    return canvas;
  }

  _buildRow(s) {
    const row = document.createElement('article');
    row.className = 'ui-shop-item';
    if (s.selected) row.classList.add('ui-shop-item--afford');

    const iconFallback = `<span style="display:inline-block;width:26px;height:26px;border-radius:50%;background:${s.tint || '#5C85D6'}"></span>`;
    row.innerHTML = `
      <div class="ui-shop-item__icon" aria-hidden="true">${iconFallback}</div>
      <div class="ui-shop-item__info">
        <span class="ui-shop-item__name">${s.name}</span>
        <span class="ui-shop-item__desc">${s.desc}</span>
      </div>
      <div class="ui-shop-item__action"></div>
    `;

    // Podmieniamy placeholder-kółko na prawdziwy podgląd postaci, jeśli
    // sprite już się wczytał (patrz _buildPreviewCanvas).
    const preview = this._buildPreviewCanvas(s);
    if (preview) row.querySelector('.ui-shop-item__icon').replaceChildren(preview);

    const actionEl = row.querySelector('.ui-shop-item__action');
    if (s.selected) {
      const badge = document.createElement('span');
      badge.className = 'ui-shop-item__done';
      badge.setAttribute('aria-label', 'Wybrany');
      badge.innerHTML = CHECK_ICON_SVG;
      actionEl.appendChild(badge);
    } else if (s.unlocked) {
      const btn = new UIButton({
        label: 'Wybierz',
        variant: 'ghost',
        onClick: () => {
          if (this.economyManager.selectSkin(s.id)) this.refresh();
        }
      });
      actionEl.appendChild(btn.mount());
    } else if (s.eventOnly && !s.available) {
      // Wydarzenie ("Deszcz Meteorytów") aktualnie nieaktywne - zwykły
      // przycisk kupna byłby mylący (klik i tak zostałby odrzucony przez
      // buySkin()), więc zamiast niego stały, nieklikalny badge z
      // wyjaśnieniem KIEDY wrócić, zamiast po prostu chować pozycję (gracz
      // ma wiedzieć, że taki skin w ogóle istnieje).
      const btn = new UIButton({
        label: `${LOCK_ICON_SVG} Tylko w weekend`,
        variant: 'ghost',
        disabled: true,
        title: 'Dostępny wyłącznie podczas Weekendowego Deszczu Meteorytów'
      });
      actionEl.appendChild(btn.mount());
    } else {
      const canBuy = this.economyManager.cores >= s.cost;
      // Kłódka gdy nie stać - patrz identyczny komentarz w ShopPanel._buildRow.
      const costLabel = canBuy ? `${CORE_ICON_SVG}${s.cost}` : `${LOCK_ICON_SVG} ${CORE_ICON_SVG}${s.cost}`;
      const btn = new UIButton({
        label: costLabel,
        variant: canBuy ? 'accent' : 'ghost',
        denied: !canBuy,
        title: canBuy ? 'Kup skin' : 'Za mało Rdzeni',
        onClick: () => {
          if (this.economyManager.buySkin(s.id)) this.refresh();
        }
      });
      actionEl.appendChild(btn.mount());
    }

    return row;
  }

  destroy() {
    document.removeEventListener('keydown', this._onKeyDown);
    if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
  }
}

// --- Powiadomienia (toast) --------------------------------------------------

class NotificationManager {
  constructor(container) {
    this.container = container;
    this.queue = [];
    this.maxVisible = 4;
  }

  show(message, { type = 'info', duration = 2800, icon = '' } = {}) {
    const note = document.createElement('div');
    note.className = `ui-toast ui-toast--${type}`;
    note.innerHTML = `
      ${icon ? `<span class="ui-toast__icon">${icon}</span>` : ''}
      <span class="ui-toast__text">${message}</span>
    `;
    this.container.appendChild(note);

    requestAnimationFrame(() => note.classList.add('ui-toast--visible'));

    setTimeout(() => {
      note.classList.remove('ui-toast--visible');
      note.classList.add('ui-toast--exit');
      setTimeout(() => note.remove(), 350);
    }, duration);
  }
}

// --- Tooltip ----------------------------------------------------------------

class TooltipManager {
  constructor() {
    this.el = document.createElement('div');
    this.el.id = 'ui-tooltip';
    this.el.className = 'ui-tooltip';
    this.el.setAttribute('role', 'tooltip');
    this.visible = false;
    this._onMove = (e) => this._move(e);
    this._onOver = (e) => this._showFromTarget(e);
    this._onOut = () => this.hide();
  }

  mount(parent) {
    parent.appendChild(this.el);
    document.addEventListener('pointerover', this._onOver);
    document.addEventListener('pointerout', this._onOut);
    document.addEventListener('pointermove', this._onMove);
  }

  _showFromTarget(e) {
    const target = e.target.closest('[data-tooltip]');
    if (!target) return;
    const text = target.getAttribute('data-tooltip');
    if (!text) return;
    this.el.textContent = text;
    this.el.classList.add('ui-tooltip--visible');
    this.visible = true;
    this._move(e);
  }

  _move(e) {
    if (!this.visible) return;
    const pad = 14;
    let x = e.clientX + pad;
    let y = e.clientY + pad;
    const rect = this.el.getBoundingClientRect();
    if (x + rect.width > window.innerWidth - 8) x = e.clientX - rect.width - pad;
    if (y + rect.height > window.innerHeight - 8) y = e.clientY - rect.height - pad;
    this.el.style.left = `${x}px`;
    this.el.style.top = `${y}px`;
  }

  hide() {
    this.visible = false;
    this.el.classList.remove('ui-tooltip--visible');
  }

  destroy() {
    document.removeEventListener('pointerover', this._onOver);
    document.removeEventListener('pointerout', this._onOut);
    document.removeEventListener('pointermove', this._onMove);
    if (this.el.parentNode) this.el.parentNode.removeChild(this.el);
  }
}

// --- Główny manager UI ------------------------------------------------------

class UIManager {
  constructor(game) {
    this.game = game;
    this.root = null;
    this.moneyDisplay = null;
    this.stackDisplay = null;
    this.challengeDisplay = null;
    this.unlockProgressDisplay = null;
    this.shopPanel = null;
    this.prestigePanel = null;
    this.settingsPanel = null;
    this.achievementsPanel = null;
    this.skinsPanel = null;
    this.statsPanel = null;
    this.offlineModal = null;
    this.notifications = null;
    this.tooltip = null;
    this.shopToggleBtn = null;
    this.shipToggleBtn = null;
    this.settingsToggleBtn = null;
    this.shipContributeBtn = null;
    this.shipContributeWrap = null;
    // Cache ostatnio zapisanej widoczności (patrz update() niżej) - BUGFIX
    // (wydajność, niezależna od dpr): oba przyciski dostawały nowy
    // style.display co klatkę (60x/s), NAWET gdy wartość się nie zmieniała -
    // każdy zapis do .style to potencjalne przeliczenie stylu przez
    // przeglądarkę. Piszemy teraz tylko przy FAKTYCZNEJ zmianie stanu.
    this._shipToggleVisible = false;
    this._shipContributeVisible = false;

    this._onMoney = () => this._syncMoney(true);
    this._onMachineOutput = () => this._syncMoney(true);
    this._onStackAdded = (d) => this._syncStack(d);
    this._onStackRemoved = (d) => this._syncStack(d);
    this._onUpgrade = (d) => {
      this._syncMoney(true);
      // BUGFIX: brakowało tego wywołania - licznik "X / max" w HUD nie
      // odświeżał się natychmiast po kupnie większego plecaka, tylko przy
      // NASTĘPNYM podniesieniu/oddaniu przedmiotu (STACK_ADDED/STACK_REMOVED).
      // _syncStack() bez argumentu sam doczyta aktualny rozmiar/max ze
      // stackControllera, więc bezpieczne też dla pozostałych ulepszeń.
      this._syncStack();
      this._refreshShop();
      // BUGFIX: klucze poniżej nie zgadzały się z SHOP_UPGRADES (economy.js)
      // - 'stage_glass'/'stage_metal' nigdy tam nie istniały, prawdziwe id
      // to 'toxic_filter'/'radiation_suit'. Efekt: zakup stroju ochronnego
      // pokazywał tylko ogólne "Kupiono ulepszenie" zamiast kontekstowej
      // wiadomości o odblokowanej strefie.
      const unlockMessages = {
        stage_paper: 'Papier odblokowany! Szukaj go w świecie i wrzuć do Recyklera.',
        minimap: 'Minimapa kupiona! Radar w rogu ekranu pokazuje, co jest w pobliżu.',
        headlamp: 'Kask z Latarką kupiony! Mniejsza kara prędkości w strefach skażenia.',
        boots: 'Robocze Buty kupione! Więcej czasu, zanim stracisz przedmiot w hazardzie.',
        toxic_filter: 'Filtr Toksyn kupiony! Bagno jest już dla Ciebie bezpieczne.',
        radiation_suit: 'Kombinezon Radiacyjny kupiony! Strefa Atomowa jest już dla Ciebie bezpieczna.'
      };
      const message = unlockMessages[d.upgradeId];
      if (message) {
        // Ikona TEGO SAMEGO ulepszenia, zdefiniowana raz w SHOP_UPGRADES
        // (economy.js) - żadnego osobnego zestawu ikon do zsynchronizowania.
        const shopDef = window.SHOP_UPGRADES && window.SHOP_UPGRADES.find((u) => u.id === d.upgradeId);
        this.notifications.show(message, { type: 'success', icon: (shopDef && shopDef.icon) || PARTY_ICON_SVG, duration: 3600 });
      } else {
        this.notifications.show(`Kupiono ulepszenie`, { type: 'success', icon: CHECK_ICON_SVG });
      }
    };

    // Osobny od _onGameWon poniżej - TO strzela przy KAŻDYM z 5 modułów
    // (GAME_WON tylko przy ostatnim). Dotąd ui.js w ogóle tego nie łapało -
    // jedyna reakcja na ukończenie modułu 1-4 był mały FX_POPUP przy statku
    // (łatwy do przeoczenia) + dźwięk. Toast trzyma się dłużej i pokazuje
    // KONKRETNY postęp (X/5), niezależnie od tego, gdzie akurat patrzy gracz.
    // Progresywne odblokowania - najważniejszy sygnał "coś nowego!" w grze,
    // bezpośredni lek na "martwo/ciągle to samo". Dłuższy i mocniejszy niż
    // zwykły toast, bo to rzadki, ważny moment odkrycia.
    this._onUnlockGranted = (d) => {
      const kindLabel = d.kind === 'zone' ? 'Nowa strefa' : 'Nowa maszyna';
      this.notifications.show(`${UNLOCK_ICON_SVG} ${kindLabel}: ${d.name}! ${d.desc || ''}`, {
        type: 'success',
        icon: SPARKLE_ICON_SVG,
        duration: 5000
      });
    };

    // Osiągnięcie zdobyte - toast z ikoną-trofeum. Odświeżamy też panel
    // osiągnięć (gdyby akurat był otwarty) i licznik "X/Y" w Menu przy
    // następnym otwarciu (Menu i tak odświeża się przy każdym open()).
    this._onAchievementUnlocked = (d) => {
      this.notifications.show(`Osiągnięcie: ${d.name}! (+1% do zarobku na stałe)`, {
        type: 'success',
        icon: d.icon || TROPHY_ICON_SVG,
        duration: 4200
      });
      if (this.achievementsPanel) this.achievementsPanel.refresh();
    };

    this._onShipModuleCompleted = (d) => {
      const eco = window.economyManager;
      const doneCount = eco ? eco.shipCompletedModules.length : (d && (d.index + 1)) || 0;
      const total = (window.SHIP_MODULE_DEFINITIONS && window.SHIP_MODULE_DEFINITIONS.length) || 5;
      // Zdolność, którą moduł właśnie włączył - bez tego gracz dostawał perk
      // po cichu i mógł go nigdy nie zauważyć, co zabijałoby cały sens
      // "moduły dają zdolności" (patrz SHIP_MODULE_PERKS w economy.js).
      const perkLabel = (eco && d && typeof eco.getShipPerkLabel === 'function')
        ? eco.getShipPerkLabel(d.moduleId)
        : '';
      const suffix = perkLabel ? ` ${perkLabel}` : '';
      this.notifications.show(`Moduł ukończony (${doneCount}/${total})!${suffix}`, {
        type: 'success',
        icon: WRENCH_ICON_SVG,
        duration: 4600
      });
    };

    // Faza 4 (prestiż): GAME_WON strzela RAZ, dokładnie w momencie ukończenia
    // piątego modułu - to moment na celebracyjne auto-otwarcie panelu
    // statku. Nie strzela ponownie po reloadzie, gdy gra była już wygrana
    // wcześniej (patrz ship.js _initialSyncDone) - stąd shipToggleBtn w
    // update() jako TRWAŁA droga powrotu do tego samego panelu.
    this._onGameWon = () => {
      this.notifications.show(`${ROCKET_ICON_SVG} Wszystkie moduły gotowe! Możesz lecieć dalej.`, {
        type: 'success',
        icon: PARTY_ICON_SVG,
        duration: 4000
      });
      if (this.shopPanel) this.shopPanel.close();
      if (this.settingsPanel) this.settingsPanel.close();
      if (this.achievementsPanel) this.achievementsPanel.close();
      if (this.skinsPanel) this.skinsPanel.close();
      if (this.statsPanel) this.statsPanel.close();
      if (this.prestigePanel) this.prestigePanel.open();
    };

    // Po prestige() (economy.js) - odświeża WSZYSTKO naraz (pieniądze/stos
    // wróciły do zera lub startowego bonusu, katalog trwałych ulepszeń ma
    // nowy stan Rdzeni). Panel NIE zamyka się automatycznie - po odlocie
    // gracz zwykle chce od razu wydać świeżo zdobyte Rdzenie, więc zostaje
    // otwarty, tylko odświeżony.
    this._onPrestigeDone = (d) => {
      this._syncMoney(false);
      this._syncStack();
      this._refreshShop();
      this._refreshPrestige();
      const planet = (d && d.planetNumber) || '?';
      const cores = (d && d.coresEarned) || 0;
      const mod = d && d.modifier;
      const modSuffix = mod ? ` — ${mod.icon} ${mod.name}` : '';
      this.notifications.show(`${PLANET_ICON_SVG} Nowa planeta #${planet}${modSuffix}! +${CORE_ICON_SVG}${cores} Rdzeni`, {
        type: 'success',
        icon: SPARKLE_ICON_SVG,
        duration: 4200
      });
      // Drugi poziom trwałych ulepszeń (economy.js) jest CELOWO ukryty z
      // katalogu do tego momentu (patrz CORE_TIER2_UNLOCK_PLANET) - bez tego
      // toastu gracz mógłby nigdy nie zauważyć, że w Statku pojawiły się
      // nowe pozycje, skoro sam katalog wcześniej wyglądał "ukończony".
      if (window.CORE_TIER2_UNLOCK_PLANET && planet === window.CORE_TIER2_UNLOCK_PLANET) {
        this.notifications.show(`${UNLOCK_ICON_SVG} Nowe trwałe ulepszenia dostępne w Statku!`, {
          type: 'success',
          icon: CORE_ICON_SVG,
          duration: 4600
        });
      }
    };

    this._onCoreUpgrade = () => this._refreshPrestige();

    // Faza 5 (codzienne haki). checkDailyLogin()/checkDailyChallenge()
    // (economy.js) wołane są raz z main.js, PO tym jak UIManager już istnieje
    // i zdążył się zasubskrybować - więc te dwa eventy na pewno zostaną złapane,
    // nawet jeśli strzelą w tej samej klatce co konstrukcja.
    this._onDailyLogin = (d) => {
      const coreText = d.coreBonus > 0 ? ` + ${CORE_ICON_SVG}${d.coreBonus} Rdzeni!` : '';
      this.notifications.show(`Dzień ${d.streak} z rzędu! +${d.moneyReward}${CREDIT_ICON_SVG}${coreText}`, {
        type: 'success',
        icon: FLAME_ICON_SVG,
        duration: 4200
      });
    };
    this._onDailyChallengeUpdated = (d) => {
      if (this.challengeDisplay) this.challengeDisplay.setChallenge(d);
    };
    this._onDailyChallengeClaimed = (d) => {
      this._syncMoney(true);
      this.notifications.show(`Wyzwanie odebrane! +${d.reward}${CREDIT_ICON_SVG}`, { type: 'success', icon: CHECK_ICON_SVG, duration: 2600 });
    };

    this._buildDOM();
    this._bindEvents();
    this._syncAll();
  }

  _buildDOM() {
    this.root = document.createElement('div');
    this.root.id = 'game-ui';
    this.root.className = 'game-ui';

    const topBar = document.createElement('header');
    topBar.className = 'game-ui__top';

    // Dwie strefy zamiast jednego zawijającego się rzędu czterech grubych
    // pigułek (patrz komentarz przy .game-ui__goals w style.css): żywe
    // statystyki obok siebie u góry, cele jako slim paski pod nimi.
    const statsRow = document.createElement('div');
    statsRow.className = 'game-ui__stats';
    const goalsCol = document.createElement('div');
    goalsCol.className = 'game-ui__goals';

    this.moneyDisplay = new MoneyDisplay();
    this.stackDisplay = new StackDisplay();
    this.challengeDisplay = new ChallengeDisplay(() => {
      if (window.economyManager && window.economyManager.claimDailyChallenge()) {
        // Bus.publish w claimDailyChallenge() już odświeży widget przez
        // _onDailyChallengeUpdated - nic więcej nie trzeba tu robić.
      }
    });
    this.unlockProgressDisplay = new UnlockProgressDisplay();

    statsRow.appendChild(this.moneyDisplay.mount());
    statsRow.appendChild(this.stackDisplay.mount());
    goalsCol.appendChild(this.unlockProgressDisplay.mount());
    goalsCol.appendChild(this.challengeDisplay.mount());
    topBar.appendChild(statsRow);
    topBar.appendChild(goalsCol);

    const economy = window.economyManager;
    this.shopPanel = new ShopPanel(economy, () => {
      this._syncMoney(true);
      this._refreshShop();
    });
    this.prestigePanel = new PrestigePanel(economy, () => {
      this._syncMoney(true);
      this._syncStack();
      this._refreshShop();
      this._refreshPrestige();
    });
    this.achievementsPanel = new AchievementsPanel(economy);
    this.skinsPanel = new SkinsPanel(economy);
    this.statsPanel = new StatsPanel(economy);
    // Dźwięk włącza/wyłącza się TYLKO z Menu (SettingsPanel._buildSoundRow) -
    // brak osobnego przycisku Wycisz na ekranie gry (patrz usunięty
    // muteToggleBtn niżej), więc nie ma już nic do zsynchronizowania po
    // przełączeniu - pierwszy argument (onChange) zostaje pusty.
    this.settingsPanel = new SettingsPanel(
      null,
      () => this.achievementsPanel.open(),
      () => this.skinsPanel.open(),
      () => this.statsPanel.open()
    );

    const toastContainer = document.createElement('div');
    toastContainer.className = 'game-ui__toasts';
    toastContainer.setAttribute('aria-live', 'polite');
    this.notifications = new NotificationManager(toastContainer);

    this.tooltip = new TooltipManager();

    const fabRow = document.createElement('div');
    fabRow.className = 'game-ui__fab-row';

    this.shopToggleBtn = new UIButton({
      icon: CART_ICON_SVG,
      label: 'Sklep',
      variant: 'fab',
      onClick: () => {
        // Tylko jeden bottom-sheet naraz - wszystkie (Sklep/Statek/Menu/
        // Osiągnięcia) używają tych samych klas CSS (.ui-shop*, patrz
        // PrestigePanel/SettingsPanel), więc dwa naraz by się nałożyły.
        if (this.prestigePanel) this.prestigePanel.close();
        if (this.settingsPanel) this.settingsPanel.close();
        if (this.achievementsPanel) this.achievementsPanel.close();
        if (this.skinsPanel) this.skinsPanel.close();
        if (this.statsPanel) this.statsPanel.close();
        this.shopPanel.toggle();
      }
    });
    fabRow.appendChild(this.shopToggleBtn.mount());

    // Przycisk statku - widoczny TYLKO gdy gracz stoi w jego zasięgu (patrz
    // update() - czyta window.ship.inRange co klatkę). Domyślnie ukryty, bo
    // przy starcie gry (spawn daleko od statku) i tak nie ma sensu.
    this.shipToggleBtn = new UIButton({
      icon: ROCKET_ICON_SVG,
      label: 'Statek',
      variant: 'fab',
      onClick: () => {
        if (this.shopPanel) this.shopPanel.close();
        if (this.settingsPanel) this.settingsPanel.close();
        if (this.achievementsPanel) this.achievementsPanel.close();
        if (this.skinsPanel) this.skinsPanel.close();
        if (this.statsPanel) this.statsPanel.close();
        this.prestigePanel.toggle();
      }
    });
    fabRow.appendChild(this.shipToggleBtn.mount());
    this.shipToggleBtn.el.style.display = 'none';

    // "Pełnoprawne menu z dodatkowymi opcjami jak w grze mobilnej" - dźwięk/
    // samouczek/reset postępu/wersja (patrz SettingsPanel). Zawsze widoczny,
    // w przeciwieństwie do przycisku Statku.
    this.settingsToggleBtn = new UIButton({
      icon: GEAR_ICON_SVG,
      label: 'Menu',
      variant: 'fab',
      onClick: () => {
        if (this.shopPanel) this.shopPanel.close();
        if (this.prestigePanel) this.prestigePanel.close();
        if (this.achievementsPanel) this.achievementsPanel.close();
        if (this.skinsPanel) this.skinsPanel.close();
        if (this.statsPanel) this.statsPanel.close();
        this.settingsPanel.toggle();
      }
    });
    fabRow.appendChild(this.settingsToggleBtn.mount());

    // Przycisk "Wpłać" - jedyny sposób, żeby statek zaczął zabierać
    // pieniądze/surowce ze stosu (ship.js już nie robi tego automatycznie
    // samym staniem w zasięgu, patrz Ship.update()/confirmContribution()).
    // CELOWO NIE w fabRow (stały róg ekranu, jak Sklep/Statek/Wycisz) -
    // pozycjonowany bezpośrednio NAD statkiem w świecie (patrz update()
    // niżej, przelicza world->screen przez window.game.cameraX/Y), żeby
    // przycisk pojawiał się tam, gdzie faktycznie dzieje się akcja.
    this.shipContributeBtn = new UIButton({
      icon: PAY_ICON_SVG,
      label: 'Wpłać',
      variant: 'accent',
      title: 'Przekaż pieniądze i surowce na bieżący moduł statku',
      onClick: () => {
        if (window.ship && typeof window.ship.confirmContribution === 'function') {
          window.ship.confirmContribution();
        }
      }
    });
    this.shipContributeWrap = document.createElement('div');
    this.shipContributeWrap.className = 'ui-ship-contribute';
    this.shipContributeWrap.style.display = 'none';
    this.shipContributeWrap.appendChild(this.shipContributeBtn.mount());

    // BRAK przycisku Wycisz tutaj (dawniej muteToggleBtn w fabRow, obok
    // Sklep/Statek/Menu) - dźwięk włącza/wyłącza się TERAZ wyłącznie z Menu
    // (SettingsPanel._buildSoundRow), żeby ekran gry nie zaśmiecał się
    // czwartą stałą ikoną, której gracz dotyka raz na sesję, nie co chwilę
    // jak Sklepu/Statku.

    this.root.appendChild(topBar);
    this.root.appendChild(toastContainer);
    this.root.appendChild(fabRow);
    this.root.appendChild(this.shipContributeWrap);
    this.root.appendChild(this.shopPanel.mount());
    this.root.appendChild(this.prestigePanel.mount());
    this.root.appendChild(this.settingsPanel.mount());
    this.root.appendChild(this.achievementsPanel.mount());
    this.root.appendChild(this.skinsPanel.mount());
    this.root.appendChild(this.statsPanel.mount());
    this.offlineModal = new OfflineRewardModal(window.economyManager, () => this._syncMoney(true));
    this.root.appendChild(this.offlineModal.mount());

    const container = document.body;
    container.appendChild(this.root);
    this.tooltip.mount(this.root);

    this._applyResponsiveLayout();
    window.addEventListener('resize', () => this._applyResponsiveLayout());
  }

  _bindEvents() {
    Bus.subscribe(Events.MONEY_COLLECTED, this._onMoney);
    Bus.subscribe(Events.MACHINE_OUTPUT, this._onMachineOutput);
    Bus.subscribe(Events.STACK_ADDED, this._onStackAdded);
    Bus.subscribe(Events.STACK_REMOVED, this._onStackRemoved);
    Bus.subscribe(Events.UPGRADE_BOUGHT, this._onUpgrade);
    if (Events.UNLOCK_GRANTED) Bus.subscribe(Events.UNLOCK_GRANTED, this._onUnlockGranted);
    if (Events.ACHIEVEMENT_UNLOCKED) Bus.subscribe(Events.ACHIEVEMENT_UNLOCKED, this._onAchievementUnlocked);
    if (Events.SHIP_MODULE_COMPLETED) Bus.subscribe(Events.SHIP_MODULE_COMPLETED, this._onShipModuleCompleted);
    Bus.subscribe(Events.GAME_WON, this._onGameWon);
    if (Events.PRESTIGE_DONE) Bus.subscribe(Events.PRESTIGE_DONE, this._onPrestigeDone);
    if (Events.CORE_UPGRADE_BOUGHT) Bus.subscribe(Events.CORE_UPGRADE_BOUGHT, this._onCoreUpgrade);
    if (Events.DAILY_LOGIN) Bus.subscribe(Events.DAILY_LOGIN, this._onDailyLogin);
    if (Events.DAILY_CHALLENGE_UPDATED) Bus.subscribe(Events.DAILY_CHALLENGE_UPDATED, this._onDailyChallengeUpdated);
    if (Events.DAILY_CHALLENGE_CLAIMED) Bus.subscribe(Events.DAILY_CHALLENGE_CLAIMED, this._onDailyChallengeClaimed);
  }

  _syncMoney(animate) {
    const money = window.economyManager
      ? window.economyManager.getMoney()
      : (this.game && this.game.state.money) || 0;
    this.moneyDisplay.setValue(money, animate);
    if (animate) this.moneyDisplay.pulse();
    this._refreshShop();
    // Pasek "co dalej" zależy od totalEarned, które rośnie razem z każdym
    // przychodem - więc odświeżamy go przy każdej zmianie kasy.
    if (this.unlockProgressDisplay && window.economyManager
        && typeof window.economyManager.getNextUnlock === 'function') {
      this.unlockProgressDisplay.setNext(window.economyManager.getNextUnlock());
    }
  }

  _syncStack(data) {
    const size = (data && typeof data.size === 'number')
      ? data.size
      : (window.stackController ? window.stackController.items.length : 0);
    const max = window.stackController ? window.stackController.maxCapacity : 10;
    this.stackDisplay.setStack(size, max);
  }

  _refreshShop() {
    if (this.shopPanel) this.shopPanel.refresh();
  }

  /** Odpowiednik _refreshShop() dla panelu statku/prestiżu - osobna metoda,
   * żeby wywołujący kod (handlery eventów) nie musiał znać istnienia dwóch
   * osobnych paneli, tylko wołał "odśwież to, co dotyczy tego zdarzenia". */
  _refreshPrestige() {
    if (this.prestigePanel) this.prestigePanel.refresh();
  }

  syncFromGameState() {
    this._syncAll();
  }

  /** Wołane wprost z main.js (nie przez Bus - to jednorazowy, deterministyczny
   * pokaz zaraz po starcie, nie coś reagujące na gameplay). data to wynik
   * economyManager.computeOfflineReward() - {elapsedSeconds, reward}. */
  showOfflineReward(data) {
    if (this.shopPanel) this.shopPanel.close();
    if (this.prestigePanel) this.prestigePanel.close();
    if (this.settingsPanel) this.settingsPanel.close();
    if (this.achievementsPanel) this.achievementsPanel.close();
    if (this.skinsPanel) this.skinsPanel.close();
    if (this.statsPanel) this.statsPanel.close();
    if (this.offlineModal) this.offlineModal.open(data);
  }

  _syncAll() {
    this._syncMoney(false);
    this._syncStack({
      size: window.stackController ? window.stackController.items.length : 0
    });
    this._refreshShop();
    this._refreshPrestige();
    if (this.challengeDisplay && window.economyManager) {
      this.challengeDisplay.setChallenge(window.economyManager.dailyChallenge);
    }
  }

  _applyResponsiveLayout() {
    const narrow = window.innerWidth < UI_BREAKPOINT_NARROW;
    this.root.classList.toggle('game-ui--narrow', narrow);
  }

  update(delta) {
    if (window.economyManager) {
      const actual = window.economyManager.getMoney();
      if (actual !== this.moneyDisplay.value) {
        this.moneyDisplay.setValue(actual, true);
      }
    }
    this.moneyDisplay.update(delta);

    // Przycisk "Statek" widoczny TYLKO gdy gracz stoi w jego zasięgu -
    // ship.inRange jest już liczone co klatkę przez ship.js (update()
    // modułów w game.js woła je PRZED update() UIManagera, patrz kolejność
    // registerModule w main.js), więc tu tylko czytamy gotowy wynik, zero
    // duplikowania liczenia odległości.
    // BUGFIX (wydajność): style.display zapisywany TYLKO gdy nearShip
    // faktycznie się zmienił (patrz this._shipToggleVisible w konstruktorze) -
    // dawniej pisany co klatkę (60x/s) niezależnie od tego, czy się zmienił.
    if (this.shipToggleBtn && this.shipToggleBtn.el) {
      const nearShip = !!(window.ship && window.ship.inRange);
      if (nearShip !== this._shipToggleVisible) {
        this._shipToggleVisible = nearShip;
        this.shipToggleBtn.el.style.display = nearShip ? '' : 'none';
      }
    }

    // Przycisk "Wpłać" - widoczny tylko, dopóki gracz stoi w zasięgu I
    // jeszcze nie potwierdził wpłaty na bieżący moduł przy TYM podejściu
    // (Ship.needsContributionConfirm() sam pilnuje obu warunków). Pozycja
    // przeliczana co klatkę ze świata na ekran (world - camera) - ten sam
    // przelicznik co canvas (patrz game.js translate(-cameraX/Y)), więc
    // przycisk "przykleja się" do statku niezależnie od ruchu kamery -
    // left/top MUSZĄ zostać przeliczane co klatkę (kamera się rusza), ale
    // display - tak jak przy shipToggleBtn wyżej - tylko przy zmianie stanu.
    if (this.shipContributeWrap) {
      const ship = window.ship;
      const needsConfirm = !!(ship && typeof ship.needsContributionConfirm === 'function'
        && ship.needsContributionConfirm());
      if (needsConfirm && window.game) {
        const screenX = ship.x - window.game.cameraX;
        const screenY = ship.y + ship.h / 2 - window.game.cameraY + 90;
        this.shipContributeWrap.style.left = `${screenX}px`;
        this.shipContributeWrap.style.top = `${screenY}px`;
        if (!this._shipContributeVisible) {
          this._shipContributeVisible = true;
          this.shipContributeWrap.style.display = '';
        }
      } else if (this._shipContributeVisible) {
        this._shipContributeVisible = false;
        this.shipContributeWrap.style.display = 'none';
      }
    }
  }

  draw() {
    // HUD renderowany w DOM; warstwa canvas UI pozostaje dla GameFeel.
  }

  destroy() {
    Bus.unsubscribe(Events.MONEY_COLLECTED, this._onMoney);
    Bus.unsubscribe(Events.MACHINE_OUTPUT, this._onMachineOutput);
    Bus.unsubscribe(Events.STACK_ADDED, this._onStackAdded);
    Bus.unsubscribe(Events.STACK_REMOVED, this._onStackRemoved);
    Bus.unsubscribe(Events.UPGRADE_BOUGHT, this._onUpgrade);
    if (Events.UNLOCK_GRANTED) Bus.unsubscribe(Events.UNLOCK_GRANTED, this._onUnlockGranted);
    if (Events.ACHIEVEMENT_UNLOCKED) Bus.unsubscribe(Events.ACHIEVEMENT_UNLOCKED, this._onAchievementUnlocked);
    if (Events.SHIP_MODULE_COMPLETED) Bus.unsubscribe(Events.SHIP_MODULE_COMPLETED, this._onShipModuleCompleted);
    Bus.unsubscribe(Events.GAME_WON, this._onGameWon);
    if (Events.PRESTIGE_DONE) Bus.unsubscribe(Events.PRESTIGE_DONE, this._onPrestigeDone);
    if (Events.CORE_UPGRADE_BOUGHT) Bus.unsubscribe(Events.CORE_UPGRADE_BOUGHT, this._onCoreUpgrade);
    if (Events.DAILY_LOGIN) Bus.unsubscribe(Events.DAILY_LOGIN, this._onDailyLogin);
    if (Events.DAILY_CHALLENGE_UPDATED) Bus.unsubscribe(Events.DAILY_CHALLENGE_UPDATED, this._onDailyChallengeUpdated);
    if (Events.DAILY_CHALLENGE_CLAIMED) Bus.unsubscribe(Events.DAILY_CHALLENGE_CLAIMED, this._onDailyChallengeClaimed);

    if (this.tooltip) this.tooltip.destroy();
    if (this.shopPanel) this.shopPanel.destroy();
    if (this.prestigePanel) this.prestigePanel.destroy();
    if (this.settingsPanel) this.settingsPanel.destroy();
    if (this.achievementsPanel) this.achievementsPanel.destroy();
    if (this.skinsPanel) this.skinsPanel.destroy();
    if (this.statsPanel) this.statsPanel.destroy();
    if (this.offlineModal) this.offlineModal.destroy();
    if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root);
  }
}

window.UIManager = UIManager;