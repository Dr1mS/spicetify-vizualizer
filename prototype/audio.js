// AudioEngine — pipeline de features "musicales" sur AnalyserNode.
//
// Slice 1a (pilier 1) : l'analyse est découplée du rendu et perceptuelle.
//   spectre dB brut  ->  bandes log/mel  ->  AGC par bande (0..1)
//     ->  spectral flux (AVANT l'envelope rapide)  ->  onsets
//     ->  envelope followers attack/release  ->  bandes affichées
//
// Le smoothing interne de l'AnalyserNode est mis à 0 : on fait NOTRE lissage,
// séparé par feature, au lieu de subir un lissage global opaque.
//
// Note archi : cette classe est l'ORACLE du futur AudioWorklet (Slice 1b).
// Même entrée -> mêmes bandes, à comparer bit à bit une fois la FFT maison écrite.

const BAND_COUNT = 64;
const F_MIN = 30; // Hz — bas des bandes log
const F_MAX = 16000; // Hz — haut des bandes log

export class AudioEngine {
  constructor({ fftSize = 8192 } = {}) {
    this.fftSize = fftSize;
    this.bandCount = BAND_COUNT;
    this.ctx = null;
    this.analyser = null;
    this.stream = null;

    // Chemin worklet (Slice 1b) : détection d'onsets au hop rate sur le thread
    // audio. AnalyserNode reste le défaut ; worklet activé via `useWorklet`.
    this.useWorklet = false;
    this._workletReady = false;
    this._packet = null; // dernier paquet du worklet (mags + flags + strengths)
    this._pending = { kick: false, snare: false, hats: false, onset: false, kickS: 0, snareS: 0, hatsS: 0, onsetS: 0 };

    // Buffers d'analyse
    this.db = null; // Float32Array, spectre en dB
    this.wave = null; // Float32Array, forme d'onde -1..1
    this.bandBins = []; // [i0,i1] par bande (calculé selon sampleRate)
    this.bandHz = []; // fréquence centrale par bande

    // État persistant des features
    this.peak = new Float32Array(BAND_COUNT); // plafond glissant (release lent) pour l'AGC
    this.noise = new Float32Array(BAND_COUNT); // plancher de bruit glissant par bande
    this.norm = new Float32Array(BAND_COUNT); // bandes normalisées 0..1 (pré-envelope)
    this.prevNorm = new Float32Array(BAND_COUNT); // frame précédente, pour le flux
    this.bands = new Float32Array(BAND_COUNT); // bandes affichées (post-envelope)
    this.mag = new Float32Array(BAND_COUNT); // magnitude linéaire BRUTE par bande (analyseur)
    this.maxMagSlow = 0; // bande la plus forte (release lent) -> réf. du gate de bruit
    this.fluxAvg = 0; // moyenne glissante du flux (seuil onset adaptatif)
    this.onset = 0; // force d'onset lissée 0..1 (large bande)
    this.onsetFlag = false; // onset discret détecté cette frame
    this._refractory = 0; // frames restantes avant un nouvel onset

    // Onsets par bande (batterie séparée) — chacun avec seuil + réfractaire propres.
    // kick <120 Hz | snare 150-2500 Hz (bruité) | hats >5 kHz.
    this.kickAvg = 0; this.kick = 0; this.kickFlag = false; this._kickRef = 0;
    this.snareAvg = 0; this.snare = 0; this.snareFlag = false; this._snareRef = 0;
    this.hatsAvg = 0; this.hats = 0; this.hatsFlag = false; this._hatsRef = 0;

    // Chroma (12 classes de hauteur) -> teinte harmonique.
    this.chroma = new Float32Array(12);
    this.keyHue = 0;

    // Build-up / drop (structure) — sur l'énergie BRUTE (non aplatie par l'AGC),
    // relative à une baseline lente : c'est ce qui rend breakdown/drop visibles,
    // comme sur le spectrogramme.
    this.energy = 0; // 0..1 : énergie macro relative à la baseline ~20 s
    this.energyRef = 0; // baseline lente
    this.fastEnv = 0;
    this.slowEnv = 0;
    this._prevFast = 0;
    this.tension = 0;
    this.dropFlag = false;
    this._dropRef = 0;

    // Coupure / reprise (accalmie soutenue -> retour en force).
    this._breakFrames = 0;
    this._breakLatched = false;
    this.breakActive = false; // on est dans une accalmie
    this.anticipation = 0; // monte pendant l'accalmie ("ça va repartir")
    this.reentryFlag = false; // la reprise vient de se déclencher

    // Résumé
    this.bass = 0;
    this.mid = 0;
    this.treble = 0;
    this.level = 0;
    this.centroid = 0; // brillance 0..1 (log)
    this.flatness = 0; // platitude spectrale 0..1 (bruité/disto)
    this.raw = 0; // crête brute (HUD/diagnostic)
  }

