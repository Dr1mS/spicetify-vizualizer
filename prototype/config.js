// config.js — configuration paramétrable, persistée, partagée par les scènes.
//
// Le PANNEAU de contrôle est généré AUTOMATIQUEMENT depuis SCHEMA : pour ajouter
// une manette, il suffit d'une ligne ici + de lire `config.<groupe>.<clé>` dans
// la scène. `config` est un singleton mutable ; le panneau le modifie en direct.

export const SCHEMA = {
  global: {
    label: "Global",
    params: {
      brightness: { label: "Luminosité", min: 0.2, max: 2.5, step: 0.05, default: 1 },
      reactivity: { label: "Réactivité audio", min: 0.3, max: 2.5, step: 0.05, default: 1 },
      colorMode: { label: "Mode couleur", type: "select", options: ["harmonie", "fixe", "arc-en-ciel"], default: "harmonie" },
      baseHue: { label: "Teinte de base", min: 0, max: 1, step: 0.01, default: 0.6 },
      hueSpread: { label: "Étalement teinte", min: 0, max: 1, step: 0.02, default: 0.35 },
    },
  },
  particles: {
    label: "Particules",
    params: {
      flowScale: { label: "Échelle du flux", min: 0.4, max: 3, step: 0.05, default: 1.2 },
      flowSpeed: { label: "Vitesse du flux", min: 0.2, max: 3, step: 0.05, default: 1 },
      damping: { label: "Inertie", min: 0.7, max: 0.97, step: 0.005, default: 0.86 },
      kickImpulse: { label: "Souffle du kick", min: 0, max: 3, step: 0.05, default: 1 },
      pointSize: { label: "Taille des points", min: 0.5, max: 3, step: 0.05, default: 1 },
      trail: { label: "Longueur des traînées", min: 0.75, max: 0.98, step: 0.005, default: 0.9 },
      brightness: { label: "Éclat", min: 0.3, max: 2.5, step: 0.05, default: 1 },
    },
  },
  fluid: {
    label: "Fluide",
    params: {
      velDissipation: { label: "Dissipation vélocité", min: 0.98, max: 1, step: 0.001, default: 0.996 },
      dyeDissipation: { label: "Dissipation encre", min: 0.96, max: 1, step: 0.001, default: 0.99 },
      pressureIters: { label: "Itérations pression", min: 4, max: 40, step: 1, default: 20, int: true },
      splatForce: { label: "Force des impacts", min: 0.3, max: 3, step: 0.05, default: 1 },
      brightness: { label: "Éclat", min: 0.3, max: 2.5, step: 0.05, default: 1 },
    },
  },
  reaction: {
    label: "Réaction-diffusion",
    params: {
      feed: { label: "Feed (F)", min: 0.01, max: 0.06, step: 0.001, default: 0.034 },
      kill: { label: "Kill (k)", min: 0.045, max: 0.07, step: 0.001, default: 0.058 },
      iterations: { label: "Itérations/frame", min: 2, max: 12, step: 1, default: 6, int: true },
      decay: { label: "Dissolution", min: 0, max: 0.01, step: 0.0002, default: 0.0004 },
      brightness: { label: "Éclat", min: 0.3, max: 2.5, step: 0.05, default: 1 },
    },
  },
};

const STORAGE_KEY = "viz.config.v1";

function defaults() {
  const c = {};
  for (const [g, group] of Object.entries(SCHEMA)) {
    c[g] = {};
    for (const [k, p] of Object.entries(group.params)) c[g][k] = p.default;
  }
  return c;
}

function load() {
  const c = defaults();
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    for (const g in c) if (saved[g]) for (const k in c[g]) if (saved[g][k] !== undefined) c[g][k] = saved[g][k];
  } catch {}
  return c;
}

// Singleton mutable.
export const config = load();

export function saveConfig() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(config)); } catch {}
}

export function resetConfig() {
  const d = defaults();
  for (const g in d) Object.assign(config[g], d[g]);
  saveConfig();
}

export function exportConfig() {
  return JSON.stringify(config, null, 2);
}

export function importConfig(json) {
  const obj = JSON.parse(json);
  for (const g in config) if (obj[g]) for (const k in config[g]) if (obj[g][k] !== undefined) config[g][k] = obj[g][k];
  saveConfig();
}

// Teinte résolue selon le mode couleur (partagée par toutes les scènes).
export function themeHue(frame, t) {
  const g = config.global;
  if (g.colorMode === "fixe") return g.baseHue;
  if (g.colorMode === "arc-en-ciel") return (g.baseHue + t * 0.05) % 1;
  return frame.keyHue !== undefined ? frame.keyHue : (frame.centroid || 0); // harmonie
}
