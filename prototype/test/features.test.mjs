// Tests du pipeline de features (audio.js) sans navigateur.
// On stub l'AnalyserNode et on injecte des spectres dB synthétiques.
//
// But : valider le MATHS (les 80% du ressenti) avant tout pixel.
//   1. axe log      -> un sinus balayé traverse les bandes de bas en haut
//   2. AGC          -> mix faible ET mix fort remplissent 0..1
//   3. silence      -> les bandes restent ~0 (pas de "bloom")
//   4. spectral flux -> un transitoire déclenche un onset, pas le régime établi

import { AudioEngine } from "../audio.js";

const SR = 48000;
const FFT = 2048;
const BIN_HZ = SR / FFT;
const BINS = FFT / 2;

let passed = 0,
  failed = 0;
function ok(cond, msg) {
  if (cond) {
    passed++;
    console.log("  ✓ " + msg);
  } else {
    failed++;
    console.log("  ✗ " + msg);
  }
}

// Fabrique un moteur "hors-ligne" avec un AnalyserNode stubé.
function makeEngine() {
  const e = new AudioEngine({ fftSize: FFT });
  e.ctx = { sampleRate: SR };
  e.db = new Float32Array(BINS);
  e.wave = new Float32Array(FFT);
  e._src = new Float32Array(BINS).fill(-140); // spectre source injecté
  e._computeBandBins();
  e.analyser = {
    getFloatFrequencyData: (a) => a.set(e._src),
    getFloatTimeDomainData: (a) => a.fill(0),
  };
  return e;
}

// Pose un pic spectral (dB) autour d'une fréquence.
function tone(e, hz, ampDb = -25) {
  e._src.fill(-140);
  const bin = Math.round(hz / BIN_HZ);
  for (let k = -1; k <= 1; k++) {
    const i = bin + k;
    if (i >= 0 && i < BINS) e._src[i] = ampDb - Math.abs(k) * 6;
  }
}

function argmaxBand(e) {
  let bi = 0,
    bv = -1;
  for (let b = 0; b < e.bands.length; b++)
    if (e.bands[b] > bv) {
      bv = e.bands[b];
      bi = b;
    }
  return { bi, bv };
}

function run(e, n) {
  let last;
  for (let i = 0; i < n; i++) last = e.sample();
  return last;
}

// --- Test 1 : axe log -------------------------------------------------------
console.log("\n[1] Axe log : un sinus balayé monte dans les bandes");
{
  const e = makeEngine();
  const freqs = [60, 120, 250, 500, 1000, 2000, 4000, 8000];
  const idx = [];
  for (const f of freqs) {
    tone(e, f);
    run(e, 40); // laisse l'AGC + l'envelope se poser
    idx.push(argmaxBand(e).bi);
  }
  console.log("    freqs :", freqs.join(", "));
  console.log("    bande :", idx.join(", "));
  let monotone = true;
  for (let i = 1; i < idx.length; i++) if (idx[i] <= idx[i - 1]) monotone = false;
  ok(monotone, "l'indice de bande croît strictement avec la fréquence");

  // Octaves équi-espacées : 250->500->1000->2000->4000 doivent avoir un pas ~constant.
  const oct = [250, 500, 1000, 2000, 4000].map((f) => {
    tone(e, f);
    run(e, 40);
    return argmaxBand(e).bi;
  });
  const steps = [];
  for (let i = 1; i < oct.length; i++) steps.push(oct[i] - oct[i - 1]);
  const mean = steps.reduce((a, b) => a + b) / steps.length;
  const spread = Math.max(...steps) - Math.min(...steps);
  console.log("    pas/octave :", steps.join(", "), "(moyenne", mean.toFixed(1) + ")");
  // ~7 bandes/octave attendu (64 bandes sur ~9 octaves) ; ±quantification des bins bas.
  ok(spread <= 4 && mean > 4, "pas quasi-constant par octave (axe log)");
}

// --- Test 2 : AGC ----------------------------------------------------------
console.log("\n[2] AGC : mix faible ET mix fort remplissent 0..1");
{
  const loud = makeEngine();
  tone(loud, 1000, -25);
  const lb = argmaxBand(run(loud, 800)).bi;
  const lv = loud.bands[lb];

  const quiet = makeEngine();
  tone(quiet, 1000, -75); // 50 dB plus bas
  const qb = argmaxBand(run(quiet, 800)).bi;
  const qv = quiet.bands[qb];

  console.log("    fort  -> bande", lb, "valeur", lv.toFixed(3));
  console.log("    faible-> bande", qb, "valeur", qv.toFixed(3));
  ok(lv > 0.8, "mix fort sature (>0.8)");
  ok(qv > 0.8, "mix faible sature aussi grâce à l'AGC (>0.8)");
  ok(Math.abs(lv - qv) < 0.15, "les deux convergent au même niveau (indép. du volume)");
}

