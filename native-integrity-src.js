/**
 * native-integrity-src.js
 * ------------------------------------------------------------------------
 * Piąty (po ads/notifications/haptics/cloudsave) i najnowszy plik w tym
 * projekcie pisany jako ES module z importem npm - ten sam powód co tamte
 * cztery (patrz native-cloudsave-src.js): @capacitor-community/play-integrity
 * wymaga importu modułowego, więc bundlujemy go esbuildem
 * (js/native-integrity.bundle.js) zamiast wciągać bundler do reszty gry.
 *
 * Eksponuje window.NativeIntegrity - prosty obiekt z JEDNĄ funkcją, który
 * integrity.js (zwykły plik gry, bez importów) odpytuje bezpiecznie przez
 * `if (window.NativeIntegrity) {...}`, dokładnie jak window.NativeAds/
 * NativeNotifications/NativeHaptics/NativeCloudSave.
 *
 * Play Integrity API (Tomek: "pełna integracja") potwierdza, że apka jest
 * PRAWDZIWYM, niezmodyfikowanym binarnym plikiem z Google Play, zainstalowanym
 * przez licencjonowane konto - token zwrócony tutaj NIE JEST wiarygodny sam w
 * sobie (to zaszyfrowany blob) i MUSI być zweryfikowany na backendzie
 * (Google Play Developer API, service account) - to robi Cloud Function
 * opisana w README-INTEGRITY.md, NIE ten plik. Tu tylko żądamy tokena.
 *
 * WAŻNE - żeby to faktycznie zadziałało na prawdziwym urządzeniu, Tomek musi
 * ręcznie: (1) włączyć Play Integrity API w Google Cloud Console, (2)
 * wdrożyć Cloud Function do weryfikacji tokena i wkleić jej URL w
 * js/integrity.js - PEŁNA instrukcja w README-INTEGRITY.md. Bez tego
 * checkNow() w integrity.js po prostu nigdy nie wystartuje (bezpieczny
 * fallback tam), tak jak cloud save bez konfiguracji Play Console.
 */
import { PlayIntegrity } from '@capacitor-community/play-integrity';

/**
 * @param {string} nonce - losowy, jednorazowy string (base64url, patrz
 *   integrity.js/_makeNonce) - wraca w zdekodowanym werdykcie z Google, więc
 *   backend może sprawdzić, że token faktycznie odpowiada TEJ konkretnej
 *   prośbie, a nie jest starym, przechwyconym tokenem odtworzonym później.
 * @returns {Promise<string|null>} zaszyfrowany token do przekazania
 *   backendowi, albo null przy błędzie (API niedostępne, stary Play Store,
 *   brak Usług Google Play - patrz README pluginu, sekcja "Errors").
 */
async function requestIntegrityToken(nonce) {
  try {
    const { token } = await PlayIntegrity.requestIntegrityToken({
      nonce,
      // 0 = domyślny numer projektu Google Cloud POWIĄZANEGO z tą apką w
      // Play Console (patrz README-INTEGRITY.md, Krok 1) - nie trzeba go tu
      // wpisywać ręcznie, dopóki apka i projekt są połączone w konsoli.
      googleCloudProjectNumber: 0
    });
    return token || null;
  } catch (err) {
    console.warn('[NativeIntegrity] requestIntegrityToken nie powiódł się:', err);
    return null;
  }
}

window.NativeIntegrity = { requestIntegrityToken };
