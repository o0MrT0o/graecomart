'use strict';

/**
 * functions/verify-integrity/index.js
 * ------------------------------------------------------------------------
 * PIERWSZY własny serwer w całym tym projekcie (Tomek: "Play Integrity ->
 * pełna integracja"). Google Cloud Function (2. generacji, HTTP trigger) -
 * odbiera token z requestIntegrityToken() (native-integrity-src.js, przez
 * integrity.js w grze), odszyfrowuje go przez Google Play Developer API
 * (Play Integrity decode) i zwraca klientowi TYLKO uproszczony werdykt
 * (`{ ok, verdict }`) - nigdy surowego payloadu z Google.
 *
 * DLACZEGO to musi być osobny serwer, a nie kod w samej apce: token jest
 * zaszyfrowany kluczem Google - jego odszyfrowanie wymaga wywołania
 * playintegrity.googleapis.com z poświadczeniami konta serwisowego
 * uprawnionego w Play Console do TEJ konkretnej apki. Te poświadczenia
 * NIGDY nie mogą trafić do klienta (byłyby widoczne w każdym pobranym APK-u,
 * każdy mógłby je wyciągnąć i fałszować werdykty) - muszą zostać na
 * serwerze, którego kod (ten plik) klient nigdy nie widzi.
 *
 * AUTORYZACJA DO GOOGLE - BEZ ŻADNEGO KLUCZA W REPO: `google.auth.GoogleAuth`
 * poniżej wywołany BEZ podania keyFile/credentials - na Cloud Functions to
 * automatycznie użyje WBUDOWANEGO konta serwisowego środowiska uruchomieniowego
 * (Application Default Credentials), które Google Cloud tworzy samo przy
 * wdrożeniu. Zero pliku JSON z sekretem do pilnowania/rotacji - jedyne co
 * Tomek musi zrobić to zaprosić TO konto serwisowe (adres e-mail widoczny w
 * konsoli GCP) jako użytkownika w Play Console z dostępem do tej apki - patrz
 * README-INTEGRITY.md, Krok 3.
 *
 * CORS: `Access-Control-Allow-Origin: *` CELOWO otwarte - Capacitor WebView
 * na Androidzie robi fetch() z originu `https://localhost` (patrz
 * capacitor.config.json, androidScheme), a ta funkcja i tak nie zwraca
 * niczego wrażliwego (żadnych danych osobowych, żadnego sekretu) - najgorszy
 * scenariusz nadużycia to ktoś zużywający limit wywołań, nie wyciek danych.
 * Nonce+podpisany token nadal chronią przed sfałszowaniem samego werdyktu.
 */
const { google } = require('googleapis');

// Musi zgadzać się z appId w capacitor.config.json - inaczej decodeIntegrityToken
// odrzuci token jako wystawiony dla innej aplikacji.
const PACKAGE_NAME = 'com.ecomart.game';

// Token starszy niż to (od momentu żądania na urządzeniu, requestDetails.timestampMillis)
// jest odrzucany - ogranicza okno, w którym przechwycony/powtórzony token
// mógłby zostać wysłany ponownie (bez pełnej ochrony przed replay, którą dałby
// dopiero serwerowo generowany + zapamiętywany nonce, patrz README-INTEGRITY.md
// "Znane ograniczenie" - świadomy kompromis dla gry bez istniejącego backendu/sesji).
const MAX_TOKEN_AGE_MS = 5 * 60 * 1000;

let cachedClient = null;
async function getPlayIntegrityClient() {
  if (cachedClient) return cachedClient;
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/playintegrity']
  });
  const authClient = await auth.getClient();
  cachedClient = google.playintegrity({ version: 'v1', auth: authClient });
  return cachedClient;
}

/**
 * Werdykt "ok" TYLKO gdy WSZYSTKIE trzy sygnały są dobre naraz - apka
 * rozpoznana przez Play, urządzenie spełnia integralność, konto ma
 * licencję. Pierwszy zawodzący sygnał staje się czytelną etykietą (klient
 * pokazuje ją w Menu, patrz ui.js/_buildIntegrityRow), reszta payloadu
 * (dokładne certyfikaty, activityLevel itd.) świadomie NIE trafia do klienta.
 */
