// main.ts — banc d'essai : bus audio -> mod matrix -> mode actif -> tonemap.
import { AudioBus, type BusFrame } from "./audio/bus";
import { createGL } from "./core/gl";
import { probeCaps, type Caps } from "./core/caps";
import { makeProgram, drawFullscreen, bindTarget } from "./core/fullscreen";
import { createTarget, type Target } from "./core/pingpong";
import { FeatureTexture } from "./core/featureTexture";
import { RenderLoop, type Viewport } from "./core/loop";
import { makeLUT, LUT_NAMES } from "./post/lut";
import { ModMatrix } from "./modmatrix/matrix";
import { mountMatrixUI } from "./modmatrix/ui";
import { ModeRegistry } from "./modes/registry";
import toneFrag from "./post/tonemap.frag?raw";

const canvas = document.getElementById("c") as HTMLCanvasElement;
const hud = document.getElementById("hud")!;
const mm = document.getElementById("mm")!;
let bus: AudioBus | null = null;

const ZERO: BusFrame = { feat: new Float32Array(64), bpm: 120, beatPhase: 0, nextBeat: 0, lockConf: 0, onsetFired: false, kickFired: false, snareFired: false, hatsFired: false };

async function start() {
  document.getElementById("boot")!.classList.add("hidden");

  const ctx = new AudioContext();
  await ctx.resume();
  bus = new AudioBus();
  const params = new URLSearchParams(location.search);
  let source: AudioNode;
  if (params.has("osc")) { const o = ctx.createOscillator(); o.type = "sawtooth"; o.frequency.value = Number(params.get("osc")) || 220; o.start(); source = o; }
  else source = await AudioBus.micSource(ctx);
  await bus.start(source);
  (globalThis as any).__audiobus = bus;

  const gl = createGL(canvas);
  const caps: Caps = probeCaps(gl);
  console.info("[viz] caps", caps);
  const matrix = new ModMatrix();
  const feat = new FeatureTexture(gl);
  const tone = makeProgram(gl, toneFrag);
  let lutIdx = 0;
  let lut = makeLUT(gl, LUT_NAMES[lutIdx]);

  const loop = new RenderLoop(canvas, 0.8);
  const registry = new ModeRegistry({ gl, caps, feat, matrix }, loop.vp);
  let scene: Target = createTarget(gl, loop.vp.simW, loop.vp.simH, caps.simFormat);
  loop.onResize((vp: Viewport) => {
    gl.deleteTexture(scene.tex); gl.deleteFramebuffer(scene.fbo);
    scene = createTarget(gl, vp.simW, vp.simH, caps.simFormat);
    registry.resize(vp);
  });

  let fps = 60, fpsT = 0, fpsN = 0;
  const frame = (dt: number, time: number, vp: Viewport, override?: BusFrame) => {
    const fr = override ?? (bus && bus.ready ? bus.read() : ZERO);
    matrix.apply(fr, dt);
    feat.update(fr);
    registry.update(fr, dt, time);
    // mode -> scene (float, résolution de sim)
    registry.render(scene.fbo, vp.simW, vp.simH);
    // tonemap scene -> écran
    bindTarget(gl, null, vp.dispW, vp.dispH);
    drawFullscreen(gl, tone, { u_src: scene.tex, u_lut: lut, u_exposure: matrix.get("global.exposure"), u_hueShift: matrix.get("global.hueShift"), u_beatFlash: matrix.get("global.beatFlash") });
    // hud
    fpsN++; if (time - fpsT > 0.5) { fps = fpsN / (time - fpsT); fpsT = time; fpsN = 0; }
    hud.textContent = `${registry.names[registry.index]} · ${Math.round(fps)}fps · ${Math.round(fr.bpm)}bpm · lock ${fr.lockConf.toFixed(2)} · [1-3] mode [M] matrix [L] lut`;
  };
  loop.start(frame);

  const setLut = () => { gl.deleteTexture(lut); lut = makeLUT(gl, LUT_NAMES[lutIdx]); };
  addEventListener("keydown", (e: KeyboardEvent) => {
    const k = e.key.toLowerCase();
    if (k >= "1" && k <= "3") registry.switch(Number(k) - 1);
    else if (k === "m") mm.classList.toggle("hidden");
    else if (k === "l") { lutIdx = (lutIdx + 1) % LUT_NAMES.length; setLut(); }
    else if (k === "f") { if (!document.fullscreenElement) document.documentElement.requestFullscreen(); else document.exitFullscreen(); }
    else if (k === "r") registry.current.reset();
  });
  mountMatrixUI(mm, matrix);
  hud.classList.remove("hidden");

  (globalThis as any).__render = {
    caps, glError: () => gl.getError(),
    renderOnce: (t: number) => frame(0.016, t ?? 0, loop.vp),
    testFrame: (fr: BusFrame, t: number) => frame(0.016, t ?? 0, loop.vp, fr),
    switchMode: (i: number) => registry.switch(i),
    modeName: () => registry.names[registry.index],
  };
  console.info("[viz] rendu démarré");
}

(globalThis as any).__viz = { crossOriginIsolated: typeof crossOriginIsolated !== "undefined" && crossOriginIsolated, hasSAB: typeof SharedArrayBuffer !== "undefined" };
document.getElementById("start")!.addEventListener("click", () => { start().catch((e) => console.error("[viz] erreur:", e)); });
