'use strict';

/**
 * save.js
 * ------------------------------------------------------------------------
 * Prosty zapis/odczyt stanu gry w localStorage.
 */

const SAVE_STORAGE_KEY = 'ecomart_save_v1';
const SAVE_DEBOUNCE_MS = 2000;

class SaveManager {
  constructor(game, economyManager) {
    this.game = game;
    this.economyManager = economyManager;
    this._saveTimer = null;

    this._onStateChange = () => this.scheduleSave();
    Bus.subscribe(Events.MONEY_COLLECTED, this._onStateChange);
    Bus.subscribe(Events.UPGRADE_BOUGHT, this._onStateChange);
    Bus.subscribe(Events.STACK_ADDED, this._onStateChange);
    Bus.subscribe(Events.STACK_REMOVED, this._onStateChange);
    Bus.subscribe(Events.SHIP_MODULE_COMPLETED, this._onStateChange);

    // Wygrana zapisuje się NATYCHMIAST (nie debounced jak reszta) - to zbyt
    // ważny moment, żeby ryzykować utratę, gdyby gracz zamknął kartę w ciągu
    // tych paru sekund debounce'a.
    this._onGameWon = () => this.save();
    Bus.subscribe(Events.GAME_WON, this._onGameWon);

    // Faza 4 (prestiż): odlot na nową planetę zeruje cały przebieg w zamian
    // za Rdzenie - dokładnie tak samo nieodwracalny i ważny moment jak
    // wygrana, więc ten sam natychmiastowy zapis (nie czekamy na debounce).
    this._onPrestigeDone = () => this.save();
    if (Events.PRESTIGE_DONE) {
      Bus.subscribe(Events.PRESTIGE_DONE, this._onPrestigeDone);
    }
  }

  scheduleSave() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.save(), SAVE_DEBOUNCE_MS);
  }

  save() {
    try {
      const payload = {
        version: 1,
        timestamp: Date.now(),
        game: this.game ? { money: this.game.state.money, stackSize: this.game.state.stackSize } : {},
        economy: this.economyManager ? this.economyManager.getSaveData() : {}
      };
      localStorage.setItem(SAVE_STORAGE_KEY, JSON.stringify(payload));
    } catch (err) {
      console.warn('[SaveManager] Nie udało się zapisać:', err);
    }
  }

  /**
   * @returns {number|null} ile ms minęło od ostatniego zapisu (Faza 5 -
   *   idle offline, patrz main.js/economy.js computeOfflineReward), albo
   *   null gdy nie ma zapisu / coś poszło nie tak. BUGFIX/ZMIANA: dawniej
   *   zwracało zwykłe true/false - timestamp w payloadzie i tak już tam
   *   był (Date.now() przy każdym save()), po prostu nikt go dotąd nie
   *   czytał. Nic w main.js nie sprawdzało starego zwrotu, więc zmiana typu
   *   jest bezpieczna.
   */
  load() {
    try {
      const raw = localStorage.getItem(SAVE_STORAGE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (this.economyManager && data.economy) {
        this.economyManager.applySaveData(data.economy);
      }
      if (this.game && data.game && typeof data.game.money === 'number') {
        this.game.state.money = data.game.money;
      }
      return (typeof data.timestamp === 'number') ? Math.max(0, Date.now() - data.timestamp) : null;
    } catch (err) {
      console.warn('[SaveManager] Nie udało się wczytać:', err);
      return null;
    }
  }

  /**
   * Eksport zapisu jako string JSON do pobrania jako plik (Tomek: "eksport/
   * import zapisu jako plik - backup poza localStorage, buduje zaufanie że
   * postęp nie zniknie"). save() PRZED odczytem - flush świeżego stanu, nie
   * poleganie na ostatnim zaplanowanym debounce (SAVE_DEBOUNCE_MS) - żeby
   * eksportowany plik zawsze odzwierciedlał DOKŁADNIE to, co gracz widzi na
   * ekranie w chwili kliknięcia "Eksportuj", nie stan sprzed 2s.
   * @returns {string|null} JSON zapisu, albo null gdy localStorage niedostępny.
   */
  exportSaveJSON() {
    this.save();
    try {
      return localStorage.getItem(SAVE_STORAGE_KEY);
    } catch (err) {
      return null;
    }
  }

  /**
   * Importuje zapis z pliku (string JSON, patrz exportSaveJSON) - WYŁĄCZNIE
   * waliduje kształt i zapisuje do localStorage. Wywołujący (SettingsPanel.
   * _buildImportRow, ui.js) robi PO tym location.reload() - hot-patchowanie
   * każdego już żywego obiektu gry (maszyny, statek, minimapa...) z osobna
   * byłoby dużo bardziej kruche niż zwykłe przeładowanie strony, które i tak
   * poprawnie odtwarza cały stan z load() od zera (main.js).
   * @returns {boolean} czy plik wyglądał na poprawny zapis i został zapisany.
   */
  importSaveJSON(jsonString) {
    let data;
    try {
      data = JSON.parse(jsonString);
    } catch (err) {
      return false;
    }
    // Minimalna walidacja kształtu - prawdziwy zapis ZAWSZE ma pole
    // "economy" (patrz save() wyżej). Nie chronimy przed KAŻDYM złośliwym
    // plikiem (to i tak tylko dane samego gracza dla samego siebie), tylko
    // przed oczywistą pomyłką (np. wybranie zupełnie innego pliku).
    if (!data || typeof data !== 'object' || !data.economy) return false;
    try {
      localStorage.setItem(SAVE_STORAGE_KEY, JSON.stringify(data));
      return true;
    } catch (err) {
      return false;
    }
  }

  destroy() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    Bus.unsubscribe(Events.MONEY_COLLECTED, this._onStateChange);
    Bus.unsubscribe(Events.UPGRADE_BOUGHT, this._onStateChange);
    Bus.unsubscribe(Events.STACK_ADDED, this._onStateChange);
    Bus.unsubscribe(Events.STACK_REMOVED, this._onStateChange);
    Bus.unsubscribe(Events.SHIP_MODULE_COMPLETED, this._onStateChange);
    Bus.unsubscribe(Events.GAME_WON, this._onGameWon);
    if (Events.PRESTIGE_DONE) {
      Bus.unsubscribe(Events.PRESTIGE_DONE, this._onPrestigeDone);
    }
  }
}

window.SaveManager = SaveManager;
