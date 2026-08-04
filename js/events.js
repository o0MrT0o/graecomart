'use strict';

/**
 * events.js
 * ------------------------------------------------------------------------
 * Wydarzenie sezonowe "Deszcz Meteorytów" (Tomek: "sezonowe wydarzenie z
 * unikalną dekoracją, ale coś fajnego"). Gra nie ma backendu/serwera, więc
 * nie ma jak wypchnąć PRAWDZIWEGO, zaplanowanego z góry wydarzenia (skoń-
 * czyłoby się kiedyś i wymagało ręcznej aktualizacji kodu na kolejne) -
 * zamiast tego cykliczne, oparte o dzień tygodnia URZĄDZENIA gracza
 * (sobota/niedziela) - zawsze świeże, zero konserwacji, zero serwera.
 *
 * Efekty podczas wydarzenia:
 *   - spadające gwiazdy na niebie - czysto atmosferyczne, ekranowa warstwa
 *     UI (drawLayer='ui', ten sam wzorzec co minimap.js) - NIE są częścią
 *     świata (nie przesuwają się z kamerą), tak jak prawdziwe niebo.
 *   - Złoty Bonus (goldbonus.js) spawnuje 2x częściej - czyta isActive()
 *     stąd, żeby "deszcz" faktycznie czuć w rozgrywce, nie tylko na oko.
 *   - ekskluzywny skin "Meteorytowy" (economy.js: PLAYER_SKINS, eventOnly)
 *     kupowalny WYŁĄCZNIE gdy wydarzenie trwa - raz kupiony, zostaje na
 *     zawsze jak każdy inny skin (unlockedSkins nie jest zerowane).
 *   - +15% do cen na targu (market.js: MARKET_SEASONAL_PRICE_MULT, czyta
 *     isActive() stąd) - realna, ekonomiczna nagroda za granie akurat w te
 *     dni, nie tylko kosmetyka/RNG (Tomek: "wyzwania sezonowe z realną
 *     nagrodą").
 */

const EVENT_STREAK_SPAWN_MIN_MS = 2800;
const EVENT_STREAK_SPAWN_MAX_MS = 5500;
const EVENT_STREAK_LIFETIME_MS = 900;
const EVENT_STREAK_LENGTH = 90;

class SeasonalEventManager {
  constructor() {
    // Ekran (nie świat) - ten sam powód co minimap.js: efekt ma trzymać się
    // widoku gracza jak prawdziwe niebo, nie przesuwać się z kamerą po mapie.
    this.drawLayer = 'ui';

    // Liczony RAZ przy starcie (nie co klatkę) - dzień tygodnia nie zmienia
    // się w trakcie sesji, więc nie ma sensu odpytywać Date() bez przerwy.
    this._active = this._computeActive();
    this._streaks = [];
    this._msUntilNextStreak = this._rollStreakDelay();
  }

  _computeActive() {
    const day = new Date().getDay(); // 0 = niedziela, 6 = sobota
    return day === 0 || day === 6;
  }

  isActive() {
    return this._active;
  }

  _rollStreakDelay() {
    return EVENT_STREAK_SPAWN_MIN_MS + Math.random() * (EVENT_STREAK_SPAWN_MAX_MS - EVENT_STREAK_SPAWN_MIN_MS);
  }

  update(delta) {
    if (!this._active) return;

    this._msUntilNextStreak -= delta;
    if (this._msUntilNextStreak <= 0) {
      this._msUntilNextStreak = this._rollStreakDelay();
      // Start w górnej połowie ekranu, kąt lekko losowy wokół "z góry w dół
      // po skosie" - klasyczny wygląd spadającej gwiazdy, nie pionowy deszcz.
      this._streaks.push({
        x: Math.random() * window.innerWidth,
        y: Math.random() * window.innerHeight * 0.45,
        angle: Math.PI * 0.72 + (Math.random() - 0.5) * 0.3,
        age: 0
      });
    }

    this._streaks.forEach((s) => { s.age += delta; });
    if (this._streaks.some((s) => s.age >= EVENT_STREAK_LIFETIME_MS)) {
      this._streaks = this._streaks.filter((s) => s.age < EVENT_STREAK_LIFETIME_MS);
    }
  }

  /**
   * Smuga gwiazdy - gradient linii (przezroczysty ogon -> jasna głowa) +
   * jasny punkt na czubku, ten sam "warstwowa alfa zamiast shadowBlur"
   * pomysł co reszta gry (patrz minimap.js/market.js). Głowa "leci" wzdłuż
   * kąta w miarę starzenia się smugi (age/LIFETIME), więc gwiazda faktycznie
   * przemieszcza się po niebie, nie tylko pojawia/znika w miejscu.
   */
  draw(ctxBg, ctx, ctxUI) {
    if (!this._active || this._streaks.length === 0) return;

    this._streaks.forEach((s) => {
      const t = s.age / EVENT_STREAK_LIFETIME_MS;
      const alpha = t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85;
      const dx = Math.cos(s.angle);
      const dy = Math.sin(s.angle);
      const travel = EVENT_STREAK_LENGTH * 2.2 * t;
      const headX = s.x + dx * travel;
      const headY = s.y + dy * travel;
      const tailX = headX - dx * EVENT_STREAK_LENGTH;
      const tailY = headY - dy * EVENT_STREAK_LENGTH;

      const grad = ctxUI.createLinearGradient(tailX, tailY, headX, headY);
      grad.addColorStop(0, 'rgba(255, 255, 255, 0)');
      grad.addColorStop(1, `rgba(255, 255, 255, ${alpha})`);
      ctxUI.strokeStyle = grad;
      ctxUI.lineWidth = 2;
      ctxUI.lineCap = 'round';
      ctxUI.beginPath();
      ctxUI.moveTo(tailX, tailY);
      ctxUI.lineTo(headX, headY);
      ctxUI.stroke();

      ctxUI.fillStyle = `rgba(255, 255, 255, ${Math.min(1, alpha * 1.3)})`;
      ctxUI.beginPath();
      ctxUI.arc(headX, headY, 1.8, 0, Math.PI * 2);
      ctxUI.fill();
    });
  }

  destroy() {}
}

window.SeasonalEventManager = SeasonalEventManager;
