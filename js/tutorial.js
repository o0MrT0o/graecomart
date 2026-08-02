'use strict';

/**
 * tutorial.js
 * ------------------------------------------------------------------------
 * Progresywny, kontekstowy samouczek dla nowych graczy - NIE ściana tekstu
 * na starcie, tylko jeden krótki hint na raz, aktualizujący się automatycznie
 * w miarę jak gracz FAKTYCZNIE wykonuje kroki (podpięty pod te same eventy
 * Bus, które już lecą w grze - żadnej nowej logiki do wykrywania postępu).
 *
 * Stan (który krok, czy pominięty) trzymany jest w EconomyManager
 * (tutorialStep/tutorialDismissed) - TRWAŁY, przetrwa prestiż (raz nauczony
 * gracz nie powinien dostawać samouczka od nowa po każdym odlocie).
 *
 * Ten moduł NIE ma update()/draw() - czysto event-driven + DOM, więc NIE
 * jest rejestrowany w game.registerModule() (patrz main.js) - tworzony jest
 * wprost, żyje przez własne subskrypcje Bus, aż do ukończenia/pominięcia.
 */

// Próg prędkości, poniżej którego PLAYER_MOVED nie liczy się jako "ruch" -
// bez tego drobny joystickowy jitter/martwa strefa mógłby fałszywie odhaczyć
// pierwszy krok, zanim gracz faktycznie się poruszył.
const TUTORIAL_MOVE_SPEED_THRESHOLD = 20;

// Symbol głównej waluty - własna kopia ui.js/economy.js CREDIT_ICON_SVG
// (konwencja projektu: brak współdzielonych utili między plikami).
const TUTORIAL_CREDIT_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" style="vertical-align:-2px" fill="#FFD54F" stroke="none"><path fill-rule="evenodd" d="M21 12 16.5 19.79 7.5 19.79 3 12 7.5 4.21 16.5 4.21Z M14.2 12A2.2 2.2 0 1 1 9.8 12A2.2 2.2 0 1 1 14.2 12Z"/></svg>';

// Jednorazowa nagroda za ukończenie całego samouczka - mały "dziękuję, że
// przeczytałeś", ten sam duch co nagroda za wyzwanie dnia/streak, żeby
// samouczek też dawał namacalny powód, żeby nie kliknąć od razu "pomiń".
const TUTORIAL_COMPLETION_BONUS = 60;

// Ikony SVG (nie emoji) - własna kopia stylu ui.js (konwencja projektu, brak
// współdzielonych utili).
const TUTORIAL_CLOSE_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 5 19 19M19 5 5 19"/></svg>';
// PODMIENIONE na prawdziwą maskę Kenney (Tomek: "dokończ ikony w
// samouczku" - ostatnie miejsce w grze z ręcznie rysowanym SVG). Plain
// .ui-icon span BEZ kolorowej plakietki (jak TROPHY_ICON_SVG/PARTY_ICON_SVG
// w ui.js) - to ikonka toastu (NotificationManager), nie wiersz listy, więc
// nie dostaje tła .ui-shop-item__icon-badge jak katalogi w economy.js.
const TUTORIAL_GRADUATE_ICON_SVG = '<span class="ui-icon ui-icon--award" aria-hidden="true" style="color:#FFD54F"></span>';

