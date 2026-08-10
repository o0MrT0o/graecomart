'use strict';

/**
 * cloudsave.js
 * ------------------------------------------------------------------------
 * Zapis w chmurze przez Google Play Games (Tomek: "bez tego zgubiony
 * telefon = zgubiony postęp mimo eksportu") - ten sam wzorzec bezpiecznego
 * no-opa co reszta natywnych mostków w tym projekcie (audio/ads/
 * notifications/haptics): jeśli window.NativeCloudSave nie istnieje
 * (zwykła przeglądarka, plugin nieskonfigurowany) albo logowanie się nie
 * powiedzie (brak konfiguracji Play Console - patrz README-CLOUDSAVE.md),
 * gra działa DOKŁADNIE jak dotąd, wyłącznie na localStorage.
 *
 * Rozdzielczość konfliktu (lokalny zapis vs zapis w chmurze) jest CELOWO
 * najprostsza z możliwych - "nowszy wygrywa" po polu `timestamp`, które
 * SaveManager i tak już zapisuje w każdym payloadzie (save.js). To ten sam
 * timestamp, który napędza już nagrodę offline (computeOfflineReward) -
 * żadnego nowego pola/formatu zapisu.
 *
 * Moment synchronizacji:
 *   - PRZY LOGOWANIU (checkAutoSignIn/signIn) - jedyny moment, w którym
 *     lokalny i chmurowy zapis mogą się realnie ROZJECHAĆ (inne urządzenie
 *     grało od ostatniej synchronizacji) - stąd jedyne miejsce z realnym
 *     porównaniem i EWENTUALNYM importem zapisu z chmury (+ reload, ten sam
 *     wzorzec co import pliku w ui.js).
 *   - WYSYŁKA do chmury (bez pobierania) przy chowaniu apki w tło
 *     (visibilitychange, ten sam sygnał co offline-reminder.js) i przy
 *     ważnych momentach (prestiż/wygrana, ten sam zestaw zdarzeń co
 *     natychmiastowy zapis lokalny w save.js) - NIE przy każdej drobnej
 *     zmianie jak lokalny zapis (debounce 2s), żeby nie zasypywać API
 *     Google zapytaniami przy każdym kliknięciu.
 */
class CloudSaveManager {
  constructor(saveManager) {
    this.saveManager = saveManager;
    this.signedIn = false;
    this.playerName = null;
    this.lastSyncAt = null;
    this.status = 'idle'; // 'idle' | 'syncing' | 'error'
    this._syncing = false;

    this._onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') this.uploadNow();
    };
    document.addEventListener('visibilitychange', this._onVisibilityChange);

