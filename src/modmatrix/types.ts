// types.ts — modulation matrix : le point d'injection audio -> visuel.

export type Curve = "lin" | "exp" | "log" | "pow";

// Une route pousse une FEATURE audio vers un PARAM (uniform de mode / global).
export interface Route {
  source: string; // nom de feature : "onset","rms","energy","beatPhase","mel12",...
  dest: string; // paramPath : "fhn.params.injAmp","global.brightness",...
  amount: number; // gain (peut être négatif)
  curve?: Curve; // mise en forme 0..1 -> 0..1 (défaut lin)
  smoothing?: number; // 0 = instantané, 1 = très lissé (temps, dt-compensé)
  k?: number; // paramètre de courbe (exp/log/pow)
  enabled?: boolean;
}

// Cible modulable : valeur courante = base + Σ contributions des routes.
export interface Target {
  value: number;
  base: number;
  min: number;
  max: number;
  wrap: boolean; // true = teinte cyclique (0..1)
}

export type Targets = Map<string, Target>;
export type Features = Record<string, number>;
