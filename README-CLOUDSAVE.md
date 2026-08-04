# Eco Mart — Zapis w chmurze (Capacitor + Google Play Games Services)

> 🔴 = musisz zrobić Ty, w Google Play Console/Android Studio na swoim komputerze — nie mam tu środowiska Android/Node do uruchomienia tego za Ciebie, ani konta Google Play Console.
> 🤖 = już zrobione, siedzi w plikach które dostałeś.
> ✅ = sprawdź, zanim pójdziesz dalej.

Wszystko poniżej sprawdziłem naprawdę: rozpakowałem `capacitor-google-game-services@2.0.0` z npm i przeczytałem jego prawdziwy kod źródłowy Java (nie tylko README) — używa aktualnego, NIE przestarzałego Google Play Games Services SDK v2 (`PlayGamesSdk.initialize`), ma wbudowaną rozdzielczość konfliktów zapisu (`RESOLUTION_POLICY_MOST_RECENTLY_MODIFIED`), i **faktycznie zbudowałem** `native-cloudsave-src.js` esbuildem — 23.2kb, zero błędów — oraz przepuściłem cały projekt przez `npx cap sync android`, które poprawnie wpięło plugin do `android/app/capacitor.build.gradle`. To nie jest kod pisany z pamięci.

**Jedna szczera uwaga na start:** ten konkretny plugin deklaruje zgodność z Capacitorem 5, a ten projekt jest na Capacitorze 7 (stąd `.npmrc` z `legacy-peer-deps=true`, inaczej `npm install`/`npm ci` w ogóle by nie ruszyło). Realny kod pluginu nie używa niczego specyficznego dla Capacitora 5 (stabilne, niezmienione od lat API `Plugin`/`@PluginMethod`), więc ocena ryzyka jest niska — ale **nie mam tu ani jednego prawdziwego telefonu ani konta Google do przetestowania logowania/synchronizacji na żywo**. To jedyna część tej gry w całej tej sesji, której nie mogłem sam włączyć i zobaczyć, że działa — zweryfikowałem architekturę i kod tak dokładnie, jak się dało bez tego, ale ostateczny test "czy naprawdę loguje i synchronizuje" możesz zrobić tylko Ty, na realnym urządzeniu, po Kroku 6 niżej.

---

## 🤖 Co już jest zrobione

| Plik | Co robi |
|---|---|
| `js/cloudsave.js` | `CloudSaveManager` — loguje, porównuje timestamp lokalnego zapisu z zapisem w chmurze, wysyła/pobiera. "Nowszy wygrywa" — ten sam timestamp, który zapis lokalny już ma (save.js). |
| `native-cloudsave-src.js` | Jedyny (obok ads/notifications/haptics) plik z importem npm — **wymaga zbudowania**, patrz Krok 5 |
| `js/i18n.js` | Cały tekst wiersza "Chmura" w Menu po polsku i angielsku |
| `ui.js` | Wiersz "Chmura" w Menu → Dane: pokazuje stan (niezalogowany/zalogowany/błąd), przycisk logowania/synchronizacji |
| `.npmrc` | `legacy-peer-deps=true` — bez tego `npm ci` w CI padnie na konflikt wersji (patrz uwaga wyżej) |
| `package.json` | Zależność + skrypt `build-cloudsave` |
| `.github/workflows/android-apk.yml` | Dopisany krok budowania bundla w CI |

**Synchronizacja dzieje się:**
- **przy logowaniu** — jedyny moment realnego porównania lokalnego zapisu z chmurą (i ewentualnego pobrania nowszego z innego urządzenia + `location.reload()`, ten sam wzorzec co import pliku zapisu)
- **przy chowaniu apki w tło** i **przy odlocie/wygranej** — sama wysyłka do chmury, bez pobierania (te same momenty, w których i tak już dzieje się natychmiastowy zapis lokalny)

---

## 🔴 Krok 1 — Włącz Play Games Services w Google Play Console

1. Wejdź na https://play.google.com/console (potrzebujesz już założonego konta developera — jeśli publikujesz apkę z AdMob, patrz README-ADS.md Krok 8, prawdopodobnie już je masz)
2. W menu bocznym: **Wzrost → Play Games Services → Ustawienia** (albo wyszukaj "Play Games Services")
3. Kliknij **Skonfiguruj Play Games Services** → wybierz **Tak, moja gra już korzysta z interfejsów API Google**
4. Wybierz swój projekt Google Cloud (albo pozwól konsoli stworzyć nowy) — to POWIĄŻE tę grę z Google Play Games na stałe

✅ **SPRAWDŹ:** w sekcji Play Games Services powinieneś zobaczyć status "Skonfigurowano" albo podobny.

