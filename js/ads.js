'use strict';

/**
 * ads.js
 * ------------------------------------------------------------------------
 * Cienki wrapper na window.NativeAds (bundle z native-ads-src.js, patrz
 * README-ADS.md w korzeniu projektu) - jedyny most między czystym,
 * bezbudowlanym JS-em tej gry a pluginem @capacitor-community/admob, który
 * WYMAGA importów npm/bundlera (stąd osobny plik do zbudowania esbuildem,
 * zamiast <script> wprost).
 *
 * Na zwykłej stronie (Live Server, test w przeglądarce) window.NativeAds
 * NIE istnieje - showRewarded() od razu "udaje sukces" po krótkiej pauzie,
 * więc reszta gry (ui.js: OfflineRewardModal._watchAdStub) działa
 * IDENTYCZNIE w obu środowiskach. Żaden inny plik nie musi wiedzieć, czy
 * aktualnie jest w przeglądarce czy w prawdziwej apce Capacitor - to
 * rozgałęzienie siedzi wyłącznie tutaj, w jednym miejscu.
 *
 * PODMIEŃ PRZED PUBLIKACJĄ: ADMOB_REWARDED_UNIT_ID poniżej to OFICJALNY
 * testowy ID Google (zawsze serwuje testowe reklamy, nigdy prawdziwe) -
 * bezpieczny do developmentu, ale musisz go zamienić na własny z konsoli
 * AdMob przed wysłaniem apki do Play Store (patrz README-ADS.md, krok 5).
 */
const ADMOB_REWARDED_UNIT_ID = 'ca-app-pub-3940256099942544/5224354917'; // TESTOWY ID Google

class AdManager {
  constructor() {
    // true, gdy window.NativeAds istnieje (jesteśmy w prawdziwej apce
    // Capacitor z zbudowanym mostkiem) - używane tylko do logu/debugu,
    // showRewarded() i tak sam to sprawdza za każdym razem.
    this.nativeAvailable = !!(window.NativeAds && typeof window.NativeAds.showRewarded === 'function');
    if (this.nativeAvailable) {
      console.log('[AdManager] Natywne reklamy dostępne (Capacitor).');
    } else {
      console.log('[AdManager] Brak natywnych reklam (zwykła przeglądarka) - showRewarded() użyje fallbacku.');
    }
  }

  /**
   * Ładuje kreację reklamową Z WYPRZEDZENIEM - woła się z main.js zanim
   * gracz w ogóle zobaczy przycisk "obejrzyj reklamę" (np. tuż przed
   * pokazaniem modala offline), żeby do czasu kliknięcia reklama miała
   * szansę dociągnąć się w tle. Bez tego showRewarded() ładował na
   * poczekaniu DOPIERO po kliknięciu - stąd długie, widoczne oczekiwanie.
   * Bezpieczny no-op w zwykłej przeglądarce (nie ma czego preloadować).
   */
  preload() {
    if (window.NativeAds && typeof window.NativeAds.preloadRewarded === 'function') {
      window.NativeAds.preloadRewarded(ADMOB_REWARDED_UNIT_ID);
    }
  }

  /**
   * Pokazuje rewarded video i woła onResult(gotNagrode: boolean) po
   * zakończeniu. gotNagrode=false gdy gracz zamknął reklamę przed końcem
   * albo reklama nie załadowała się - wywołujący (ui.js) NIE powinien
   * przyznawać nagrody w tym wypadku.
   */
  showRewarded(onResult) {
    if (window.NativeAds && typeof window.NativeAds.showRewarded === 'function') {
      window.NativeAds.showRewarded(ADMOB_REWARDED_UNIT_ID, onResult);
      return;
    }
    // Fallback dla zwykłej przeglądarki - brak prawdziwych reklam poza
    // apką Capacitor, więc udajemy krótkie "obejrzenie" zakończone sukcesem,
    // żeby dało się przetestować całą resztę przepływu (podwojenie nagrody
    // itd.) bez budowania natywnej apki za każdym razem.
    setTimeout(() => onResult(true), 400);
  }
}

window.adManager = new AdManager();