// --- Test 3 : silence ------------------------------------------------------
console.log("\n[3] Silence : pas de bloom du bruit de fond");
{
  const e = makeEngine();
  e._src.fill(-140); // silence total
  run(e, 200);
  let maxB = 0;
  for (const v of e.bands) maxB = Math.max(maxB, v);
  console.log("    bande max au silence :", maxB.toFixed(4));
  ok(maxB < 0.1, "les bandes restent proches de 0 au silence (<0.1)");
}

// --- Test 4 : spectral flux / onset ----------------------------------------
console.log("\n[4] Onset : transitoire = onset, régime établi = rien");
{
  const e = makeEngine();
  // régime établi : même spectre large répété
  e._src.fill(-140);
  for (let i = 200; i < 400; i++) e._src[i] = -30;
  let steadyOnsets = 0;
  for (let i = 0; i < 60; i++) if (e.sample().onsetFlag) steadyOnsets++;
  ok(steadyOnsets <= 1, "quasi aucun onset en régime établi (" + steadyOnsets + ")");

  // transitoire : saut d'énergie franc sur tout le spectre
  let fired = false;
  for (let i = 0; i < 800; i++) e._src[i] = -20;
  for (let i = 0; i < 15; i++) if (e.sample().onsetFlag) fired = true;
  ok(fired, "un onset se déclenche sur le transitoire");
}

// --- Test 5 : gate de présence ---------------------------------------------
console.log("\n[5] Gate : le bruit ~70 dB sous la bande forte est coupé");
{
  const e = makeEngine();
  // Basse FORTE (-20 dB @ ~60 Hz) + "bruit" faible large bande (-95 dB partout).
  const binHz = SR / FFT;
  function scene() {
    e._src.fill(-95); // plancher de bruit large bande
    const bass = Math.round(60 / binHz);
    for (let k = -1; k <= 1; k++) e._src[bass + k] = -20 - Math.abs(k) * 6;
  }
  scene();
  run(e, 400);
  // bande de la basse (forte) vs une bande d'aigus (uniquement du bruit)
  const bassBand = argmaxBand(e).bi;
  let hiNoise = 0;
  for (let b = 0; b < e.bands.length; b++)
    if (e.bandHz[b] > 6000) hiNoise = Math.max(hiNoise, e.bands[b]);
  console.log("    basse (forte) bande", bassBand, "=", e.bands[bassBand].toFixed(3));
  console.log("    aigus (bruit) max =", hiNoise.toFixed(3));
  ok(e.bands[bassBand] > 0.8, "la bande forte reste levée (>0.8)");
  ok(hiNoise < 0.15, "le bruit d'aigus est coupé par le gate (<0.15)");
}

// --- Test 6 : kick dédié bas-spectre ---------------------------------------
console.log("\n[6] Kick : détecté même sous un mix médium/aigu continu");
{
  const e = makeEngine();
  const binHz = SR / FFT;
  const bassBin = Math.round(55 / binHz);
  let kicks = 0;
  // Nappe médium/aigu CONTINUE + kicks périodiques dans le bas.
  for (let frame = 0; frame < 240; frame++) {
    e._src.fill(-120);
    for (let i = 40; i < 300; i++) e._src[i] = -35; // "mur" médium continu (dense)
    const onKick = frame % 30 < 3; // kick toutes les ~0.5 s
    if (onKick) for (let k = -2; k <= 2; k++) e._src[bassBin + k] = -18;
    if (e.sample().kickFlag) kicks++;
  }
  console.log("    kicks détectés :", kicks, "(attendu ~8)");
  ok(kicks >= 5, "les kicks passent malgré le mur médium (≥5)");
}

// --- helpers batterie -------------------------------------------------------
function setRegions(e, regions, floor = -140) {
  e._src.fill(floor);
  for (const [f0, f1, db] of regions) {
    const i0 = Math.max(0, Math.round(f0 / BIN_HZ));
    const i1 = Math.min(BINS, Math.round(f1 / BIN_HZ));
    for (let i = i0; i < i1; i++) e._src[i] = db;
  }
}
function drumHit(e, regions) {
  setRegions(e, []); // silence
  for (let i = 0; i < 12; i++) e.sample();
  setRegions(e, regions); // frappe (reste allumée -> le front montant = l'onset)
  const fl = { kick: false, snare: false, hats: false };
  for (let i = 0; i < 4; i++) {
    const f = e.sample();
    fl.kick ||= f.kickFlag;
    fl.snare ||= f.snareFlag;
    fl.hats ||= f.hatsFlag;
  }
  return fl;
}

