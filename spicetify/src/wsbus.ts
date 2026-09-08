// wsbus.ts — client du pont audio : WebSocket -> BusFrame.
//
// Contrat IDENTIQUE à AudioBus.read() (src/audio/bus.ts) : les modes, la mod
// matrix et la feature texture ne voient aucune différence entre le navigateur
// (worklet local) et Spotify (features calculées par le pont).
//
// Horloge : les trames portent T_FRAME, une horloge AUDIO (échantillons consommés).
// On l'aligne sur performance.now() via un offset LISSÉ (slew) — pw-record peut
// livrer en rafales au démarrage, et un offset qui saute ferait sauter beatPhase.

import { BeatTracker } from "../../src/audio/beatTracker.js";
import { F, FEAT_LEN } from "../../src/audio/constants";
import type { BusFrame } from "../../src/audio/bus";

export type BusStatus = "connecting" | "live" | "offline";

const STALE = 1.5; // s sans trame -> le pont est considéré muet
const SLEW = 0.05; // s d'offset rattrapés par seconde (lissage doux)
const JUMP = 0.5; // s d'écart -> resynchro brutale (reconnexion, gros stall)

export class WsBus {
  status: BusStatus = "connecting";
  onStatus?: (s: BusStatus) => void;
  latest = new Float32Array(FEAT_LEN);
  beat = new BeatTracker();
  bridgeInfo: { source?: string; sampleRate?: number } = {};

  private ws: WebSocket | null = null;
  private url: string;
  private closed = false;
  private retry = 0;
  private timer = 0;
  private ids = { onset: 0, kick: 0, snare: 0, hats: 0 };
  private offset = 0; // audioT - perfT
  private haveOffset = false;
  private lastRecv = 0; // perf (s)
  private lastFrames = 0;
  private frames = 0;

  constructor(url = "ws://127.0.0.1:8787") { this.url = url; this.connect(); }

  private setStatus(s: BusStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.onStatus?.(s);
  }

  private connect(): void {
    if (this.closed) return;
    this.setStatus(this.frames ? "offline" : "connecting");
    let ws: WebSocket;
    try { ws = new WebSocket(this.url); } catch { this.scheduleRetry(); return; }
    this.ws = ws;
    ws.binaryType = "arraybuffer";
    ws.onopen = () => { this.retry = 0; };
    ws.onmessage = (e) => this.onMessage(e);
    ws.onerror = () => { /* onclose suit toujours */ };
    ws.onclose = () => { this.ws = null; this.setStatus("offline"); this.scheduleRetry(); };
  }

  private scheduleRetry(): void {
    if (this.closed || this.timer) return;
    const delay = Math.min(5000, 500 * 2 ** this.retry++);
    this.timer = self.setTimeout(() => { this.timer = 0; this.connect(); }, delay);
  }

  private onMessage(e: MessageEvent): void {
    if (typeof e.data === "string") {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "hello") {
          this.bridgeInfo = { source: msg.source, sampleRate: msg.sampleRate };
          if (msg.featLen !== FEAT_LEN) console.error(`[wsbus] layout divergent : pont ${msg.featLen} floats, client ${FEAT_LEN}. Rebuild du pont ou de l'app.`);
        }
      } catch { /* ignore */ }
      return;
    }
    const f = new Float32Array(e.data as ArrayBuffer);
    if (f.length !== FEAT_LEN) return;
    this.latest.set(f);
    this.frames++;

    const perf = performance.now() / 1000;
    this.lastRecv = perf;
    const target = f[F.T_FRAME] - perf;
    if (!this.haveOffset || Math.abs(target - this.offset) > JUMP) { this.offset = target; this.haveOffset = true; }
    else this.offset += Math.max(-SLEW, Math.min(SLEW, target - this.offset)) * 0.02; // ~1 trame

    this.setStatus("live");
  }

  /** Horloge audio locale, reconstruite entre deux trames. */
  now(): number { return performance.now() / 1000 + this.offset; }

  /** Même forme que AudioBus.read(). */
  read(): BusFrame {
    const feat = this.latest;
    const perf = performance.now() / 1000;
    const stale = this.status === "live" && perf - this.lastRecv > STALE;
    if (stale) this.setStatus("offline");

    const onsetFired = feat[F.ONSET_ID] !== this.ids.onset;
    if (onsetFired) { this.ids.onset = feat[F.ONSET_ID]; this.beat.addOnset(feat[F.T_FRAME], feat[F.ONSET_STR]); }
    const kickFired = feat[F.KICK_ID] !== this.ids.kick; if (kickFired) this.ids.kick = feat[F.KICK_ID];
    const snareFired = feat[F.SNARE_ID] !== this.ids.snare; if (snareFired) this.ids.snare = feat[F.SNARE_ID];
    const hatsFired = feat[F.HATS_ID] !== this.ids.hats; if (hatsFired) this.ids.hats = feat[F.HATS_ID];

    const q = this.beat.query(this.now());
    return { feat, bpm: q.bpm, beatPhase: q.beatPhase, nextBeat: q.nextBeat, lockConf: q.lockConf, onsetFired, kickFired, snareFired, hatsFired };
  }

  /** Trames/s reçues depuis le dernier appel (diagnostic HUD). */
  rate(): number { const d = this.frames - this.lastFrames; this.lastFrames = this.frames; return d; }

  dispose(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    const ws = this.ws;
    this.ws = null;
    if (ws) { ws.onclose = null; ws.onmessage = null; ws.onerror = null; try { ws.close(); } catch { /* ignore */ } }
  }
}
