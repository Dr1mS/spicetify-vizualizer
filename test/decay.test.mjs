// decayDt : une décroissance écrite pour 60 fps doit produire le MÊME effet par
// seconde quel que soit le nombre de frames rendues. Sans ça, une fenêtre non
// focalisée (rAF bridé à ~1,3 Hz, mesuré) fait saturer les accumulations.
// Le fichier est en TS ; on teste la formule sur la même expression.
const decayDt = (d60, dt, sub = 1, plancher = 0.45) => {
  const d = Math.min(0.9999, Math.max(0, d60));
  const frames = (Math.min(Math.max(dt, 1 / 1000), 1) * 60) / Math.max(1, sub);
  return Math.max(plancher, Math.pow(d, frames));
};
const gainDt = (g60, dt, maxScale = 8) =>
  g60 * Math.min(maxScale, Math.max(0.2, Math.min(Math.max(dt, 1 / 1000), 1) * 60));

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log("  ✓ " + m); } else { failed++; console.log("  ✗ " + m); } };

console.log("\n[A] À 60 fps, le facteur est inchangé (aucune régression visuelle)");
ok(Math.abs(decayDt(0.93, 1 / 60) - 0.93) < 1e-9, "0,93 à 60 fps reste 0,93");

console.log("\n[B] Le résidu après UNE SECONDE ne dépend pas du frame rate");
{
  const apres1s = (dt) => { let v = 1; for (let t = 0; t < 1 - 1e-9; t += dt) v *= decayDt(0.93, dt); return v; };
  const a60 = apres1s(1 / 60), a30 = apres1s(1 / 30), a10 = apres1s(1 / 10);
  console.log(`    60 fps ${a60.toExponential(2)} · 30 fps ${a30.toExponential(2)} · 10 fps ${a10.toExponential(2)}`);
  ok(Math.abs(a30 - a60) / a60 < 0.01, "30 fps donne le même résidu qu'à 60 (< 1 %)");
  ok(Math.abs(a10 - a60) / a60 < 0.05, "10 fps aussi (< 5 %)");
}

console.log("\n[C] État stationnaire : la densité tient à 60 fps comme à 1 fps");
{
  // stationnaire d'une accumulation : dépôt / (1 - décroissance)
  const stat = (dt) => gainDt(1, dt) / (1 - decayDt(0.93, dt));
  const s60 = stat(1 / 60), s30 = stat(1 / 30), s10 = stat(1 / 10), s1 = stat(1 / 1.2);
  console.log(`    60 fps ${s60.toFixed(1)} · 30 fps ${s30.toFixed(1)} · 10 fps ${s10.toFixed(1)} · 1,2 fps ${s1.toFixed(1)}`);
  ok(s1 / s60 > 0.5 && s1 / s60 < 2, "à 1,2 fps la densité reste du même ordre qu'à 60 (ni noir, ni saturé)");
  ok(s30 / s60 > 0.8 && s30 / s60 < 1.25, "à 30 fps aussi");
}

console.log("\n[D] Les sous-pas sont pris en compte (hocket : 3 pas par frame)");
{
  const parFrame = Math.pow(decayDt(0.9995, 1 / 60, 3), 3);
  ok(Math.abs(parFrame - 0.9995) < 1e-9, "3 sous-pas composés = le facteur par frame");
}

console.log(`\n${passed} passés, ${failed} échoués\n`);
process.exit(failed ? 1 : 0);
