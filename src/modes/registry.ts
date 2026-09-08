// registry.ts — enregistrement + hot-swap des modes (garde l'ancien si l'init échoue).
import type { Mode, Resources } from "./Mode";
import type { Viewport } from "../core/loop";
import type { BusFrame } from "../audio/bus";
import { FHNMode } from "./fhn";
import { DeJongMode } from "./dejong";
import { SpaceColMode } from "./spacecol";
import { KuramotoMode } from "./kuramoto";
import { GreenbergMode } from "./greenberg";
import { SmoothLifeMode } from "./smoothlife";
import { LeniaMode } from "./lenia";
import { CliffordMode } from "./clifford";
import { ThomasMode } from "./thomas";
import { AizawaMode } from "./aizawa";
import { ChladniMode } from "./chladni";
import { KifsMode } from "./kifs";
import { DiffGrowthMode } from "./diffgrowth";
import { NeuralCAMode } from "./neuralca";
import { GrayScottMode } from "./grayscott";
import { IsingMode } from "./ising";
import { BuddhabrotMode } from "./buddhabrot";
import { NBodyMode } from "./nbody";
import { DbmMode } from "./dbm";
import { HocketMode } from "./hocket";
import { CombMode } from "./comb";
import { StitchMode } from "./stitch";
import { AnamneseMode } from "./anamnese";
import { SymbioseMode } from "./symbiose";

const FACTORIES: Array<{ id: string; make: () => Mode }> = [
  { id: "fhn", make: () => new FHNMode() },
  { id: "dejong", make: () => new DeJongMode() },
  { id: "spacecol", make: () => new SpaceColMode() },
  { id: "kuramoto", make: () => new KuramotoMode() },
  { id: "greenberg", make: () => new GreenbergMode() },
  { id: "smoothlife", make: () => new SmoothLifeMode() },
  { id: "lenia", make: () => new LeniaMode() },
  { id: "clifford", make: () => new CliffordMode() },
  { id: "thomas", make: () => new ThomasMode() },
  { id: "aizawa", make: () => new AizawaMode() },
  { id: "chladni", make: () => new ChladniMode() },
  { id: "kifs", make: () => new KifsMode() },
  { id: "diffgrowth", make: () => new DiffGrowthMode() },
  { id: "grayscott", make: () => new GrayScottMode() },
  { id: "neuralca", make: () => new NeuralCAMode() },
  { id: "ising", make: () => new IsingMode() },
  { id: "buddhabrot", make: () => new BuddhabrotMode() },
  { id: "nbody", make: () => new NBodyMode() },
  { id: "dbm", make: () => new DbmMode() },
  // --- créations maison (pas des systèmes du catalogue) ---
  { id: "hocket", make: () => new HocketMode() },
  { id: "comb", make: () => new CombMode() },
  { id: "stitch", make: () => new StitchMode() },
  { id: "anamnese", make: () => new AnamneseMode() },
  { id: "symbiose", make: () => new SymbioseMode() },
];

export class ModeRegistry {
  current: Mode;
  index = 0;
  constructor(private res: Resources, private vp: Viewport) {
    this.current = FACTORIES[0].make();
    this.current.init(res, vp);
  }
  get names(): string[] { return FACTORIES.map((f) => f.id); }
  get count(): number { return FACTORIES.length; }

  switch(i: number): void {
    if (i === this.index || i < 0 || i >= FACTORIES.length) return;
    const next = FACTORIES[i].make();
    try { next.init(this.res, this.vp); }
    catch (e) { console.error(`[mode] init "${FACTORIES[i].id}" échouée:`, e); try { next.dispose(); } catch { /* */ } return; }
    const prev = this.current;
    this.current = next; this.index = i;
    prev.dispose();
  }
  cycle(dir: number): void { this.switch((this.index + dir + FACTORIES.length) % FACTORIES.length); }
  resize(vp: Viewport): void { this.vp = vp; this.current.resize(vp); }
  update(fr: BusFrame, dt: number, time: number): void { this.current.update(fr, dt, time); }
  render(target: WebGLFramebuffer | null, w: number, h: number): void { this.current.render(target, w, h); }
}
