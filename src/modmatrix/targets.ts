// targets.ts — registre APLATI des paramètres modulables (clé = paramPath).
import type { Targets } from "./types";

export function buildTargets(): Targets {
  const t: Targets = new Map();
  add(t, "global.brightness", 1, 0, 3);
  add(t, "global.exposure", 1.6, 0.2, 8);
  add(t, "global.baseHue", 0.6, 0, 1, true);
  add(t, "global.hueShift", 0, 0, 1, true);
  add(t, "global.beatFlash", 0, 0, 2); // gain de sortie pulsé sur le beat
  return t;
}

export function add(t: Targets, path: string, base: number, min: number, max: number, wrap = false): void {
  t.set(path, { value: base, base, min, max, wrap });
}

// Enregistre les params d'un mode. `ranges` donne [min,max] par param (sinon auto).
export function registerParams(t: Targets, id: string, params: Record<string, number>, ranges: Record<string, [number, number]> = {}): void {
  for (const [k, v] of Object.entries(params)) {
    const r = ranges[k];
    const span = Math.max(Math.abs(v), 1);
    add(t, `${id}.params.${k}`, v, r ? r[0] : v - span, r ? r[1] : v + span, false);
  }
}

export function unregister(t: Targets, id: string): void {
  for (const key of [...t.keys()]) if (key.startsWith(id + ".")) t.delete(key);
}

export function getParam(t: Targets, path: string, fallback = 0): number {
  return t.get(path)?.value ?? fallback;
}
