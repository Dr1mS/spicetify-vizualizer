// Tests du beat tracker sur trains synthétiques (critère = jitter/monotonicité,
// PAS la moyenne : le verify a prouvé que moyenne≈0 masque l'échec offbeat).

import { BeatTracker } from "../src/audio/beatTracker.js";

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log("  ✓ " + m); } else { failed++; console.log("  ✗ " + m); } };
const std = (a) => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / a.length); };

// --- Test 1 : verrou sur tempo régulier ------------------------------------
console.log("\n[1] Verrou sur 128 BPM régulier");
{
  const bt = new BeatTracker(120);
  const P = 60 / 128;
  const errs = [];
  for (let k = 0; k < 60; k++) {
    const t = k * P;
    const q = bt.query(t); // phase juste avant l'onset (au beat)
    if (t > 6) errs.push(Math.min(q.beatPhase, 1 - q.beatPhase));
    bt.addOnset(t, 1);
  }
  const s = std(errs);
  console.log("    bpm final", bt.bpm.toFixed(1), "| std phase au beat", s.toFixed(4), "| lockConf", bt.lockConf.toFixed(2));
  ok(Math.abs(bt.bpm - 128) < 6, "bpm converge vers ~128");
  ok(s < 0.05, "phase verrouillée au beat (std < 0.05)");
  ok(bt.lockConf > 0.5, "lockConf haute quand verrouillé");
}

// --- Test 2 : sélection d'octave (reste dans 70..180, bon multiple) ---------
console.log("\n[2] Sélection d'octave : reste borné, bon tempo");
{
  for (const trueBpm of [140, 90, 160]) {
    const bt = new BeatTracker(120);
    const P = 60 / trueBpm;
    for (let k = 0; k < 80; k++) bt.addOnset(k * P, 1);
    console.log("    vrai", trueBpm, "-> estimé", bt.bpm.toFixed(1));
    ok(bt.bpm >= 70 && bt.bpm <= 180, `${trueBpm}: reste dans 70..180`);
    ok(Math.abs(bt.bpm - trueBpm) < 8, `${trueBpm}: tempo correct (±8)`);
  }
  // double-tempo trap : croches d'un 120 BPM -> doit résoudre ~120, pas 240
  {
    const bt = new BeatTracker(120);
    const P8 = 60 / 120 / 2; // croches (240 events/min)
    for (let k = 0; k < 160; k++) bt.addOnset(k * P8, k % 2 === 0 ? 1 : 0.6);
    console.log("    croches@120 -> estimé", bt.bpm.toFixed(1));
    ok(bt.bpm >= 70 && bt.bpm <= 240, "croches: reste borné");
  }
}

// --- Test 3 : rejet des contretemps (le "frappe pile") ---------------------
console.log("\n[3] Contretemps rejetés : le jitter reste faible");
{
  const bt = new BeatTracker(120);
  const P = 60 / 128;
  // pré-verrou
  for (let k = 0; k < 20; k++) bt.addOnset(k * P, 1);
  const errs = [];
  for (let k = 20; k < 80; k++) {
    const t = k * P;
    const q = bt.query(t);
    errs.push(Math.min(q.beatPhase, 1 - q.beatPhase));
    bt.addOnset(t, 1); // beat
    bt.addOnset(t + P * 0.5, 0.7); // contretemps (hats "and")
  }
  const s = std(errs);
  console.log("    std phase au beat AVEC contretemps", s.toFixed(4));
  ok(s < 0.06, "les contretemps ne corrompent pas la phase (std < 0.06)");
}

// --- Test 4 : coasting sur beats manquants (breakbeat) ---------------------
console.log("\n[4] Coasting : beats manquants (30%)");
{
  const bt = new BeatTracker(120);
  const P = 60 / 128;
  let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let k = 0; k < 20; k++) bt.addOnset(k * P, 1); // verrou propre
  const errs = [];
  for (let k = 20; k < 90; k++) {
    const t = k * P;
    const q = bt.query(t);
    if (rnd() > 0.3) { errs.push(Math.min(q.beatPhase, 1 - q.beatPhase)); bt.addOnset(t, 1); }
  }
  console.log("    bpm", bt.bpm.toFixed(1), "| std phase (beats présents)", std(errs).toFixed(4));
  ok(Math.abs(bt.bpm - 128) < 8 && std(errs) < 0.07, "reste verrouillé malgré 30% manquants");
}

// --- Test 5 : predictedNextBeat monotone (F4) ------------------------------
console.log("\n[5] predictedNextBeat non-décroissant (F4)");
{
  const bt = new BeatTracker(128);
  const P = 60 / 128;
  let seed = 777; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let k = 0; k < 12; k++) bt.addOnset(k * P + (rnd() - 0.5) * 0.05, 1);
  let prev = -1, violations = 0, samples = 0;
  for (let t = 6; t < 20; t += 0.016) {
    // onsets syncopés occasionnels
    if (rnd() < 0.05) bt.addOnset(t, 0.8);
    const q = bt.query(t);
    samples++;
    if (prev >= 0 && q.nextBeat < prev - 1e-6) violations++;
    prev = q.nextBeat;
  }
  console.log("    reculs de nextBeat :", violations, "/", samples);
  ok(violations === 0, "nextBeat ne recule jamais (pas de double-flash)");
}

