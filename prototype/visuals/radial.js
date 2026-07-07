// RadialVisual — anneau de bandes LOG + noyau + bursts sur onsets.
// Piloté par les features musicales (audio.js), pas par des bins FFT bruts.
//   bands[]  -> anneau (axe log : les médiums/aigus respirent enfin)
//   bass     -> taille du noyau
//   onset    -> flash de l'anneau ; onsetFlag -> burst de particules
//   centroid -> teinte (brillance du son -> couleur)

export class RadialVisual {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.started = false;
    this.w = 0;
    this.h = 0;
    this.dpr = 1;
    this.particles = [];
    this.t = 0;
    this.hue = 220;
    this._onResize = () => this.resize();
  }

  start() {
    this.started = true;
    this.resize();
    window.addEventListener("resize", this._onResize);
  }

  resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.canvas.width = this.w * this.dpr;
    this.canvas.height = this.h * this.dpr;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  render(frame) {
    const { ctx, w, h } = this;
    this.t += 0.006;

    // Teinte pilotée par la brillance réelle (centroïde), rotation lente.
    const targetHue = 200 + frame.centroid * 140;
    this.hue += (targetHue - this.hue) * 0.05 + 0.1;

    // Traînée (rémanence).
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "rgba(5, 6, 10, 0.16)";
    ctx.fillRect(0, 0, w, h);

    const cx = w / 2;
    const cy = h / 2;
    const baseR = Math.min(w, h) * 0.17;

    ctx.globalCompositeOperation = "lighter";
    this._drawCore(cx, cy, baseR, frame);
    this._drawBands(cx, cy, baseR, frame);
    if (frame.kickFlag || frame.onsetFlag) this._burst(cx, cy, baseR, frame);
    this._drawParticles();
    ctx.globalCompositeOperation = "source-over";
  }

  _drawCore(cx, cy, baseR, frame) {
    const { ctx } = this;
    const r = baseR * (0.55 + frame.bass * 1.2 + frame.kick * 0.8 + frame.onset * 0.3);
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    const hue = this.hue % 360;
    g.addColorStop(0, `hsla(${hue}, 90%, 72%, ${0.45 + frame.level * 0.55})`);
    g.addColorStop(0.5, `hsla(${(hue + 40) % 360}, 90%, 55%, 0.22)`);
    g.addColorStop(1, "hsla(0,0%,0%,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  _drawBands(cx, cy, baseR, frame) {
    const { ctx } = this;
    const bands = frame.bands;
    const n = bands.length;
    const rot = this.t * 0.25;
    const glow = frame.onset; // l'onset "flashe" tout l'anneau

    // Anneau miroir : n bandes déployées sur les deux moitiés.
    for (let i = 0; i < n; i++) {
      const v = bands[i];
      const len = baseR * (0.2 + v * 2.4);
      for (const dir of [1, -1]) {
        const a = rot + dir * (i / n) * Math.PI - Math.PI / 2;
        const x0 = cx + Math.cos(a) * baseR;
        const y0 = cy + Math.sin(a) * baseR;
        const x1 = cx + Math.cos(a) * (baseR + len);
        const y1 = cy + Math.sin(a) * (baseR + len);
        const hue = (this.hue + i * 2.2) % 360;
        const light = 45 + v * 35 + glow * 15;
        ctx.strokeStyle = `hsla(${hue}, 95%, ${light}%, ${0.3 + v * 0.6 + glow * 0.3})`;
        ctx.lineWidth = 2 + v * 3;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      }
    }
  }

  _burst(cx, cy, baseR, frame) {
    const energy = Math.max(frame.onset, frame.kick);
    const count = 16 + Math.floor(energy * 28);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const speed = 2 + Math.random() * 4 + frame.bass * 5;
      this.particles.push({
        x: cx + Math.cos(a) * baseR,
        y: cy + Math.sin(a) * baseR,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed,
        life: 1,
        hue: (this.hue + Math.random() * 60) % 360,
        size: 1.5 + Math.random() * 2.5,
      });
    }
    if (this.particles.length > 1400) this.particles.splice(0, this.particles.length - 1400);
  }

  _drawParticles() {
    const { ctx } = this;
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vx *= 0.96;
      p.vy *= 0.96;
      p.life -= 0.012;
      if (p.life <= 0) {
        this.particles.splice(i, 1);
        continue;
      }
      ctx.fillStyle = `hsla(${p.hue}, 95%, 65%, ${p.life})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
