# Eco Mart — Pakowanie pod Google Play (Capacitor + AdMob)

> 🔴 = musisz zrobić Ty, w terminalu/Android Studio na swoim komputerze — nie mam tu środowiska Android/Node do uruchomienia tego za Ciebie.
> 🤖 = już zrobione, siedzi w plikach które dostałeś.
> ✅ = sprawdź, zanim pójdziesz dalej.

Wszystko poniżej sprawdziłem naprawdę: zainstalowałem `@capacitor-community/admob` w wersji **7.2.0** (aktualna), zweryfikowałem nazwy metod względem jej rzeczywistych plików `.d.ts`, i **faktycznie zbudowałem** `native-ads-src.js` esbuildem — 30.4kb, zero błędów. To nie jest kod pisany z pamięci.

---

## 🤖 Co już jest zrobione

| Plik | Co robi |
|---|---|
| `js/ads.js` | Wrapper na reklamy — reszta gry (ui.js) woła tylko `window.adManager.showRewarded(callback)`, nie musi wiedzieć czy jest w Capacitorze czy w przeglądarce |
| `native-ads-src.js` | Jedyny plik z importem npm (`@capacitor-community/admob`) — **wymaga zbudowania**, patrz Krok 4 |
| `capacitor.config.json` | Konfiguracja Capacitor (appId **do podmiany**, patrz Krok 3) |
| `package.json` | Zależności + skrypty budowania |
| `scripts/copy-www.js` | Kopiuje `index.html`/`style.css`/`js/`/`assets/` do `www/` (przetestowane, działa) |
| `index.html` | Dopisane `<script>` dla bundla reklam |
| `ui.js` | Przycisk "obejrzyj reklamę x2" w modalu offline już woła prawdziwy `adManager` (nie stub) |

**Dlaczego w ogóle bundlowanie**, skoro reszta gry to zwykłe `<script>` bez importów: nowoczesny Capacitor wymaga modułów ES dla pluginów firm trzecich — stare obejście (`bundledWebRuntime`) bundlowało tylko sam rdzeń Capacitora, nie pluginy takie jak AdMob. Zamiast wciągać bundler do wszystkich 16 plików gry, izolujemy potrzebę bundlowania do jednego małego mostka (`native-ads-src.js` → `js/native-ads.bundle.js`). Ten JEDEN plik wynikowy jest zwykłym `<script>` jak cała reszta.

---

## 🔴 Krok 1 — Zainstaluj narzędzia (jednorazowo)

- **Node.js** — https://nodejs.org (jeśli jeszcze nie masz)
- **Android Studio** — https://developer.android.com/studio
- W Android Studio przy pierwszym uruchomieniu: **SDK Manager** → zainstaluj najnowszy Android SDK + Android SDK Build-Tools (kreator instalacji zwykle proponuje to sam)

## 🔴 Krok 2 — Zainstaluj zależności

W terminalu, w folderze `EcoMartGame`:

```bash
npm install
```

## 🔴 Krok 3 — Ustaw appId i zainicjalizuj Android

Otwórz `capacitor.config.json` i zamień `"appId": "com.ecomart.game"` na coś swojego — konwencja to odwrócona domena, np. `com.tom88.ecomart`. To ID musi zostać **na stałe** (Google Play wiąże publikację z tym identyfikatorem — zmiana po publikacji = nowa, osobna aplikacja).

```bash
npx cap add android
```

✅ **SPRAWDŹ:** powinien pojawić się nowy folder `android/` w projekcie.

## 🔴 Krok 4 — Zbuduj mostek reklam i zsynchronizuj

Za każdym razem po zmianach w kodzie gry (nie tylko raz):

```bash
npm run sync
```

To wywołuje po kolei: zbudowanie `native-ads-src.js` → `js/native-ads.bundle.js`, skopiowanie plików gry do `www/`, i `npx cap sync` (wgrywa wszystko do projektu Android).

✅ **SPRAWDŹ:** powinien istnieć `js/native-ads.bundle.js` (kilkadziesiąt KB) i folder `www/` z kopią gry.

