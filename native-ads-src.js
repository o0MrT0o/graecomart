/**
 * native-ads-src.js
 * ------------------------------------------------------------------------
 * JEDYNY plik w tym projekcie pisany jako ES module z importem npm - reszta
 * gry to czysty JS przez <script> (patrz eventbus.js i cała reszta). Ten
 * plik NIE jest ładowany bezpośrednio - buduje się go esbuildem (patrz
 * README-ADS.md, krok 4) w js/native-ads.bundle.js, który DOPIERO jest
 * zwykłym <script> w index.html.
 *
 * Powód całego tego rozdzielenia: @capacitor-community/admob (jak
 * praktycznie każdy plugin npm dla nowoczesnego Capacitora) wymaga importu
 * modułowego - nie da się go wywołać jako gołego <script> tak jak resztę
 * tej gry. Zamiast wciągać bundler do WSZYSTKICH 15 plików gry, izolujemy
 * potrzebę bundlowania do tego jednego, małego mostka.
 *
 * Eksponuje window.NativeAds - prosty obiekt z callbackami, który ads.js
 * (zwykły plik gry, bez importów) odpytuje bezpiecznie przez
 * `if (window.NativeAds) {...}`.
 *
 * BUGFIX: dawniej prepareRewardVideoAd() (faktyczne pobranie kreacji z
 * serwerów Google - zajmuje kilka sekund) wołało się DOPIERO wewnątrz
 * showRewarded(), czyli dokładnie w momencie kliknięcia przez gracza -
 * stąd długie widoczne oczekiwanie zanim reklama się w ogóle pokazała.
 * Teraz jest osobna preloadRewarded(), wołana WCZEŚNIEJ (main.js, zanim
 * gracz w ogóle zobaczy przycisk) - showRewarded() korzysta z tego, co już
 * czeka gotowe, i tylko w AWARYJNYM wypadku (preload nie zdążył/nie było
 * go wcale) sam ładuje na poczekaniu jako fallback.
 */
import { AdMob, RewardAdPluginEvents } from '@capacitor-community/admob';

let initialized = false;
let pendingCallback = null;
let loadedAdUnitId = null; // ktory adUnitId jest AKTUALNIE zaladowany i gotowy do pokazania

/** Woła przekazany callback DOKŁADNIE RAZ i czyści go - zabezpieczenie
 * przed podwójnym wywołaniem, gdyby więcej niż jeden listener odpalił się
 * dla tego samego pokazania reklamy (np. FailedToShow i Dismissed razem). */
function resolveOnce(result) {
  if (!pendingCallback) return;
  const cb = pendingCallback;
  pendingCallback = null;
  cb(result);
}

async function init() {
  if (initialized) return;
  await AdMob.initialize({ initializeForTesting: false });

  AdMob.addListener(RewardAdPluginEvents.Rewarded, () => resolveOnce(true));
  AdMob.addListener(RewardAdPluginEvents.FailedToShow, () => resolveOnce(false));
  // Dismissed BEZ wcześniejszego Rewarded = gracz zamknął przed końcem,
  // brak nagrody. Jeśli Rewarded już rozstrzygnęło (resolveOnce zużyło
  // pendingCallback), to drugie wywołanie poniżej jest bezpiecznym no-opem.
  AdMob.addListener(RewardAdPluginEvents.Dismissed, () => resolveOnce(false));

  initialized = true;
}

/**
 * Ładuje kreację reklamową Z WYPRZEDZENIEM (np. zaraz po starcie gry, albo
 * tuż przed pokazaniem modala offline) - dzięki temu przez cały czas, gdy
 * gracz PATRZY na przycisk "x2", reklama ma czas dociągnąć się w tle, i
 * kliknięcie pokazuje ją niemal natychmiast zamiast czekać od zera.
 * Celowo połyka błędy (tylko loguje) - to zadanie w tle, nie coś, na co
 * wywołujący aktywnie czeka.
 */
async function preloadRewarded(adUnitId) {
  try {
    await init();
    await AdMob.prepareRewardVideoAd({ adId: adUnitId });
    loadedAdUnitId = adUnitId;
  } catch (err) {
    console.warn('[NativeAds] Preload rewarded nie powiódł się (spróbujemy ponownie przy showRewarded):', err);
    loadedAdUnitId = null;
  }
}

/**
 * @param {string} adUnitId - prawdziwy ID jednostki reklamowej (patrz ads.js)
 * @param {(gotReward: boolean) => void} onResult
 */
async function showRewarded(adUnitId, onResult) {
  pendingCallback = onResult;
  try {
    await init();
    if (loadedAdUnitId !== adUnitId) {
      // Preload nie zdążył (albo nie był wołany) - awaryjnie ładujemy TERAZ,
      // z widocznym opóźnieniem, ale przynajmniej działa zamiast się wywalić.
      await AdMob.prepareRewardVideoAd({ adId: adUnitId });
    }
    loadedAdUnitId = null; // zuzywamy zaladowany stan - kazda reklama jednorazowa
    await AdMob.showRewardVideoAd();
    // Od razu zaczynamy ładować NASTĘPNĄ w tle, na przyszłość (np. gdyby
    // gracz miał okazję obejrzeć kolejną tego samego dnia).
    preloadRewarded(adUnitId);
  } catch (err) {
    console.warn('[NativeAds] Reklama rewarded nie powiodła się:', err);
    loadedAdUnitId = null;
    resolveOnce(false);
  }
}

window.NativeAds = { init, preloadRewarded, showRewarded };
