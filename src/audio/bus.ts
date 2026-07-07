// bus.ts — orchestration audio main-thread : monte le worklet, lit la trame de
// features (SAB seqlock zéro-copie, ou postMessage en fallback non-isolé), fait
// l'edge-detection des onsets et alimente le beat tracker (horloge audio).
//
// Source commutable : micro (getUserMedia, DSP navigateur OFF, sans retour HP)
// OU fichier (décodé, joué vers la destination) OU oscillateur (test).

import workletUrl from "./analyser.worklet.js?url";
import { F, FEAT_LEN, MEL_COUNT, makeFeatureBuffer, readSeqlock, type FeatureBuffer } from "./constants";
import { BeatTracker } from "./beatTracker.js";

export interface BusFrame {
  feat: Float32Array; // trame brute (indices F.*)
  bpm: number;
  beatPhase: number;
  nextBeat: number; // horloge audio (s)
  lockConf: number;
  onsetFired: boolean;
  kickFired: boolean;
  snareFired: boolean;
  hatsFired: boolean;
}

export class AudioBus {
  ctx!: AudioContext;
  node!: AudioWorkletNode;
  fb!: FeatureBuffer;
  beat = new BeatTracker();
  latest = new Float32Array(FEAT_LEN);
  private _postFrame: Float32Array | null = null;
  private _lastSeq = { v: -1 };
  private _ids = { onset: 0, kick: 0, snare: 0, hats: 0 };
  ready = false;
  isolated = false;

  async start(source: AudioNode, opts: { toDestination?: boolean } = {}): Promise<void> {
    this.isolated = typeof crossOriginIsolated !== "undefined" && crossOriginIsolated === true;
    if (!this.isolated) console.warn("[bus] pas cross-origin isolated -> transport postMessage (fallback, latence +)");

    this.ctx = source.context as AudioContext;
    await this.ctx.audioWorklet.addModule(workletUrl);
    this.fb = makeFeatureBuffer();

    this.node = new AudioWorkletNode(this.ctx, "analyser", {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      processorOptions: {
        layout: F, melCount: MEL_COUNT, featLen: FEAT_LEN,
        sab: this.fb.shared ? this.fb.buffer : null,
      },
    });
    if (!this.fb.shared) this.node.port.onmessage = (e) => { this._postFrame = e.data as Float32Array; };

    source.connect(this.node);
    // Le graphe doit atteindre la destination pour que process() tourne. Gain 0 = muet.
    const sink = this.ctx.createGain();
    sink.gain.value = 0;
    this.node.connect(sink);
    sink.connect(this.ctx.destination);
    if (opts.toDestination) source.connect(this.ctx.destination); // fichier : on l'entend

    this.ready = true;
    // Garde runtime : après un peu d'audio, le worklet doit avoir avancé (sinon ctx suspendu).
    setTimeout(() => {
      const alive = this.fb.shared ? Atomics.load(this.fb.i32, F.SEQ) > 0 : this._postFrame !== null;
      if (!alive) console.warn("[bus] worklet muet après 400ms — AudioContext suspendu ? (geste utilisateur requis)");
    }, 400);
  }

  // À appeler une fois par frame de rendu.
  read(): BusFrame {
    if (this.fb.shared) readSeqlock(this.fb.i32, this.fb.f32, this.latest, this._lastSeq);
    else if (this._postFrame) this.latest.set(this._postFrame);
    const feat = this.latest;

    // edge-detect : les compteurs d'ID monotones sont canoniques (survivent au rate-gap).
    const t = feat[F.T_FRAME];
    const onsetFired = feat[F.ONSET_ID] !== this._ids.onset;
    if (onsetFired) { this._ids.onset = feat[F.ONSET_ID]; this.beat.addOnset(t, feat[F.ONSET_STR]); }
    const kickFired = feat[F.KICK_ID] !== this._ids.kick; if (kickFired) this._ids.kick = feat[F.KICK_ID];
    const snareFired = feat[F.SNARE_ID] !== this._ids.snare; if (snareFired) this._ids.snare = feat[F.SNARE_ID];
    const hatsFired = feat[F.HATS_ID] !== this._ids.hats; if (hatsFired) this._ids.hats = feat[F.HATS_ID];

    const q = this.beat.query(this.ctx.currentTime);
    return { feat, bpm: q.bpm, beatPhase: q.beatPhase, nextBeat: q.nextBeat, lockConf: q.lockConf, onsetFired, kickFired, snareFired, hatsFired };
  }

  // --- sources -------------------------------------------------------------
  static async micSource(ctx: AudioContext): Promise<MediaStreamAudioSourceNode> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
    return ctx.createMediaStreamSource(stream);
  }
  static async fileSource(ctx: AudioContext, file: File): Promise<AudioBufferSourceNode> {
    const buf = await ctx.decodeAudioData(await file.arrayBuffer());
    const src = ctx.createBufferSource();
    src.buffer = buf; src.loop = true; src.start();
    return src;
  }
}
