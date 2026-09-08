// Teste le FICHIER expédié src/audio/recurrence.js — la mémoire de forme.
//
// On fabrique un "morceau" synthétique A B A B A B où chaque section a sa
// couleur spectrale, PLUS une grosse composante commune : c'est le cas réel
// (l'AGC par bande du worklet fait que tous les passages se ressemblent à 0,8+).
// Un détecteur naïf sur cosinus brut échoue ici ; celui-ci doit retrouver la
// période de la structure.

import { RecurrenceMemory } from "../src/audio/recurrence.js";

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log("  ✓ " + m); } else { failed++; console.log("  ✗ " + m); } };

// PRNG déterministe (un test ne doit pas dépendre du hasard)
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(42);

const MEL = 32, FPS = 94;
// Composante COMMUNE (pente spectrale imposée par l'AGC) : forte exprès.
const common = Array.from({ length: MEL }, (_, i) => 0.75 * Math.exp(-i / 14) + 0.15);
// Une bosse spectrale = un motif.
const motif = (centre, largeur) => Array.from({ length: MEL }, (_, i) => Math.exp(-((i - centre) ** 2) / (2 * largeur * largeur)));

// Une SECTION n'est pas un bloc homogène : c'est une SUITE de motifs, comme un
// couplet a une progression interne. Sans ça, n'importe quel décalage à
// l'intérieur d'une section serait déjà une vraie récurrence, et le test ne
// dirait rien de la capacité à retrouver la PÉRIODE de la structure.
const SUB = 4; // s par motif
const A = [motif(4, 2.5), motif(9, 3), motif(6, 2), motif(12, 3.5), motif(3, 2)];
const B = [motif(21, 3), motif(17, 2.5), motif(25, 3.5), motif(19, 2), motif(23, 3)];
const C = [motif(13, 4), motif(28, 3), motif(8, 5), motif(16, 2.5), motif(11, 3)];

function melAt(sec, tDansSection, t) {
  const m = sec[Math.min(sec.length - 1, Math.floor(tDansSection / SUB))];
  const out = new Float32Array(MEL);
  for (let i = 0; i < MEL; i++) {
    // motif + composante commune + respiration + bruit (rien n'est jamais identique)
    out[i] = Math.min(1, Math.max(0, common[i] + 0.55 * m[i] * (0.85 + 0.15 * Math.sin(t * 0.7 + i))
      + 0.03 * (rnd() - 0.5)));
  }
  return out;
}

function play(structure, secDur, mem, onWindow) {
  let t = 0;
  for (const sec of structure) {
    for (let n = 0; n < secDur * FPS; n++, t += 1 / FPS) {
      if (mem.push(melAt(sec, n / FPS, t), t) && onWindow) onWindow(t, mem.state);
      mem.update(1 / 60);
    }
  }
  return t;
}

// --- A : la structure A B A B A B est retrouvée ----------------------------
console.log("\n[A] Un morceau A-B-A-B-A-B : la mémoire retrouve la période");
{
  const SEC = 20; // s par section -> le retour de A est à 40 s
  const mem = new RecurrenceMemory();
  let fired = 0, lagWhenFired = [], firstFireT = 0;
  play([A, B, A, B, A, B], SEC, mem, (t, st) => {
    if (st.active) { if (!fired) firstFireT = t; fired++; lagWhenFired.push(st.lagSec); }
  });
  const med = lagWhenFired.length ? [...lagWhenFired].sort((a, b) => a - b)[lagWhenFired.length >> 1] : 0;
  console.log(`    ${fired} fenêtres en rappel · 1er à t=${firstFireT.toFixed(1)}s · décalage médian ${med.toFixed(1)}s (attendu ${2 * SEC}s)`);
  ok(fired > 0, "un rappel est détecté");
  ok(Math.abs(med - 2 * SEC) <= 3, `le décalage retrouvé est la période de la structure (±3 s)`);
  ok(firstFireT > 2 * SEC, "aucun rappel avant que le motif ait eu le temps de revenir");
}

