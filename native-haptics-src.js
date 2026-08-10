/**
 * native-haptics-src.js
 * ------------------------------------------------------------------------
 * Trzeci plik w tym projekcie pisany jako ES module z importem npm (obok
 * native-ads-src.js i native-notifications-src.js) - reszta gry to czysty
 * JS przez <script> (patrz eventbus.js i cała reszta). Ten plik NIE jest
 * ładowany bezpośrednio - buduje się go esbuildem (patrz "build-haptics" w
 * package.json) w js/native-haptics.bundle.js, który DOPIERO jest zwykłym
 * <script> w index.html.
 *
 * Powód: @capacitor/haptics (jak local-notifications/admob) wymaga importu
 * modułowego. Ten sam wzorzec izolacji - jeden mały mostek zamiast
 * wciągania bundlera do reszty gry.
 *
 * Eksponuje window.NativeHaptics - proste funkcje async, które haptics.js
 * (zwykły plik gry, bez importów) odpytuje bezpiecznie przez
 * `if (window.NativeHaptics) {...}`. Każda funkcja połyka własne błędy
 * (np. web bez wsparcia, urządzenie bez wibratora) - wibracja to czysty
 * "bonus" odczucia, nigdy nie powinna wywalić reszty gry.
 */
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';

async function impactLight() {
  try {
    await Haptics.impact({ style: ImpactStyle.Light });
  } catch (err) {
    // Brak wsparcia (przeglądarka, urządzenie bez wibratora) - cicho ignorujemy.
  }
}

async function impactMedium() {
  try {
    await Haptics.impact({ style: ImpactStyle.Medium });
  } catch (err) {
    // jw.
  }
}

async function impactHeavy() {
  try {
    await Haptics.impact({ style: ImpactStyle.Heavy });
  } catch (err) {
    // jw.
  }
}

async function notifySuccess() {
  try {
    await Haptics.notification({ type: NotificationType.Success });
  } catch (err) {
    // jw.
  }
}

window.NativeHaptics = { impactLight, impactMedium, impactHeavy, notifySuccess };
