// apply.ts — features(BusFrame) + application des routes (courbe -> amount -> smoothing).
import { F, MEL_COUNT } from "../audio/constants";
import type { BusFrame } from "../audio/bus";
import type { Curve, Features, Route, Targets } from "./types";

// Construit le dictionnaire de features (les `source` des routes).
export function busFeatures(fr: BusFrame): Features {
  const f = fr.feat;
  const o: Features = {
    rms: f[F.RMS], peak: f[F.PEAK], flux: f[F.FLUX], centroid: f[F.CENTROID],
    flatness: f[F.FLATNESS], energy: f[F.ENERGY], keyHue: f[F.KEY_HUE], onset: f[F.ONSET_STR],
    kick: f[F.KICK], snare: f[F.SNARE], hats: f[F.HATS],
    beatPhase: fr.beatPhase, bpm: fr.bpm, lockConf: fr.lockConf,
    beatPulse: beatPulse(fr), // pic étroit SUR le beat (prédictif, compense la latence photon)
    // impulsions 1-frame (déclencheurs discrets)
    onsetFired: fr.onsetFired ? 1 : 0, kickFired: fr.kickFired ? 1 : 0,
    snareFired: fr.snareFired ? 1 : 0, hatsFired: fr.hatsFired ? 1 : 0,
    // bandes larges dérivées du mel[32]
    bass: melAvg(f, 0, 6), lowmid: melAvg(f, 6, 12), mid: melAvg(f, 12, 20),
    highmid: melAvg(f, 20, 26), treble: melAvg(f, 26, 32),
  };
  for (let i = 0; i < MEL_COUNT; i++) o["mel" + i] = f[F.MEL0 + i];
  return o;
}
function melAvg(f: Float32Array, a: number, b: number): number {
  let s = 0; for (let i = a; i < b; i++) s += f[F.MEL0 + i]; return s / (b - a);
}

// Avance de phase compensant la latence photon (worklet -> tracker -> rAF ->
// composite -> photon). Réglable via PHOTON_LEAD ; c'est le "hit sur le beat".
export const PHOTON_LEAD = 0.045; // s
function beatPulse(fr: { beatPhase: number; bpm: number }): number {
  const ph = (fr.beatPhase + PHOTON_LEAD * (fr.bpm / 60)) % 1;
  const near = Math.min(ph, 1 - ph); // distance au beat (0 = pile)
  return Math.exp(-near * near * 120); // pic étroit
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
function shape(v: number, curve: Curve, k: number): number {
  v = clamp01(v);
  switch (curve) {
    case "exp": return (Math.exp(v * k) - 1) / (Math.exp(k) - 1); // accentue le haut
    case "log": return Math.log(1 + v * k) / Math.log(1 + k); // accentue le bas
    case "pow": return Math.pow(v, k);
    default: return v;
  }
}

export type SmoothState = Map<Route, { v: number }>;

// Ordre : reset cibles -> base ; par route : shape -> amount -> smoothing (dt) ;
// accumulation sur la cible ; clamp/wrap.
export function applyRoutes(targets: Targets, routes: Route[], feats: Features, dt: number, sm: SmoothState): void {
  for (const t of targets.values()) t.value = t.base;
  for (const r of routes) {
    if (r.enabled === false) continue;
    const tgt = targets.get(r.dest);
    if (!tgt) continue; // dest inconnu -> ignoré (pas de crash)
    const raw = feats[r.source] ?? 0;
    const contrib = shape(raw, r.curve ?? "lin", r.k ?? 3) * r.amount;
    let st = sm.get(r);
    if (!st) { st = { v: contrib }; sm.set(r, st); }
    const tau = (r.smoothing ?? 0) * 0.5; // s -> constante de temps
    const a = tau > 1e-4 ? 1 - Math.exp(-dt / tau) : 1;
    st.v += (contrib - st.v) * a;
    tgt.value += st.v;
  }
  for (const t of targets.values()) {
    if (t.wrap) t.value = t.value - Math.floor(t.value);
    else t.value = Math.min(t.max, Math.max(t.min, t.value));
  }
}
