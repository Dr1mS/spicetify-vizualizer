// main.ts — bootstrap. Étapes 0-3 : bus audio + beat tracker + cœur de rendu.
// (Mod matrix + modes arrivent aux étapes 4-5 ; la démo procédurale valide le
//  chemin de rendu complet en attendant.)

import { AudioBus, type BusFrame } from "./audio/bus";
import { createGL } from "./core/gl";
import { probeCaps, type Caps } from "./core/caps";
import { makeProgram, drawFullscreen, bindTarget } from "./core/fullscreen";
import { createTarget, type Target } from "./core/pingpong";
import { FeatureTexture } from "./core/featureTexture";
import { RenderLoop, type Viewport } from "./core/loop";
import { makeLUT } from "./post/lut";
import demoFrag from "./shaders/demo.frag?raw";
import toneFrag from "./post/tonemap.frag?raw";

const canvas = document.getElementById("c") as HTMLCanvasElement;
let bus: AudioBus | null = null;

// Trame audio neutre tant que le bus n'est pas prêt.
const ZERO: BusFrame = {
  feat: new Float32Array(64), bpm: 120, beatPhase: 0, nextBeat: 0, lockConf: 0,
  onsetFired: false, kickFired: false, snareFired: false, hatsFired: false,
};

async function start() {
  document.getElementById("boot")!.classList.add("hidden");

  // --- audio ---------------------------------------------------------------
  const ctx = new AudioContext();
  await ctx.resume();
  bus = new AudioBus();
  const params = new URLSearchParams(location.search);
  let source: AudioNode;
  if (params.has("osc")) {
    const o = ctx.createOscillator();
    o.type = "sawtooth"; o.frequency.value = Number(params.get("osc")) || 220; o.start();
    source = o;
  } else {
    source = await AudioBus.micSource(ctx);
  }
  await bus.start(source);
  (globalThis as unknown as { __audiobus: unknown }).__audiobus = bus;

  // --- rendu ---------------------------------------------------------------
  const gl = createGL(canvas);
  const caps: Caps = probeCaps(gl);
  console.info("[viz] caps", caps);
  const lut = makeLUT(gl, "ember");
  const demo = makeProgram(gl, demoFrag, { common: true });
  const tone = makeProgram(gl, toneFrag);
  const feat = new FeatureTexture(gl);

  let scene: Target = createTarget(gl, 8, 8, caps.simFormat);
  const loop = new RenderLoop(canvas, 0.75);
  loop.onResize((vp: Viewport) => {
    gl.deleteTexture(scene.tex); gl.deleteFramebuffer(scene.fbo);
    scene = createTarget(gl, vp.simW, vp.simH, caps.simFormat);
  });

  const frame = (_dt: number, time: number, vp: Viewport) => {
    const fr = bus && bus.ready ? bus.read() : ZERO;
    feat.update(fr);
    // passe 1 : densité procédurale -> buffer float (résolution de sim)
    bindTarget(gl, scene.fbo, vp.simW, vp.simH);
    drawFullscreen(gl, demo, { u_time: time, ...feat.uniforms(fr) });
    // passe 2 : tonemap -> écran (résolution d'affichage)
    bindTarget(gl, null, vp.dispW, vp.dispH);
    drawFullscreen(gl, tone, { u_src: scene.tex, u_lut: lut, u_exposure: 1.6, u_hueShift: 0 });
  };
  loop.start(frame);

  (globalThis as unknown as { __render: unknown }).__render = {
    caps, glError: () => gl.getError(),
    renderOnce: (t: number) => frame(0.016, t ?? 0, loop.vp),
  };
  console.info("[viz] rendu démarré");
}

(globalThis as unknown as { __viz: unknown }).__viz = {
  crossOriginIsolated: typeof crossOriginIsolated !== "undefined" && crossOriginIsolated,
  hasSAB: typeof SharedArrayBuffer !== "undefined",
};

document.getElementById("start")!.addEventListener("click", () => {
  start().catch((e) => { console.error("[viz] erreur:", e); });
});
