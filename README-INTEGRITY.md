# Eco Mart — Play Integrity API (Capacitor + Cloud Function)

> 🔴 = musisz zrobić Ty, w Google Cloud Console/Google Play Console/terminalu z `gcloud` na swoim komputerze — nie mam tu ani konta Google Cloud, ani konta Google Play Console, ani sposobu wdrożenia czegokolwiek na Twoją infrastrukturę.
> 🤖 = już zrobione, siedzi w plikach które dostałeś.
> ✅ = sprawdź, zanim pójdziesz dalej.

Wszystko poniżej sprawdziłem naprawdę: rozpakowałem `@capacitor-community/play-integrity@7.1.0` z npm i przeczytałem jego kod źródłowy (deklaruje `@capacitor/core >=7.0.0`, więc pasuje do tego projektu bez żadnych sztuczek z `.npmrc`, w przeciwieństwie do pluginu cloud save), **faktycznie zbudowałem** `native-integrity-src.js` esbuildem (21.7kb, zero błędów), sprawdziłem prawdziwe typy odpowiedzi Google Play Developer API (`googleapis` z npm, pakiet `playintegrity/v1`) i **napisałem jednostkowe testy** logiki werdyktu w `functions/verify-integrity/index.js` (4 przypadki, wszystkie przechodzą - patrz historia sesji). To nie jest kod pisany z pamięci.

**Jedna szczera uwaga na start, ważniejsza niż przy cloud save:** to jest PIERWSZY własny serwer w całym tym projekcie. Wszystko inne (AdMob, Play Games Services, powiadomienia) to gotowe usługi Google, do których gra łączy się bezpośrednio - tu musisz sam wdrożyć i utrzymywać (darmowy tier, ale trzeba założyć/pilnować) Google Cloud Function. Nie mam tu konta Google Cloud ani możliwości czegokolwiek wdrożyć za Ciebie - to, co mogłem, to napisać kod tej funkcji i dokładnie opisać, co zrobić krok po kroku.

---

## 🤖 Co już jest zrobione

| Plik | Co robi |
|---|---|
| `js/integrity.js` | `IntegrityManager` — generuje nonce, prosi o token, wysyła go do TWOJEGO backendu, trzyma werdykt |
| `native-integrity-src.js` | Piąty (obok ads/notifications/haptics/cloudsave) plik z importem npm — **wymaga zbudowania**, patrz Krok 5 |
| `functions/verify-integrity/index.js` | Cloud Function — odszyfrowuje token przez Play Developer API, zwraca klientowi TYLKO `{ ok, verdict }` |
| `js/i18n.js` | Cały tekst wiersza "Integralność" w Menu po polsku i angielsku |
| `js/ui.js` | Wiersz "Integralność" w Menu → Dane: pokazuje stan (niedostępne/sprawdzanie/zweryfikowano/ostrzeżenie/błąd) |
| `package.json` | Zależność + skrypt `build-integrity` |
| `.github/workflows/android-apk.yml` | Dopisany krok budowania bundla w CI |

**Sprawdzenie dzieje się RAZ przy starcie gry** (main.js, ten sam moment co `cloudSaveManager.checkAutoSignIn()`) — integralność apki nie zmienia się w trakcie sesji, więc częstsze sprawdzanie nie dałoby nic poza zbędnym ruchem sieciowym (Google i tak limituje wywołania na urządzenie/dzień).

**Zero wpływu na rozgrywkę, w obie strony — to CELOWA decyzja projektowa, nie niedopatrzenie.** Zły/brakujący werdykt NIE blokuje zapisu, gry ani żadnej funkcji — tylko wiersz w Menu pokazuje status. Powód: ta gra dziś nie ma ŻADNEGO wspólnego/serwerowego stanu do ochrony (Tablica Wyników jest czysto lokalna, patrz README-CLOUDSAVE.md "Czego świadomie NIE zrobiłem") — jedyne realne zastosowanie Play Integrity w TEJ grze to wykrywanie podrobionych/zmodyfikowanych APK-ów krążących poza Play Store (np. z wyciętymi reklamami), nie anti-cheat jakiegoś współdzielonego rankingu. Fałszywie zły werdykt (bug w Twoim backendzie, awaria sieci) nie może więc zablokować legalnego gracza jego WŁASNEJ, jednoosobowej rozgrywce.

