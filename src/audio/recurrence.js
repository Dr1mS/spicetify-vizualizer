// recurrence.ts — MÉMOIRE DE FORME : détecte, en temps réel, qu'un passage du
// morceau est en train de SE REJOUER, et depuis combien de temps.
//
// Trois choses ont été mesurées sur de la vraie musique avant d'écrire ceci ;
// elles expliquent chaque choix :
//
// 1. Les bandes mel sortent du worklet avec une AGC par bande. Conséquence :
//    tous les contenus se ressemblent (cosinus 0,77 à 0,98 entre des passages
//    pourtant différents) — une composante COMMUNE écrase tout. On retire donc
//    la moyenne courante des empreintes avant de comparer : sur un test A-B-A,
//    la marge passe de 0,156 à 1,46. C'est ce centrage qui rend la suite possible.
//
// 2. La phase de beat ne peut PAS servir d'horloge de découpage : le verrou de
//    tempo est souvent à 0,1-0,4 et la phase se recale sur chaque onset, ce qui
//    produisait 4,9 fenêtres/s au lieu de 2. On découpe donc à pas FIXE.
//
// 3. La valeur de similarité d'une fenêtre isolée ne dit rien de fiable (elle
//    oscille entre 0,6 et 0,97 en permanence). Ce qui dit "ça revient", c'est la
//    CONSTANCE DU DÉCALAGE : quand un passage se rejoue, la fenêtre i ressemble
//    à la fenêtre i-L pour un L stable, fenêtre après fenêtre — une diagonale
//    dans la matrice d'auto-similarité. On entretient donc une moyenne glissante
//    par décalage candidat (le "spectre de décalages") et on cherche sa pointe.
//    Bonus : la confiance devient un z-score sur ce spectre, donc NON BORNÉ —
//    contrairement au cosinus plafonné à 1, sur lequel un seuil "moyenne + 2σ"
//    valait 1,027 et ne se déclenchait jamais (mesuré : 0 rappel sur 535 fenêtres).

/**
 * @typedef {{active:boolean, z:number, lagSec:number, env:number, windows:number,
 *            hop:number, prominence:number, plateauSec:number, candidateLagSec:number}} RecurrenceState
 */

const DEFAULTS = {
  mel: 32,          // taille du vecteur d'entrée
  hop: 0.5,         // s entre deux fenêtres
  win: 2.0,         // s accumulées par fenêtre (recouvrement)
  lagMinSec: 12,    // MESURÉ : en dessous, ce sont les boucles de 2 mesures qui
                    // gagnent toujours — un rappel permanent ne veut plus rien dire.
  lagMaxSec: 120,   // portée de la mémoire
  alpha: 0.25,      // lissage du spectre de décalages (par fenêtre)
  meanTau: 60,      // constante (en fenêtres) de la moyenne courante retirée
  minPlateauSec: 0.5, // Sur de la VRAIE musique le plateau à mi-hauteur fait une
                    // seule fenêtre, même quand la proéminence monte à 0,43-0,50 :
                    // ce garde-fou bloquait donc tous les vrais rappels. C'est
                    // l'hystérésis + l'enveloppe qui empêchent le scintillement,
                    // pas la largeur du plateau.
  // SEUIL CHOISI DANS LES DONNÉES (diag3), proéminence = pic - médiane :
  //   vrais retours      p10 0,31  méd 0,52  p90 0,76
  //   reste du morceau   p10 0,09  méd 0,14  p90 0,20
  //   flux sans structure            méd 0,02
  // 0,25 sépare les trois, avec un facteur 10 de marge contre le bruit.
  minProminence: 0.25,
  releaseRatio: 0.6, // hystérésis : on sort à 60 % du seuil d'entrée
  attack: 0.35,     // s — montée de l'enveloppe
  release: 1.4,     // s — descente
};

const BASE = 10;    // rayon (en décalages) du fond local retiré au blanchiment

export class RecurrenceMemory {
  constructor(opts = {}) {
    this.o = { ...DEFAULTS, ...opts };
    this.mel = this.o.mel;
    this.hop = this.o.hop;
    this.win = this.o.win;
    this.lagMin = Math.max(2, Math.round(this.o.lagMinSec / this.hop));
    this.lagMax = Math.max(this.lagMin + 4, Math.round(this.o.lagMaxSec / this.hop));
    /** score[L] = moyenne glissante de cos(empreinte_i, empreinte_{i-L}) */
    this.spectrum = new Float32Array(this.lagMax + 1);
    /** spectre BLANCHI (pointe - fond local) : c'est lui qui décide */
    this.peaks = new Float32Array(this.lagMax + 1);
    this.seen = new Uint8Array(this.lagMax + 1);
    this.mean = new Float64Array(this.mel);
    this.acc = new Float64Array(this.mel);
    this.ring = [];
    this.offset = 0; // fenêtres sorties du ring : les index publics restent ABSOLUS
    this.accN = 0; this.meanN = 0; this.t0 = -1; this.nextEmit = 0;
    /** @type {RecurrenceState} */
    this.state = { active: false, z: 0, lagSec: 0, env: 0, windows: 0, hop: this.hop, prominence: 0, plateauSec: 0, candidateLagSec: 0 };
  }

