// Mode.ts — contrat de mode. Chaque mode écrit une DENSITÉ COLORÉE dans le
// buffer `scene` (résolution de sim) ; main.ts la tonemappe vers l'écran.
import type { Caps } from "../core/caps";
import type { FeatureTexture } from "../core/featureTexture";
import type { ModMatrix } from "../modmatrix/matrix";
import type { BusFrame } from "../audio/bus";
import type { Viewport } from "../core/loop";

export interface Resources {
  gl: WebGL2RenderingContext;
  caps: Caps;
  feat: FeatureTexture;
  matrix: ModMatrix;
}

export type Family = "continuous" | "density" | "growth";

export interface Mode {
  id: string;
  family: Family;
  init(res: Resources, vp: Viewport): void;
  resize(vp: Viewport): void;
  update(fr: BusFrame, dt: number, time: number): void;
  render(target: WebGLFramebuffer | null, w: number, h: number): void;
  reset(): void;
  dispose(): void;
}
