// Spectrogram — vue temps-fréquence défilante (diagnostic).
//
// Chaque frame = une colonne de 1px à droite ; l'image défile vers la gauche.
// Axe Y = fréquence (log, grave en bas), couleur = niveau BRUT (dB) par bande.
//
// Lecture du bug intermittent : une COLONNE NOIRE pendant que la musique joue
// = le signal ne parvient pas au navigateur (coupure de capture PipeWire/FF),
// PAS un problème de rendu. Si au contraire les colonnes restent colorées mais
// le visuel ne réagit pas, c'est le mapping.

const DB_MIN = -90;
const DB_MAX = -20;

export class Spectrogram {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.buf = document.createElement("canvas");
    this.bufCtx = this.buf.getContext("2d");
    this.w = 0;
    this.h = 0;
    this._onResize = () => this.resize();
    window.addEventListener("resize", this._onResize);
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.w = Math.max(1, Math.floor(rect.width));
    this.h = Math.max(1, Math.floor(rect.height));
    this.canvas.width = this.w;
    this.canvas.height = this.h;
    this.buf.width = this.w;
    this.buf.height = this.h;
    this.ctx.fillStyle = "#05060a";
    this.ctx.fillRect(0, 0, this.w, this.h);
  }

  // Heat map : noir -> bleu -> magenta -> jaune -> blanc.
  static _heat(t) {
    if (t <= 0) return "#05060a";
    const hue = (1 - t) * 250; // 250=bleu -> 0=rouge
    const light = Math.min(60, t * 65);
    return `hsl(${hue}, 95%, ${light}%)`;
  }

  render(frame) {
    if (!this.w) this.resize();
    const { ctx, bufCtx, w, h } = this;
    const mag = frame.bandsMag;
    if (!mag) return;
    const n = mag.length;

    // Décalage vers la gauche via un buffer hors-écran (sans artefact).
    bufCtx.clearRect(0, 0, w, h);
    bufCtx.drawImage(this.canvas, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(this.buf, -1, 0);

    // Nouvelle colonne à droite.
    const cellH = h / n;
    for (let i = 0; i < n; i++) {
      const db = 20 * Math.log10(mag[i] + 1e-12);
      const t = Math.min(1, Math.max(0, (db - DB_MIN) / (DB_MAX - DB_MIN)));
      ctx.fillStyle = Spectrogram._heat(t);
      const y = h - (i + 1) * cellH;
      ctx.fillRect(w - 1, y, 1, Math.ceil(cellH) + 1);
    }
  }
}
