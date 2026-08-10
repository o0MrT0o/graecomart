'use strict';

/**
 * haptics.js
 * ------------------------------------------------------------------------
 * Wibracje (Tomek: "haptics") na kluczowych momentach gry - PRÓBUJE
 * window.NativeHaptics (native-haptics-src.js, bridge do @capacitor/haptics -
 * patrz komentarz tam), bezpieczny no-op w zwykłej przeglądarce/gdy plugin
 * niedostępny (window.NativeHaptics po prostu nie istnieje). Ten sam wzorzec
 * co audio.js - reaguje na zdarzenia z Bus, żaden inny moduł nie musi
 * wiedzieć, że wibracje w ogóle istnieją.
 *
 * CELOWO tylko na wybranych, "ważnych" zdarzeniach (zakup, osiągnięcie,
 * odmowa, utrata przedmiotu w hazardzie, prestiż, premia) - NIE na każdym
 * pojedynczym tapnięciu (ui_click w audio.js gra na WSZYSTKICH przyciskach) -
 * wibrowanie na każdej interakcji szybko męczy i wysysa baterię, zamiast
 * czuć się jak nagroda za coś konkretnego.
 *
 * Zależności globalne (muszą być załadowane przed tym plikiem):
 *   - window.Bus / window.Events (UPGRADE_BOUGHT, ACHIEVEMENT_UNLOCKED,
 *     ITEM_LOST, PRESTIGE_DONE, GOLD_BONUS_COLLECTED)
 *
 * Użycie w main.js:
 *   window.hapticsManager = new HapticsManager();
 *   (NIE trzeba rejestrować przez game.registerModule() - bez update()/draw(),
 *   działa wyłącznie na zdarzeniach, tak jak AudioManager)
 */
class HapticsManager {
  constructor() {
    this._onUpgradeBought = () => this._impactLight();
    // Odmowa (za mało pieniędzy/Rdzeni) - wołane WPROST z UIButton (ui.js),
    // nie przez Bus (ten sam powód co przy audio.js 'error': natywny
    // <button disabled> w ogóle nie emituje eventu 'click', więc "denied"
    // musi zostać osobną ścieżką w UIButton, patrz `denied` tam).
    this._onAchievementUnlocked = () => this._notifySuccess();
    this._onItemLost = () => this._impactMedium();
    this._onPrestigeDone = () => this._impactHeavy();
    this._onGoldBonusCollected = () => this._impactLight();

    Bus.subscribe(Events.UPGRADE_BOUGHT, this._onUpgradeBought);
    if (Events.ACHIEVEMENT_UNLOCKED) Bus.subscribe(Events.ACHIEVEMENT_UNLOCKED, this._onAchievementUnlocked);
    if (Events.ITEM_LOST) Bus.subscribe(Events.ITEM_LOST, this._onItemLost);
    if (Events.PRESTIGE_DONE) Bus.subscribe(Events.PRESTIGE_DONE, this._onPrestigeDone);
    if (Events.GOLD_BONUS_COLLECTED) Bus.subscribe(Events.GOLD_BONUS_COLLECTED, this._onGoldBonusCollected);
  }

  /** Wołane WPROST z UIButton (ui.js) przy tapnięciu przycisku "denied" -
   * krótki, ostry impuls jako fizyczne "nie", obok już istniejącego
   * dźwięku odmowy (audio.js 'error'). */
  denied() {
    this._impactLight();
  }

  _impactLight() {
    if (window.NativeHaptics) window.NativeHaptics.impactLight();
  }

  _impactMedium() {
    if (window.NativeHaptics) window.NativeHaptics.impactMedium();
  }

  _impactHeavy() {
    if (window.NativeHaptics) window.NativeHaptics.impactHeavy();
  }

  _notifySuccess() {
    if (window.NativeHaptics) window.NativeHaptics.notifySuccess();
  }

  /** Usuwa subskrypcje z Bus - analogicznie do destroy() w AudioManager. */
  destroy() {
    Bus.unsubscribe(Events.UPGRADE_BOUGHT, this._onUpgradeBought);
    if (Events.ACHIEVEMENT_UNLOCKED) Bus.unsubscribe(Events.ACHIEVEMENT_UNLOCKED, this._onAchievementUnlocked);
    if (Events.ITEM_LOST) Bus.unsubscribe(Events.ITEM_LOST, this._onItemLost);
    if (Events.PRESTIGE_DONE) Bus.unsubscribe(Events.PRESTIGE_DONE, this._onPrestigeDone);
    if (Events.GOLD_BONUS_COLLECTED) Bus.unsubscribe(Events.GOLD_BONUS_COLLECTED, this._onGoldBonusCollected);
  }
}

window.HapticsManager = HapticsManager;