function summarizeVerdict(payload) {
  const appVerdict = payload.appIntegrity && payload.appIntegrity.appRecognitionVerdict;
  const deviceVerdicts = (payload.deviceIntegrity && payload.deviceIntegrity.deviceRecognitionVerdict) || [];
  const licenseVerdict = payload.accountDetails && payload.accountDetails.appLicensingVerdict;

  if (appVerdict !== 'PLAY_RECOGNIZED') {
    return { ok: false, verdict: `app:${appVerdict || 'UNKNOWN'}` };
  }
  if (!deviceVerdicts.includes('MEETS_DEVICE_INTEGRITY')) {
    return { ok: false, verdict: `device:${deviceVerdicts.join(',') || 'NONE'}` };
  }
  if (licenseVerdict !== 'LICENSED') {
    return { ok: false, verdict: `license:${licenseVerdict || 'UNKNOWN'}` };
  }
  return { ok: true, verdict: 'OK' };
}

// Eksportowane osobno TYLKO pod lekki test jednostkowy bez sieci (patrz
// scratchpad/test_summarize_verdict.js z tej sesji) - `gcloud functions
// deploy --entry-point=verifyIntegrity` i tak używa wyłącznie eksportu
// verifyIntegrity poniżej, ten drugi eksport mu nie przeszkadza.
exports.summarizeVerdict = summarizeVerdict;

/**
 * Punkt wejścia Cloud Function (Functions Framework - podpis (req,res) jak
 * zwykły handler HTTP). Wdrażane jako `verifyIntegrity`, patrz
 * README-INTEGRITY.md Krok 4 po dokładną komendę `gcloud functions deploy`.
 */
exports.verifyIntegrity = async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') {
    res.set('Access-Control-Allow-Methods', 'POST');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.status(204).send('');
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, verdict: 'method_not_allowed' });
    return;
  }

  const { token, nonce } = req.body || {};
  if (typeof token !== 'string' || !token || typeof nonce !== 'string' || !nonce) {
    res.status(400).json({ ok: false, verdict: 'bad_request' });
    return;
  }

  try {
    const client = await getPlayIntegrityClient();
    const result = await client.v1.decodeIntegrityToken({
      packageName: PACKAGE_NAME,
      requestBody: { integrityToken: token }
    });

    const payload = result.data && result.data.tokenPayloadExternal;
    if (!payload) {
      res.status(502).json({ ok: false, verdict: 'no_payload' });
      return;
    }

    const details = payload.requestDetails || {};
    if (details.nonce !== nonce) {
      // Token nie odpowiada TEJ konkretnej prośbie - potencjalnie stary,
      // przechwycony token wysłany ponownie. Odrzucamy, zero dwuznaczności.
      res.status(200).json({ ok: false, verdict: 'nonce_mismatch' });
      return;
    }
    if (details.requestPackageName !== PACKAGE_NAME) {
      res.status(200).json({ ok: false, verdict: 'wrong_package' });
      return;
    }
    const tokenAgeMs = Date.now() - Number(details.timestampMillis || 0);
    if (!Number.isFinite(tokenAgeMs) || tokenAgeMs < 0 || tokenAgeMs > MAX_TOKEN_AGE_MS) {
      res.status(200).json({ ok: false, verdict: 'stale_token' });
      return;
    }

    const summary = summarizeVerdict(payload);
    res.status(200).json(summary);
  } catch (err) {
    // Nigdy nie odsyłamy err.message/stack do klienta (mogłoby ujawnić
    // szczegóły konfiguracji backendu) - tylko cichy status błędu, ten sam
    // 'error', który integrity.js już obsługuje jako zwykły fail-open.
    console.error('[verifyIntegrity] Błąd weryfikacji:', err);
    res.status(500).json({ ok: false, verdict: 'server_error' });
  }
};