  /** Empreinte d'une fenêtre, en numérotation ABSOLUE (0 = première du morceau). */
  fingerprint(index) {
    const i = index - this.offset;
    return i >= 0 && i < this.ring.length ? this.ring[i] : null;
  }

  /** Index de la fenêtre actuellement rejouée (celle d'il y a `lagSec`), ou -1. */
  recalledIndex() {
    if (!this.state.active) return -1;
    const i = this.state.windows - 1 - Math.round(this.state.lagSec / this.hop);
    return i >= 0 ? i : -1;
  }

  /**
   * À appeler à chaque trame audio. `t` est l'horloge AUDIO (s), pas le mur.
   * Renvoie true si une fenêtre vient d'être fermée (donc si la détection a été
   * réévaluée) — c'est le bon moment pour prendre un instantané visuel.
   */
  push(mel, t) {
    if (this.t0 < 0) { this.t0 = t; this.nextEmit = this.o.win; }
    // Garde-fou d'horloge : un saut en arrière, ou un bond en avant bien au-delà
    // de la prochaine émission, veut dire que l'horloge audio n'est plus la même
    // (pont relancé, source changée, trame de repos à 0 prise pour origine).
    // Sans ce rebasage, la condition d'émission reste vraie à chaque frame et la
    // mémoire ne forme plus jamais une seule fenêtre — panne totale, silencieuse.
    const ecoule = t - this.t0;
    if (ecoule < 0 || ecoule > this.nextEmit + this.o.win + 2) {
      this.t0 = t; this.nextEmit = this.o.win; this.acc.fill(0); this.accN = 0;
    }
    for (let i = 0; i < this.mel; i++) this.acc[i] += mel[i];
    this.accN++;
    if (t - this.t0 < this.nextEmit) return false;
    this.nextEmit += this.hop;
    return this._closeWindow();
  }

  /** Fait respirer l'enveloppe. Une fois par frame de rendu. */
  update(dt) {
    const tau = this.state.active ? this.o.attack : this.o.release;
    // lissage compensé en dt : identique à 30, 60 ou 144 fps
    const k = 1 - Math.exp(-Math.max(1e-4, dt) / Math.max(1e-3, tau));
    this.state.env += ((this.state.active ? 1 : 0) - this.state.env) * k;
  }

  reset() {
    this.ring.length = 0;
    this.offset = 0;
    this.spectrum.fill(0); this.peaks.fill(0); this.seen.fill(0);
    this.mean.fill(0); this.acc.fill(0);
    this.accN = 0; this.meanN = 0; this.t0 = -1; this.nextEmit = 0;
    this.state = { active: false, z: 0, lagSec: 0, env: 0, windows: 0, hop: this.hop, prominence: 0, plateauSec: 0, candidateLagSec: 0 };
  }