---

## 🔴 Krok 1 — Sprawdź/podłącz projekt Google Cloud w Play Console

1. Wejdź na https://play.google.com/console → wybierz Eco Mart
2. W menu bocznym: **Setup → App integrity** (albo szukaj "App integrity")
3. Sekcja **Play Integrity API** powinna pokazywać POWIĄZANY projekt Google Cloud — jeśli konfigurowałeś już Play Games Services (README-CLOUDSAVE.md, Krok 1), to **prawdopodobnie ten sam projekt** (Play Console łączy jeden projekt Cloud z całą apką, nie osobno per funkcja)
4. Zanotuj **numer projektu** (Project number, nie Project ID) — przyda się tylko, jeśli kiedyś zechcesz podać go jawnie zamiast `googleCloudProjectNumber: 0` w `native-integrity-src.js` (domyślne `0` = "użyj powiązanego projektu", więc zwykle nie trzeba nic zmieniać)

✅ **SPRAWDŹ:** sekcja App integrity pokazuje status "Podłączono"/"Linked" z nazwą Twojego projektu Cloud.

## 🔴 Krok 2 — Włącz Play Integrity API w Google Cloud Console

1. Wejdź na https://console.cloud.google.com/ → wybierz TEN SAM projekt co w Kroku 1
2. **APIs & Services → Library** → wyszukaj "Play Integrity API"
3. Kliknij **Enable**

✅ **SPRAWDŹ:** API pokazuje się jako włączone w **APIs & Services → Enabled APIs**.

## 🔴 Krok 3 — Wdróż Cloud Function