    this._onPrestigeDone = () => this.uploadNow();
    if (Events.PRESTIGE_DONE) Bus.subscribe(Events.PRESTIGE_DONE, this._onPrestigeDone);
    this._onGameWon = () => this.uploadNow();
    Bus.subscribe(Events.GAME_WON, this._onGameWon);
  }

  /** false w zwykłej przeglądarce / bez zbudowanego pluginu - patrz komentarz u góry pliku. */
  available() {
    return !!window.NativeCloudSave;
  }

  _publishState() {
    Bus.publish(Events.CLOUD_SAVE_STATE_CHANGED, {
      signedIn: this.signedIn,
      playerName: this.playerName,
      lastSyncAt: this.lastSyncAt,
      status: this.status
    });
  }

  /**
   * Wołane RAZ przy starcie gry (main.js, zaraz po saveManager.load()) -
   * plugin sam próbuje zalogować się automatycznie (patrz jego dokumentacja
   * w native-cloudsave-src.js), więc to tylko SPRAWDZENIE, czy się udało,
   * nie jawne żądanie logowania (to robi dopiero signIn() niżej, wołane z
   * przycisku w Menu). Cichy no-op, gdy plugin niedostępny/niezalogowany -
   * gracz nigdy nie widzi błędu za coś, czego nawet nie próbował zrobić.
   */
  async checkAutoSignIn() {
    if (!this.available()) return false;
    try {
      const signedIn = await window.NativeCloudSave.isSignedIn();
      if (signedIn) await this._afterSignIn();
      return signedIn;
    } catch (err) {
      return false;
    }
  }

  /** Jawne logowanie na żądanie gracza (przycisk w Menu) - w przeciwieństwie
   * do checkAutoSignIn() POKAZUJE stan błędu, żeby kliknięcie miało widoczny
   * skutek, nawet gdy się nie uda (np. Play Console jeszcze nieskonfigurowane). */
  async signIn() {
    if (!this.available()) return false;
    this.status = 'syncing';
    this._publishState();
    try {
      const ok = await window.NativeCloudSave.signIn();
      if (ok) {
        await this._afterSignIn();
      } else {
        this.status = 'error';
        this._publishState();
      }
      return ok;
    } catch (err) {
      this.status = 'error';
      this._publishState();
      return false;
    }
  }

  async _afterSignIn() {
    this.signedIn = true;
    this.playerName = await window.NativeCloudSave.getPlayerName();
    await this.syncNow();
  }

  /**
   * Jedyne miejsce w tym pliku, które może NADPISAĆ lokalny stan (import +
   * reload) - patrz komentarz u góry pliku o "nowszy wygrywa". Bezpieczne
   * wołać wielokrotnie (this._syncing chroni przed nakładającymi się
   * wywołaniami, np. szybkie kliknięcie "Synchronizuj" kilka razy z rzędu).
   */
  async syncNow() {
    if (!this.signedIn || this._syncing) return;
    this._syncing = true;
    this.status = 'syncing';
    this._publishState();

    try {
      const cloudJson = await window.NativeCloudSave.loadFromCloud();
      const localJson = this.saveManager.exportSaveJSON();

      const cloudData = cloudJson ? this._tryParse(cloudJson) : null;
      const localData = localJson ? this._tryParse(localJson) : null;
      const cloudTs = (cloudData && typeof cloudData.timestamp === 'number') ? cloudData.timestamp : -1;
      const localTs = (localData && typeof localData.timestamp === 'number') ? localData.timestamp : -1;

      if (cloudData && cloudTs > localTs) {
        // Chmura ma nowszy zapis (np. gracz grał na innym urządzeniu od
        // ostatniej synchronizacji) - importSaveJSON + reload, ten sam
        // wzorzec co import pliku (SettingsPanel._buildImportRow w ui.js).
        this.saveManager.importSaveJSON(cloudJson);
        this.lastSyncAt = Date.now();
        this.status = 'idle';
        this._publishState();
        location.reload();
        return;
      }

      // Lokalny zapis jest nowszy/równy (albo w chmurze jeszcze nic nie ma)
      // - wysyłamy go w górę, żeby chmura dogoniła urządzenie.
      if (localJson) {
        await window.NativeCloudSave.saveToCloud(localJson);
      }
      this.lastSyncAt = Date.now();
      this.status = 'idle';
      this._publishState();
    } catch (err) {
      this.status = 'error';
      this._publishState();
    } finally {
      this._syncing = false;
    }
  }

  /** Wysyłka BEZ pobierania/porównywania - patrz "Moment synchronizacji" u
   * góry pliku. Celowo cichy (bez zmiany this.status) - to zdarzenie w tle
   * (chowanie apki, prestiż), nie akcja gracza, więc nie zasługuje na
   * widoczny stan "syncing" w Menu przez ułamek sekundy. */
  async uploadNow() {
    if (!this.signedIn || !this.available()) return;
    const json = this.saveManager.exportSaveJSON();
    if (!json) return;
    const ok = await window.NativeCloudSave.saveToCloud(json);
    if (ok) {
      this.lastSyncAt = Date.now();
      this._publishState();
    }
  }

  _tryParse(jsonString) {
    try {
      return JSON.parse(jsonString);
    } catch (err) {
      return null;
    }
  }

  destroy() {
    document.removeEventListener('visibilitychange', this._onVisibilityChange);
    if (Events.PRESTIGE_DONE) Bus.unsubscribe(Events.PRESTIGE_DONE, this._onPrestigeDone);
    Bus.unsubscribe(Events.GAME_WON, this._onGameWon);
  }
}

window.CloudSaveManager = CloudSaveManager;
