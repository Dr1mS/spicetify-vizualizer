// SpectrumAnalyzer — instrument de diagnostic (canvas dédié, net, sans traînée).
//
// Barres = niveau BRUT par bande en dB (ce qui est réellement capté).
// Peak-hold = crête qui retombe lentement.
// Ligne = valeur post-AGC (ce que le VISUEL voit) -> compare capture vs mapping.
//
// But : répondre à "certains sons ne sont pas captés ?" — si une zone de
// fréquences reste plate ici alors que ça joue, c'est la CAPTURE, pas le rendu.

const DB_MIN = -90;
const DB_MAX = -20;
const LABELS = [30, 100, 300, 1000, 3000, 10000]; // Hz
const F_LO = 30;
const F_HI = 16000;

export class SpectrumAnalyzer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.dpr = 1;
    this.w = 0;
    this.h = 0;
    this.peaks = null; // peak-hold par bande (en fraction 0..1)
    this._onResize = () => this.resize();
    window.addEventListener("resize", this._onResize);
  }

  resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    this.w = rect.width;
    this.h = rect.height;
    this.canvas.width = this.w * this.dpr;
    this.canvas.height = this.h * this.dpr;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  static _magToFrac(mag) {
    const db = 20 * Math.log10(mag + 1e-12);
    return Math.min(1, Math.max(0, (db - DB_MIN) / (DB_MAX - DB_MIN)));
  }

  static _fToX(f, w) {
    return ((Math.log(f) - Math.log(F_LO)) / (Math.log(F_HI) - Math.log(F_LO))) * w;
  }

  render(frame) {
    if (!this.w) this.resize();
    const { ctx, w, h } = this;
    const mag = frame.bandsMag;
    const bands = frame.bands;
    if (!mag) return;
    const n = mag.length;
    if (!this.peaks || this.peaks.length !== n) this.peaks = new Float32Array(n);

    const padB = 16; // marge basse (labels Hz)
    const plotH = h - padB;

    ctx.clearRect(0, 0, w, h);

    // Fond + cadre.
    ctx.fillStyle = "rgba(8, 9, 16, 0.72)";
    ctx.fillRect(0, 0, w, h);

    // Grille dB horizontale.
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.fillStyle = "rgba(160,166,200,0.55)";
    ctx.font = "10px system-ui, sans-serif";
    ctx.lineWidth = 1;
    for (let db = DB_MAX; db >= DB_MIN; db -= 20) {
      const t = (db - DB_MIN) / (DB_MAX - DB_MIN);
      const y = plotH - t * plotH;
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(w, y + 0.5);
      ctx.stroke();
      ctx.fillText(db + " dB", 4, y + 11);
    }

    // Barres (niveau brut) + peak-hold.
    const bw = w / n;
    for (let i = 0; i < n; i++) {
      const frac = SpectrumAnalyzer._magToFrac(mag[i]);
      const x = i * bw;
      const bh = frac * plotH;
      const hue = (200 + (i / n) * 140) % 360;
      ctx.fillStyle = `hsl(${hue}, 85%, 55%)`;
      ctx.fillRect(x + 0.5, plotH - bh, bw - 1, bh);

      // peak-hold : monte instant, retombe lentement.
      this.peaks[i] = frac > this.peaks[i] ? frac : this.peaks[i] - 0.006;
      if (this.peaks[i] < 0) this.peaks[i] = 0;
      const py = plotH - this.peaks[i] * plotH;
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.fillRect(x + 0.5, py - 1, bw - 1, 1.5);
    }

    // Ligne "ce que voit le visuel" (post-AGC, 0..1) — repère de mapping.
    if (bands) {
      ctx.strokeStyle = "rgba(120, 240, 190, 0.9)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const x = i * bw + bw / 2;
        const y = plotH - bands[i] * plotH;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // Axe Hz.
    ctx.fillStyle = "rgba(180,186,220,0.7)";
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    for (const f of LABELS) {
      const x = SpectrumAnalyzer._fToX(f, w);
      ctx.beginPath();
      ctx.moveTo(x, plotH);
      ctx.lineTo(x, plotH + 4);
      ctx.stroke();
      const label = f >= 1000 ? f / 1000 + "k" : "" + f;
      ctx.fillText(label, x - 6, h - 3);
    }

    // Légende post-AGC.
    ctx.fillStyle = "rgba(120, 240, 190, 0.9)";
    ctx.fillText("— post-AGC (vu par le visuel)", w - 170, 12);
  }
}