// Każdy krok: tekst hinta + event Bus, na który czekamy + funkcja matches()
// decydująca czy AKURAT TEN konkretny event spełnia warunek (nie każdy
// event tego typu musi się liczyć, patrz 'move' i 'sell' niżej). Ostatni
// krok (id:'done') ma event:null - znika sam po kilku sekundach zamiast
// czekać na kolejną akcję.
// Ikony - prawdziwe maski Kenney (ten sam _kenneyIcon-owy styl co katalogi
// w economy.js, patrz Tomek: "dokończ ikony w samouczku") zamiast wcześniej
// ręcznie rysowanych SVG, a jeszcze wcześniej emoji (👆/📦/⚙️/⏳/💹/🎉) -
// _goToStep w klasie niżej wstawia je przez innerHTML (patrz BUGFIX tam).
// Plain .ui-icon span bez kolorowej plakietki - .tutorial-window__icon to
// mały, pojedynczy slot ikony (jak toast), nie wiersz listy .ui-shop-item.
const TUTORIAL_STEPS = [
  {
    id: 'move',
    icon: '<span class="ui-icon ui-icon--pointer" aria-hidden="true" style="color:#FFE082"></span>',
    text: 'Dotknij ekranu i przeciągnij, żeby się poruszać',
    event: 'PLAYER_MOVED',
    matches: (d) => d.speed > TUTORIAL_MOVE_SPEED_THRESHOLD
  },
  {
    id: 'collect',
    icon: '<span class="ui-icon ui-icon--trashcan" aria-hidden="true" style="color:#A5D6A7"></span>',
    text: 'Zbierz przedmioty widoczne na mapie',
    event: 'STACK_ADDED',
    matches: () => true
  },
  {
    id: 'feed',
    icon: '<span class="ui-icon ui-icon--wrench" aria-hidden="true" style="color:#90CAF9"></span>',
    text: 'Zanieś je do pasującej maszyny (np. Recyklera) - nakarmi się sama, gdy staniesz obok',
    event: 'MACHINE_RECEIVED',
    matches: () => true
  },
  {
    id: 'process',
    icon: '<span class="ui-icon ui-icon--hourglass" aria-hidden="true" style="color:#FFD54F"></span>',
    text: 'Poczekaj, aż maszyna skończy przetwarzać surowiec na coś nowego',
    event: 'MACHINE_OUTPUT',
    matches: () => true
  },
  {
    id: 'sell',
    icon: '<span class="ui-icon ui-icon--coin" aria-hidden="true" style="color:#81C784"></span>',
    text: 'Zanieś gotowy produkt do Terminalu Handlowego i sprzedaj za gotówkę',
    event: 'MONEY_COLLECTED',
    matches: (d) => d.amount > 0
  },
  {
    id: 'done',
    icon: '<span class="ui-icon ui-icon--flag" aria-hidden="true" style="color:#FFD54F"></span>',
    text: 'Świetnie, wiesz już jak grać! Sklep i Statek czekają, gdy będziesz gotów.',
    event: null,
    matches: null
  }
];

class TutorialManager {
  constructor(economyManager) {
    this.economyManager = economyManager;
    this.el = null;
    this.bodyEl = null;
    this.iconEl = null;
    this.textEl = null;
    this.stepEl = null;
    this.prevBtn = null;
    this.nextBtn = null;
    this._subscribedEvent = null;
    this._currentHandler = null;

    const step = economyManager.tutorialStep || 0;
    const dismissed = !!economyManager.tutorialDismissed;

    // Ukończony albo pominięty w POPRZEDNIEJ sesji - nic do zrobienia, nie
    // twórz nawet DOM (zero śladu w drzewie elementów dla gracza, który już
    // to przeszedł).
    if (dismissed || step >= TUTORIAL_STEPS.length) return;

    this._buildDOM();
    this._goToStep(step);
  }

  /**
   * "Okienko" (nagłówek z licznikiem kroku + zamknij, treść z dużą ikoną i
   * tekstem) zamiast dawnej jednej wąskiej pigułki tekstu - patrz
   * .tutorial-window* w style.css. CELOWO bez backdropu (w przeciwieństwie
   * do .ui-shop) - kroki proszą o realne akcje na mapie (np. "przeciągnij,
   * żeby się poruszać"), więc nic nie może przechwytywać dotyku poza samym
   * okienkiem.
   */
  _buildDOM() {
    this.el = document.createElement('div');
    this.el.className = 'tutorial-window';

    const header = document.createElement('header');
    header.className = 'tutorial-window__header';
    header.innerHTML = `
      <span class="tutorial-window__title">Samouczek <span class="tutorial-window__step"></span></span>
      <button type="button" class="tutorial-window__close" aria-label="Pomiń samouczek">${TUTORIAL_CLOSE_ICON_SVG}</button>
    `;
    header.querySelector('.tutorial-window__close').addEventListener('click', () => this._dismiss());
    this.stepEl = header.querySelector('.tutorial-window__step');

    this.bodyEl = document.createElement('div');
    this.bodyEl.className = 'tutorial-window__body';

    // Strzałki - przewijają kroki RĘCZNIE, niezależnie od tego, czy gracz
    // faktycznie wykonał akcję danego kroku (wołają wprost _goToStep(), tę
    // samą metodę co auto-postęp z eventów Bus - patrz tam). "◀" na kroku 0
    // jest wyłączona (nie ma dokąd cofnąć), "▶" na ostatnim kroku kończy
    // samouczek od razu zamiast czekać na 6s auto-timeout (patrz _goToStep).
    this.prevBtn = document.createElement('button');
    this.prevBtn.type = 'button';
    this.prevBtn.className = 'tutorial-window__nav tutorial-window__nav--prev';
    this.prevBtn.setAttribute('aria-label', 'Poprzedni krok');
    this.prevBtn.textContent = '◀';
    this.prevBtn.addEventListener('click', () => this._goToStep(this.economyManager.tutorialStep - 1));

    this.iconEl = document.createElement('span');
    this.iconEl.className = 'tutorial-window__icon';
    this.iconEl.setAttribute('aria-hidden', 'true');

    this.textEl = document.createElement('span');
    this.textEl.className = 'tutorial-window__text';

    this.nextBtn = document.createElement('button');
    this.nextBtn.type = 'button';
    this.nextBtn.className = 'tutorial-window__nav tutorial-window__nav--next';
    this.nextBtn.setAttribute('aria-label', 'Następny krok');
    this.nextBtn.textContent = '▶';
    this.nextBtn.addEventListener('click', () => this._goToStep(this.economyManager.tutorialStep + 1));

    this.bodyEl.appendChild(this.prevBtn);
    this.bodyEl.appendChild(this.iconEl);
    this.bodyEl.appendChild(this.textEl);
    this.bodyEl.appendChild(this.nextBtn);

    this.el.appendChild(header);
    this.el.appendChild(this.bodyEl);
    document.body.appendChild(this.el);
  }

