'use strict';

/**
 * integrity.js
 * ------------------------------------------------------------------------
 * Play Integrity (Tomek: "bierz się za Play [Integrity]" -> "pełna
 * integracja") - potwierdza, że apka jest PRAWDZIWYM, niezmodyfikowanym
 * binarnym plikiem z Google Play (nie zmodyfikowanym/sideloadowanym APK-iem
 * z wyciętymi reklamami czy odblokowanymi upgrade'ami za darmo), zainstalowanym
 * przez licencjonowane konto. Ten sam wzorzec bezpiecznego no-opa co reszta
 * natywnych mostków w tym projekcie (ads/notifications/haptics/cloudsave):
 * jeśli window.NativeIntegrity nie istnieje (zwykła przeglądarka, plugin
 * nieskonfigurowany) albo backend jeszcze nie wdrożony (INTEGRITY_VERIFY_URL
 * puste - patrz README-INTEGRITY.md), gra działa DOKŁADNIE jak dotąd. Zero
 * wpływu na rozgrywkę w OBU kierunkach - to CELOWO tylko informacyjny sygnał
 * (wiersz w Menu), NIE blokuje zapisu/rozgrywki nawet przy złym werdykcie.
 * Powód: gra nie ma dziś żadnego wspólnego/serwerowego stanu do ochrony
 * (Tablica Wyników jest lokalna, patrz README-CLOUDSAVE.md "Czego świadomie
 * NIE zrobiłem") - jedyne realne zastosowanie integrity w TEJ grze to
 * wykrywanie podrobionych/zmodyfikowanych APK-ów krążących poza Play Store,
 * a fałszywie ujemny werdykt (błąd sieci, bug w backendzie) nie może
 * zablokować legalnego gracza jego WŁASNEJ, jednoosobowej rozgrywce.
 *
 * DLACZEGO token trzeba wysłać na WŁASNY backend, a nie zweryfikować w
 * przeglądarce: token z requestIntegrityToken() (native-integrity-src.js)
 * jest zaszyfrowany kluczem Google - odszyfrowanie/weryfikacja wymaga
 * Google Play Developer API + konta serwisowego z uprawnieniami do tej
 * konkretnej apki w Play Console. Te poświadczenia NIGDY nie mogą trafić do
 * klienta (byłyby widoczne w APK, każdy mógłby je wyciągnąć i fałszować
 * werdykty) - stąd Cloud Function w README-INTEGRITY.md, pierwszy własny
 * serwer w całym tym projekcie.
 *
 * Moment sprawdzenia: RAZ przy starcie gry (main.js, po saveManager.load(),
 * ten sam moment co cloudSaveManager.checkAutoSignIn()) - integrity apki się
 * nie zmienia w trakcie sesji, więc sprawdzanie częściej niż raz na
 * uruchomienie nie dałoby żadnej dodatkowej informacji, tylko zbędny ruch
 * sieciowy i zużycie dziennego limitu wywołań Play Integrity API (Google
 * limituje liczbę requestIntegrityToken() na urządzenie/dzień).
 */
const INTEGRITY_VERIFY_URL = ''; // Tomek: wklej tu URL Cloud Function PO wdrożeniu - patrz README-INTEGRITY.md, Krok 4. Puste = funkcja poniżej jest cichym no-opem.

class IntegrityManager {
  constructor() {
    this.status = 'idle'; // 'idle' | 'checking' | 'verified' | 'warning' | 'unavailable' | 'error'
    this.verdictLabel = null;
    this.checkedAt = null;
    this._checking = false;
  }

  /** false w zwykłej przeglądarce/bez zbudowanego pluginu ALBO gdy Tomek
   * jeszcze nie wdrożył/wkleił URL backendu - patrz komentarz u góry pliku. */
  available() {
    return !!(window.NativeIntegrity && INTEGRITY_VERIFY_URL);
  }

  _publishState() {
    Bus.publish(Events.INTEGRITY_STATE_CHANGED, {
      status: this.status,
      verdictLabel: this.verdictLabel,
      checkedAt: this.checkedAt
    });
  }

  /** Losowy, jednorazowy string (32 bajty, base64url) - wraca w zdekodowanym
   * werdykcie z Google (requestDetails.nonce), więc backend może potwierdzić,
   * że token faktycznie odpowiada TEJ konkretnej prośbie z TEGO uruchomienia,
   * a nie jest starym tokenem odtworzonym/przechwyconym później. */
  _makeNonce() {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    let binary = '';
    bytes.forEach((b) => { binary += String.fromCharCode(b); });
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  /**
   * Wołane RAZ przy starcie gry (main.js) - patrz "Moment sprawdzenia" u
   * góry pliku. this._checking chroni przed nakładającymi się wywołaniami,
   * gdyby ktoś kiedyś zawołał to więcej niż raz na sesję.
   */
  async checkNow() {
    if (this._checking) return;
    if (!window.NativeIntegrity) {
      this.status = 'unavailable';
      this._publishState();
      return;
    }
    if (!INTEGRITY_VERIFY_URL) {
      // Plugin jest (prawdziwy build), ale backend jeszcze nie wdrożony -
      // patrz README-INTEGRITY.md. Cichy no-op, ten sam wzorzec co
      // cloudsave.js bez konfiguracji Play Console.
      this.status = 'unavailable';
      this._publishState();
      return;
    }

    this._checking = true;
    this.status = 'checking';
    this._publishState();

    try {
      const nonce = this._makeNonce();
      const token = await window.NativeIntegrity.requestIntegrityToken(nonce);
      if (!token) {
        this.status = 'error';
        this._publishState();
        return;
      }

      const resp = await fetch(INTEGRITY_VERIFY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, nonce })
      });
      if (!resp.ok) {
        this.status = 'error';
        this._publishState();
        return;
      }

      const data = await resp.json();
      this.status = data && data.ok ? 'verified' : 'warning';
      this.verdictLabel = (data && data.verdict) || null;
      this.checkedAt = Date.now();
      this._publishState();
    } catch (err) {
      // Błąd sieci/backendu - CELOWO cichy poza statusem (patrz komentarz u
      // góry pliku o zero-wpływie na rozgrywkę). Gracz zobaczy tylko "błąd"
      // w wierszu Menu, jeśli w ogóle tam zajrzy.
      this.status = 'error';
      this._publishState();
    } finally {
      this._checking = false;
    }
  }
}

window.IntegrityManager = IntegrityManager;
