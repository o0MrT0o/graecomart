'use strict';

/**
 * gamefeel.js
 * ------------------------------------------------------------------------
 * Efekty wizualne na warstwie UI canvas: cząsteczki, unoszące się teksty.
 */

const FEEL_PARTICLE_GRAVITY = 280;
const FEEL_PARTICLE_DRAG = 0.96;
const FEEL_POPUP_RISE_SPEED = 42;
const FEEL_POPUP_FADE_MS = 900;

// Twarde sufity na liczbę jednoczesnych efektów - żywotność każdej cząstki/
// popupu i tak jest krótka (patrz update()), więc w normalnej rozgrywce nigdy
// się do tego nie zbliżamy. To czysto zabezpieczenie na wypadek patologicznego
// nagromadzenia zdarzeń (np. wiele maszyn kończących produkcję w tej samej
// sekundzie na słabym telefonie, gdzie klatki są rzadsze niż tempo spawnów) -
// bez sufitu tablice rosłyby bez ograniczeń, każda dodatkowa cząstka to kolejny
// drawImage() w draw() poniżej, więc runaway wzrost wprost przekłada się na
// coraz gorsze FPS w najgorszym możliwym momencie.
const FEEL_MAX_PARTICLES = 160;
const FEEL_MAX_POPUPS = 40;

class GameFeel {
  constructor() {
    this.drawLayer = 'gameplay';
    this.particles = [];
    this.popups = [];
    this.shockwaves = [];

    this._onParticles = (data) => this._spawnParticles(data);
    this._onPopup = (data) => this._spawnPopup(data);
    this._onShockwave = (data) => this._spawnShockwave(data);

    Bus.subscribe(Events.FX_PARTICLES, this._onParticles);
    Bus.subscribe(Events.FX_POPUP, this._onPopup);
    if (Events.FX_SHOCKWAVE) Bus.subscribe(Events.FX_SHOCKWAVE, this._onShockwave);
  }