  async connect(deviceId) {
    this.deviceId = deviceId; // mémorisé pour la reconnexion
    // Nettoie l'ancien graphe (évite d'empiler des nœuds à chaque reconnexion).
    if (this._graph) {
      try {
        this._graph.src.disconnect();
        this._graph.sink.disconnect();
      } catch {}
      this._graph = null;
    }
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());

    const constraints = {
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    };
    this.stream = await navigator.mediaDevices.getUserMedia(constraints);

    const track = this.stream.getAudioTracks()[0];
    // Firefox ignore parfois les contraintes de getUserMedia sur un monitor :
    // on RÉ-APPLIQUE explicitement (l'AEC est le suspect n°1 des coupures).
    try {
      await track.applyConstraints({
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      });
    } catch (e) {
      console.warn("[VIZ] applyConstraints échoué :", e);
    }
    this.trackSettings = track.getSettings ? track.getSettings() : {};

    this.ctx = this.ctx || new AudioContext();
    if (this.ctx.state === "suspended") await this.ctx.resume();

    const src = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = this.fftSize;
    this.analyser.smoothingTimeConstant = 0; // NOTRE lissage, pas le sien
    this.analyser.minDecibels = -100;
    this.analyser.maxDecibels = -20;
    src.connect(this.analyser);

    // Le graphe doit atteindre la destination pour être "tiré" en continu,
    // sinon l'analyser peut ne se rafraîchir que par à-coups. Gain 0 = muet.
    const sink = this.ctx.createGain();
    sink.gain.value = 0;
    this.analyser.connect(sink);
    sink.connect(this.ctx.destination);
    this._graph = { src, sink };

    this.db = new Float32Array(this.analyser.frequencyBinCount);
    this.wave = new Float32Array(this.analyser.fftSize);
    this._computeBandBins();

    // --- chemin worklet (optionnel) : détection d'onsets au hop rate ---------
    this._workletReady = false;
    if (this.useWorklet) {
      try {
        if (!this._moduleAdded) { await this.ctx.audioWorklet.addModule("feature-worklet.js"); this._moduleAdded = true; }
        if (this._wnode) { try { this._wnode.disconnect(); } catch {} }
        this._wnode = new AudioWorkletNode(this.ctx, "feature-extractor", {
          numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
        });
        src.connect(this._wnode);
        const wsink = this.ctx.createGain();
        wsink.gain.value = 0;
        this._wnode.connect(wsink);
        wsink.connect(this.ctx.destination); // tire le graphe -> process() tourne
        this._wnode.port.onmessage = (e) => {
          const d = e.data, pk = this._pending;
          this._packet = d;
          if (d[64]) pk.kick = true;
          if (d[65]) pk.snare = true;
          if (d[66]) pk.hats = true;
          if (d[67]) pk.onset = true;
          pk.kickS = Math.max(pk.kickS, d[68]); pk.snareS = Math.max(pk.snareS, d[69]);
          pk.hatsS = Math.max(pk.hatsS, d[70]); pk.onsetS = Math.max(pk.onsetS, d[71]);
        };
        this._workletReady = true;
        console.info("[VIZ] worklet actif (détection d'onsets au hop rate)");
      } catch (e) {
        console.warn("[VIZ] worklet indisponible -> fallback AnalyserNode :", e);
        this.useWorklet = false;
      }
    }

