// main.ts — bootstrap. Étapes 0-2 : caps + bus audio + beat tracker.
// (Le cœur de rendu / modes arrivent aux étapes suivantes.)

import { AudioBus } from "./audio/bus";
import { F } from "./audio/constants";

const canvas = document.getElementById("c") as HTMLCanvasElement;
const gl = canvas.getContext("webgl2", { antialias: false, alpha: false });

(globalThis as unknown as { __viz: unknown }).__viz = {
  crossOriginIsolated: typeof crossOriginIsolated !== "undefined" && crossOriginIsolated,
  hasSAB: typeof SharedArrayBuffer !== "undefined",
  webgl2: !!gl,
  ext: gl
    ? {
        colorBufferFloat: !!gl.getExtension("EXT_color_buffer_float"),
        colorBufferHalfFloat: !!gl.getExtension("EXT_color_buffer_half_float"),
        floatLinear: !!gl.getExtension("OES_texture_float_linear"),
        floatBlend: !!gl.getExtension("EXT_float_blend"),
      }
    : null,
};

let bus: AudioBus | null = null;

async function startAudio() {
  const ctx = new AudioContext();
  await ctx.resume();
  bus = new AudioBus();

  const params = new URLSearchParams(location.search);
  let source: AudioNode;
  if (params.has("osc")) {
    // Mode test : oscillateur (permet de vérifier le pipeline sans micro).
    const o = ctx.createOscillator();
    o.type = "sawtooth";
    o.frequency.value = Number(params.get("osc")) || 220;
    o.start();
    source = o;
  } else {
    source = await AudioBus.micSource(ctx);
  }
  await bus.start(source);
  (globalThis as unknown as { __audiobus: unknown }).__audiobus = bus;
  console.info("[viz] bus audio démarré (isolated =", bus.isolated, ")");

  let n = 0;
  const loop = () => {
    requestAnimationFrame(loop);
    if (!bus) return;
    const fr = bus.read();
    if (n++ % 20 === 0) {
      let melSum = 0;
      for (let i = 0; i < 32; i++) melSum += fr.feat[F.MEL0 + i];
      (globalThis as unknown as { __bus: unknown }).__bus = {
        rms: fr.feat[F.RMS], peak: fr.feat[F.PEAK], melSum,
        onset: fr.feat[F.ONSET_STR], flux: fr.feat[F.FLUX], centroid: fr.feat[F.CENTROID],
        bpm: fr.bpm, beatPhase: fr.beatPhase, lockConf: fr.lockConf,
      };
    }
  };
  loop();
}

document.getElementById("start")!.addEventListener("click", () => {
  document.getElementById("boot")!.classList.add("hidden");
  startAudio().catch((e) => { console.error("[viz] audio erreur:", e); });
});