## 🔴 Krok 5 — Załóż konto AdMob i podmień testowe ID

`js/ads.js` na razie ma **oficjalny testowy ID Google** (`ca-app-pub-3940256099942544/5224354917`) — bezpieczny do developmentu (zawsze testowe reklamy, nigdy prawdziwe pieniądze), ale musisz go podmienić przed publikacją.

1. Wejdź na https://admob.google.com, załóż konto
2. Dodaj nową aplikację (platforma: Android)
3. Stwórz jednostkę reklamową typu **Rewarded** (z nagrodą)
4. Skopiuj jej ID (wygląda jak `ca-app-pub-XXXXXXXXXXXXXXXX/YYYYYYYYYY`)
5. W `js/ads.js` podmień: `const ADMOB_REWARDED_UNIT_ID = 'TWOJE_ID';`
6. Zapisz też swój **App ID** (`ca-app-pub-XXXXXXXXXXXXXXXX~ZZZZZZZZZZ`, inny format niż ID jednostki) — potrzebny w Kroku 6

## 🔴 Krok 6 — Wpisz App ID do projektu Android

Te dwa pliki generuje `cap add android` (Krok 3) — edytujesz je RĘCZNIE, `cap sync` ich nie nadpisuje ponownie po Twoich zmianach w tym konkretnym miejscu.

**`android/app/src/main/res/values/strings.xml`** — dodaj linię:
```xml
<string name="admob_app_id">TWÓJ_APP_ID_TUTAJ</string>
```

**`android/app/src/main/AndroidManifest.xml`** — w sekcji `<application>` dodaj:
```xml
<meta-data
    android:name="com.google.android.gms.ads.APPLICATION_ID"
    android:value="@string/admob_app_id"/>
```

## 🔴 Krok 7 — Uruchom w Android Studio

```bash
npm run android
```

W Android Studio kliknij ▶ **Run** (potrzebny emulator albo telefon z włączonym USB debugging).

✅ **SPRAWDŹ:** zagraj do momentu modalu "Witaj z powrotem" (albo wpisz `DEBUG.simulateOffline(4)` w konsoli, jeśli akurat testujesz przez Live Server, żeby wywołać go bez czekania), kliknij przycisk z ikoną odtwarzania "x2" — powinna pokazać się testowa reklama wideo Google, a po jej obejrzeniu do końca — podwojona nagroda.

## 🔴 Krok 8 — Publikacja (kiedy będziesz gotowy)

1. Google Play Console — https://play.google.com/console (jednorazowa opłata rejestracyjna developera)
2. W Android Studio: **Build → Generate Signed Bundle / APK** → wybierz **Android App Bundle**, stwórz klucz podpisujący (zachowaj go bezpiecznie — potrzebny do KAŻDEJ przyszłej aktualizacji tej samej apki)
3. Wgraj wygenerowany `.aab` do Play Console, wypełnij kartę sklepu (opis, screenshoty, ikona), ustaw **politykę prywatności** (Google wymaga publicznego linku do niej dla apek z reklamami)
4. Wyślij do weryfikacji — Google zwykle odpowiada w ciągu kilku dni

---

## Czego świadomie NIE zrobiłem w tej turze

- **Banner** (stały, mały pasek reklamowy) — plugin już to wspiera (`AdMob.showBanner(...)`), ale nie wpiąłem, żeby nie zaśmiecać ekranu bez wyraźnej potrzeby. Powiedz, jeśli chcesz.
- **Interstitial** (pełnoekranowa reklama między sesjami) — wysoki przychód, ale realne ryzyko wkurzenia gracza przy nadużyciu (już to wcześniej flagowałem). Nie wpięte celowo — jeśli chcesz, powiedz gdzie dokładnie miałby się pokazywać (np. po zamknięciu sklepu, po ukończeniu modułu statku).
- **iOS** — cały ten setup dotyczy Androida/Google Play. iOS wymaga Maca do budowania i osobnego konta Apple Developer (99$/rok) — inny temat, jeśli kiedyś zechcesz.
