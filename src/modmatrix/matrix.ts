// matrix.ts — ModMatrix : détient routes + registre de cibles, applique chaque
// frame, éditable À CHAUD, persistée (localStorage). C'est LE point de tuning.
import type { BusFrame } from "../audio/bus";
import { applyRoutes, busFeatures, type SmoothState } from "./apply";
import { buildTargets } from "./targets";
import defaultRoutes from "./routes.default.json";
import type { Route, Targets } from "./types";

const STORAGE = "viz.routes.v1";

export class ModMatrix {
  targets: Targets = buildTargets();
  routes: Route[] = [];
  private sm: SmoothState = new Map();

  constructor() { this.load(); }

  load(): void {
    let saved: Route[] | null = null;
    try { saved = JSON.parse(localStorage.getItem(STORAGE) || "null"); } catch { /* ignore */ }
    this.routes = (saved ?? (defaultRoutes as Route[])).map((r) => ({ ...r }));
  }
  save(): void { try { localStorage.setItem(STORAGE, JSON.stringify(this.routes)); } catch { /* ignore */ } }
  reset(): void { this.routes = (defaultRoutes as Route[]).map((r) => ({ ...r })); this.sm.clear(); this.save(); }

  // Hot-reload sans reset de simulation : on remplace juste les routes.
  setRoutes(routes: Route[]): void { this.routes = routes; this.sm = new Map(); this.save(); }
  addRoute(r: Route): void { this.routes.push(r); this.save(); }
  removeRoute(i: number): void { this.routes.splice(i, 1); this.save(); }

  apply(fr: BusFrame, dt: number): void {
    applyRoutes(this.targets, this.routes, busFeatures(fr), dt, this.sm);
  }

  get(path: string, fallback = 0): number { return this.targets.get(path)?.value ?? fallback; }
  exportJSON(): string { return JSON.stringify(this.routes, null, 2); }
  importJSON(json: string): void { this.setRoutes(JSON.parse(json)); }
}