  _spawnParticles(data) {
    const x = (data && data.x) || 0;
    const y = (data && data.y) || 0;
    const color = (data && data.color) || '#FFD700';
    const count = Math.min(24, (data && data.count) || 6);

    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 40 + Math.random() * 90;
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 30,
        life: 0.4 + Math.random() * 0.5,
        maxLife: 0.4 + Math.random() * 0.5,
        size: 3 + Math.random() * 4,
        color
      });
    }

    if (this.particles.length > FEEL_MAX_PARTICLES) {
      this.particles.splice(0, this.particles.length - FEEL_MAX_PARTICLES);
    }
  }

  /**
   * Ekspandujący, zanikający pierścień - wizualnie odrębny od zwykłych
   * cząsteczek (drobne, rozlatujące się kropki), celowo zarezerwowany dla
   * RZADKICH, ważnych momentów (np. ukończenie modułu statku), żeby nie
   * spłaszczyć się do "kolejnego efektu" przez nadużycie przy byle okazji.
   */
  _spawnShockwave(data) {
    this.shockwaves.push({
      x: (data && data.x) || 0,
      y: (data && data.y) || 0,
      color: (data && data.color) || '#FFD700',
      maxRadius: (data && data.maxRadius) || 100,
      radius: 8,
      life: 0.55,
      maxLife: 0.55
    });
  }

  _spawnPopup(data) {
    if (!data || !data.text) return;
    this.popups.push({
      text: data.text,
      // Ikona rysowana PROCEDURALNIE nad tekstem (patrz _drawPopupIcon) -
      // zamiast dawnego emoji wtopionego w text (⚠️/💢/✅/🔥) - fillText()
      // z emoji polegał na podstawianiu systemowej czcionki emoji, co dawało
      // inny styl niż reszta gry. null = brak ikony (większość popupów).
      icon: data.icon || null,
      x: typeof data.x === 'number' ? data.x : null,
      y: typeof data.y === 'number' ? data.y : null,
      color: data.color || '#FFD700',
      duration: data.duration || FEEL_POPUP_FADE_MS,
      age: 0,
      scale: 0.6
    });

    if (this.popups.length > FEEL_MAX_POPUPS) {
      this.popups.splice(0, this.popups.length - FEEL_MAX_POPUPS);
    }
  }

  update(delta) {
    const sec = delta / 1000;

    this.particles = this.particles.filter((p) => {
      p.life -= sec;
      if (p.life <= 0) return false;
      p.vy += FEEL_PARTICLE_GRAVITY * sec;
      p.vx *= FEEL_PARTICLE_DRAG;
      p.vy *= FEEL_PARTICLE_DRAG;
      p.x += p.vx * sec;
      p.y += p.vy * sec;
      return true;
    });

    this.popups = this.popups.filter((p) => {
      p.age += delta;
      if (p.age < 120) {
        p.scale = Math.min(1.1, p.scale + sec * 4);
      } else {
        p.scale = Math.max(0.85, p.scale - sec * 0.5);
      }
      if (p.x !== null) p.y -= FEEL_POPUP_RISE_SPEED * sec;
      return p.age < p.duration;
    });

    this.shockwaves = this.shockwaves.filter((s) => {
      s.life -= sec;
      if (s.life <= 0) return false;
      const t = 1 - Math.max(0, s.life / s.maxLife);
      s.radius = 8 + t * (s.maxRadius - 8);
      return true;
    });
  }

  /**
   * Tonuje prawdziwą, miękką teksturkę blasku (fx_glow.png, Kenney Particle
   * Pack CC0 - ta sama grafika co poświata pod maszynami, machines.js
   * _drawCosmicGlow) na dowolny kolor cząsteczki, techniką "source-atop"
   * (jak tint skinów gracza w player.js) - zamiast płaskiego wypełnionego
   * kółka. Cache'owany per DOKŁADNY string koloru (hex ALBO rgba - obojętne,
   * oba są poprawnym fillStyle), więc każdy unikalny kolor liczy się raz,
   * nie co klatkę/cząsteczkę. Własna kopia (nie import z machines.js) zgodnie
   * z konwencją "brak współdzielonych utili" w tym projekcie.
   */
  _getTintedGlow(color) {
    this._glowCache = this._glowCache || {};
    if (this._glowCache[color]) return this._glowCache[color];
    const img = window.spriteLoader && window.spriteLoader.get('fx_glow');
    if (!img || !img.complete || !img.naturalWidth) return null;
    const size = img.naturalWidth;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const tctx = canvas.getContext('2d');
    tctx.drawImage(img, 0, 0);
    tctx.globalCompositeOperation = 'source-atop';
    tctx.fillStyle = color;
    tctx.fillRect(0, 0, size, size);
    this._glowCache[color] = canvas;
    return canvas;
  }

  draw(ctxBg, ctx, ctxUI) {
    const target = ctx;

    this.particles.forEach((p) => {
      const alpha = Math.max(0, p.life / p.maxLife);
      const glow = this._getTintedGlow(p.color);
      if (glow) {
        const r = p.size * alpha * 2.1;
        target.globalAlpha = alpha * 0.9;
        target.drawImage(glow, p.x - r, p.y - r, r * 2, r * 2);
        target.globalAlpha = 1;
      } else {
        target.fillStyle = ItemRenderer.withAlpha(p.color, alpha * 0.85);
        target.beginPath();
        target.arc(p.x, p.y, p.size * alpha, 0, Math.PI * 2);
        target.fill();
      }
    });

    this.shockwaves.forEach((s) => {
      const t = Math.max(0, s.life / s.maxLife);
      target.save();
      target.globalAlpha = t * 0.75;
      target.strokeStyle = s.color;
      target.lineWidth = 2 + t * 4;
      target.beginPath();
      target.arc(s.x, s.y, s.radius, 0, Math.PI * 2);
      target.stroke();
      target.restore();
    });

    this.popups.forEach((p) => {
      const t = p.age / p.duration;
      const alpha = 1 - t;
      // BUGFIX: ctx (=target) jest już przesunięty o -cameraX/-cameraY (ta
      // metoda jest wołana WEWNĄTRZ tej translacji, patrz game.js draw()) -
      // "środek ekranu" w WSPÓŁRZĘDNYCH ŚWIATA to więc cameraX/Y + połowa
      // SZEROKOŚCI EKRANU, NIE sam canvas.width/2. Bez tego dodania popup bez
      // jawnego x/y (np. ostrzeżenie o strefie w player.js, zanim to
      // naprawiliśmy tam osobno) renderował się w STAŁYM punkcie świata - w
      // praktyce gdziekolwiek akurat ten punkt wypadał względem kamery,
      // kompletnie niezależnie od tego, gdzie w danej chwili jest gracz/kamera.
      // window.innerWidth/innerHeight (logiczne piksele CSS), NIE
      // canvas.width/height - od fixu DPR w game.js (resize()) to ostatnie to
      // fizyczne piksele bufora (dpr-krotnie większe niż ekran).
      const camX = window.game ? window.game.cameraX : 0;
      const camY = window.game ? window.game.cameraY : 0;
      const cx = p.x !== null ? p.x : camX + window.innerWidth / 2;
      const cy = p.y !== null ? p.y - 20 : camY + window.innerHeight * 0.38;

      target.save();
      target.translate(cx, cy);
      target.scale(p.scale, p.scale);
      target.globalAlpha = alpha;
      target.font = 'bold 22px "Segoe UI", Arial, sans-serif';
      target.textAlign = 'center';
      target.textBaseline = 'middle';

      // BUGFIX: ostrzeżenia stref (player.js, np. "Strefa Skażenia - bez
      // Filtra Toksyn stracisz przedmiot!") to pełne zdania - jedna linia w
      // tym foncie wychodzi grubo ponad szerokość telefonu i uciekała za oba
      // brzegi ekranu. Reszta popupów w grze ("+50" itp.) to pojedyncze
      // krótkie słowa/liczby, więc zawijanie ich nie dotyczy (zawsze 1 linia).
      const maxWidth = (window.innerWidth || 400) * 0.84;
      const lines = this._wrapPopupLines(target, p.text, maxWidth);
      const lineHeight = 25;
      const startY = -((lines.length - 1) * lineHeight) / 2;

      if (p.icon) {
        target.save();
        target.translate(0, startY);
        this._drawPopupIcon(target, p.icon, p.color);
        target.restore();
      }

      lines.forEach((line, i) => {
        const ly = startY + i * lineHeight;
        target.fillStyle = 'rgba(0,0,0,0.45)';
        target.fillText(line, 2, ly + 2);
        target.fillStyle = p.color;
        target.fillText(line, 0, ly);
      });
      target.restore();
    });
  }

  /** Dzieli tekst na linie nieprzekraczające maxWidth (mierzone aktualnym
   * ctx.font) łamiąc po spacjach - pojedyncze słowo dłuższe niż maxWidth
   * zostaje na swojej linii bez łamania (w praktyce nie występuje w tekstach
   * gry). */
  _wrapPopupLines(ctx, text, maxWidth) {
    const words = String(text).split(' ');
    const lines = [];
    let current = '';
    words.forEach((word) => {
      const test = current ? `${current} ${word}` : word;
      if (current && ctx.measureText(test).width > maxWidth) {
        lines.push(current);
        current = word;
      } else {
        current = test;
      }
    });
    if (current) lines.push(current);
    return lines;
  }

  /**
   * Mała ikona rysowana proceduralnie NAD tekstem popupu (przesunięcie w
   * górę o 18px, ten sam punkt (0,0) już przesunięty/przeskalowany przez
   * wywołującego) - zastępuje dawne emoji wtopione wprost w string tekstu
   * (⚠️ ostrzeżenie, 💢 utracono, ✅ gotowe, 🔥 combo). Woła się TYLKO gdy
   * popup faktycznie ma icon (patrz _spawnPopup) - reszta (większość
   * popupów w grze, np. zwykłe "+50") nadal nie rysuje nic ponad tekstem.
   */
  _drawPopupIcon(ctx, iconKey, color) {
    const s = 8;
    ctx.save();
    ctx.translate(0, -18);
    if (iconKey === 'warning') {
      // Trójkąt ostrzegawczy z wykrzyknikiem - hazard w player.js.
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(0, -s);
      ctx.lineTo(s, s);
      ctx.lineTo(-s, s);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.fillRect(-1.3, -s * 0.3, 2.6, s * 0.7);
      ctx.beginPath();
      ctx.arc(0, s * 0.62, 1.5, 0, Math.PI * 2);
      ctx.fill();
    } else if (iconKey === 'lost') {
      // X - utrata przedmiotu w hazardzie (player.js).
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-s * 0.7, -s * 0.7);
      ctx.lineTo(s * 0.7, s * 0.7);
      ctx.moveTo(s * 0.7, -s * 0.7);
      ctx.lineTo(-s * 0.7, s * 0.7);
      ctx.stroke();
    } else if (iconKey === 'done') {
      // Checkmark w kółku - moduł statku ukończony (ship.js).
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.arc(0, 0, s, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-s * 0.45, 0);
      ctx.lineTo(-s * 0.1, s * 0.4);
      ctx.lineTo(s * 0.5, -s * 0.4);
      ctx.stroke();
    } else if (iconKey === 'flame') {
      // Płomień - combo sprzedaży (economy.js).
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(0, -s);
      ctx.bezierCurveTo(s * 0.8, -s * 0.2, s * 0.5, s * 0.6, 0, s);
      ctx.bezierCurveTo(-s * 0.5, s * 0.6, -s * 0.8, -s * 0.2, 0, -s);
      ctx.closePath();
      ctx.fill();
    } else if (iconKey === 'star') {
      // Gwiazdka - Złoty Bonus (economy.js: collectGoldBonus). 5-ramienna,
      // ten sam prosty "wypełniony kształt" jak flame wyżej, nie kontur.
      ctx.fillStyle = color;
      ctx.beginPath();
      for (let i = 0; i < 5; i++) {
        const outerA = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
        const innerA = outerA + Math.PI / 5;
        const ox = Math.cos(outerA) * s;
        const oy = Math.sin(outerA) * s;
        const ix = Math.cos(innerA) * s * 0.42;
        const iy = Math.sin(innerA) * s * 0.42;
        if (i === 0) ctx.moveTo(ox, oy);
        else ctx.lineTo(ox, oy);
        ctx.lineTo(ix, iy);
      }
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  destroy() {
    Bus.unsubscribe(Events.FX_PARTICLES, this._onParticles);
    Bus.unsubscribe(Events.FX_POPUP, this._onPopup);
    if (Events.FX_SHOCKWAVE) Bus.unsubscribe(Events.FX_SHOCKWAVE, this._onShockwave);
  }
}

window.GameFeel = GameFeel;
