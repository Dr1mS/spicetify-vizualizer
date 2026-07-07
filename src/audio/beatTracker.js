// beatTracker.js — beat tracker EN LIGNE (réactif pur ; extrapolation de phase,
// pas de look-ahead offline). Plain JS -> testable en Node ET importé par le TS.
//
// Décision d'archi (adresse R1/R3 du verify) : on DÉCOUPLE
//   - TEMPO : autocorrélation de l'enveloppe d'onset, ré-estimée périodiquement,
//     avec sélection d'octave explicite + hystérésis (source UNIQUE du bpm).
//   - PHASE : PLL qui corrige la phase UNIQUEMENT sur les onsets proches d'un
//     beat (rejet des contretemps, F3), correction douce plafonnée pondérée par
//     la force (F5). Le bpm ne vient JAMAIS de la phase.
//
// Fixes intégrés :
//   F2  clamp bpm 70..180 à CHAQUE mise à jour (jamais dans une branche onset).
//   F3  correction de phase seulement si |err| < NEAR (rejette offbeats).
//   F4  predictedNextBeat non-décroissant (latch dans query()).
//   F5  correction douce plafonnée : phase += clamp(Kp*err*strength, ±MAXCORR).
//   F6  lock-confidence = 1 - std(|err| récents)/tol  (PAS la moyenne, qui masque le jitter).

const BPM_MIN = 70;
const BPM_MAX = 180;
const NEAR = 0.14; // fenêtre de correction (fraction de beat)
const KP = 0.4; // gain proportionnel de phase (fort -> verrou serré malgré un tempo bruité)
const MAXCORR = 0.12; // correction max par onset (fraction de beat)
const BIN = 0.005; // résolution de l'enveloppe d'onset (s) — fin pour ne pas splitter le lag fondamental
const WINDOW = 4.0; // historique pour l'autocorrélation (s)
const EST_PERIOD = 0.5; // ré-estimation du tempo (s)

export class BeatTracker {
  constructor(bpm = 120) {
    this.bpm = clampBpm(bpm);
    this.phase = 0; // 0..1
    this.lastT = 0;
    this.onsets = []; // {t, s} récents (≤ WINDOW)
    this.errHist = []; // |err| des onsets acceptés (lock confidence)
    this.lastEst = -1e9;
    this.lockConf = 0;
    this.locked = false; // état à HYSTÉRÉSIS (Schmitt) : évite le flapping acquisition<->suivi
    this._latchedNext = 0;
    this._started = false;
  }

  _advanceTo(t) {
    if (!this._started) { this.lastT = t; this._started = true; return; }
    const dt = t - this.lastT;
    if (dt > 0) { this.phase = frac(this.phase + dt * (this.bpm / 60)); this.lastT = t; }
  }

  // Onset détecté à l'instant t (horloge audio), force 0..1.
  addOnset(t, strength) {
    this._advanceTo(t);
    this.onsets.push({ t, s: strength });
    const cut = t - WINDOW;
    while (this.onsets.length && this.onsets[0].t < cut) this.onsets.shift();

    // erreur de phase (pré-correction) vers le beat le plus proche
    const err = this.phase < 0.5 ? -this.phase : 1 - this.phase; // ∈ [-0.5, 0.5]
    const absErr = Math.abs(err);
    if (this.locked) {
      // SUIVI : rejet des contretemps (F3) + correction douce plafonnée (F5).
      if (absErr < NEAR) {
        this.phase = frac(this.phase + clamp(KP * err * strength, -MAXCORR, MAXCORR));
        this._pushErr(absErr);
      }
      // offbeats : ignorés (ne corrompent ni la phase ni le lock)
    } else {
      // ACQUISITION : l'onset DÉFINIT un beat -> on snappe la phase dessus.
      // (Résout le chicken-and-egg : sans ça, un tempo initial faux empêche le verrou.)
      this.phase = frac(this.phase + err);
      this._pushErr(absErr);
    }
    if (t - this.lastEst > EST_PERIOD) this._estimateTempo(t);
  }

  _pushErr(e) {
    this.errHist.push(e);
    if (this.errHist.length > 16) this.errHist.shift();
    if (this.errHist.length >= 8) {
      const m = this.errHist.reduce((a, b) => a + b, 0) / this.errHist.length;
      let v = 0; for (const x of this.errHist) v += (x - m) * (x - m);
      this.lockConf = clamp(1 - Math.sqrt(v / this.errHist.length) / 0.05, 0, 1); // F6 : std, pas moyenne
      // Schmitt : on n'ACQUIERT le lock qu'au-dessus de 0.5, on ne le PERD que
      // sous 0.15 -> pas de bascule vers l'acquisition sur un creux transitoire.
      if (!this.locked && this.lockConf > 0.5) this.locked = true;
      else if (this.locked && this.lockConf < 0.15) this.locked = false;
    }
  }

