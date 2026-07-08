// registry.ts — enregistrement + hot-swap des modes (garde l'ancien si l'init échoue).
import type { Mode, Resources } from "./Mode";
import type { Viewport } from "../core/loop";
import type { BusFrame } from "../audio/bus";
import { FHNMode } from "./fhn";
import { DeJongMode } from "./dejong";
import { SpaceColMode } from "./spacecol";

const FACTORIES: Array<{ id: string; make: () => Mode }> = [
  { id: "fhn", make: () => new FHNMode() },
  { id: "dejong", make: () => new DeJongMode() },
  { id: "spacecol", make: () => new SpaceColMode() },
];

export class ModeRegistry {
  current: Mode;
  index = 0;
  constructor(private res: Resources, private vp: Viewport) {
    this.current = FACTORIES[0].make();
    this.current.init(res, vp);
  }
  get names(): string[] { return FACTORIES.map((f) => f.id); }

  switch(i: number): void {
    if (i === this.index || i < 0 || i >= FACTORIES.length) return;
    const next = FACTORIES[i].make();
    try { next.init(this.res, this.vp); } // compilation hors-critique
    catch (e) { console.error("[mode] init échouée:", e); try { next.dispose(); } catch { /* */ } return; }
    const prev = this.current;
    this.current = next; this.index = i;
    prev.dispose(); // (crossfade possible ici ; swap simple pour l'instant)
  }
  resize(vp: Viewport): void { this.vp = vp; this.current.resize(vp); }
  update(fr: BusFrame, dt: number, time: number): void { this.current.update(fr, dt, time); }
  render(target: WebGLFramebuffer | null, w: number, h: number): void { this.current.render(target, w, h); }
}
