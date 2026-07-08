// beatTracker.js — beat tracker EN LIGNE (réactif pur ; extrapolation de phase,
// pas de look-ahead offline). Plain JS -> testable en Node ET importé par le TS.
//
// Décision d'archi (adresse R1/R3 du verify) : on DÉCOUPLE
//   - TEMPO : autocorrélation de l'enveloppe d'onset, ré-estimée périodiquement,
//     avec sélection d'octave explicite + hystérésis (source UNIQUE du bpm).
//   - PHASE : ACCUMULATEUR CIRCULAIRE pondéré par la force (moyenne vectorielle à
//     décroissance). Chaque onset ajoute un vecteur à l'angle = phase courante ; la
//     moyenne φ̄ = où tombent les onsets dans notre repère → on corrige pour l'amener
//     à 0 (beat = phase 0). Robuste aux offbeats : les hats faibles à l'antiphase se
//     SOUSTRAIENT sans arracher la phase (l'ancien snap-sur-chaque-onset battait au
//     rythme des onsets, pas du beat). Le bpm ne vient JAMAIS de la phase.
//
// Fixes intégrés :
//   F2  clamp bpm 70..180 à CHAQUE mise à jour (jamais dans une branche onset).
//   F4  predictedNextBeat non-décroissant (latch dans query()).
//   F6  lock-confidence = R = |V|/W = concentration de l'accumulateur (1 = onsets
//       serrés sur le beat, 0 = diffus). Verrou (Schmitt) que si R haut ET aligné.

const BPM_MIN = 70;
const BPM_MAX = 180;
const DECAY = 0.88; // mémoire de l'accumulateur de phase (~8 onsets)
const GAIN_ACQ = 0.6; // gain de correction de phase en ACQUISITION (converge vite)
const GAIN_LOCK = 0.4; // gain de correction fine une fois verrouillé (suivi serré, stable)
const MIN_EV = 4.5; // preuve minimale (wsum) avant d'autoriser le verrou (R=1 dès 1 onset)
const R_LOCK = 0.5; // seuil Schmitt haut (acquiert le verrou)
const R_UNLOCK = 0.25; // seuil Schmitt bas (perd le verrou)
const TEMPO_LERP = 0.3; // vitesse de convergence du bpm (assez rapide -> peu de lag de phase)
const BIN = 0.005; // résolution de l'enveloppe d'onset (s) — fin pour ne pas splitter le lag fondamental
const WINDOW = 4.0; // historique pour l'autocorrélation (s)
const EST_PERIOD = 0.5; // ré-estimation du tempo (s)

export class BeatTracker {
  constructor(bpm = 120) {
    this.bpm = clampBpm(bpm);
    this.phase = 0; // 0..1
    this.lastT = 0;
    this.onsets = []; // {t, s} récents (≤ WINDOW)
    this.vx = 0; this.vy = 0; this.wsum = 0; // accumulateur circulaire pondéré (phase)
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

    // ACCUMULATEUR CIRCULAIRE pondéré par la force (mémoire à décroissance) : ajoute
    // un vecteur à l'angle = phase courante. R = |V|/W = concentration = lock-confidence.
    const ang = 2 * Math.PI * this.phase;
    this.vx = this.vx * DECAY + strength * Math.cos(ang);
    this.vy = this.vy * DECAY + strength * Math.sin(ang);
    this.wsum = this.wsum * DECAY + strength;
    const R = this.wsum > 1e-6 ? Math.hypot(this.vx, this.vy) / this.wsum : 0;
    this.lockConf = R;
    const phiBar = Math.atan2(this.vy, this.vx) / (2 * Math.PI); // ∈ (-0.5,0.5] = décalage résiduel
    // Schmitt : on n'ACQUIERT le verrou que quand les onsets sont concentrés (R haut)
    // ET alignés sur la phase 0 (|φ̄| petit) ET avec assez de preuve (wsum ≥ MIN_EV —
    // sinon R=1 dès le 1er onset verrouillerait à un tempo initial faux). R mesure la
    // consistance, pas l'alignement : d'où la condition sur |φ̄|.
    if (!this.locked && R > R_LOCK && Math.abs(phiBar) < 0.06 && this.wsum > MIN_EV) this.locked = true;
    else if (this.locked && R < R_UNLOCK) this.locked = false;

    // L'accumulateur possède la phase (un seul mécanisme, pas de duel PLL/accum) :
    // corrige vers φ̄ = 0. Gain fort en acquisition (converge vite), doux une fois
    // verrouillé (suivi serré). On TOURNE l'accumulateur du même angle que la
    // correction : les vecteurs stockés restent dans le repère courant (sinon φ̄ traîne
    // d'un frame périmé → convergence lente). |V| (donc R) est préservé par la rotation.
    const gain = this.locked ? GAIN_LOCK : GAIN_ACQ;
    const delta = gain * phiBar; // phase -= delta
    this.phase = frac(this.phase - delta);
    const rot = -2 * Math.PI * delta, c = Math.cos(rot), s = Math.sin(rot);
    const nx = this.vx * c - this.vy * s, ny = this.vx * s + this.vy * c;
    this.vx = nx; this.vy = ny;

    if (t - this.lastEst > EST_PERIOD) this._estimateTempo(t);
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
    // Étend l'autocorr jusqu'à 3·Lmax pour que le renfort harmonique (2L,3L) soit
    // DISPONIBLE même pour les lags lents. Sinon biais structurel vers les tempos
    // rapides faux : une tactus près de Lmax (ex. 120 BPM, lag 100) ne récolte pas
    // son 2L=200 hors plage, tandis qu'un candidat rapide (160 BPM, lag 75) récolte
    // son 2L=150 → il gagne à tort (cause du 240→158). Normalisé par le recouvrement
    // (N-L) : sinon les lags longs (moins de termes) sont sous-évalués (autre biais).
    const Lext = Math.min(3 * Lmax, N - 1);
    const ac = new Float32Array(Lext + 1);
    for (let L = Lmin; L <= Lext; L++) {
      let s = 0; for (let i = L; i < N; i++) s += env[i] * env[i - L];
      ac[L] = s / (N - L);
    }
    const PREF = 125, SIG = 0.55;
    const pref = (bpm) => { const x = Math.log(bpm / PREF); return Math.exp(-(x * x) / (2 * SIG * SIG)); };
    const acAt = (k) => (k <= Lext ? ac[k] : 0);
    const harm = (L) => ac[L] + 0.6 * acAt(2 * L) + 0.35 * acAt(3 * L);
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
    this.bpm = clampBpm(this.bpm + TEMPO_LERP * (candBpm - this.bpm)); // F2 clamp à chaque MAJ
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
