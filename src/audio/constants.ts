// constants.ts — LAYOUT du buffer de features (SOURCE UNIQUE main + worklet).
//
// Le worklet est en plain-JS et ne peut pas importer ce module : on lui passe
// le LAYOUT via processorOptions -> une seule source de vérité, zéro duplication.
//
// Transport : un Float32Array sur SharedArrayBuffer (zéro-copie) quand
// crossOriginIsolated ; sinon fallback postMessage (copie). Dans les deux cas la
// même trame de features arrive au main thread.
//
// Anti-tearing : SEQLOCK. Le worklet écrit SEQ impair -> features -> SEQ pair
// (incrément de 2). Le lecteur rAF relit si SEQ est impair ou a changé.
// SEQ vit dans une vue Int32 sur le MÊME buffer (slot 0).

export const MEL_COUNT = 32;

// Indices Float32 dans la trame de features.
export const F = {
  SEQ: 0, // lu via vue Int32 (seqlock)
  T_FRAME: 1, // horloge AudioContext du centre de fenêtre (s)
  RMS: 2,
  PEAK: 3,
  FLUX: 4, // flux spectral normalisé 0..1
  CENTROID: 5, // brillance 0..1
  FLATNESS: 6, // 0..1
  ENERGY: 7, // macro-énergie 0..1
  KEY_HUE: 8, // chroma -> teinte 0..1
  ONSET_STR: 9, // enveloppe d'onset continue 0..1
  ONSET_ID: 10, // compteur monotone -> edge-detect au rAF (CANONIQUE)
  KICK: 11,
  KICK_ID: 12,
  SNARE: 13,
  SNARE_ID: 14,
  HATS: 15,
  HATS_ID: 16,
  STEREO: 17, // largeur/pan 0..1 (0.5 si mono)
  PITCH: 18, // f0 normalisée, -1 si absent
  MEL0: 19, // MEL[0..31] = indices 19..50
} as const;

export const FEAT_LEN = F.MEL0 + MEL_COUNT; // 51 floats

export interface FeatureBuffer {
  buffer: ArrayBufferLike;
  f32: Float32Array;
  i32: Int32Array;
  shared: boolean;
}

// Alloue le buffer de features (SAB si possible, sinon ArrayBuffer classique).
export function makeFeatureBuffer(): FeatureBuffer {
  const bytes = FEAT_LEN * 4;
  const shared = typeof SharedArrayBuffer !== "undefined" && (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
  const buffer: ArrayBufferLike = shared ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes);
  return { buffer, f32: new Float32Array(buffer), i32: new Int32Array(buffer), shared };
}

// Lecture seqlock côté main (SAB). Retourne true si une trame stable a été copiée.
export function readSeqlock(i32: Int32Array, f32: Float32Array, out: Float32Array, lastSeq: { v: number }): boolean {
  for (let tries = 0; tries < 4; tries++) {
    const s1 = Atomics.load(i32, F.SEQ);
    if (s1 & 1) continue; // écriture en cours
    // copie
    for (let i = 1; i < FEAT_LEN; i++) out[i] = f32[i];
    const s2 = Atomics.load(i32, F.SEQ);
    if (s1 === s2) {
      const isNew = s1 !== lastSeq.v;
      lastSeq.v = s1;
      out[F.SEQ] = s1;
      return isNew;
    }
  }
  return false;
}