    console.info("[VIZ] piste:", track?.label, "| réglages appliqués:", this.trackSettings);
    console.info("[VIZ] AEC:", this.trackSettings.echoCancellation, "| NS:", this.trackSettings.noiseSuppression, "| AGC:", this.trackSettings.autoGainControl);
    console.info("[VIZ] sampleRate:", this.ctx.sampleRate, "| binHz:", (this.ctx.sampleRate / this.fftSize).toFixed(1));

    // Diagnostic du bug intermittent : la piste peut se faire couper par le
    // navigateur (relink PipeWire quand YouTube change de flux/pub).
    this.trackMuted = false;
    if (track) {
      track.onmute = () => { this.trackMuted = true; console.warn("[VIZ] piste MUTE (capture coupée par le navigateur)"); };
      track.onunmute = () => { this.trackMuted = false; console.info("[VIZ] piste rétablie"); };
      track.onended = () => { this.trackMuted = true; console.warn("[VIZ] piste ENDED (source perdue) — reconnecte la source"); };
    }
  }

  // Re-acquiert le flux (nouveau getUserMedia) pour rebinder sur le nœud
  // PipeWire vivant après un suspend/resume (pause de la musique).
  async reconnect() {
    if (this._reconnecting) return false;
    this._reconnecting = true;
    try {
      await this.connect(this.deviceId);
      console.info("[VIZ] reconnecté");
      return true;
    } catch (e) {
      console.warn("[VIZ] reconnexion échouée :", e);
      return false;
    } finally {
      this._reconnecting = false;
    }
  }

  // Mappe chaque bande log vers une plage de bins FFT (dépend du sampleRate).
  _computeBandBins() {
    const binHz = this.ctx.sampleRate / this.fftSize;
    const nyq = this.ctx.sampleRate / 2;
    const fMax = Math.min(F_MAX, nyq * 0.98);
    const bins = this.db.length;
    this.bandBins = [];
    this.bandHz = [];
    for (let b = 0; b < BAND_COUNT; b++) {
      const fLo = F_MIN * Math.pow(fMax / F_MIN, b / BAND_COUNT);
      const fHi = F_MIN * Math.pow(fMax / F_MIN, (b + 1) / BAND_COUNT);
      let i0 = Math.floor(fLo / binHz);
      let i1 = Math.ceil(fHi / binHz);
      i0 = Math.max(0, Math.min(i0, bins - 1));
      i1 = Math.min(bins, Math.max(i1, i0 + 1)); // au moins 1 bin
      this.bandBins.push([i0, i1]);
      this.bandHz.push(Math.sqrt(fLo * fHi)); // centre géométrique
    }
  }

  // À appeler une fois par frame de rendu. Renvoie le "frame" de features.
  sample() {
    if (this.useWorklet && this._workletReady) return this._sampleWorklet();
    if (!this.analyser) return this._empty();
    this.analyser.getFloatFrequencyData(this.db);
    this.analyser.getFloatTimeDomainData(this.wave);

    const nyqLog0 = Math.log(F_MIN);
    const nyqLog1 = Math.log(Math.min(F_MAX, this.ctx.sampleRate / 2));

    // --- 1) bandes log + 2) AGC par bande -----------------------------------
    let cWeighted = 0,
      cTotal = 0; // pour le centroïde
    let logSum = 0,
      linSum = 0,
      nBins = 0; // pour la platitude
    const MIN_RANGE = 2e-6; // dynamique mini (évite le bloom du bruit au silence)
    const NOISE_RATIO = 3.16e-4; // -70 dB : seuil du gate de présence
    const noiseRef = Math.max(this.maxMagSlow * NOISE_RATIO, 1e-9);
    let frameMax = 0;
    const chromaRaw = this._chromaRaw || (this._chromaRaw = new Float32Array(12));
    chromaRaw.fill(0);

    for (let b = 0; b < BAND_COUNT; b++) {
      const [i0, i1] = this.bandBins[b];
      let sum = 0;
      for (let i = i0; i < i1; i++) {
        let d = this.db[i];
        if (!isFinite(d)) d = -140;
        const lin = Math.pow(10, d / 20); // dB -> magnitude linéaire
        sum += lin;
        // features spectrales globales (sur bins réels, pas bandes)
        const f = i * (this.ctx.sampleRate / this.fftSize);
        cWeighted += f * lin;
        cTotal += lin;
        logSum += Math.log(lin + 1e-9);
        linSum += lin;
        nBins++;
        // Chroma : on plie 100 Hz–2 kHz en 12 classes (sub-bass EXCLU pour que
        // la basse trance ne capture pas toute la couleur).
        if (f >= 100 && f <= 2000) {
          const pc = ((Math.round(12 * Math.log2(f / 440)) % 12) + 12) % 12;
          chromaRaw[pc] += lin;
        }
      }
      const mag = sum / (i1 - i0);
      this.mag[b] = mag; // niveau BRUT conservé pour l'analyseur (pré-AGC)

      // AGC = min/max glissant PAR BANDE : chaque bande sature 0..1 seule,
      // indépendamment du volume du morceau.
      //   plafond (peak) : release LENT -> ne "mange" pas le transitoire du flux
      //   plancher (nf)  : min-follower à montée très lente -> suit le bruit de fond
      // norm = (mag - nf) / (peak - nf) : vaut 1 sur un signal soutenu (quel que
      // soit son niveau), ~0 au silence (mag ≈ nf). MIN_RANGE tue le bloom du bruit.
      this.peak[b] = Math.max(mag, this.peak[b] * 0.994);
      const nf = this.noise;
      if (mag < nf[b]) nf[b] = mag; // suit le plancher instantanément vers le bas
      else nf[b] += (mag - nf[b]) * 0.0001; // montée très lente (~évite de fermer le gate sur un son tenu)
      const denom = Math.max(this.peak[b] - nf[b], MIN_RANGE);
      const agc = Math.min(1, Math.max(0, (mag - nf[b]) / denom));

      // GATE DE PRÉSENCE (relatif au niveau GLOBAL) : une bande dont l'énergie
      // absolue est très en-dessous de la bande la plus forte du spectre est du
      // bruit -> pas levée. Relatif = marche quel que soit le volume du morceau.
      // (noiseRef vient de la frame précédente : lag d'1 frame, négligeable.)
      const gate = Math.min(1, Math.max(0, (mag - noiseRef) / (2 * noiseRef)));
      this.norm[b] = agc * gate;
      if (mag > frameMax) frameMax = mag;
    }
    // Référence de bruit pour la frame SUIVANTE (release lent).
    this.maxMagSlow = Math.max(frameMax, this.maxMagSlow * 0.995);

    // --- 3) spectral flux par RÉGION (batterie séparée) ---------------------
    // Flux AGC'd = SENSIBILITÉ (un onset a-t-il lieu, indép. du volume).
    // Énergie BRUTE par région = DOMINANCE (où est vraiment centré l'événement) :
    // indispensable car l'AGC met toute bande touchée à ~1, donc le "bave" large
    // bande d'un kick donnerait des flux égaux -> il faut la forme spectrale réelle.
    let flux = 0;
    let kickFlux = 0, kickRaw = 0, kickN = 0;   // <120 Hz
    let snareFlux = 0, snareRaw = 0, snareN = 0; // 150-2500 Hz
    let hatFlux = 0, hatRaw = 0, hatN = 0;       // >5 kHz
    for (let b = 0; b < BAND_COUNT; b++) {
      const d = this.norm[b] - this.prevNorm[b];
      if (d > 0) flux += d;
      const hz = this.bandHz[b];
      const m = this.mag[b];
      if (hz < 120) { if (d > 0) kickFlux += d; kickRaw += m; kickN++; }
      else if (hz >= 150 && hz < 2500) { if (d > 0) snareFlux += d; snareRaw += m; snareN++; }
      if (hz >= 5000) { if (d > 0) hatFlux += d; hatRaw += m; hatN++; }
      this.prevNorm[b] = this.norm[b];
    }
    flux /= BAND_COUNT;
    kickFlux /= kickN || 1; kickRaw /= kickN || 1;
    snareFlux /= snareN || 1; snareRaw /= snareN || 1;
    hatFlux /= hatN || 1; hatRaw /= hatN || 1;

    // --- onset large bande ---------------------------------------------------
    this.fluxAvg = this.fluxAvg * 0.9 + flux * 0.1;
    this.onsetFlag = false;
    if (this._refractory > 0) this._refractory--;
    if (flux > this.fluxAvg * 1.6 + 0.004 && this._refractory === 0) {
      this.onsetFlag = true;
      this._refractory = 5;
    }
    const target = Math.min(1, flux * 12);
    this.onset = target > this.onset ? target : this.onset * 0.86;

    // --- batterie : 3 détecteurs, seuil sur le flux + DOMINANCE sur le brut --
    // Dominance = l'énergie brute de l'événement est bien centrée dans la région.
    // Empêche le clic large-bande d'un kick de déclencher aussi snare + hats.
    const EPS = 1e-7;
    // kick : région grave dominante (sinon un snare, centré médium, tirerait le kick)
    this.kickAvg = this.kickAvg * 0.9 + kickFlux * 0.1;
    this.kickFlag = false;
    if (this._kickRef > 0) this._kickRef--;
    if (kickFlux > this.kickAvg * 1.4 + 0.006 && kickRaw > snareRaw * 1.3 && this._kickRef === 0) {
      this.kickFlag = true; this._kickRef = 8;
    }
    this.kick = Math.min(1, kickFlux * 10) > this.kick ? Math.min(1, kickFlux * 10) : this.kick * 0.85;
    // snare : médium dominant sur le grave (rejette le bave d'un kick)
    this.snareAvg = this.snareAvg * 0.9 + snareFlux * 0.1;
    this.snareFlag = false;
    if (this._snareRef > 0) this._snareRef--;
    if (snareFlux > this.snareAvg * 1.6 + 0.008 && snareRaw > kickRaw * 1.2 && snareRaw > hatRaw * 1.1 && this._snareRef === 0) {
      this.snareFlag = true; this._snareRef = 7;
    }
    this.snare = Math.min(1, snareFlux * 10) > this.snare ? Math.min(1, snareFlux * 10) : this.snare * 0.85;
    // hats : aigu dominant (rejette le bave aigu d'un kick, bien plus faible)
    this.hatsAvg = this.hatsAvg * 0.9 + hatFlux * 0.1;
    this.hatsFlag = false;
    if (this._hatsRef > 0) this._hatsRef--;
    if (hatFlux > this.hatsAvg * 1.6 + 0.006 && hatRaw > kickRaw * 0.15 + EPS && hatRaw > snareRaw * 1.2 && this._hatsRef === 0) {
      this.hatsFlag = true; this._hatsRef = 3;
    }
    this.hats = Math.min(1, hatFlux * 12) > this.hats ? Math.min(1, hatFlux * 12) : this.hats * 0.8;

    // --- 4) envelope followers (affichage) ----------------------------------
    // attaque rapide (punch), release lent (sustain) -> dynamique perçue.
    const ATT = 0.6,
      REL = 0.14;
    for (let b = 0; b < BAND_COUNT; b++) {
      const t = this.norm[b];
      this.bands[b] += (t > this.bands[b] ? ATT : REL) * (t - this.bands[b]);
    }

    // --- résumé -------------------------------------------------------------
    this.bass = this._meanBand(F_MIN, 150);
    this.mid = this._meanBand(150, 2000);
    this.treble = this._meanBand(2000, F_MAX);
    this.level = (this.bass + this.mid + this.treble) / 3;

    if (cTotal > 1e-6) {
      const cHz = cWeighted / cTotal;
      this.centroid = Math.min(1, Math.max(0, (Math.log(Math.max(cHz, F_MIN)) - nyqLog0) / (nyqLog1 - nyqLog0)));
    }
    if (nBins > 0 && linSum > 1e-9) {
      const geo = Math.exp(logSum / nBins);
      this.flatness = Math.min(1, geo / (linSum / nBins));
    }

    // crête brute (diagnostic HUD)
    let peak = 0;
    for (let i = 0; i < this.wave.length; i++) {
      const a = Math.abs(this.wave[i]);
      if (a > peak) peak = a;
    }
    this.raw = peak;

    this._structure(chromaRaw);
    return this._frame();
  }

  // Chemin worklet : le spectre + les onsets (hop rate) viennent du worklet ;
  // on fait ici le reste (bandes d'affichage, chroma coarse, structure) au rAF.
  _sampleWorklet() {
    const d = this._packet;
    if (!d) return this._empty();
    const chromaRaw = this._chromaRaw || (this._chromaRaw = new Float32Array(12));
    chromaRaw.fill(0);
    const MIN_RANGE = 2e-6, NOISE_RATIO = 3.16e-4;
    const noiseRef = Math.max(this.maxMagSlow * NOISE_RATIO, 1e-9);
    let frameMax = 0, cW = 0, cT = 0, logSum = 0, linSum = 0;
    const ATT = 0.6, REL = 0.14;
    for (let b = 0; b < BAND_COUNT; b++) {
      const mag = d[b];
      this.mag[b] = mag;
      if (mag > frameMax) frameMax = mag;
      this.peak[b] = Math.max(mag, this.peak[b] * 0.994);
      const nf = this.noise;
      if (mag < nf[b]) nf[b] = mag; else nf[b] += (mag - nf[b]) * 0.0001;
      const denom = Math.max(this.peak[b] - nf[b], MIN_RANGE);
      const agc = Math.min(1, Math.max(0, (mag - nf[b]) / denom));
      const gate = Math.min(1, Math.max(0, (mag - noiseRef) / (2 * noiseRef)));
      const norm = agc * gate;
      this.bands[b] += (norm > this.bands[b] ? ATT : REL) * (norm - this.bands[b]);
      const hz = this.bandHz[b];
      if (hz >= 100 && hz <= 2000) { const pc = ((Math.round(12 * Math.log2(hz / 440)) % 12) + 12) % 12; chromaRaw[pc] += mag; }
      cW += hz * mag; cT += mag; logSum += Math.log(mag + 1e-9); linSum += mag;
    }
    this.maxMagSlow = Math.max(frameMax, this.maxMagSlow * 0.995);
    this.bass = this._meanBand(F_MIN, 150);
    this.mid = this._meanBand(150, 2000);
    this.treble = this._meanBand(2000, F_MAX);
    this.level = (this.bass + this.mid + this.treble) / 3;
    const l0 = Math.log(F_MIN), l1 = Math.log(F_MAX);
    if (cT > 1e-9) { const cHz = cW / cT; this.centroid = Math.min(1, Math.max(0, (Math.log(Math.max(cHz, F_MIN)) - l0) / (l1 - l0))); }
    if (linSum > 1e-9) { const geo = Math.exp(logSum / BAND_COUNT); this.flatness = Math.min(1, geo / (linSum / BAND_COUNT)); }

    // Onsets détectés au HOP RATE dans le worklet : on consomme les flags.
    const pk = this._pending;
    this.kickFlag = pk.kick; this.snareFlag = pk.snare; this.hatsFlag = pk.hats; this.onsetFlag = pk.onset;
    const env = (cur, s, dec) => (s > cur ? s : cur * dec);
    this.kick = env(this.kick, pk.kickS, 0.85); this.snare = env(this.snare, pk.snareS, 0.85);
    this.hats = env(this.hats, pk.hatsS, 0.8); this.onset = env(this.onset, pk.onsetS, 0.86);
    pk.kick = pk.snare = pk.hats = pk.onset = false; pk.kickS = pk.snareS = pk.hatsS = pk.onsetS = 0;

    this.raw = d[72];
    this._structure(chromaRaw);
    return this._frame();
  }

  // Partie LENTE partagée (main thread, rAF) : chroma, energy, build/drop,
  // coupure/reprise. Appelée par le chemin AnalyserNode ET le chemin worklet.
  _structure(chromaRaw) {
    // chroma -> teinte : lissage ~1 s + centroïde CIRCULAIRE (pas d'argmax).
    let cSum = 0;
    for (let k = 0; k < 12; k++) cSum += chromaRaw[k];
    if (cSum > 1e-9) {
      for (let k = 0; k < 12; k++) this.chroma[k] = this.chroma[k] * 0.95 + (chromaRaw[k] / cSum) * 0.05;
    }
    let hx = 0, hy = 0;
    for (let k = 0; k < 12; k++) {
      const a = (2 * Math.PI * k) / 12;
      hx += this.chroma[k] * Math.cos(a);
      hy += this.chroma[k] * Math.sin(a);
    }
    if (hx * hx + hy * hy > 1e-9) this.keyHue = (Math.atan2(hy, hx) / (2 * Math.PI) + 1) % 1;

    // build-up / drop sur l'énergie BRUTE (moyenne des mags), normalisée par une
    // baseline lente ~20 s -> `energy` préserve la dynamique breakdown/drop.
    let rawE = 0;
    for (let b = 0; b < BAND_COUNT; b++) rawE += this.mag[b];
    rawE /= BAND_COUNT;
    this.energyRef = this.energyRef === 0 ? rawE : this.energyRef * 0.9992 + rawE * 0.0008;
    const eNorm = Math.min(1, Math.max(0, (rawE / (this.energyRef + 1e-9)) * 0.5));
    this.energy = this.energy * 0.7 + eNorm * 0.3;

    this.fastEnv = this.fastEnv * 0.9 + this.energy * 0.1;
    this.slowEnv = this.slowEnv * 0.985 + this.energy * 0.015;
    const rise = this.fastEnv - this.slowEnv;
    this.tension = Math.min(1, Math.max(0, this.energy * 1.1 - 0.15));
    this.dropFlag = false;
    if (this._dropRef > 0) this._dropRef--;
    if (rise > 0.1 && this.fastEnv > 0.55 && this._dropRef === 0) {
      this.dropFlag = true;
      this._dropRef = 45;
    }
    this._prevFast = this.fastEnv;

    // coupure / reprise
    const BREAK_LOW = 0.3, BREAK_HIGH = 0.46;
    if (this.energy < BREAK_LOW) this._breakFrames++;
    else this._breakFrames = Math.max(0, this._breakFrames - 3);
    this.breakActive = this._breakFrames > 24;
    if (this.breakActive) this._breakLatched = true;
    this.reentryFlag = false;
    if (this._breakLatched && this.energy > BREAK_HIGH) {
      this.reentryFlag = true;
      this._breakLatched = false;
      this._breakFrames = 0;
    }
    if (this.reentryFlag) this.anticipation = 0;
    else if (this.breakActive) this.anticipation = Math.min(1, this.anticipation + 0.008);
    else this.anticipation *= 0.95;
  }

  _frame() {
    return {
      bands: this.bands,
      bandsMag: this.mag,
      bandHz: this.bandHz,
      bass: this.bass,
      mid: this.mid,
      treble: this.treble,
      level: this.level,
      onset: this.onset,
      onsetFlag: this.onsetFlag,
      kick: this.kick,
      kickFlag: this.kickFlag,
      snare: this.snare,
      snareFlag: this.snareFlag,
      hats: this.hats,
      hatsFlag: this.hatsFlag,
      chroma: this.chroma,
      keyHue: this.keyHue,
      tension: this.tension,
      dropFlag: this.dropFlag,
      energy: this.energy,
      breakActive: this.breakActive,
      anticipation: this.anticipation,
      reentryFlag: this.reentryFlag,
      centroid: this.centroid,
      flatness: this.flatness,
      raw: this.raw,
    };
  }

  // Moyenne des bandes affichées couvrant [fLo,fHi].
  _meanBand(fLo, fHi) {
    let sum = 0,
      n = 0;
    for (let b = 0; b < BAND_COUNT; b++) {
      if (this.bandHz[b] >= fLo && this.bandHz[b] < fHi) {
        sum += this.bands[b];
        n++;
      }
    }
    return n ? sum / n : 0;
  }

  _empty() {
    return {
      bands: this.bands,
      bandsMag: this.mag,
      bandHz: this.bandHz,
      bass: 0,
      mid: 0,
      treble: 0,
      level: 0,
      onset: 0,
      onsetFlag: false,
      kick: 0,
      kickFlag: false,
      snare: 0,
      snareFlag: false,
      hats: 0,
      hatsFlag: false,
      chroma: this.chroma,
      keyHue: this.keyHue,
      tension: 0,
      dropFlag: false,
      energy: 0,
      breakActive: false,
      anticipation: 0,
      reentryFlag: false,
      centroid: 0,
      flatness: 0,
      raw: 0,
    };
  }
}
