// loop.ts — boucle rAF : dt clampé, DPR≤2, résolution de SIM découplée du DPR.
// Le DPR ne s'applique QU'AU composite final ; la sim tourne en simW×simH.

export interface Viewport {
  cssW: number; cssH: number; // taille CSS (px logiques)
  dpr: number; // ≤ 2
  dispW: number; dispH: number; // pixels du canvas (css × dpr)
  simW: number; simH: number; // résolution de simulation (≤ fenêtre, JAMAIS ×DPR)
}

/**
 * Convertit un facteur de décroissance ÉCRIT POUR 60 fps en facteur compensé par dt.
 *
 * Sans ça, une traînée « qui dure 0,2 s » dure ce que dure une frame : quand
 * Chromium bride le rAF (fenêtre non focalisée, occultée, écran verrouillé —
 * mesuré à 1,3 Hz), un facteur de 0,93 par frame devient 0,93 PAR SECONDE et les
 * accumulations saturent en blanc au lieu de s'effacer. C'est le mode d'échec
 * signalé par « ça part en couille quand Spotify n'a pas le focus ».
 */
export function decayDt(decay60: number, dt: number, subSteps = 1, plancher = 0.45): number {
  const d = Math.min(0.9999, Math.max(0, decay60));
  const frames = (Math.min(Math.max(dt, 1 / 1000), 1) * 60) / Math.max(1, subSteps);
  // PLANCHER : au-delà d'un certain effondrement du frame rate, conserver l'énergie
  // exactement reviendrait à tout effacer entre deux images — mesuré : à 1,2 fps
  // (fenêtre non focalisée) l'écran devenait NOIR. Le plancher garde les traînées
  // visibles ; combiné au dépôt de gainDt(), l'état stationnaire à 1 fps retrouve
  // celui de 60 fps (≈14 g contre 14,3 g).
  return Math.max(plancher, Math.pow(d, frames));
}

/**
 * Facteur d'échelle du DÉPÔT additif, pendant `dt`, pour une valeur écrite à 60 fps.
 *
 * Complément indispensable de decayDt() : compenser seulement la décroissance rend
 * l'image NOIRE quand le frame rate s'effondre (mesuré : à 1 image/s, l'encre est
 * effacée à 98,7 % alors qu'on ne dépose qu'un soixantième de la matière). En
 * mettant à l'échelle les deux, l'énergie déposée PAR SECONDE reste constante et
 * l'image garde la même densité à 1, 30, 60 ou 144 fps.
 */
export function gainDt(gain60: number, dt: number, maxScale = 3): number {
  const scale = Math.min(maxScale, Math.max(0.2, Math.min(Math.max(dt, 1 / 1000), 1) * 60));
  return gain60 * scale;
}

export class RenderLoop {
  vp: Viewport = { cssW: 1, cssH: 1, dpr: 1, dispW: 1, dispH: 1, simW: 1, simH: 1 };
  private raf = 0;
  private last = 0;
  private _onResize?: (vp: Viewport) => void;

  private onWinResize = (): void => this.resize();

  constructor(public canvas: HTMLCanvasElement, public simScale = 0.75) {
    this.resize();
    addEventListener("resize", this.onWinResize);
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
    const v = this.vp;
    const change = v.dispW !== dispW || v.dispH !== dispH || v.simW !== simW || v.simH !== simH;
    this.vp = { cssW, cssH, dpr, dispW, dispH, simW, simH };
    // SORTIE ANTICIPÉE si rien n'a bougé : le callback détruit et réalloue le
    // tampon d'accumulation ET appelle Mode.resize(), qui remet la simulation à
    // zéro. Sans cette garde, replier la sidebar ou ouvrir le panneau « en cours
    // de lecture » effaçait l'image alors que le canvas n'avait pas changé de
    // taille — et en mode fond (canvas 100vw x 100vh) il ne change JAMAIS.
    if (!change) return;
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

  // stop() doit AUSSI retirer l'écouteur : la boucle est montée/démontée à chaque
  // navigation dans le client Spotify, sinon chaque montage laisse un écouteur
  // qui redimensionne un canvas mort.
  stop(): void { cancelAnimationFrame(this.raf); removeEventListener("resize", this.onWinResize); }
}
