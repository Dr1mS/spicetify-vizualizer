// analyser.worklet.js — bus de features sur le THREAD AUDIO (plain JS, aucun import).
//
// Chaîne : ring buffer -> fenêtre Hann -> FFT -> spectre -> features -> écriture.
// Features/hop : mel[32] (échelle mel), rms, peak, spectralFlux, onset, centroid,
// flatness, energy, keyHue, kick/snare/hats (flux par région + dominance brute).
// NORMALISATION ADAPTATIVE par feature (min/max glissant) -> 0..1 sans tuning.
//
// Écriture SEQLOCK dans un SharedArrayBuffer (zéro-copie) si fourni, sinon
// postMessage de la trame (fallback non-isolé). Le LAYOUT vient de processorOptions
// (source unique partagée avec le main thread).
//
// ⚠️ Testé en Node (test/worklet-node.test.mjs) sur le FICHIER expédié :
// FFT vs DFT, mel d'un sinus, séparation d'onsets, remplissage de l'AGC.

const FFT_SIZE = 2048;
const HOP = 512; // hop rate = sampleRate/HOP (~94/s @48k)
const F_MIN = 30;
const F_MAX = 16000;

// ---- FFT radix-2, tables précalculées (pas de dérive) ----------------------
function makeFFT(n) {
  const bits = Math.log2(n);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) { let x = i, r = 0; for (let j = 0; j < bits; j++) { r = (r << 1) | (x & 1); x >>= 1; } rev[i] = r >>> 0; }
  const cos = new Float32Array(n / 2), sin = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) { const a = (-2 * Math.PI * i) / n; cos[i] = Math.cos(a); sin[i] = Math.sin(a); }
  return function fft(re, im) {
    for (let i = 0; i < n; i++) { const j = rev[i]; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
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
if (typeof globalThis !== "undefined") globalThis.__viz_makeFFT = makeFFT;

const hzToMel = (f) => 2595 * Math.log10(1 + f / 700);
const melToHz = (m) => 700 * (Math.pow(10, m / 2595) - 1);

// ---- normalisation adaptative par feature (min/max glissant) ---------------
function makeNorm(riseFloor) {
  return { max: 1e-6, min: 0, floor: riseFloor };
}
function norm(s, x) {
  s.max = Math.max(x, s.max * 0.9995); // release lent
  if (x < s.min) s.min = x; else s.min += (x - s.min) * 0.0003; // montée lente
  const d = Math.max(s.max - s.min, s.floor);
  return Math.min(1, Math.max(0, (x - s.min) / d));
}

class AnalyserProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.L = o.layout; // indices Float32 (source unique du main)
    this.melCount = o.melCount || 32;
    this.useSAB = !!o.sab;
    if (this.useSAB) { this.f32 = new Float32Array(o.sab); this.i32 = new Int32Array(o.sab); }
    this.out = new Float32Array(o.featLen);

    this.fft = makeFFT(FFT_SIZE);
    this.re = new Float32Array(FFT_SIZE);
    this.im = new Float32Array(FFT_SIZE);
    this.ring = new Float32Array(FFT_SIZE);
    this.rw = 0; this.sinceHop = 0;

    this.win = new Float32Array(FFT_SIZE);
    let wsum = 0;
    for (let i = 0; i < FFT_SIZE; i++) { this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)); wsum += this.win[i]; }
    this.magScale = 2 / wsum;

    this._buildMel();

    const bins = FFT_SIZE / 2;
    this.mag = new Float32Array(bins);
    this.prevMag = new Float32Array(bins);
    this.mel = new Float32Array(this.melCount);
    this.melPeak = new Float32Array(this.melCount); // AGC par bande mel
    this.melNoise = new Float32Array(this.melCount);
    this.prevMelN = new Float32Array(this.melCount);

    // normaliseurs adaptatifs
    this.nRms = makeNorm(1e-4); this.nFlux = makeNorm(1e-4); this.nCentroid = makeNorm(1e-3); this.nEnergy = makeNorm(1e-5);

    // détecteurs d'onsets
    this.fluxAvg = 0; this.onset = 0; this.onsetId = 0; this._refr = 0;
    this.kickAvg = 0; this.kick = 0; this.kickId = 0; this._kR = 0;
    this.snareAvg = 0; this.snare = 0; this.snareId = 0; this._sR = 0;
    this.hatsAvg = 0; this.hats = 0; this.hatsId = 0; this._hR = 0;
    this.energyRef = 0; this.energyV = 0;
    this.chroma = new Float32Array(12); this.keyHue = 0;
    this._blockTime = 0;
  }

  _buildMel() {
    const nyq = sampleRate / 2;
    const fMax = Math.min(F_MAX, nyq * 0.98);
    const binHz = sampleRate / FFT_SIZE;
    const bins = FFT_SIZE / 2;
    const m0 = hzToMel(F_MIN), m1 = hzToMel(fMax);
    const edges = []; // melCount+2 points en Hz
    for (let i = 0; i < this.melCount + 2; i++) edges.push(melToHz(m0 + ((m1 - m0) * i) / (this.melCount + 1)));
    // pour chaque bande : liste [bin, poids] triangulaire
    this.melBands = [];
    this.melHz = [];
    for (let b = 0; b < this.melCount; b++) {
      const lo = edges[b], ce = edges[b + 1], hi = edges[b + 2];
      const taps = [];
      const i0 = Math.max(0, Math.floor(lo / binHz)), i1 = Math.min(bins - 1, Math.ceil(hi / binHz));
      for (let i = i0; i <= i1; i++) {
        const f = i * binHz;
        let w = 0;
        if (f >= lo && f <= ce) w = ce > lo ? (f - lo) / (ce - lo) : 1;
        else if (f > ce && f <= hi) w = hi > ce ? (hi - f) / (hi - ce) : 1;
        if (w > 0) taps.push(i, w);
      }
      if (taps.length === 0) { const i = Math.min(bins - 1, Math.round(ce / binHz)); taps.push(i, 1); }
      this.melBands.push(taps);
      this.melHz.push(ce);
    }
  }

  _analyze() {
    const bins = FFT_SIZE / 2;
    // fenêtrage + rms/peak (temps-domaine)
    let rms = 0, peak = 0;
    for (let i = 0; i < FFT_SIZE; i++) {
      const s = this.ring[(this.rw + i) % FFT_SIZE];
      const a = s < 0 ? -s : s; if (a > peak) peak = a; rms += s * s;
      this.re[i] = s * this.win[i]; this.im[i] = 0;
    }
    rms = Math.sqrt(rms / FFT_SIZE);
    this.fft(this.re, this.im);

    // spectre
    let cW = 0, cT = 0, logSum = 0, linSum = 0;
    const binHz = sampleRate / FFT_SIZE;
    this.chroma.fill(0);
    for (let i = 0; i < bins; i++) {
      const m = Math.hypot(this.re[i], this.im[i]) * this.magScale;
      this.mag[i] = m;
      const f = i * binHz;
      cW += f * m; cT += m; logSum += Math.log(m + 1e-9); linSum += m;
      if (f >= 100 && f <= 2000) { const pc = ((Math.round(12 * Math.log2(f / 440)) % 12) + 12) % 12; this.chroma[pc] += m; }
    }

    // mel + AGC par bande + flux par région (kick/snare/hats)
    let kR = 0, kN = 0, sR = 0, sN = 0, hR = 0, hN = 0;
    let kFx = 0, sFx = 0, hFx = 0, flux = 0;
    for (let b = 0; b < this.melCount; b++) {
      const taps = this.melBands[b];
      let e = 0; for (let t = 0; t < taps.length; t += 2) e += this.mag[taps[t]] * taps[t + 1];
      // AGC bande (norm 0..1)
      this.melPeak[b] = Math.max(e, this.melPeak[b] * 0.994);
      const nf = this.melNoise;
      if (e < nf[b]) nf[b] = e; else nf[b] += (e - nf[b]) * 0.0001;
      const denom = Math.max(this.melPeak[b] - nf[b], 2e-6);
      const nrm = Math.min(1, Math.max(0, (e - nf[b]) / denom));
      // flux (par région) sur la bande normalisée
      const d = nrm - this.prevMelN[b]; if (d > 0) flux += d;
      const hz = this.melHz[b];
      if (hz < 120) { if (d > 0) kFx += d; kR += e; kN++; }
      else if (hz >= 150 && hz < 2500) { if (d > 0) sFx += d; sR += e; sN++; }
      if (hz >= 5000) { if (d > 0) hFx += d; hR += e; hN++; }
      this.prevMelN[b] = nrm; this.mel[b] = nrm;
    }
    flux /= this.melCount;
    kFx /= kN || 1; sFx /= sN || 1; hFx /= hN || 1;
    kR /= kN || 1; sR /= sN || 1; hR /= hN || 1;

    // onset large bande + kick/snare/hats (dominance décisive)
    this.fluxAvg = this.fluxAvg * 0.9 + flux * 0.1;
    if (this._refr > 0) this._refr--;
    if (flux > this.fluxAvg * 1.6 + 0.004 && this._refr === 0) { this.onsetId++; this._refr = 5; }
    const oT = Math.min(1, flux * 12); this.onset = oT > this.onset ? oT : this.onset * 0.86;

    this.kickAvg = this.kickAvg * 0.9 + kFx * 0.1;
    if (this._kR > 0) this._kR--;
    if (kFx > this.kickAvg * 1.4 + 0.006 && kR > sR * 1.3 && this._kR === 0) { this.kickId++; this._kR = 8; }
    this.kick = Math.min(1, kFx * 10) > this.kick ? Math.min(1, kFx * 10) : this.kick * 0.85;
    this.snareAvg = this.snareAvg * 0.9 + sFx * 0.1;
    if (this._sR > 0) this._sR--;
    if (sFx > this.snareAvg * 1.6 + 0.008 && sR > kR * 1.2 && sR > hR * 1.1 && this._sR === 0) { this.snareId++; this._sR = 7; }
    this.snare = Math.min(1, sFx * 10) > this.snare ? Math.min(1, sFx * 10) : this.snare * 0.85;
    this.hatsAvg = this.hatsAvg * 0.9 + hFx * 0.1;
    if (this._hR > 0) this._hR--;
    if (hFx > this.hatsAvg * 1.6 + 0.006 && hR > kR * 0.15 + 1e-7 && hR > sR * 1.2 && this._hR === 0) { this.hatsId++; this._hR = 3; }
    this.hats = Math.min(1, hFx * 12) > this.hats ? Math.min(1, hFx * 12) : this.hats * 0.8;

    // features scalaires
    const centroidHz = cT > 1e-9 ? cW / cT : F_MIN;
    const l0 = Math.log(F_MIN), l1 = Math.log(F_MAX);
    const centroidRaw = Math.min(1, Math.max(0, (Math.log(Math.max(centroidHz, F_MIN)) - l0) / (l1 - l0)));
    const flatness = (linSum > 1e-9) ? Math.min(1, Math.exp(logSum / bins) / (linSum / bins)) : 0;
    // energy macro (brute, relative baseline ~20s)
    let rawE = 0; for (let b = 0; b < this.melCount; b++) rawE += this.melPeak[b] === 0 ? 0 : this.mel[b];
    rawE = linSum; // énergie spectrale brute
    this.energyRef = this.energyRef === 0 ? rawE : this.energyRef * 0.9992 + rawE * 0.0008;
    const energyRaw = Math.min(1, Math.max(0, (rawE / (this.energyRef + 1e-9)) * 0.5));
    this.energyV = this.energyV * 0.7 + energyRaw * 0.3;
    // keyHue (centroïde circulaire lissé)
    let cs = 0; for (let k = 0; k < 12; k++) cs += this.chroma[k];
    if (cs > 1e-9) for (let k = 0; k < 12; k++) this.chroma[k] = this.chroma[k] * 0.95 + (this.chroma[k] / cs) * 0.05;
    let hx = 0, hy = 0; for (let k = 0; k < 12; k++) { const a = (2 * Math.PI * k) / 12; hx += this.chroma[k] * Math.cos(a); hy += this.chroma[k] * Math.sin(a); }
    if (hx * hx + hy * hy > 1e-9) this.keyHue = (Math.atan2(hy, hx) / (2 * Math.PI) + 1) % 1;

    // écriture de la trame
    const L = this.L, o = this.out;
    o[L.T_FRAME] = this._blockTime - (FFT_SIZE * 0.5) / sampleRate;
    o[L.RMS] = norm(this.nRms, rms);
    o[L.PEAK] = Math.min(1, peak);
    o[L.FLUX] = norm(this.nFlux, flux);
    o[L.CENTROID] = norm(this.nCentroid, centroidRaw);
    o[L.FLATNESS] = flatness;
    o[L.ENERGY] = this.energyV;
    o[L.KEY_HUE] = this.keyHue;
    o[L.ONSET_STR] = this.onset; o[L.ONSET_ID] = this.onsetId;
    o[L.KICK] = this.kick; o[L.KICK_ID] = this.kickId;
    o[L.SNARE] = this.snare; o[L.SNARE_ID] = this.snareId;
    o[L.HATS] = this.hats; o[L.HATS_ID] = this.hatsId;
    o[L.STEREO] = 0.5; o[L.PITCH] = -1;
    for (let b = 0; b < this.melCount; b++) o[L.MEL0 + b] = this.mel[b];

    this._publish();
  }

  _publish() {
    if (this.useSAB) {
      const i32 = this.i32, f32 = this.f32, L = this.L, o = this.out;
      Atomics.store(i32, L.SEQ, Atomics.load(i32, L.SEQ) + 1); // impair
      for (let i = 1; i < o.length; i++) f32[i] = o[i];
      Atomics.store(i32, L.SEQ, Atomics.load(i32, L.SEQ) + 1); // pair
    } else {
      this.port.postMessage(this.out);
    }
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    this._blockTime = currentTime;
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.ring[this.rw] = ch[i];
        this.rw = (this.rw + 1) % FFT_SIZE;
        if (++this.sinceHop >= HOP) { this.sinceHop = 0; this._blockTime = currentTime + i / sampleRate; this._analyze(); }
      }
    }
    return true;
  }
}

registerProcessor("analyser", AnalyserProcessor);
