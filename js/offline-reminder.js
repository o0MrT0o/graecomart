'use strict';

/**
 * offline-reminder.js
 * ------------------------------------------------------------------------
 * Powiadomienie push "wróć po odbiór" - gdy gracz wychodzi z gry (chowa
 * apkę w tło), planujemy lokalne powiadomienie za OFFLINE_REMINDER_DELAY_SECONDS,
 * z podglądem ile już zarobi (ta sama formuła co prawdziwy modal offline -
 * patrz EconomyManager.computeOfflineReward). Gdy gracz wróci SAM (bez
 * czekania na powiadomienie), planowane powiadomienie jest anulowane - bez
 * tego dostałby przypomnienie o grze, w którą już właśnie gra.
 *
 * document.visibilitychange (nie Capacitor App plugin) - Capacitor WebView
 * odpala to samo zdarzenie DOM przy chowaniu/przywracaniu apki co zwykła
 * przeglądarka (patrz identyczny wzorzec w audio.js, _scheduleNextNote),
 * więc nie trzeba osobnego pluginu tylko do wykrycia tła.
 *
 * Bezpieczny no-op w zwykłej przeglądarce (window.NativeNotifications nie
 * istnieje, patrz native-notifications-src.js) - reszta gry nie musi
 * wiedzieć, czy jesteśmy w prawdziwej apce Capacitor.
 */
const OFFLINE_REMINDER_DELAY_SECONDS = 3 * 3600; // 3h - kiedy powiadomienie faktycznie się pokaże
// BALANS: podgląd w treści powiadomienia liczony z KRÓTSZEGO okna niż
// faktyczne opóźnienie wyżej - inaczej (przy dobrym tempie zarobku) tekst
// obiecywałby setki/tysiące $ za nicnierobienie, co wygląda jak tania
// naganka i podważa sens grania aktywnie. 30 min to wciąż uczciwa,
// niepusta liczba (ta sama formuła co prawdziwy modal - patrz niżej), po
// prostu skromna - realna nagroda po 3h i tak będzie większa (miła
// niespodzianka), nigdy mniejsza (zero ryzyka rozczarowania).
const OFFLINE_REMINDER_PREVIEW_SECONDS = 30 * 60;

class OfflineReminderManager {
  constructor(economyManager) {
    this.economyManager = economyManager;

    this._onVisibilityChange = () => {
      if (document.hidden) this._scheduleReminder();
      else this._cancelReminder();
    };
  }

  init() {
    document.addEventListener('visibilitychange', this._onVisibilityChange);
  }

  /** Podgląd nagrody liczony TĄ SAMĄ metodą co prawdziwy modal offline
   * (economy.js), ale z krótszego okna (OFFLINE_REMINDER_PREVIEW_SECONDS) -
   * patrz komentarz przy tej stałej wyżej. */
  _scheduleReminder() {
    if (!window.NativeNotifications || !this.economyManager) return;
    const preview = typeof this.economyManager.computeOfflineReward === 'function'
      ? this.economyManager.computeOfflineReward(OFFLINE_REMINDER_PREVIEW_SECONDS * 1000)
      : null;
    const body = preview
      ? `Twój sklep już zarabia (+${preview.reward}$) - wróć po odbiór!`
      : 'Twój sklep czeka na Ciebie w Eco Mart!';
    window.NativeNotifications.scheduleOfflineReminder(OFFLINE_REMINDER_DELAY_SECONDS, 'Eco Mart', body);
  }

  _cancelReminder() {
    if (!window.NativeNotifications) return;
    window.NativeNotifications.cancelOfflineReminder();
  }

  destroy() {
    document.removeEventListener('visibilitychange', this._onVisibilityChange);
  }
}

window.OfflineReminderManager = OfflineReminderManager;
