/**
 * native-notifications-src.js
 * ------------------------------------------------------------------------
 * Drugi (obok native-ads-src.js) plik w tym projekcie pisany jako ES module
 * z importem npm - reszta gry to czysty JS przez <script> (patrz
 * eventbus.js i cała reszta). Ten plik NIE jest ładowany bezpośrednio -
 * buduje się go esbuildem (patrz "build-notifications" w package.json) w
 * js/native-notifications.bundle.js, który DOPIERO jest zwykłym <script>
 * w index.html.
 *
 * Powód: @capacitor/local-notifications (jak @capacitor-community/admob w
 * native-ads-src.js) wymaga importu modułowego. Ten sam wzorzec izolacji -
 * jeden mały mostek zamiast wciągania bundlera do reszty gry.
 *
 * Eksponuje window.NativeNotifications - proste funkcje async, które
 * offline-reminder.js (zwykły plik gry, bez importów) odpytuje bezpiecznie
 * przez `if (window.NativeNotifications) {...}`.
 */
import { LocalNotifications } from '@capacitor/local-notifications';

// Stałe ID - jedno zaplanowane powiadomienie na raz (schedule() z tym samym
// ID nadpisuje poprzednie zamiast dokładać kolejne), więc wielokrotne
// wejście/wyjście z apki nie zasypuje gracza stosem powiadomień.
const OFFLINE_REMINDER_ID = 1001;

/** Android 13+ (API 33) wymaga zgody w runtime na powiadomienia - reszta
 * platform (starszy Android, iOS z wcześniej udzieloną zgodą) zwraca
 * 'granted' od razu bez pytania. Celowo połyka błędy (np. web bez wsparcia)
 * i traktuje je jako "brak zgody" zamiast wywalać resztę gry. */
async function ensurePermission() {
  try {
    const current = await LocalNotifications.checkPermissions();
    if (current.display === 'granted') return true;
    const requested = await LocalNotifications.requestPermissions();
    return requested.display === 'granted';
  } catch (err) {
    console.warn('[NativeNotifications] Sprawdzenie/prośba o uprawnienia nie powiodła się:', err);
    return false;
  }
}

/**
 * Planuje (albo nadpisuje istniejące) powiadomienie o przypomnienie offline.
 * @param {number} delaySeconds - za ile sekund od teraz ma się pokazać.
 * @param {string} title
 * @param {string} body
 */
async function scheduleOfflineReminder(delaySeconds, title, body) {
  try {
    const granted = await ensurePermission();
    if (!granted) return;
    await LocalNotifications.schedule({
      notifications: [{
        id: OFFLINE_REMINDER_ID,
        title,
        body,
        schedule: { at: new Date(Date.now() + delaySeconds * 1000) }
      }]
    });
  } catch (err) {
    console.warn('[NativeNotifications] Zaplanowanie powiadomienia nie powiodło się:', err);
  }
}

/** Wołane, gdy gracz wraca do gry SAM - przypomnienie stałoby się bez sensu
 * (widzi ekran, i tak zbierze nagrodę offline z modala). Cichy no-op, gdy
 * nic nie było zaplanowane. */
async function cancelOfflineReminder() {
  try {
    await LocalNotifications.cancel({ notifications: [{ id: OFFLINE_REMINDER_ID }] });
  } catch (err) {
    // Brak zaplanowanego powiadomienia (albo brak uprawnień) - nic do
    // anulowania, to nie jest błąd wart logowania.
  }
}

window.NativeNotifications = { scheduleOfflineReminder, cancelOfflineReminder };
