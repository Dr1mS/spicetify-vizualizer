// Frame synthétique — pilote le visuel SANS audio (dev + preview headless).
// Reproduit le contrat exact de AudioEngine.sample() :
//   { bands, bandHz, bass, mid, treble, level, onset, onsetFlag, centroid, flatness, raw }

const N = 64;

export function makeDemo() {
  const bands = new Float32Array(N);
  const mag = new Float32Array(N); // magnitude linéaire "brute" simulée (analyseur)
  const chroma = new Float32Array(12);
  const bandHz = Array.from({ length: N }, (_, b) => 30 * Math.pow(16000 / 30, (b + 0.5) / N));
  let t = 0;
  let onsetEnv = 0;
  let wasBreak = false;

  return function demoFrame() {
    t += 1 / 60;

    // Kick régulier ~2 Hz -> onset + poussée de basses.
    const beatPhase = (t * 2) % 1;
    const onsetFlag = beatPhase < 1 / 60;
    if (onsetFlag) onsetEnv = 1;
    onsetEnv *= 0.86;

    const bass = 0.35 + 0.5 * Math.exp(-beatPhase * 8) + 0.1 * Math.sin(t * 1.3);
    const centroid = 0.5 + 0.4 * Math.sin(t * 0.37);

    // Batterie synthétique : snare sur le contretemps, hats en croches.
    const snarePhase = (t * 2 + 0.5) % 1;
    const snareFlag = snarePhase < 1 / 60;
    const hatFlag = ((t * 8) % 1) < 1 / 60;
    // Harmonie qui tourne lentement + chroma factice.
    const keyHue = (t * 0.03) % 1;
    for (let k = 0; k < 12; k++) chroma[k] = Math.max(0, Math.sin(t * 0.1 + k));
    // Cycle de structure ~14 s : plein -> accalmie -> reprise.
    const cyc = (t % 14) / 14;
    const breakActive = cyc > 0.55 && cyc < 0.72;
    const reentryFlag = wasBreak && !breakActive;
    wasBreak = breakActive;
    const anticipation = breakActive ? (cyc - 0.55) / 0.17 : 0;
    const energy = breakActive ? 0.12 : Math.min(1, 0.5 + 0.45 * Math.sin(t * 0.3) + (reentryFlag ? 0.5 : 0));
    const tension = Math.max(0, energy * 1.1 - 0.15);
    const dropFlag = Math.abs(snarePhase - 0.5) < 1 / 60 && tension > 0.85;

    // Spectre : bosse mobile + harmoniques + scintillement aigu.
    for (let b = 0; b < N; b++) {
      const x = b / N;
      const bump = Math.exp(-Math.pow((x - (0.35 + 0.25 * Math.sin(t * 0.5))) * 4, 2));
      const bassPart = Math.exp(-x * 6) * (0.6 + 0.6 * Math.exp(-beatPhase * 8));
      const shimmer = 0.15 * Math.max(0, Math.sin(t * 6 + b * 0.6)) * x;
      bands[b] = Math.min(1, bump * 0.8 + bassPart + shimmer);
      // "brut" simulé : bande 0..1 -> plage dB [-90,-20] -> magnitude linéaire.
      mag[b] = Math.pow(10, (-90 + bands[b] * 70) / 20);
    }

    return {
      bands,
      bandsMag: mag,
      bandHz,
      bass: Math.min(1, bass),
      mid: 0.4 + 0.2 * Math.sin(t * 0.9),
      treble: 0.3 + 0.2 * centroid,
      level: 0.4 + 0.3 * Math.exp(-beatPhase * 8),
      onset: onsetEnv,
      onsetFlag,
      kick: onsetEnv, // dans la démo, le "beat" EST un kick
      kickFlag: onsetFlag,
      snare: snareFlag ? 1 : 0,
      snareFlag,
      hats: hatFlag ? 1 : 0,
      hatsFlag: hatFlag,
      chroma,
      keyHue,
      tension,
      dropFlag,
      energy,
      breakActive,
      anticipation,
      reentryFlag,
      centroid,
      flatness: 0.2,
      raw: 0.3 + 0.4 * Math.exp(-beatPhase * 8),
    };
  };
}
