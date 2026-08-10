/**
 * native-cloudsave-src.js
 * ------------------------------------------------------------------------
 * Czwarty (po ads/notifications/haptics) i ostatni plik w tym projekcie
 * pisany jako ES module z importem npm - ten sam powód co tamte trzy
 * (patrz native-ads-src.js): capacitor-google-game-services wymaga importu
 * modułowego, więc bundlujemy go esbuildem (js/native-cloudsave.bundle.js)
 * zamiast wciągać bundler do reszty gry.
 *
 * Eksponuje window.NativeCloudSave - prosty obiekt z funkcjami, który
 * cloudsave.js (zwykły plik gry, bez importów) odpytuje bezpiecznie przez
 * `if (window.NativeCloudSave) {...}`, dokładnie jak window.NativeAds/
 * NativeNotifications/NativeHaptics.
 *
 * Tomek: "Cloud save / Google Play Games Services (logowanie, sync między
 * urządzeniami, leaderboard) - bez tego zgubiony telefon = zgubiony
 * postęp mimo eksportu". Ten plik daje logowanie + zapis/odczyt w chmurze
 * (Google Play Games "Zapisane gry" / Snapshots API) - leaderboard NIE jest
 * tu wpięty (ten plugin go nie ma, patrz README-CLOUDSAVE.md, sekcja
 * "Czego brakuje" po uzasadnienie), lokalna Tablica Wyników w grze zostaje
 * bez zmian.
 *
 * WAŻNE - żeby to faktycznie zadziałało na prawdziwym urządzeniu, Tomek
 * musi ręcznie skonfigurować Google Play Console (Play Games Services,
 * połączenie z aplikacją, certyfikat podpisywania) - PEŁNA instrukcja w
 * README-CLOUDSAVE.md. Bez tej konfiguracji signIn() po prostu nigdy się
 * nie powiedzie (bezpieczny fallback niżej), tak jak reklamy bez konta
 * AdMob (patrz README-ADS.md).
 *
 * Nazwa slotu zapisu (SAVE_SLOT_TITLE) jest STAŁA - to gra jednoosobowa z
 * JEDNYM zapisem (jak localStorage), nie potrzeba UI wyboru wielu zapisanych
 * gier (showSavedGamesUI() z pluginu świadomo nieużyte).
 */
import { GoogleGameServices } from 'capacitor-google-game-services';

const SAVE_SLOT_TITLE = 'ecomart_save';

let signInAttempted = false;

/**
 * Plugin sam próbuje zalogować się automatycznie przy starcie (patrz jego
 * dokumentacja) - to tylko JAWNE wywołanie na wypadek, gdyby automat zawiódł
 * (pierwsze uruchomienie, brak wcześniejszej zgody) albo gracz kliknął
 * "Zaloguj" ręcznie w Menu. Bezpieczne wołać wielokrotnie.
 */
async function signIn() {
  signInAttempted = true;
  try {
    const { isAuthenticated } = await GoogleGameServices.signIn();
    return !!isAuthenticated;
  } catch (err) {
    console.warn('[NativeCloudSave] Logowanie nie powiodło się:', err);
    return false;
  }
}

async function isSignedIn() {
  try {
    const { isAuthenticated } = await GoogleGameServices.isAuthenticated();
    return !!isAuthenticated;
  } catch (err) {
    // Częste na starcie, zanim automatyczne logowanie pluginu zdąży się
    // rozstrzygnąć - nie logujemy jako warn, żeby nie zaśmiecać konsoli przy
    // każdym zwykłym uruchomieniu bez wcześniejszego zalogowania.
    return false;
  }
}

async function getPlayerName() {
  try {
    const { player } = await GoogleGameServices.getCurrentPlayer();
    return (player && player.displayName) || null;
  } catch (err) {
    return null;
  }
}

/** @param {string} jsonString - pełny zapis gry (ten sam JSON co localStorage/eksport pliku) */
async function saveToCloud(jsonString) {
  try {
    await GoogleGameServices.saveGame({ title: SAVE_SLOT_TITLE, data: jsonString });
    return true;
  } catch (err) {
    console.warn('[NativeCloudSave] Zapis w chmurze nie powiódł się:', err);
    return false;
  }
}

/** @returns {string|null} JSON zapisu z chmury, albo null gdy brak/błąd. */
async function loadFromCloud() {
  try {
    const result = await GoogleGameServices.loadGame();
    return (result && typeof result.data === 'string' && result.data) ? result.data : null;
  } catch (err) {
    // Normalne przy PIERWSZYM logowaniu (jeszcze nic nie zapisane w chmurze)
    // - cloudsave.js i tak traktuje null jako "brak zapisu w chmurze", nie
    // jako błąd wymagający uwagi gracza.
    return null;
  }
}

window.NativeCloudSave = { signIn, isSignedIn, getPlayerName, saveToCloud, loadFromCloud };