// --- Test 7 : SÉPARATION de la batterie (make-or-break) ---------------------
console.log("\n[7] Batterie séparée : kick / snare / hats ne se déclenchent pas ensemble");
{
  // kick AVEC bave large-bande (le piège) -> doit tirer kick SEUL
  let f = drumHit(makeEngine(), [[20, 120, -18], [300, 2000, -45], [6000, 14000, -55]]);
  console.log("    kick+bave -> kick", f.kick, "snare", f.snare, "hats", f.hats);
  ok(f.kick && !f.snare && !f.hats, "un kick (avec bave) tire kick SEUL");

  // snare (médium bruité) -> snare seul
  f = drumHit(makeEngine(), [[300, 2000, -22]]);
  console.log("    snare     -> kick", f.kick, "snare", f.snare, "hats", f.hats);
  ok(f.snare && !f.kick, "un snare tire snare, pas kick");

  // hat (aigu) -> hats seul
  f = drumHit(makeEngine(), [[6000, 14000, -24]]);
  console.log("    hat       -> kick", f.kick, "snare", f.snare, "hats", f.hats);
  ok(f.hats && !f.kick, "un hat tire hats, pas kick");

  // kick + hat SIMULTANÉS (courant) -> les deux, pas de snare
  f = drumHit(makeEngine(), [[20, 120, -18], [6000, 14000, -24]]);
  console.log("    kick+hat  -> kick", f.kick, "snare", f.snare, "hats", f.hats);
  ok(f.kick && f.hats && !f.snare, "kick+hat simultanés tirent les deux, pas snare");
}

// --- Test 8 : chroma -> teinte stable ---------------------------------------
console.log("\n[8] Chroma : teinte suit la note, stable (pas de strobe)");
{
  const domBin = (e) => { let bi = 0, bv = -1; for (let k = 0; k < 12; k++) if (e.chroma[k] > bv) { bv = e.chroma[k]; bi = k; } return bi; };
  const e1 = makeEngine();
  tone(e1, 440, -25); // La
  run(e1, 300);
  const b1 = domBin(e1), h1 = e1.keyHue;
  const e2 = makeEngine();
  tone(e2, 523.25, -25); // Do
  run(e2, 300);
  const b2 = domBin(e2), h2 = e2.keyHue;
  console.log("    440Hz -> bin", b1, "hue", h1.toFixed(3), "| 523Hz -> bin", b2, "hue", h2.toFixed(3));
  ok(b1 === 0, "440 Hz -> classe de hauteur A (bin 0)");
  ok(b1 !== b2 && Math.abs(h1 - h2) > 0.02, "deux notes -> teintes différentes");
  // stabilité : pas de saut entre deux instants sur une note tenue
  const hMid = e1.keyHue; run(e1, 120); const hEnd = e1.keyHue;
  ok(Math.abs(hMid - hEnd) < 0.02, "teinte stable sur une note tenue (pas de strobe)");
}

// --- Test 9 : build-up / drop -----------------------------------------------
console.log("\n[9] Build-up/drop : tension monte puis drop sur le surge");
{
  const e = makeEngine();
  // baseline sparse (juste un peu de grave)
  setRegions(e, [[40, 100, -35]]); run(e, 60);
  const tLow = e.tension;
  // build : on ouvre progressivement tout le spectre
  let dropped = false;
  for (let step = 0; step < 60; step++) {
    const hi = 100 + step * 250;
    setRegions(e, [[40, hi, -22]]);
    if (e.sample().dropFlag) dropped = true;
  }
  const tHigh = e.tension;
  console.log("    tension baseline", tLow.toFixed(3), "-> build", tHigh.toFixed(3), "| drop:", dropped);
  ok(tHigh > tLow + 0.1, "la tension monte pendant le build-up");
  ok(dropped, "un drop est détecté sur le surge d'énergie");
}

// --- Test 10 : coupure / reprise --------------------------------------------
console.log("\n[10] Coupure/reprise : accalmie détectée puis reprise en force");
{
  const e = makeEngine();
  const full = () => setRegions(e, [[40, 14000, -20]]);
  const quiet = () => setRegions(e, [[40, 90, -40]]); // presque tout coupé
  full(); run(e, 120); // section pleine -> baseline
  quiet();
  let brk = false;
  for (let i = 0; i < 80; i++) { e.sample(); if (e.breakActive) brk = true; }
  console.log("    accalmie:", brk, "| energy en break:", e.energy.toFixed(3));
  ok(brk, "l'accalmie (coupure) est détectée");
  full();
  let reentry = false;
  for (let i = 0; i < 40; i++) if (e.sample().reentryFlag) reentry = true;
  console.log("    reprise:", reentry);
  ok(reentry, "la reprise après coupure est détectée (reentryFlag)");
}

console.log(`\n${passed} passés, ${failed} échoués\n`);
process.exit(failed ? 1 : 0);