  // Autocorrélation de l'enveloppe d'onset -> bpm.
  // Désambiguïsation d'octave = score harmonique × PRIOR de salience (log-gaussien
  // autour de ~125 BPM). Résolution sub-bin = interpolation PARABOLIQUE du pic.
  _estimateTempo(now) {
    this.lastEst = now;
    const N = Math.round(WINDOW / BIN);
    const env = new Float32Array(N);
    const t0 = now - WINDOW;
    for (const o of this.onsets) {
      const b = Math.floor((o.t - t0) / BIN);
      if (b >= 0 && b < N) env[b] += o.s;
    }
    let e = 0; for (let i = 0; i < N; i++) e += env[i];
    if (e < 1e-6) return;

    const Lmin = Math.round(60 / BPM_MAX / BIN); // 180 BPM
    const Lmax = Math.round(60 / BPM_MIN / BIN); // 70 BPM
    const ac = new Float32Array(Lmax + 2);
    for (let L = Lmin; L <= Lmax + 1 && L < N; L++) {
      let s = 0; for (let i = L; i < N; i++) s += env[i] * env[i - L];
      ac[L] = s;
    }
    const PREF = 125, SIG = 0.55;
    const pref = (bpm) => { const x = Math.log(bpm / PREF); return Math.exp(-(x * x) / (2 * SIG * SIG)); };
    const harm = (L) => ac[L] + (2 * L <= Lmax ? 0.6 * ac[2 * L] : 0) + (3 * L <= Lmax ? 0.35 * ac[3 * L] : 0);
    // score = harmonique × prior de salience (résout demi/double tempo)
    const sc = new Float32Array(Lmax + 1);
    let bestL = Lmin, best = -1;
    for (let L = Lmin; L <= Lmax; L++) { sc[L] = harm(L) * pref(60 / (L * BIN)); if (sc[L] > best) { best = sc[L]; bestL = L; } }

    // interpolation parabolique -> lag fractionnaire (précision sub-bin)
    let Lref = bestL;
    if (bestL > Lmin && bestL < Lmax) {
      const a = sc[bestL - 1], b = sc[bestL], c = sc[bestL + 1];
      const den = a - 2 * b + c;
      if (Math.abs(den) > 1e-12) Lref = bestL + clamp(0.5 * (a - c) / den, -0.5, 0.5);
    }
    let candBpm = clampBpm(60 / (Lref * BIN));

    // On SUIT toujours le candidat pour un RAFFINEMENT (petit écart) : c'est ce
    // qui amène le tempo pile sur le beat. On ne GATE que les SAUTS D'OCTAVE
    // (candidat ~2x/~0.5x), qui exigent une preuve forte (score courant = max voisin,
    // car le pic fondamental tombe entre deux bins entiers).
    const curL = Math.round(60 / this.bpm / BIN);
    let curScore = 0;
    for (let L = curL - 2; L <= curL + 2; L++) if (L >= Lmin && L <= Lmax && sc[L] > curScore) curScore = sc[L];
    // FIABILITÉ : ne bouge le tempo que si le pic est PROÉMINENT et qu'il y a assez
    // d'onsets. Sinon on COASTE (données trop pauvres -> le tempo dérive, cf. beats
    // manquants). Un tempo verrouillé ne suit pas un pic douteux.
    let meanSc = 0; for (let L = Lmin; L <= Lmax; L++) meanSc += sc[L];
    meanSc /= (Lmax - Lmin + 1);
    const reliable = this.onsets.length >= 6 && best > meanSc * 2.5;
    if (!reliable) return;

    const r = candBpm / this.bpm;
    if ((r > 1.5 || r < 0.67) && best < curScore * 1.5) candBpm = this.bpm; // rejette le saut d'octave
    this.bpm = clampBpm(this.bpm + 0.15 * (candBpm - this.bpm)); // F2 clamp à chaque MAJ
  }

  // À l'instant `now`, renvoie l'état extrapolé (réactif : lit, ne planifie pas offline).
  query(now) {
    this._advanceTo(now);
    let next = now + (1 - this.phase) * (60 / this.bpm);
    // F4 : predictedNextBeat non-décroissant (latch tant qu'il n'est pas passé).
    if (this._latchedNext > now && next < this._latchedNext) next = this._latchedNext;
    else this._latchedNext = next;
    return { bpm: this.bpm, beatPhase: this.phase, nextBeat: next, lockConf: this.lockConf };
  }
}

function frac(x) { return x - Math.floor(x); }
function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
function clampBpm(x) { return clamp(x, BPM_MIN, BPM_MAX); }
