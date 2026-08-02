window.addEventListener('load', () => {

    window.spriteLoader = new SpriteLoader();

    window.spriteLoader.loadAll().then(() => {
        startGame();
    }).catch(() => {
        startGame();
    });

});

function startGame() {
    const game = new Game();
    // Wystawione globalnie - m.in. gamefeel.js czyta stąd cameraX/cameraY,
    // żeby fallbackowa pozycja popupu (bez jawnego x/y) liczyła się jako
    // faktyczny środek EKRANU, a nie środek świata (patrz komentarz w
    // gamefeel.js przy _spawnPopup/draw).
    window.game = game;
    const gameplayCanvas = document.getElementById('layer-gameplay');

    // Audio jako jedno z pierwszych - nie zależy od niczego innego, a UIManager
    // (dalej) czyta window.audioManager.muted przy budowaniu przycisku wyciszenia.
    window.audioManager = new AudioManager();

    // Muzyka w tle rusza dopiero przy PIERWSZEJ interakcji gracza (dotknięcie
    // ekranu / klik / klawisz) - przeglądarki blokują odtwarzanie dźwięku
    // zanim użytkownik czegokolwiek nie dotknie (autoplay policy), więc
    // wywołanie startMusic() od razu tutaj i tak zostałoby zignorowane.
    // { once: true } - po pierwszym starcie nasłuchiwacze same się zdejmują.
    const startMusicOnce = () => {
        if (window.audioManager) window.audioManager.startMusic();
    };
    ['pointerdown', 'keydown', 'touchstart'].forEach((evt) => {
        window.addEventListener(evt, startMusicOnce, { once: true });
    });

    window.stackController = new StackController();
    window.itemManager = new ItemManager(gameplayCanvas);
    // PRZED goldBonusManager - ten w _rollSpawnDelay() czyta
    // window.seasonalEventManager.isActive() (patrz events.js).
    window.seasonalEventManager = new SeasonalEventManager();
    window.goldBonusManager = new GoldBonusManager();

    const player = new PlayerController(gameplayCanvas);
    window.playerController = player;

    window.machineManager = new MachineManager(gameplayCanvas);
    window.marketManager = new MarketManager();
    window.tradingPost = new TradingPost(gameplayCanvas, window.marketManager);
    window.ship = new Ship(gameplayCanvas);

    // Ambient particles (dekoracyjne tło) - rejestrowane JAKO PIERWSZE, żeby
    // rysowały się POD wszystkimi innymi modułami na warstwie gameplay
    // (moduły rysują w kolejności rejestracji). Zero wpływu na rozgrywkę.
    window.ambientManager = new AmbientManager();
    game.registerModule(window.ambientManager);

    // Drobne stworzenia (motyle/świetliki/wrony) - ten sam powód rejestracji
    // na samym początku co ambientManager wyżej (tło, nic nie zasłaniają).
    window.crittersManager = new CrittersManager();
    game.registerModule(window.crittersManager);

    // Minimapa (ulepszenie w sklepie, dawniej Kompas Surowców) -
    // drawLayer='ui' (patrz minimap.js), więc mimo rejestracji tutaj i tak
    // rysuje się w OSOBNEJ pętli w game.js (moduły z drawLayer==='ui'), po
    // wszystkim innym.
    window.minimapManager = new MinimapManager();
    game.registerModule(window.minimapManager);

    game.registerModule(window.stackController);
    game.registerModule(window.itemManager);
    game.registerModule(window.seasonalEventManager);
    game.registerModule(window.goldBonusManager);
    // Maszyny/Terminal/Statek PRZED graczem (moduły rysują się w kolejności
    // rejestracji, patrz game.js draw()) - Tomek: "postać niech wchodzi na
    // to i na maszyny, a nie chowa się za nimi". Kolizja z tymi obiektami
    // dopuszcza spory zakład (gracz może podejść blisko/częściowo nachodzić
    // na sprite), więc bez tej kolejności gracz znikał POD nimi zamiast
    // stać przed nimi. Brak pełnego sortowania po Y (byłoby "za" gdy gracz
    // stoi wyżej, "przed" gdy niżej) - to prostsza, zawsze-na-wierzchu
    // reguła, zgodna z tym, o co poproszono.
    game.registerModule(window.machineManager);
    game.registerModule(window.marketManager);
    game.registerModule(window.tradingPost);
    game.registerModule(window.ship);
    game.registerModule(player);

    window.economyManager = new EconomyManager(game);
    // Faza 5: economyManager MUSI być zarejestrowany, żeby jego update()
    // (nalicza totalPlaytimeSeconds - podstawa tempa zarobku offline) w
    // ogóle ruszył. Wcześniej nie był modułem (nie potrzebował - wszystko
    // inne w nim jest event-driven/Date.now()-based).
    game.registerModule(window.economyManager);

    // Powiadomienie "wróć po odbiór" przy chowaniu apki w tło - patrz
    // offline-reminder.js. Nie jest modułem gry (czysto event-driven przez
    // document.visibilitychange, brak update()/draw()) - wystarczy raz init().
    window.offlineReminderManager = new OfflineReminderManager(window.economyManager);
    window.offlineReminderManager.init();
    window.gameFeel = new GameFeel();
    game.registerModule(window.gameFeel);

    // BUGFIX (opóźniona reklama): preload() jak najwcześniej, jeszcze zanim
    // gracz zdąży cokolwiek zobaczyć - reklamie zostaje maksimum czasu na
    // dociągnięcie się w tle, zanim w ogóle dojdzie do ewentualnego modala
    // offline (Krok niżej). ads.js/native-ads-src.js już istnieją (ładują
    // się przed main.js w index.html), więc window.adManager jest gotowe.
    if (window.adManager) window.adManager.preload();

    try {
        window.uiManager = new UIManager(game);
        game.registerModule(window.uiManager);

        window.saveManager = new SaveManager(game, window.economyManager);
        // Faza 5: load() teraz zwraca ile ms minęło od ostatniego zapisu
        // (albo null przy pierwszym uruchomieniu) - patrz save.js.
        const offlineElapsedMs = window.saveManager.load();
        // PO load() (żeby lastLoginDateStr/dailyChallenge z zapisu były już
        // wczytane), ale PRZED syncFromGameState() (żeby HUD od razu
        // odzwierciedlił ewentualną nagrodę za dzisiejszy dzień/nowe
        // wyzwanie, a nie dopiero po następnym evencie).
        window.economyManager.checkDailyLogin();
        window.economyManager.checkDailyChallenge();
        window.uiManager.syncFromGameState();

        // Samouczek - PO load() (musi znać prawdziwy tutorialStep/
        // tutorialDismissed z zapisu, nie świeże zera z konstruktora). Nie
        // ma update()/draw() (czysto event-driven + DOM), więc NIE
        // rejestrujemy go w game.registerModule() - żyje przez własne
        // subskrypcje Bus, patrz tutorial.js.
        window.tutorialManager = new TutorialManager(window.economyManager);

        if (offlineElapsedMs !== null) {
            const offline = window.economyManager.computeOfflineReward(offlineElapsedMs);
            if (offline) window.uiManager.showOfflineReward(offline);
        }

        // Wydarzenie sezonowe (events.js) - jednorazowy toast przy starcie,
        // bo jedynym innym sygnałem byłyby spadające gwiazdy na niebie,
        // łatwe przeoczyć przy pierwszym spojrzeniu na ekran.
        if (window.seasonalEventManager.isActive()) {
            window.uiManager.notifications.show(
                `${SPARKLE_ICON_SVG} Deszcz Meteorytów! Złoty Bonus częściej, ekskluzywny skin w Skinach.`,
                { type: 'success', duration: 4200 }
            );
        }
    } catch (err) {
        console.error('[main] UI/Save init failed — gra działa bez HUD:', err);
    }

    game.start();

    // Ekran ładowania - chowamy dopiero gdy tekstury terenu/dekoracji
    // (game.assetsReady) I sprite'y postaci (player.spritesReady) skończą
    // próby wczytania (sukces LUB porażka z fallbackiem - i tak jest co
    // pokazać). Wyścig z timeoutem: gdyby któryś obrazek w WebView ani się
    // nie wczytał, ani nie wywołał onerror (rzadkie, ale się zdarza), gracz
    // i tak nie utknie na starcie na stałe.
    hideLoadingScreenWhenReady(game, player);

    // --- DEBUG: pomocnicze skróty do testowania z konsoli (F12) ---------------
    // Nie usuwaj przed publikacją "na wszelki wypadek" - to tylko funkcje
    // dostępne pod window.DEBUG, gracz nigdy ich nie zobaczy/nie uruchomi
    // przypadkiem. Wygodnie zostawić na stałe do dalszego testowania.
    window.DEBUG = {
        /**
         * Nakładka z licznikiem FPS/czasu klatki - JEDYNY sposób, żeby dostać
         * PRAWDZIWE liczby z telefonu (na desktopie gra chodzi <1ms/klatkę i
         * problem się nie ujawnia, więc profilowanie na nim nic nie mówi).
         * Pokazuje też aktualny krok jakości, żeby było widać, czy adaptacyjny
         * system (patrz _trackPerformance w game.js) już coś obniżył.
         * Wywołaj DEBUG.fps() na telefonie i podaj co pokazuje.
         */
        fps() {
            if (document.getElementById('debug-fps')) return 'już włączone';
            const el = document.createElement('div');
            el.id = 'debug-fps';
            el.style.cssText = `
                position: fixed; left: 50%; transform: translateX(-50%);
                top: calc(4px + env(safe-area-inset-top, 0px));
                z-index: 99999; pointer-events: none;
                background: rgba(0,0,0,0.75); color: #7CFC00;
                font: 700 12px monospace; padding: 5px 10px; border-radius: 8px;
                white-space: pre; text-align: center;
            `;
            document.body.appendChild(el);

            let last = performance.now();
            const samples = [];
            let worst = 0;
            const tick = () => {
                const now = performance.now();
                const dt = now - last;
                last = now;
                samples.push(dt);
                if (dt > worst) worst = dt;
                if (samples.length >= 30) {
                    const sorted = samples.slice().sort((a, b) => a - b);
                    const med = sorted[Math.floor(sorted.length / 2)];
                    const g = window.game;
                    el.textContent =
                        `${(1000 / med).toFixed(0)} FPS  (${med.toFixed(1)}ms)\n` +
                        `najgorsza: ${worst.toFixed(0)}ms\n` +
                        `jakość: ${g ? g.dpr : '?'}x`;
                    // Kolor od razu mówi, czy jest problem, bez czytania liczb.
                    el.style.color = med < 18 ? '#7CFC00' : med < 26 ? '#FFD54F' : '#FF5252';
                    samples.length = 0;
                    worst = 0;
                }
                requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
            return 'licznik FPS włączony';
        },

        /** Dokłada kasę bezpośrednio (z uwzględnieniem trwałego mnożnika
         * core_income, jeśli już kupiony - _addMoney() sam to liczy). */
        addMoney(amount = 1000) {
            if (window.economyManager) window.economyManager._addMoney(amount);
        },

        /** Wrzuca N sztuk danego typu bezpośrednio do plecaka, z pozycji
         * gracza (krótka animacja "doskoku" zamiast teleportacji na sztywno).
         * typeId: 'trash' | 'plastic' | 'paper' | 'metal' | 'glass' | 'product' | 'alloy'.
         * Zwraca ile faktycznie się zmieściło (isFull() może uciąć wcześniej). */
        giveItems(typeId, count = 10) {
            if (!window.stackController) return 0;
            const meta = (typeof ItemRenderer !== 'undefined') ? ItemRenderer.getTypeMeta(typeId) : null;
            // 'alloy' celowo NIE jest w ITEM_TYPES (items.js) - nie spawnuje
            // się nigdy losowo w świecie, tylko jako output Pieca Hutniczego
            // (patrz machines.js), stąd fallback na jego kolory tutaj.
            const label = meta ? meta.label : '';
            const color = meta ? meta.color : (typeId === 'alloy' ? '#D4A574' : '#FFFFFF');
            const px = window.playerController ? window.playerController.x : 0;
            const py = window.playerController ? window.playerController.y : 0;
            let added = 0;
            for (let i = 0; i < count; i++) {
                const ok = window.stackController.addItem({
                    id: `debug_${typeId}_${Date.now()}_${i}`,
                    typeId,
                    label,
                    color,
                    worldX: px,
                    worldY: py
                });
                if (!ok) break;
                added++;
            }
            return added;
        },

        /** Dokładnie tyle plastiku/produktu/stopu, ile trzeba na WSZYSTKIE 5
         * modułów statku razem (20/28/34 - suma z SHIP_MODULE_DEFINITIONS).
         * Tymczasowo podbija maxCapacity, żeby wszystko się zmieściło naraz,
         * i przywraca Twój prawdziwy limit zaraz potem - istniejące
         * przedmioty zostają, tylko nowe znów podlegają normalnemu limitowi. */
        giveShipMaterials() {
            const stack = window.stackController;
            const prevCap = stack ? stack.maxCapacity : 10;
            if (stack) stack.maxCapacity = 999;
            this.giveItems('plastic', 20);
            this.giveItems('product', 28);
            this.giveItems('alloy', 34);
            if (stack) stack.maxCapacity = prevCap;
        },

        /** Kasuje zapis i przeładowuje stronę - powrót do zupełnie świeżej gry. */
        resetSave() {
            localStorage.removeItem(SAVE_STORAGE_KEY);
            location.reload();
        },

        /** Symuluje powrót po X godzinach OFFLINE - liczy i pokazuje modal
         * od razu, bez reloadu i bez czekania na prawdziwy upływ czasu.
         * Wymaga, żeby w TYM przebiegu było już jakieś sellEarnings/
         * totalPlaytimeSeconds (POSPRZEDAWAJ coś normalnie przed testem -
         * DEBUG.addMoney() świadomie NIE liczy się do tego tempa, patrz
         * komentarz przy sellEarnings w economy.js), inaczej tempo=0 i
         * computeOfflineReward() świadomie nic nie zwróci. */
        simulateOffline(hours = 2) {
            if (!window.economyManager || !window.uiManager) return;
            const offline = window.economyManager.computeOfflineReward(hours * 3600 * 1000);
            if (offline) {
                window.uiManager.showOfflineReward(offline);
            } else {
                console.log('[DEBUG] Brak nagrody - albo za krótko (< 2 min), albo tempo zarobku = 0 (nic jeszcze nie sprzedane w tym przebiegu).');
            }
        },

        /** PRAWDZIWY prestige (kasa->rdzenie, reset przebiegu, +1 planetNumber,
         * nowy activeModifier) - normalnie zablokowany, dopóki statek nie jest
         * w pełni złożony (isReadyToPrestige()). Do testów tymczasowo podmienia
         * tę metodę na "zawsze gotowy", woła prawdziwe economyManager.prestige()
         * (więc liczy się TAK SAMO jak w grze - żadnej osobnej "testowej"
         * ścieżki), i od razu przywraca oryginalny warunek. Zwraca to samo co
         * prestige() - {coresEarned, totalCores, planetNumber} albo null. */
        forcePrestige() {
            if (!window.economyManager) return null;
            const em = window.economyManager;
            const originalCheck = em.isReadyToPrestige;
            em.isReadyToPrestige = () => true;
            const result = em.prestige();
            em.isReadyToPrestige = originalCheck;
            return result;
        },

        /** Podgląd wyglądu DOWOLNEJ planety BEZ prawdziwego prestige - kasa/
         * rdzenie/ulepszenia/activeModifier zostają jak są, zmienia się TYLKO
         * planetNumber (steruje wyborem DECOR_SETS - patrz _currentDecorSetIndex
         * w game.js) + wymuszone przepieczenie tła świata (_requestWorldRebake -
         * ten sam mechanizm co po prawdziwym prestige'u, z nakładką ładowania).
         * Do szybkiego porównania zestawów dekoracji/filtrów (indeks = (n-1) % 3:
         * 1/4/7... domyślny, 2/5/8... zimowy, 3/6/9... pustynny) bez
         * przechodzenia całego przebiegu za każdym razem. */
        setPlanet(n = 1) {
            if (!window.economyManager || !window.game) return;
            window.economyManager.planetNumber = n;
            window.game._requestWorldRebake();
        }
    };
    console.log(
        '🛠️ DEBUG dostępne: DEBUG.addMoney(n), DEBUG.giveItems(typeId, n), ' +
        'DEBUG.giveShipMaterials(), DEBUG.resetSave(), DEBUG.simulateOffline(godziny), ' +
        'DEBUG.forcePrestige(), DEBUG.setPlanet(n)'
    );
}

// Minimalny czas, przez jaki ekran ładowania ZOSTAJE na ekranie, nawet gdy
// assety wczytają się błyskawicznie (bundlowana apka czyta je lokalnie, więc
// bez tego ekran potrafił błysnąć i zniknąć w ułamek sekundy - "za szybko,
// żeby cokolwiek zdążyło się na spokojnie załadować"). Nie jest to fake
// opóźnienie bez powodu: dopiero PO tym czasie (plus zapas klatek niżej)
// świat zdążył upiec swoje statyczne tło (patrz komentarz przy
// LOADING_SCREEN_SETTLE_FRAMES).
const LOADING_SCREEN_MIN_MS = 2200;
// Ile klatek requestAnimationFrame czekamy PO tym, jak assety są już gotowe,
// zanim schowamy ekran. game.start() (patrz startGame() wyżej) już wtedy
// działa POD ekranem ładowania, więc w tym oknie Game._bakeWorldBackground
// (jednorazowe upieczenie tła świata - patrz game.js, dawniej główny
// winowajca zacinania) zdąży się wykonać, zamiast być widoczne jako
// zacięcie NA GOŁYM EKRANIE GRY tuż po zniknięciu tego ekranu.
const LOADING_SCREEN_SETTLE_FRAMES = 3;

function hideLoadingScreenWhenReady(game, player) {
    const loadingScreen = document.getElementById('loading-screen');
    if (!loadingScreen) return;

    const ready = Promise.all([
        game.assetsReady || Promise.resolve(),
        player.spritesReady || Promise.resolve(),
        // game.firstQualityCheckReady - dawniej czekało na pierwszą kalibrację
        // adaptacyjnej jakości; ten mechanizm jest teraz wyłączony (patrz
        // komentarz przy GAME_QUALITY_DPR_STEPS w game.js), więc ta promise
        // rozwiązuje się NATYCHMIAST w konstruktorze Game. Zostaje w tej puli
        // (nieszkodliwie) na wypadek, gdyby kiedyś w przyszłości znów była
        // czegoś warta.
        game.firstQualityCheckReady || Promise.resolve()
    ]);
    // Zabezpieczenie "gdyby jakiś obrazek nigdy się nie wczytał" (rzadkie).
    const timeout = new Promise((resolve) => setTimeout(resolve, 9000));
    const minDelay = new Promise((resolve) => setTimeout(resolve, LOADING_SCREEN_MIN_MS));

    Promise.all([Promise.race([ready, timeout]), minDelay]).then(() => {
        let framesLeft = LOADING_SCREEN_SETTLE_FRAMES;
        const waitForSettle = () => {
            framesLeft--;
            if (framesLeft > 0) {
                requestAnimationFrame(waitForSettle);
                return;
            }
            // Domyka pasek do 100% (patrz animacja "na oko" w index.html) -
            // gracz widzi wyraźne zakończenie zamiast paska ucinającego się
            // w połowie, zanim ekran zniknie.
            if (window.__loadingBarGrowInterval) {
                clearInterval(window.__loadingBarGrowInterval);
            }
            const fillEl = document.getElementById('loading-bar-fill');
            if (fillEl) fillEl.style.width = '100%';

            setTimeout(() => {
                loadingScreen.classList.add('loading-screen--hidden');
            }, 200);
        };
        requestAnimationFrame(waitForSettle);
    });
}
