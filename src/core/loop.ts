// loop.ts — boucle rAF : dt clampé, DPR≤2, résolution de SIM découplée du DPR.
// Le DPR ne s'applique QU'AU composite final ; la sim tourne en simW×simH.

export interface Viewport {
  cssW: number; cssH: number; // taille CSS (px logiques)
  dpr: number; // ≤ 2
  dispW: number; dispH: number; // pixels du canvas (css × dpr)
  simW: number; simH: number; // résolution de simulation (≤ fenêtre, JAMAIS ×DPR)
}

export class RenderLoop {
  vp: Viewport = { cssW: 1, cssH: 1, dpr: 1, dispW: 1, dispH: 1, simW: 1, simH: 1 };
  private raf = 0;
  private last = 0;
  private _onResize?: (vp: Viewport) => void;

  constructor(public canvas: HTMLCanvasElement, public simScale = 0.75) {
    this.resize();
    addEventListener("resize", () => this.resize());
  }

  onResize(cb: (vp: Viewport) => void): void { this._onResize = cb; cb(this.vp); }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = this.canvas.clientWidth || window.innerWidth;
    const cssH = this.canvas.clientHeight || window.innerHeight;
    const dispW = Math.max(1, Math.round(cssW * dpr));
    const dispH = Math.max(1, Math.round(cssH * dpr));
    this.canvas.width = dispW;
    this.canvas.height = dispH;
    const simW = Math.max(1, Math.round(cssW * this.simScale));
    const simH = Math.max(1, Math.round(cssH * this.simScale));
    this.vp = { cssW, cssH, dpr, dispW, dispH, simW, simH };
    this._onResize?.(this.vp);
  }

  start(cb: (dt: number, time: number, vp: Viewport) => void): void {
    const tick = (t: number) => {
      this.raf = requestAnimationFrame(tick);
      const time = t / 1000;
      let dt = this.last ? time - this.last : 1 / 60;
      this.last = time;
      dt = Math.min(dt, 1 / 20); // clamp (évite les explosions après un stall)
      cb(dt, time, this.vp);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop(): void { cancelAnimationFrame(this.raf); }
}