Potrzebujesz zainstalowanego [`gcloud` CLI](https://cloud.google.com/sdk/docs/install) i zalogowania (`gcloud auth login`) na to samo konto co Krok 1/2.

```bash
cd functions/verify-integrity
gcloud config set project TWOJ_PROJECT_ID   # Project ID z Kroku 1, nie numer
gcloud functions deploy verifyIntegrity \
  --gen2 \
  --runtime=nodejs20 \
  --region=europe-central2 \
  --source=. \
  --entry-point=verifyIntegrity \
  --trigger-http \
  --allow-unauthenticated
```

(`--region` możesz zmienić na dowolny bliższy Twoim graczom — `europe-central2` = Warszawa. `--allow-unauthenticated` jest bezpieczne mimo nazwy: funkcja i tak nigdy nie zwraca niczego wrażliwego, patrz komentarz "CORS" w `index.js`.)

Po zakończeniu komenda wypisze **URL funkcji** (coś jak `https://europe-central2-TWOJ_PROJECT_ID.cloudfunctions.net/verifyIntegrity`) — zapisz go, potrzebny w Kroku 4.

**Zero sekretów do zarządzania:** funkcja NIE używa żadnego pliku klucza JSON — autoryzuje się do Google przez własne, wbudowane konto serwisowe środowiska uruchomieniowego Cloud Functions (Application Default Credentials, patrz komentarz w `index.js`). To konto trzeba tylko UPOWAŻNIĆ w Play Console (następny krok), nic więcej.

✅ **SPRAWDŹ:** `gcloud functions describe verifyIntegrity --gen2 --region=europe-central2` pokazuje `state: ACTIVE`.

## 🔴 Krok 4 — Upoważnij konto serwisowe funkcji w Play Console

1. Znajdź adres e-mail konta serwisowego: `gcloud functions describe verifyIntegrity --gen2 --region=europe-central2 --format="value(serviceConfig.serviceAccountEmail)"` (domyślnie coś jak `TWOJ_PROJECT_NUMBER-compute@developer.gserviceaccount.com`)
2. Play Console → **Users and permissions** → **Invite new users**
3. Wklej ten adres e-mail
4. Przyznaj dostęp do Eco Mart z uprawnieniem **View app information (read-only)** — to wystarcza do odczytu werdyktów Play Integrity, żadnych szerszych uprawnień nie potrzeba

✅ **SPRAWDŹ:** konto serwisowe widnieje na liście użytkowników Play Console z dostępem do Eco Mart.

## 🔴 Krok 5 — Wklej URL funkcji, zainstaluj zależności, zbuduj mostek

1. Otwórz `js/integrity.js`, znajdź linię `const INTEGRITY_VERIFY_URL = '';` (na samej górze pliku) i wklej między cudzysłowy URL z Kroku 3

```bash
npm install
npm run sync
```

(`npm run sync` = zbudowanie wszystkich pięciu mostków native-*, kopia do `www/`, `npx cap sync` — to samo co przy AdMob/powiadomieniach/haptyce/cloud save, patrz README-ADS.md.)

✅ **SPRAWDŹ:** powinien istnieć `js/native-integrity.bundle.js` (kilkanaście-kilkadziesiąt KB).

## 🔴 Krok 6 — Zbuduj podpisaną apkę i przetestuj na prawdziwym urządzeniu

Play Integrity **nie działa** w zwykłym debug-buildzie ani w przeglądarce — wymaga prawdziwych Usług Google Play i (dla pełnej wiarygodności werdyktu) apki faktycznie zainstalowanej z Google Play, nie przez USB z Android Studio. Do wstępnego testu wystarczy jednak debug build zainstalowany na realnym telefonie z Usługami Google Play — werdykt `appIntegrity` może wtedy wyjść inny niż "PLAY_RECOGNIZED" (apka nie z Play Store), ale cała ścieżka (token → Cloud Function → odpowiedź) powinna zadziałać.

W Menu gry → sekcja **Dane** → wiersz **Integralność**.

✅ **SPRAWDŹ:** wiersz powinien po chwili pokazać "Apka zweryfikowana ✓" (build z Play Store) albo "Uwaga: app:..." (debug build spoza Play Store — to oczekiwane, nie błąd) zamiast utykać na "Sprawdzanie…".

---

## Znane ograniczenie (świadomy kompromis)

Backend odrzuca token, gdy jego `nonce` się nie zgadza z tym, co wysłał klient, ORAZ gdy token jest starszy niż 5 minut (`MAX_TOKEN_AGE_MS` w `functions/verify-integrity/index.js`) — to ogranicza okno na powtórne wysłanie przechwyconego tokena, ale to NIE jest pełna ochrona przed replay, jaką dałby dopiero nonce generowany i zapamiętywany PO STRONIE SERWERA (z jednorazowym zużyciem). Pełna wersja wymagałaby jakiejś bazy danych/sesji na backendzie - nadmiarowe jak na grę, która i tak niczego tym dziś nie chroni (patrz "Zero wpływu na rozgrywkę" wyżej). Jeśli kiedyś dojdzie prawdziwy, serwerowy leaderboard albo IAP, to pierwsza rzecz do dopisania.

## Czego świadomie NIE zrobiłem w tej turze

- **Żadnego egzekwowania/blokowania na podstawie werdyktu** — patrz "Zero wpływu na rozgrywkę" wyżej. To infrastruktura gotowa pod przyszłe użycie (leaderboard, IAP), nie aktywna ochrona dziś.
- **Testu End-to-End z prawdziwym wywołaniem Google Play Developer API** — nie mam tu konta Google Cloud/Play Console, więc nie mogłem wdrożyć funkcji i faktycznie zapytać Google. Przetestowałem: (1) budowanie mostka esbuildem, (2) całą logikę werdyktu (`summarizeVerdict`) na 4 przypadkach testowych, (3) walidację żądań HTTP (złe metody, brakujące pola, CORS preflight) na zamockowanym req/res, (4) bezpieczny fallback w przeglądarce (bez pluginu/bez wklejonego URL — wiersz Menu poprawnie pokazuje "niedostępne", zero błędów w konsoli). Prawdziwe "czy Google faktycznie zwraca dobry werdykt" możesz sprawdzić tylko Ty, po Kroku 6.
- **iOS** — jak w README-ADS.md/README-CLOUDSAVE.md, cały ten setup dotyczy tylko Androida/Google Play.
