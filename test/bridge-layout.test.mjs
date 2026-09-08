// Le pont Node (bridge/layout.mjs) duplique forcément le LAYOUT de features de
// src/audio/constants.ts : le worklet le reçoit via processorOptions, et Node ne
// peut pas importer un .ts. Si les deux divergent, les modes lisent n'importe
// quoi SANS ERREUR (des flottants à la mauvaise place) — le pire mode d'échec.
// Ce test compare les deux, champ par champ.

import { readFileSync } from "node:fs";
import { F as BRIDGE_F, FEAT_LEN as BRIDGE_LEN, MEL_COUNT as BRIDGE_MEL } from "../bridge/layout.mjs";

const src = readFileSync(new URL("../src/audio/constants.ts", import.meta.url), "utf8");

const block = src.match(/export const F = \{([\s\S]*?)\} as const;/)?.[1];
if (!block) { console.log("  ✗ impossible d'extraire F de constants.ts"); process.exit(1); }

const TS_F = {};
for (const m of block.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*:\s*(\d+)/gm)) TS_F[m[1]] = Number(m[2]);
const TS_MEL = Number(src.match(/export const MEL_COUNT = (\d+)/)?.[1]);
const TS_LEN = TS_F.MEL0 + TS_MEL;

let bad = 0;
const ok = (c, m) => { console.log((c ? "  ✓ " : "  ✗ ") + m); if (!c) bad++; };

console.log("\n[layout] bridge/layout.mjs == src/audio/constants.ts");
ok(TS_MEL === BRIDGE_MEL, `MEL_COUNT ${TS_MEL} == ${BRIDGE_MEL}`);
ok(TS_LEN === BRIDGE_LEN, `FEAT_LEN ${TS_LEN} == ${BRIDGE_LEN}`);

const keys = new Set([...Object.keys(TS_F), ...Object.keys(BRIDGE_F)]);
let diffs = 0;
for (const k of keys) {
  if (TS_F[k] !== BRIDGE_F[k]) { console.log(`  ✗ ${k} : constants.ts=${TS_F[k]} bridge=${BRIDGE_F[k]}`); diffs++; }
}
ok(diffs === 0, `${keys.size} champs identiques`);

console.log(`\n${bad ? "ÉCHEC" : "OK"} — layout ${bad ? "divergent" : "cohérent"}\n`);
process.exit(bad ? 1 : 0);
