// Step 6 — check BLOQUANT : chaque source/dest de routes.default.json doit
// exister (features connues / cibles enregistrées). Attrape les typos.
import { readFileSync } from "node:fs";

const routes = JSON.parse(readFileSync(new URL("../src/modmatrix/routes.default.json", import.meta.url), "utf8"));

const SOURCES = new Set([
  "rms", "peak", "flux", "centroid", "flatness", "energy", "keyHue", "onset",
  "kick", "snare", "hats", "beatPhase", "bpm", "lockConf", "beatPulse",
  "onsetFired", "kickFired", "snareFired", "hatsFired",
  "bass", "lowmid", "mid", "highmid", "treble",
  ...Array.from({ length: 32 }, (_, i) => "mel" + i),
]);

const DESTS = new Set([
  "global.brightness", "global.exposure", "global.baseHue", "global.hueShift", "global.beatFlash",
  ...["a", "b", "epsilon", "Du", "Dv", "injRadius", "injAmp"].map((k) => "fhn.params." + k),
  ...["a", "b", "c", "d", "warp", "scale", "hue"].map((k) => "dejong.params." + k),
  ...["influenceRadius", "killRadius", "stepLen", "spawnCount", "spawnSpread", "decay", "bright"].map((k) => "spacecol.params." + k),
]);

let bad = 0;
for (const r of routes) {
  if (!SOURCES.has(r.source)) { console.log("  ✗ source inconnue:", r.source, "->", r.dest); bad++; }
  if (!DESTS.has(r.dest)) { console.log("  ✗ dest inconnue:", r.source, "->", r.dest); bad++; }
}
console.log(`\n${routes.length} routes vérifiées, ${bad} références pendantes\n`);
process.exit(bad ? 1 : 0);