// --- Test 6 : tempos RAPIDES avec offbeats dès le départ (le bug 240 BPM) -----
// Kick fort SUR le beat + hat faible OFFBEAT, présents DÈS LE DÉBUT (pas de
// pré-verrou propre). L'ancien tracker : (a) tempo pêchait un sous-harmonique faux
// (240→158), (b) la phase s'ancrait sur les hats offbeat (kicks à ~0.48). On exige :
// tempo borné + STABLE, et phase verrouillée sur les KICKS (std bas).
console.log("\n[6] Tempos rapides + offbeats dès le départ (bug 240 BPM)");
{
  for (const trueBpm of [240, 200, 175, 128]) {
    const bt = new BeatTracker(120);
    const beat = 60 / trueBpm;
    const seq = [];
    for (let t = 0; t < 14; t += beat) { seq.push({ t, s: 1.0, k: true }); seq.push({ t: t + beat / 2, s: 0.35, k: false }); }
    seq.sort((a, b) => a.t - b.t);
    const bpmS = [], errK = [];
    for (const o of seq) {
      const q = bt.query(o.t);
      if (o.t > 7 && o.k) errK.push(Math.min(q.beatPhase, 1 - q.beatPhase));
      if (o.t > 10.5) bpmS.push(q.bpm); // dérive mesurée une fois ÉTABLI (hors rampe d'acquisition)
      bt.addOnset(o.t, o.s);
    }
    const drift = Math.max(...bpmS) - Math.min(...bpmS);
    const sK = std(errK);
    console.log(`    ${trueBpm} -> bpm ${bt.bpm.toFixed(1)} (dérive ${drift.toFixed(1)}) | std phase@kick ${sK.toFixed(3)}`);
    // Plafond porté à 240 (hardstyle, drum&bass, hardcore) : à 200 BPM le suiveur
    // doit maintenant rapporter 200, pas se replier sur la demi-mesure.
    ok(bt.bpm >= 70 && bt.bpm <= 240 && drift < 6, `${trueBpm}: tempo borné et stable`);
    ok(sK < 0.06, `${trueBpm}: phase verrouillée sur les KICKS (pas les offbeats)`);
  }
}

// --- Test 7 : syncope NON-antiphase (ghost notes à phase ~0.3) ----------------
// Les contretemps du Test 3 sont à l'antiphase exacte (0.5) → ils s'annulent le long
// de vx sans tirer φ̄. Un onset syncopé hors-antiphase (ghost note swing, phase ~0.3)
// injecte une vraie composante vy et POURRAIT tirer la phase. On vérifie que la phase
// reste ancrée sur les beats forts (l'accumulateur pondéré + décroissance l'absorbe).
console.log("\n[7] Syncope non-antiphase (ghost notes phase ~0.3)");
{
  const bt = new BeatTracker(120);
  const P = 60 / 128;
  for (let k = 0; k < 20; k++) bt.addOnset(k * P, 1); // pré-verrou propre
  const errs = [];
  for (let k = 20; k < 80; k++) {
    const t = k * P;
    const q = bt.query(t);
    errs.push(Math.min(q.beatPhase, 1 - q.beatPhase));
    bt.addOnset(t, 1); // beat fort
    bt.addOnset(t + P * 0.3, 0.6); // ghost note syncopée (hors antiphase)
  }
  const s = std(errs);
  console.log("    std phase au beat AVEC ghost@0.3", s.toFixed(4));
  ok(s < 0.06, "syncope hors-antiphase ne corrompt pas la phase (std < 0.06)");
}

// --- Test 8 : tempos RAPIDES réels (le bug "ça suit pas en trance") ----------
// L'instant d'un onset est daté sur la grille d'analyse (saut 10,67 ms), donc un
// kick à 150 BPM ressort à 395 ou 405 ms — en cases de 5 ms : 79 ou 81, JAMAIS 80.
// L'autocorrélation au vrai tempo valait donc exactement 0 et le suiveur tombait
// à 75. On vérifie ici la bande qui posait problème, avec une source PROPRE
// (impulsions régulières) : c'est le cas où il n'y a aucune excuse.
console.log("\n[8] Bande 140-200 BPM (verrous au demi-tempo)");
{
  for (const trueBpm of [140, 150, 160, 170, 185, 200]) {
    const bt = new BeatTracker(120);
    const beat = 60 / trueBpm;
    // Jitter de DATATION reproduit fidèlement : le worklet date chaque onset sur
    // la grille d'analyse (saut de 10,67 ms), ce qui décale l'instant détecté du
    // reste de la division — mesuré : écarts de 395/405 ms à 150 BPM.
    const HOP = 512 / 48000;
    for (let i = 0, t = 0; t < 16; i++, t = i * beat) bt.addOnset(Math.round(t / HOP) * HOP, 1.0);
    const err = Math.abs(bt.bpm - trueBpm) / trueBpm;
    console.log(`    ${trueBpm} -> ${bt.bpm.toFixed(1)}`);
    ok(err < 0.06, `${trueBpm}: pas de repli au demi-tempo`);
  }
}

console.log(`\n${passed} passés, ${failed} échoués\n`);
process.exit(failed ? 1 : 0);
