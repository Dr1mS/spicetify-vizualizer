// layout.mjs — MIROIR de src/audio/constants.ts pour le pont Node.
// Le worklet est plain-JS et reçoit le layout via processorOptions : même
// mécanique qu'en navigateur. test/bridge-layout.test.mjs échoue si ça diverge.

export const MEL_COUNT = 32;

export const F = {
  SEQ: 0, T_FRAME: 1, RMS: 2, PEAK: 3, FLUX: 4, CENTROID: 5, FLATNESS: 6,
  ENERGY: 7, KEY_HUE: 8, ONSET_STR: 9, ONSET_ID: 10, KICK: 11, KICK_ID: 12,
  SNARE: 13, SNARE_ID: 14, HATS: 15, HATS_ID: 16, STEREO: 17, PITCH: 18, MEL0: 19,
};

export const FEAT_LEN = F.MEL0 + MEL_COUNT; // 51 floats