  _goToStep(index) {
    this._unsubscribeCurrent();

    // Strzałka "◀" na kroku 0 (patrz _buildDOM) jest wyłączona i więc nie
    // powinna w ogóle kliknąć się do -1 - to tylko dodatkowe zabezpieczenie,
    // gdyby np. zdarzenie dotarło mimo disabled.
    if (index < 0) index = 0;

    if (index >= TUTORIAL_STEPS.length) {
      this._complete();
      return;
    }

    const step = TUTORIAL_STEPS[index];
    this.economyManager.tutorialStep = index;
    // innerHTML (nie textContent) - step.icon to teraz SVG, nie emoji.
    if (this.iconEl) this.iconEl.innerHTML = step.icon;
    if (this.textEl) this.textEl.textContent = step.text;
    if (this.stepEl) this.stepEl.textContent = `${index + 1}/${TUTORIAL_STEPS.length}`;
    if (this.prevBtn) this.prevBtn.disabled = index === 0;

    if (step.event && Events[step.event]) {
      this._currentHandler = (d) => {
        if (step.matches(d)) this._flashSuccessThenAdvance(index);
      };
      Bus.subscribe(Events[step.event], this._currentHandler);
      this._subscribedEvent = Events[step.event];
    } else {
      // Ostatni krok (id:'done') - brak eventu do czekania, znika sam.
      this._doneTimer = setTimeout(() => this._complete(), 6000);
    }
  }

  /** Krótki zielony błysk tła jako potwierdzenie "zrobione dobrze", zanim
   * podmieni się tekst na kolejny krok - bez tego zmiana hinta byłaby
   * niezauważalnie nagła, bez żadnej nagrody za wykonanie akcji. */
  _flashSuccessThenAdvance(index) {
    this._unsubscribeCurrent();
    if (this.bodyEl) this.bodyEl.classList.add('tutorial-window__body--success');
    setTimeout(() => {
      if (this.bodyEl) this.bodyEl.classList.remove('tutorial-window__body--success');
      this._goToStep(index + 1);
    }, 900);
  }

  _unsubscribeCurrent() {
    if (this._doneTimer) {
      clearTimeout(this._doneTimer);
      this._doneTimer = null;
    }
    if (this._subscribedEvent && this._currentHandler) {
      Bus.unsubscribe(this._subscribedEvent, this._currentHandler);
    }
    this._subscribedEvent = null;
    this._currentHandler = null;
  }

  _complete() {
    // Zabezpieczenie przed podwójną wypłatą - w normalnym przepływie i tak
    // nieosiągalne dwa razy, ale tania, prosta gwarancja na przyszłość.
    if (this.economyManager.tutorialStep >= TUTORIAL_STEPS.length) return;

    this.economyManager.tutorialStep = TUTORIAL_STEPS.length;
    const paidOut = this.economyManager._addMoney(TUTORIAL_COMPLETION_BONUS);
    if (window.uiManager && window.uiManager.notifications) {
      window.uiManager.notifications.show(`Samouczek ukończony! +${paidOut}${TUTORIAL_CREDIT_ICON_SVG}`, {
        type: 'success',
        icon: TUTORIAL_GRADUATE_ICON_SVG,
        duration: 3400
      });
    }
    this._remove();
  }

  _dismiss() {
    this.economyManager.tutorialDismissed = true;
    this._remove();
  }

  _remove() {
    this._unsubscribeCurrent();
    if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
    this.el = null;
    this.bodyEl = null;
    this.iconEl = null;
    this.textEl = null;
    this.stepEl = null;
    this.prevBtn = null;
    this.nextBtn = null;
  }

  destroy() {
    this._remove();
  }
}

window.TutorialManager = TutorialManager;