  _closeWindow() {
    // Un seul échantillon suffit à former une fenêtre. Le garde était à 4, ce qui
    // rendait la mémoire dépendante du TAUX DE RAFRAÎCHISSEMENT : le mode
    // n'échantillonne le bus qu'une fois par frame rendue, et quand Chromium
    // bride le rAF (fenêtre occultée, écran verrouillé : mesuré à 1,3 Hz), chaque
    // fenêtre se fermait avec un seul échantillon et se faisait jeter — la
    // mémoire ne formait alors plus JAMAIS une fenêtre. Mieux vaut une empreinte
    // bruitée qu'une mémoire morte.
    if (this.accN < 1) { this.acc.fill(0); this.accN = 0; return false; }
    const raw = new Float64Array(this.mel);
    for (let i = 0; i < this.mel; i++) raw[i] = this.acc[i] / this.accN;
    this.acc.fill(0); this.accN = 0;

    // moyenne courante : la composante commune que l'AGC impose à tout le monde
    this.meanN++;
    const a = Math.min(1 / this.meanN, 1 / this.o.meanTau);
    for (let i = 0; i < this.mel; i++) this.mean[i] += (raw[i] - this.mean[i]) * a;

    const fp = new Float32Array(this.mel);
    let n = 0;
    for (let i = 0; i < this.mel; i++) { const v = raw[i] - this.mean[i]; fp[i] = v; n += v * v; }
    n = Math.sqrt(n) || 1;
    for (let i = 0; i < this.mel; i++) fp[i] /= n;
    this.ring.push(fp);
    this.state.windows++;
    if (this.ring.length > this.lagMax + 4) { this.ring.shift(); this.offset++; }

    if (this.meanN < 12) return true; // moyenne pas encore fiable : on ne conclut pas

    const i = this.ring.length - 1;
    for (let L = this.lagMin; L <= Math.min(this.lagMax, i); L++) {
      const past = this.ring[i - L];
      let s = 0;
      for (let k = 0; k < this.mel; k++) s += fp[k] * past[k];
      this.spectrum[L] += (s - this.spectrum[L]) * this.o.alpha;
      this.seen[L] = 1;
    }

    // MESURÉ (diag sur structure A-B-A-B) : un PASSAGE qui revient ne fait pas
    // une pointe étroite mais un PLATEAU large — n'importe quel instant de la
    // section courante ressemble à n'importe quel instant de la section d'avant
    // (score 0,95 sur 36→50 s de décalage, contre −0,42 ailleurs). Un blanchiment
    // local rabotait ce plateau et ne laissait que ses bords : mauvaise réponse.
    // On garde donc le spectre BRUT, et on juge chaque décalage par rapport à SA
    // PROPRE HISTOIRE : la composante commune (l'AGC) maintient TOUS les
    // décalages autour de 0,5-0,8, si bien qu'une pointe vraie n'est jamais très
    // proéminente dans l'absolu. La question utile n'est pas "ce décalage est-il
    // haut ?" mais "est-il inhabituellement haut, POUR CE MORCEAU ?".
    // L'ancre est l'argmax du spectre BRUT : le diagnostic montre qu'il désigne
    // exactement la période de la structure (40,0 s sur un morceau A-B-A-B de
    // 20 s de section, et jusqu'à son harmonique 80 s). La statistique de
    // décision est sa PROÉMINENCE au-dessus de la médiane des décalages — la
    // médiane, robuste, ne se laisse pas tirer par le plateau lui-même.
    const vals = [];
    let peak = -9, peakL = this.lagMin;
    for (let L = this.lagMin; L <= this.lagMax; L++) {
      if (!this.seen[L]) continue;
      const v = this.spectrum[L];
      vals.push(v);
      if (v > peak) { peak = v; peakL = L; }
    }
    const cnt = vals.length;
    if (cnt < 16) return true;
    const sorted = vals.sort((a, c) => a - c);
    const med = sorted[cnt >> 1];
    // spectre exposé (affichable) : écart à la médiane, borné en 0..1
    for (let L = this.lagMin; L <= this.lagMax; L++)
      this.peaks[L] = this.seen[L] ? Math.max(0, Math.min(1, (this.spectrum[L] - med) / 0.6)) : 0;

    // Le décalage retenu est le CENTRE du plateau, pas son argmax (qui saute
    // d'un bord à l'autre d'une fenêtre sur l'autre). Une fois verrouillé, on
    // reste sur le plateau courant tant qu'il tient — sinon l'image sauterait
    // de souvenir en souvenir à chaque fenêtre.
    let anchor = peakL;
    if (this.state.active) {
      const held = Math.round(this.state.lagSec / this.hop);
      if (held >= this.lagMin && held <= this.lagMax && this.seen[held] &&
          (this.spectrum[held] - med) >= 0.85 * (peak - med)) anchor = held;
    }
    // Largeur du plateau mesurée à MI-HAUTEUR (0,5), pas à 90 % : à 90 % on ne
    // mesure que la pointe et la largeur retombe à une seule fenêtre sur de la
    // vraie musique, ce qui bloquait le garde-fou anti-scintillement.
    const thr = med + 0.5 * (this.spectrum[anchor] - med);
    let lo = anchor, hi = anchor;
    while (lo - 1 >= this.lagMin && this.seen[lo - 1] && this.spectrum[lo - 1] >= thr) lo--;
    while (hi + 1 <= this.lagMax && this.seen[hi + 1] && this.spectrum[hi + 1] >= thr) hi++;
    let wsum = 0, lsum = 0;
    for (let L = lo; L <= hi; L++) { const w = Math.max(0, this.spectrum[L] - med); wsum += w; lsum += w * L; }
    const centreL = wsum > 0 ? lsum / wsum : anchor;
    const plateauSec = (hi - lo + 1) * this.hop;
    // Assez d'histoire pour qu'un retour ait pu avoir lieu.
    const assezDHistoire = this.state.windows > 2.5 * this.lagMin;

    const prominence = this.spectrum[anchor] - med;
    this.state.z = prominence; // la proéminence EST la confiance
    this.state.prominence = prominence;
    this.state.plateauSec = plateauSec;
    this.state.candidateLagSec = centreL * this.hop;
    if (!this.state.active && prominence >= this.o.minProminence &&
        plateauSec >= this.o.minPlateauSec && assezDHistoire) {
      this.state.active = true; this.state.lagSec = centreL * this.hop;
    }
    else if (this.state.active && prominence < this.o.minProminence * this.o.releaseRatio) this.state.active = false;
    else if (this.state.active) this.state.lagSec = this.state.lagSec * 0.8 + centreL * this.hop * 0.2;
    return true;
  }
}