## 🔴 Krok 2 — Dodaj poświadczenia (credentials)

W tej samej sekcji Play Games Services:

1. **Poświadczenia** → **Dodaj poświadczenia**
2. Typ: **Gra Android**
3. Wklej **nazwę pakietu** apki (to samo `appId` co w `capacitor.config.json` — patrz README-ADS.md Krok 3, jeśli jeszcze go nie zmieniłeś z domyślnego `com.ecomart.game`)
4. Wklej **SHA-1 certyfikatu podpisywania** — to ten sam klucz podpisujący z README-ADS.md Krok 8 (Build → Generate Signed Bundle). Jeśli jeszcze go nie masz, w Android Studio: **Build → Generate Signed Bundle/APK**, przy tworzeniu klucza zapisz sobie SHA-1 (Android Studio go pokazuje), albo później: `keytool -list -v -keystore TWOJ_KLUCZ.jks`

✅ **SPRAWDŹ:** poświadczenia powinny pokazać się jako aktywne na liście.

## 🔴 Krok 3 — Włącz Zapisane gry (Saved Games)

1. W Play Games Services: **Konfiguracja** → **Zapisane gry**
2. Włącz tę funkcję (przełącznik) — bez tego `saveGame()`/`loadGame()` w tym pluginie będą się wywalać błędem, mimo że reszta logowania działa

## 🔴 Krok 4 — Dodaj siebie jako testera (zanim gra jest opublikowana)

Play Games Services **nie działa** dla nieopublikowanych apek, chyba że jesteś na liście testerów:

1. Play Games Services → **Testerzy**
2. Dodaj swój adres Gmail (ten sam, którym logujesz się na telefonie testowym)

✅ **SPRAWDŹ:** Twój e-mail widnieje na liście testerów.

## 🔴 Krok 5 — Zainstaluj zależności i zbuduj mostek

```bash
npm install
npm run sync
```

(`npm run sync` = zbudowanie wszystkich czterech mostków native-*, kopia do `www/`, `npx cap sync` — to samo co przy AdMob/powiadomieniach/haptyce, patrz README-ADS.md.)

✅ **SPRAWDŹ:** powinien istnieć `js/native-cloudsave.bundle.js` (kilkanaście-kilkadziesiąt KB).

## 🔴 Krok 6 — Zbuduj podpisaną apkę i przetestuj na prawdziwym urządzeniu

Logowanie Google Play Games **nie działa** w zwykłym debug-buildzie uruchomionym z Android Studio przez USB na koncie, które nie jest testerem, ani w ogóle bez prawdziwego, zalogowanego na telefonie konta Google. Potrzebujesz:

1. Podpisanej apki (README-ADS.md Krok 8) zainstalowanej na prawdziwym telefonie
2. Telefonu zalogowanego na konto Gmail dodane w Kroku 4
3. Zainstalowanej aplikacji **Google Play Games** na telefonie (zwykle jest domyślnie)

W Menu gry → sekcja **Dane** → wiersz **Chmura** → **Zaloguj przez Google Play**.

✅ **SPRAWDŹ:** po zalogowaniu wiersz powinien pokazać Twoją nazwę gracza Google Play i "zsynchronizowano przed chwilą". Zainstaluj apkę na drugim urządzeniu (albo wyczyść dane apki i zainstaluj ponownie) zalogowanym na to samo konto — postęp powinien się pojawić automatycznie po zalogowaniu.

---

## Czego świadomie NIE zrobiłem w tej turze

- **Tablica wyników Google Play Games** (prawdziwy, serwerowy leaderboard) — plugin, którego użyłem (wybrany świadomie za "Zapisane gry"/cloud save, czyli Twoją główną prośbę: "zgubiony telefon = zgubiony postęp") **nie ma** API do leaderboardów. Inny plugin (`@openforge/capacitor-game-connect`) ma leaderboard+achievementy, ale NIE ma zapisu w chmurze — dwa pluginy naraz w jednej grze to podwójne ryzyko konfliktów w Gradle, więc się wstrzymałem. Lokalna Tablica Wyników w grze (Menu → Tablica wyników) zostaje bez zmian, działa jak dotąd. Powiedz, jeśli mimo to chcesz prawdziwy, serwerowy leaderboard — da się dodać osobno.
- **Osiągnięcia Google Play Games** (natywny panel osiągnięć Google, osobny od panelu w grze) — z tego samego powodu (plugin bez tego API). Panel Osiągnięć w grze zostaje jak jest.
- **iOS** — jak w README-ADS.md, cały ten setup dotyczy tylko Androida/Google Play.