// --- B : pas de structure -> pas de rappel ---------------------------------
console.log("\n[B] Un flux sans structure ne déclenche (presque) rien");
{
  const mem = new RecurrenceMemory();
  let fired = 0, windows = 0;
  let t = 0;
  for (let n = 0; n < 120 * FPS; n++, t += 1 / FPS) {
    const sec = [A, B, C][Math.floor(rnd() * 3)];        // section tirée au hasard
    if (mem.push(melAt(sec, rnd() * 20, t), t)) { windows++; if (mem.state.active) fired++; }
    mem.update(1 / 60);
  }
  console.log(`    ${fired}/${windows} fenêtres en rappel`);
  ok(fired / Math.max(1, windows) < 0.15, "moins de 15 % de faux rappels sur du bruit structurel");
}

// --- C : l'enveloppe est compensée en dt -----------------------------------
console.log("\n[C] L'enveloppe de rappel est identique à 30 et à 144 fps");
{
  const a = new RecurrenceMemory(), b = new RecurrenceMemory();
  a.state.active = true; b.state.active = true;
  for (let i = 0; i < 30; i++) a.update(1 / 30);      // 1 s à 30 fps
  for (let i = 0; i < 144; i++) b.update(1 / 144);    // 1 s à 144 fps
  console.log(`    env(30fps)=${a.state.env.toFixed(4)}  env(144fps)=${b.state.env.toFixed(4)}`);
  ok(Math.abs(a.state.env - b.state.env) < 0.02, "les enveloppes coïncident (< 2 %)");
}

// --- D : l'index rappelé pointe vraiment sur un passage semblable ----------
console.log("\n[D] recalledIndex() désigne une fenêtre réellement semblable");
{
  const mem = new RecurrenceMemory();
  let checked = 0, good = 0;
  play([A, B, A, B, A, B], 20, mem, () => {
    const i = mem.recalledIndex();
    if (i < 0) return;
    const cur = mem.fingerprint(mem.state.windows - 1), past = mem.fingerprint(i);
    if (!cur || !past) return;
    let d = 0; for (let k = 0; k < cur.length; k++) d += cur[k] * past[k];
    checked++; if (d > 0.2) good++;
  });
  console.log(`    ${good}/${checked} rappels pointent une fenêtre de cosinus > 0,2`);
  ok(checked === 0 || good / checked > 0.7, "le passage désigné ressemble bien au présent");
}

// --- E : régression — une horloge qui saute ne doit pas tuer la mémoire -----
console.log("\n[E] Un saut d'horloge audio ne fait pas taire la mémoire pour toujours");
{
  const mem = new RecurrenceMemory();
  const mel = new Float32Array(MEL).fill(0.3);
  mem.push(mel, 0);                                  // trame de REPOS (horodatage nul)
  let t = 6417;                                      // puis le vrai flux, très plus loin
  for (let n = 0; n < 30 * FPS; n++, t += 1 / FPS) mem.push(mel, t);
  console.log(`    ${mem.state.windows} fenêtres après 30 s de vrai flux`);
  ok(mem.state.windows > 40, "la mémoire se rebase et accumule normalement");
}

// --- F : régression — un rendu bridé ne doit pas tuer la mémoire ------------
console.log("\n[F] À 1,3 Hz de rafraîchissement (écran verrouillé), la mémoire vit encore");
{
  const mem = new RecurrenceMemory();
  const mel = new Float32Array(MEL).fill(0.3);
  let t = 100;
  for (let n = 0; n < 40; n++, t += 1 / 1.3) mem.push(mel, t); // ~31 s à 1,3 échantillon/s
  console.log(`    ${mem.state.windows} fenêtres formées`);
  ok(mem.state.windows > 10, "des fenêtres se forment malgré un échantillonnage très pauvre");
}

console.log(`\n${passed} passés, ${failed} échoués\n`);
process.exit(failed ? 1 : 0);
