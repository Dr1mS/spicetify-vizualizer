// Teste le FICHIER worklet RÉELLEMENT expédié (feature-worklet.js), pas une
// copie. On stub l'environnement AudioWorklet et on l'eval en Node.

import { readFileSync } from "node:fs";

const SR = 48000;
globalThis.sampleRate = SR;
let ProcClass = null;
globalThis.AudioWorkletProcessor = class {
  constructor() {
    this.port = { _packets: [], postMessage(d) { this._packets.push(d.slice()); } };
  }
};
globalThis.registerProcessor = (_name, cls) => { ProcClass = cls; };

const src = readFileSync(new URL("../feature-worklet.js", import.meta.url), "utf8");
(0, eval)(src); // exécute le script worklet dans le scope global stubé

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log("  ✓ " + m); } else { failed++; console.log("  ✗ " + m); } };

// --- Test A : FFT exacte vs DFT naïve --------------------------------------
console.log("\n[A] FFT maison == DFT naïve (exactitude, pas de dérive)");
{
  const n = 64;
  const fft = globalThis.__viz_makeFFT(n);
  const re = new Float32Array(n), im = new Float32Array(n);
  const xr = [], xi = [];
  for (let i = 0; i < n; i++) { const v = Math.sin(i * 0.7) + 0.5 * Math.cos(i * 2.1); re[i] = v; xr.push(v); xi.push(0); }
  fft(re, im);
  let maxErr = 0;
  for (let k = 0; k < n; k++) {
    let dr = 0, di = 0;
    for (let t = 0; t < n; t++) { const a = (-2 * Math.PI * k * t) / n; dr += xr[t] * Math.cos(a) - xi[t] * Math.sin(a); di += xr[t] * Math.sin(a) + xi[t] * Math.cos(a); }
    maxErr = Math.max(maxErr, Math.abs(re[k] - dr), Math.abs(im[k] - di));
  }
  console.log("    erreur max vs DFT :", maxErr.toExponential(2));
  ok(maxErr < 1e-3, "la FFT correspond à la DFT (erreur < 1e-3)");
}

// --- helpers d'alimentation audio ------------------------------------------
const BLK = 128;
function feed(proc, signalFn, blocks) {
  for (let b = 0; b < blocks; b++) {
    const ch = new Float32Array(BLK);
    for (let i = 0; i < BLK; i++) ch[i] = signalFn(proc._t = (proc._t || 0) + 1);
    proc.process([[ch]], [], {});
  }
}
const silence = () => 0;
const sine = (hz, amp = 0.8) => (n) => amp * Math.sin((2 * Math.PI * hz * n) / SR);

// --- Test B : un sinus tombe dans la bonne bande (axe log + calibration) ----
console.log("\n[B] Un sinus 440 Hz éclaire la bonne bande");
{
  const proc = new ProcClass();
  feed(proc, sine(440), 200);
  const pk = proc.port._packets.at(-1);
  let bi = 0, bv = -1;
  for (let b = 0; b < 64; b++) if (pk[b] > bv) { bv = pk[b]; bi = b; }
  console.log("    bande dominante", bi, "~", proc.bandHz[bi].toFixed(0), "Hz | mag", bv.toFixed(3));
  ok(Math.abs(proc.bandHz[bi] - 440) < 120, "la bande dominante est ~440 Hz");
  ok(bv > 0.05, "magnitude calibrée non nulle");
}

// --- Test C : séparation des onsets (temps-domaine) -------------------------
function onsetFlags(proc, toneFn) {
  const before = proc.port._packets.length;
  feed(proc, toneFn, 24); // ~12 hops : le front montant
  const fl = { kick: 0, snare: 0, hats: 0 };
  for (let i = before; i < proc.port._packets.length; i++) {
    const p = proc.port._packets[i];
    fl.kick += p[64]; fl.snare += p[65]; fl.hats += p[66];
  }
  return fl;
}
console.log("\n[C] Séparation des onsets sur le thread audio");
{
  // kick = attaque grave (60 Hz)
  let proc = new ProcClass();
  feed(proc, silence, 40);
  let f = onsetFlags(proc, sine(60));
  console.log("    kick(60Hz) -> kick", f.kick, "snare", f.snare, "hats", f.hats);
  ok(f.kick > 0 && f.snare === 0 && f.hats === 0, "attaque grave -> kick SEUL");

  // hat = attaque aiguë (8 kHz)
  proc = new ProcClass();
  feed(proc, silence, 40);
  f = onsetFlags(proc, sine(8000));
  console.log("    hat(8kHz)  -> kick", f.kick, "snare", f.snare, "hats", f.hats);
  ok(f.hats > 0 && f.kick === 0, "attaque aiguë -> hats, pas kick");
}

console.log(`\n${passed} passés, ${failed} échoués\n`);
process.exit(failed ? 1 : 0);
