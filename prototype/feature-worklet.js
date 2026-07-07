// feature-worklet.js — extraction de features sur le THREAD AUDIO (Slice 1b).
//
// But : timing serré des onsets. Tourne à un HOP court (~5 ms) au lieu du rAF
// (~16 ms), avec une fenêtre FFT plus courte -> transitoires (kick/snare/hats)
// localisés et détectés au bon instant, jamais ratés entre deux frames.
//
// PÉRIMÈTRE (conseil archi) : seulement le RAPIDE ici — FFT, bandes, AGC-du-flux,
// détection d'onsets. Le LENT (chroma, energy, build/drop, coupure/reprise) reste
// sur le main thread au rAF, où ses constantes de temps sont valides.
//
// Script CLASSIQUE (pas d'import) : compatible Firefox ET testable en Node
// (stub AudioWorkletProcessor/registerProcessor/sampleRate).
//
// ⚠️ Les constantes de temps sont RESCALÉES du rAF (60/s) vers le hop rate :
//   EMA : α_hop tel que (1-α_hop)^hopRate = (1-α_rAF)^60  => keep_hop = keep_rAF^(60/hopRate)
//   réfractaires : × (hopRate/60) ;  seuils additifs de flux : × (60/hopRate).

const FFT_SIZE = 2048;
const HOP = 256;
const BAND_COUNT = 64;
const F_MIN = 30;
const F_MAX = 16000;

// --- FFT radix-2, tables précalculées (pas de dérive sur 2048 points) --------
function makeFFT(n) {
  const bits = Math.log2(n);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let x = i, r = 0;
    for (let j = 0; j < bits; j++) { r = (r << 1) | (x & 1); x >>= 1; }
    rev[i] = r >>> 0;
  }
  const cos = new Float32Array(n / 2), sin = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) { const a = (-2 * Math.PI * i) / n; cos[i] = Math.cos(a); sin[i] = Math.sin(a); }
  return function fft(re, im) {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1, step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let k = 0, idx = 0; k < half; k++, idx += step) {
          const wr = cos[idx], wi = sin[idx];
          const ar = re[i + k + half] * wr - im[i + k + half] * wi;
          const ai = re[i + k + half] * wi + im[i + k + half] * wr;
          const ur = re[i + k], ui = im[i + k];
          re[i + k] = ur + ar; im[i + k] = ui + ai;
          re[i + k + half] = ur - ar; im[i + k + half] = ui - ai;
        }
      }
    }
  };
}
// Exposé pour les tests Node (inoffensif en navigateur).
if (typeof globalThis !== "undefined") globalThis.__viz_makeFFT = makeFFT;

class FeatureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.fft = makeFFT(FFT_SIZE);
    this.re = new Float32Array(FFT_SIZE);
    this.im = new Float32Array(FFT_SIZE);
    this.ring = new Float32Array(FFT_SIZE);
    this.rw = 0;
    this.sinceHop = 0;

    // Fenêtre de Hann + sa somme (pour calibrer la magnitude en ~dB comparable
    // à getFloatFrequencyData : sinus pleine échelle -> ~0 dB).
    this.win = new Float32Array(FFT_SIZE);
    let wsum = 0;
    for (let i = 0; i < FFT_SIZE; i++) { this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)); wsum += this.win[i]; }
    this.magScale = 2 / wsum;

    this._computeBands();

    // État AGC (pour le flux) + détecteurs.
    this.peak = new Float32Array(BAND_COUNT);
    this.noise = new Float32Array(BAND_COUNT);
    this.norm = new Float32Array(BAND_COUNT);
    this.prevNorm = new Float32Array(BAND_COUNT);
    this.mags = new Float32Array(BAND_COUNT);
    this.maxMagSlow = 0;
    this.fluxAvg = 0; this._refr = 0;
    this.kickAvg = 0; this._kickRef = 0;
    this.snareAvg = 0; this._snareRef = 0;
    this.hatsAvg = 0; this._hatsRef = 0;

    // --- rescaling rAF(60) -> hop rate --------------------------------------
    const hopRate = sampleRate / HOP; // ex. 187.5 /s
    const p = 60 / hopRate; // exposant de conversion des "keep" d'EMA
    const rf = hopRate / 60; // facteur des réfractaires / division des seuils
    this.C = {
      peakRelease: Math.pow(0.994, p),
      nfRise: 1 - Math.pow(1 - 0.0001, p),
      maxRelease: Math.pow(0.995, p),
      fluxKeep: Math.pow(0.9, p),
      kickRef: Math.round(8 * rf), snareRef: Math.round(7 * rf), hatsRef: Math.round(3 * rf),
      addF: 0.004 / rf, addK: 0.006 / rf, addS: 0.008 / rf, addH: 0.006 / rf,
    };
  }

  _computeBands() {
    const binHz = sampleRate / FFT_SIZE;
    const nyq = sampleRate / 2;
    const fMax = Math.min(F_MAX, nyq * 0.98);
    const bins = FFT_SIZE / 2;
    this.bandBins = [];
    this.bandHz = [];
    for (let b = 0; b < BAND_COUNT; b++) {
      const fLo = F_MIN * Math.pow(fMax / F_MIN, b / BAND_COUNT);
      const fHi = F_MIN * Math.pow(fMax / F_MIN, (b + 1) / BAND_COUNT);
      let i0 = Math.floor(fLo / binHz), i1 = Math.ceil(fHi / binHz);
      i0 = Math.max(0, Math.min(i0, bins - 1));
      i1 = Math.min(bins, Math.max(i1, i0 + 1));
      this.bandBins.push([i0, i1]);
      this.bandHz.push(Math.sqrt(fLo * fHi));
    }
  }

  _analyze() {
    // Fenêtrage depuis le ring (du plus ancien au plus récent).
    let rawPeak = 0;
    for (let i = 0; i < FFT_SIZE; i++) {
      const s = this.ring[(this.rw + i) % FFT_SIZE];
      const a = s < 0 ? -s : s;
      if (a > rawPeak) rawPeak = a;
      this.re[i] = s * this.win[i];
      this.im[i] = 0;
    }
    this.fft(this.re, this.im);

    // Magnitudes de bandes (calibrées).
    const C = this.C, MIN_RANGE = 2e-6, NOISE_RATIO = 3.16e-4;
    const noiseRef = Math.max(this.maxMagSlow * NOISE_RATIO, 1e-9);
    let frameMax = 0;
    for (let b = 0; b < BAND_COUNT; b++) {
      const [i0, i1] = this.bandBins[b];
      let sum = 0;
      for (let i = i0; i < i1; i++) sum += Math.hypot(this.re[i], this.im[i]) * this.magScale;
      const mag = sum / (i1 - i0);
      this.mags[b] = mag;
      if (mag > frameMax) frameMax = mag;
      // AGC (pour le flux) — mêmes formules que le main, constantes rescalées.
      this.peak[b] = Math.max(mag, this.peak[b] * C.peakRelease);
      const nf = this.noise;
      if (mag < nf[b]) nf[b] = mag; else nf[b] += (mag - nf[b]) * C.nfRise;
      const denom = Math.max(this.peak[b] - nf[b], MIN_RANGE);
      const agc = Math.min(1, Math.max(0, (mag - nf[b]) / denom));
      const gate = Math.min(1, Math.max(0, (mag - noiseRef) / (2 * noiseRef)));
      this.norm[b] = agc * gate;
    }
    this.maxMagSlow = Math.max(frameMax, this.maxMagSlow * C.maxRelease);

    // Flux par région + énergie brute (pour la dominance).
    let flux = 0, kF = 0, kR = 0, kN = 0, sF = 0, sR = 0, sN = 0, hF = 0, hR = 0, hN = 0;
    for (let b = 0; b < BAND_COUNT; b++) {
      const d = this.norm[b] - this.prevNorm[b];
      if (d > 0) flux += d;
      const hz = this.bandHz[b], m = this.mags[b];
      if (hz < 120) { if (d > 0) kF += d; kR += m; kN++; }
      else if (hz >= 150 && hz < 2500) { if (d > 0) sF += d; sR += m; sN++; }
      if (hz >= 5000) { if (d > 0) hF += d; hR += m; hN++; }
      this.prevNorm[b] = this.norm[b];
    }
    flux /= BAND_COUNT;
    kF /= kN || 1; kR /= kN || 1; sF /= sN || 1; sR /= sN || 1; hF /= hN || 1; hR /= hN || 1;

    // Détecteurs (dominance sur le brut, seuil sur le flux).
    const fluxW = 1 - C.fluxKeep;
    this.fluxAvg = this.fluxAvg * C.fluxKeep + flux * fluxW;
    let onsetFlag = 0;
    if (this._refr > 0) this._refr--;
    if (flux > this.fluxAvg * 1.6 + C.addF && this._refr === 0) { onsetFlag = 1; this._refr = Math.round(5 * (sampleRate / HOP) / 60); }

    this.kickAvg = this.kickAvg * C.fluxKeep + kF * fluxW;
    let kickFlag = 0;
    if (this._kickRef > 0) this._kickRef--;
    if (kF > this.kickAvg * 1.4 + C.addK && kR > sR * 1.3 && this._kickRef === 0) { kickFlag = 1; this._kickRef = C.kickRef; }

    this.snareAvg = this.snareAvg * C.fluxKeep + sF * fluxW;
    let snareFlag = 0;
    if (this._snareRef > 0) this._snareRef--;
    if (sF > this.snareAvg * 1.6 + C.addS && sR > kR * 1.2 && sR > hR * 1.1 && this._snareRef === 0) { snareFlag = 1; this._snareRef = C.snareRef; }

    this.hatsAvg = this.hatsAvg * C.fluxKeep + hF * fluxW;
    let hatsFlag = 0;
    if (this._hatsRef > 0) this._hatsRef--;
    if (hF > this.hatsAvg * 1.6 + C.addH && hR > kR * 0.15 + 1e-7 && hR > sR * 1.2 && this._hatsRef === 0) { hatsFlag = 1; this._hatsRef = C.hatsRef; }

    // Paquet : mags[64] + flags[4] + strengths[4] + rawPeak.
    const out = new Float32Array(BAND_COUNT + 9);
    out.set(this.mags, 0);
    out[64] = kickFlag; out[65] = snareFlag; out[66] = hatsFlag; out[67] = onsetFlag;
    out[68] = Math.min(1, kF * 10); out[69] = Math.min(1, sF * 10);
    out[70] = Math.min(1, hF * 12); out[71] = Math.min(1, flux * 12);
    out[72] = rawPeak;
    this.port.postMessage(out, [out.buffer]);
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.ring[this.rw] = ch[i];
        this.rw = (this.rw + 1) % FFT_SIZE;
        if (++this.sinceHop >= HOP) { this.sinceHop = 0; this._analyze(); }
      }
    }
    return true;
  }
}

registerProcessor("feature-extractor", FeatureProcessor);
