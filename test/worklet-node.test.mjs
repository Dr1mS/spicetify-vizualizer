// Teste le FICHIER worklet expédié (src/audio/analyser.worklet.js) en Node :
// stub AudioWorkletProcessor/registerProcessor/sampleRate/currentTime, eval, drive.

import { readFileSync } from "node:fs";

const SR = 48000;
globalThis.sampleRate = SR;
globalThis.currentTime = 0;

// Layout (miroir de src/audio/constants.ts — passé au worklet via processorOptions).
const F = { SEQ: 0, T_FRAME: 1, RMS: 2, PEAK: 3, FLUX: 4, CENTROID: 5, FLATNESS: 6, ENERGY: 7, KEY_HUE: 8, ONSET_STR: 9, ONSET_ID: 10, KICK: 11, KICK_ID: 12, SNARE: 13, SNARE_ID: 14, HATS: 15, HATS_ID: 16, STEREO: 17, PITCH: 18, MEL0: 19 };
const FEAT_LEN = 19 + 32;

let Proc = null;
globalThis.AudioWorkletProcessor = class {
  constructor() { this.port = { _p: [], postMessage(d) { this._p.push(d.slice()); } }; }
};
globalThis.registerProcessor = (_n, c) => { Proc = c; };

const src = readFileSync(new URL("../src/audio/analyser.worklet.js", import.meta.url), "utf8");
(0, eval)(src);

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log("  ✓ " + m); } else { failed++; console.log("  ✗ " + m); } };

const BLK = 128;
function feed(proc, fn, blocks) {
  for (let b = 0; b < blocks; b++) {
    const ch = new Float32Array(BLK);
    for (let i = 0; i < BLK; i++) ch[i] = fn(proc._t = (proc._t || 0) + 1);
    globalThis.currentTime += BLK / SR;
    proc.process([[ch]], [], {});
  }
}
const silence = () => 0;
const sine = (hz, amp = 0.8) => (n) => amp * Math.sin((2 * Math.PI * hz * n) / SR);
const mkProc = () => new Proc({ processorOptions: { layout: F, melCount: 32, sab: null, featLen: FEAT_LEN } });

// --- A : FFT == DFT --------------------------------------------------------
console.log("\n[A] FFT maison == DFT");
{
  const n = 64, fft = globalThis.__viz_makeFFT(n);
  const re = new Float32Array(n), im = new Float32Array(n), xr = [];
  for (let i = 0; i < n; i++) { const v = Math.sin(i * 0.7) + 0.5 * Math.cos(i * 1.9); re[i] = v; xr.push(v); }
  fft(re, im);
  let err = 0;
  for (let k = 0; k < n; k++) { let dr = 0, di = 0; for (let t = 0; t < n; t++) { const a = (-2 * Math.PI * k * t) / n; dr += xr[t] * Math.cos(a); di += xr[t] * Math.sin(a); } err = Math.max(err, Math.abs(re[k] - dr), Math.abs(im[k] - di)); }
  console.log("    err max", err.toExponential(2));
  ok(err < 1e-3, "FFT correcte");
}

// --- B : mel d'un sinus ----------------------------------------------------
console.log("\n[B] Un sinus 440 Hz éclaire la bonne bande mel");
{
  const p = mkProc();
  feed(p, sine(440), 200);
  const pk = p.port._p.at(-1);
  let bi = 0, bv = -1;
  for (let b = 0; b < 32; b++) if (pk[F.MEL0 + b] > bv) { bv = pk[F.MEL0 + b]; bi = b; }
  console.log("    bande mel", bi, "~", p.melHz[bi].toFixed(0), "Hz | val", bv.toFixed(3));
  ok(Math.abs(p.melHz[bi] - 440) < 200, "bande dominante ~440 Hz");
  ok(bv > 0.2, "AGC mel remplit (>0.2)");
}

// --- C : séparation d'onsets ----------------------------------------------
function onsetIds(p) { const pk = p.port._p.at(-1); return { k: pk[F.KICK_ID], s: pk[F.SNARE_ID], h: pk[F.HATS_ID], o: pk[F.ONSET_ID] }; }
console.log("\n[C] Séparation kick / hats (temps-domaine)");
{
  // kick = attaque grave
  let p = mkProc(); feed(p, silence, 40); const b0 = onsetIds(p); feed(p, sine(60), 24); const a0 = onsetIds(p);
  console.log("    kick(60Hz): dKick", a0.k - b0.k, "dSnare", a0.s - b0.s, "dHats", a0.h - b0.h);
  ok(a0.k > b0.k && a0.s === b0.s && a0.h === b0.h, "attaque grave -> kick SEUL");
  // hat = attaque aiguë
  p = mkProc(); feed(p, silence, 40); const b1 = onsetIds(p); feed(p, sine(8000), 24); const a1 = onsetIds(p);
  console.log("    hat(8kHz): dKick", a1.k - b1.k, "dHats", a1.h - b1.h);
  ok(a1.h > b1.h && a1.k === b1.k, "attaque aiguë -> hats, pas kick");
}

console.log(`\n${passed} passés, ${failed} échoués\n`);
process.exit(failed ? 1 : 0);
