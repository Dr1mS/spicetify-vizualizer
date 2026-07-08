// Step 6 — check BLOQUANT : chaque source/dest de routes.default.json doit
// exister. Les DESTS valides sont DÉRIVÉES des registerParams(...) des modes
// (auto-maintenu quand on ajoute un mode).
import { readFileSync, readdirSync } from "node:fs";

const dir = new URL("../src/modes/", import.meta.url);
const routes = JSON.parse(readFileSync(new URL("../src/modmatrix/routes.default.json", import.meta.url), "utf8"));

const SOURCES = new Set([
  "rms", "peak", "flux", "centroid", "flatness", "energy", "keyHue", "onset",
  "kick", "snare", "hats", "beatPhase", "bpm", "lockConf", "beatPulse",
  "onsetFired", "kickFired", "snareFired", "hatsFired",
  "bass", "lowmid", "mid", "highmid", "treble",
  ...Array.from({ length: 32 }, (_, i) => "mel" + i),
]);

const DESTS = new Set(["global.brightness", "global.exposure", "global.baseHue", "global.hueShift", "global.beatFlash"]);

// Dérive <id>.params.<key> de chaque mode via registerParams(targets, this.id, { ... }).
for (const file of readdirSync(dir)) {
  if (!file.endsWith(".ts") || file === "Mode.ts" || file === "registry.ts") continue;
  const src = readFileSync(new URL(file, dir), "utf8");
  const id = src.match(/id\s*=\s*["']([^"']+)["']/)?.[1];
  if (!id) continue;
  const block = src.match(/registerParams\s*\([^{]*\{([^}]*)\}/s)?.[1];
  if (!block) continue;
  for (const m of block.matchAll(/([A-Za-z_]\w*)\s*:/g)) DESTS.add(`${id}.params.${m[1]}`);
}

let bad = 0;
for (const r of routes) {
  if (!SOURCES.has(r.source)) { console.log("  ✗ source inconnue:", r.source, "->", r.dest); bad++; }
  if (!DESTS.has(r.dest)) { console.log("  ✗ dest inconnue:", r.source, "->", r.dest); bad++; }
}
console.log(`\n${routes.length} routes vérifiées (${DESTS.size} cibles), ${bad} références pendantes\n`);
process.exit(bad ? 1 : 0);
