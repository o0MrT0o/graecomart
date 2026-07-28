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

// Każdy krok: tekst hinta + event Bus, na który czekamy + funkcja matches()
// decydująca czy AKURAT TEN konkretny event spełnia warunek (nie każdy
// event tego typu musi się liczyć, patrz 'move' i 'sell' niżej). Ostatni
// krok (id:'done') ma event:null - znika sam po kilku sekundach zamiast
// czekać na kolejną akcję.
const TUTORIAL_STEPS = [
  {
    id: 'move',
    icon: '👆',
    text: 'Dotknij ekranu i przeciągnij, żeby się poruszać',
    event: 'PLAYER_MOVED',
    matches: (d) => d.speed > TUTORIAL_MOVE_SPEED_THRESHOLD
  },
  {
    id: 'collect',
    icon: '📦',
    text: 'Zbierz przedmioty widoczne na mapie',
    event: 'STACK_ADDED',
    matches: () => true
  },
  {
    id: 'feed',
    icon: '⚙️',
    text: 'Zanieś je do pasującej maszyny (np. Recyklera) - nakarmi się sama, gdy staniesz obok',
    event: 'MACHINE_RECEIVED',
    matches: () => true
  },
  {
    id: 'process',
    icon: '⏳',
    text: 'Poczekaj, aż maszyna skończy przetwarzać surowiec na coś nowego',
    event: 'MACHINE_OUTPUT',
    matches: () => true
  },
  {
    id: 'sell',
    icon: '💹',
    text: 'Zanieś gotowy produkt do Terminalu Handlowego i sprzedaj za gotówkę',
    event: 'MONEY_COLLECTED',
    matches: (d) => d.amount > 0
  },
  {
    id: 'done',
    icon: '🎉',
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
      <button type="button" class="tutorial-window__close" aria-label="Pomiń samouczek">✕</button>
    `;
    header.querySelector('.tutorial-window__close').addEventListener('click', () => this._dismiss());
    this.stepEl = header.querySelector('.tutorial-window__step');

    this.bodyEl = document.createElement('div');
    this.bodyEl.className = 'tutorial-window__body';

    this.iconEl = document.createElement('span');
    this.iconEl.className = 'tutorial-window__icon';
    this.iconEl.setAttribute('aria-hidden', 'true');

    this.textEl = document.createElement('span');
    this.textEl.className = 'tutorial-window__text';

    this.bodyEl.appendChild(this.iconEl);
    this.bodyEl.appendChild(this.textEl);

    this.el.appendChild(header);
    this.el.appendChild(this.bodyEl);
    document.body.appendChild(this.el);
  }

  _goToStep(index) {
    this._unsubscribeCurrent();

    if (index >= TUTORIAL_STEPS.length) {
      this._complete();
      return;
    }

    const step = TUTORIAL_STEPS[index];
    this.economyManager.tutorialStep = index;
    if (this.iconEl) this.iconEl.textContent = step.icon;
    if (this.textEl) this.textEl.textContent = step.text;
    if (this.stepEl) this.stepEl.textContent = `${index + 1}/${TUTORIAL_STEPS.length}`;

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
        icon: '🎓',
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
  }

  destroy() {
    this._remove();
  }
}

window.TutorialManager = TutorialManager;
