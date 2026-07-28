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

// Jednorazowa nagroda za ukończenie całego samouczka - mały "dziękuję, że
// przeczytałeś", ten sam duch co nagroda za wyzwanie dnia/streak, żeby
// samouczek też dawał namacalny powód, żeby nie kliknąć od razu "pomiń".
const TUTORIAL_COMPLETION_BONUS = 60;

// Ikony SVG (nie emoji) - własna kopia stylu ui.js (konwencja projektu, brak
// współdzielonych utili).
const TUTORIAL_CLOSE_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 5 19 19M19 5 5 19"/></svg>';
const TUTORIAL_GRADUATE_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#FFD54F" stroke-width="1.8" stroke-linejoin="round"><path d="M2 9 12 4l10 5-10 5Z" fill="#FFD54F" fill-opacity="0.3"/><path d="M6 11.5V16c0 1.5 3 3 6 3s6-1.5 6-3v-4.5" /><path d="M21 9v6" stroke-linecap="round"/></svg>';

// Każdy krok: tekst hinta + event Bus, na który czekamy + funkcja matches()
// decydująca czy AKURAT TEN konkretny event spełnia warunek (nie każdy
// event tego typu musi się liczyć, patrz 'move' i 'sell' niżej). Ostatni
// krok (id:'done') ma event:null - znika sam po kilku sekundach zamiast
// czekać na kolejną akcję.
// Ikony SVG (ten sam styl co reszta gry - viewBox 24x24, kreski) zamiast
// dawnych emoji (👆/📦/⚙️/⏳/💹/🎉) - _goToStep w klasie niżej wstawia je
// przez innerHTML (patrz BUGFIX tam).
const TUTORIAL_STEPS = [
  {
    id: 'move',
    icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="#FFE082" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13V5.5a1.5 1.5 0 0 1 3 0V12"/><path d="M13 12V4.5a1.5 1.5 0 0 1 3 0V12"/><path d="M16 12.5V6.5a1.5 1.5 0 0 1 3 0v8.5c0 3.5-2 6-6 6h-1c-2.5 0-3.5-1-5-3l-2.5-4c-.6-1 .1-2.3 1.3-2.2 .7 0 1.3.4 1.7 1l1.5 2.2V13a1.5 1.5 0 0 1 3-.5"/></svg>',
    text: 'Dotknij ekranu i przeciągnij, żeby się poruszać',
    event: 'PLAYER_MOVED',
    matches: (d) => d.speed > TUTORIAL_MOVE_SPEED_THRESHOLD
  },
  {
    id: 'collect',
    icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="#A5D6A7" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3 21 7.5 12 12 3 7.5Z" fill="rgba(165,214,167,0.3)"/><path d="M3 12 12 16.5 21 12"/><path d="M3 16.5 12 21 21 16.5"/></svg>',
    text: 'Zbierz przedmioty widoczne na mapie',
    event: 'STACK_ADDED',
    matches: () => true
  },
  {
    id: 'feed',
    icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="#90CAF9" stroke-width="1.8" stroke-linejoin="round"><path d="M4 20V10l5 3v-3l5 3v-3l5 3v6Z" fill="#90CAF9" fill-opacity="0.25"/><path d="M6 11V8M11 11V8M16 11V7 a1 1 0 0 1 2 0v1h1V7"/></svg>',
    text: 'Zanieś je do pasującej maszyny (np. Recyklera) - nakarmi się sama, gdy staniesz obok',
    event: 'MACHINE_RECEIVED',
    matches: () => true
  },
  {
    id: 'process',
    icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="#FFD54F" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>',
    text: 'Poczekaj, aż maszyna skończy przetwarzać surowiec na coś nowego',
    event: 'MACHINE_OUTPUT',
    matches: () => true
  },
  {
    id: 'sell',
    icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="#81C784" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17 9 11 13 15 21 7"/><path d="M15 7h6v6"/></svg>',
    text: 'Zanieś gotowy produkt do Terminalu Handlowego i sprzedaj za gotówkę',
    event: 'MONEY_COLLECTED',
    matches: (d) => d.amount > 0
  },
  {
    id: 'done',
    icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="#FFD54F" stroke-width="2" stroke-linecap="round"><path d="M4 20 9 9l6 6Z" fill="#FFD54F" fill-opacity="0.3"/><path d="M15 4v2M19 6l-1.4 1.4M21 10h-2M18 15l-2-2"/></svg>',
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
      window.uiManager.notifications.show(`Samouczek ukończony! +${paidOut}$`, {
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
