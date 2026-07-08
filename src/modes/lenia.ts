// lenia.ts — Lenia (automate cellulaire CONTINU à noyau, famille CONTINUOUS, ping-pong).
// État A∈[0,1] (canal R). Convolution avec un NOYAU ANNULAIRE : ~24 points sur un
// anneau (rayon uR en UV) pondérés par une cloche gaussienne centrée sur l'anneau
// -> U (moyenne pondérée, ∈[0,1]). Croissance growth = 2*exp(-(U-mu)^2/(2*sig^2))-1
// (cloche). A += dt*growth, clamp [0,1]. Des 'créatures' (orbium-like) émergent et
// glissent. Onset = ensemencement local. mu/sig pilotés par le spectre (mod matrix).
import { makeProgram, drawFullscreen, bindTarget } from "../core/fullscreen";
import { PingPong } from "../core/pingpong";
import { registerParams, unregister, getParam } from "../modmatrix/targets";
import type { Mode, Resources } from "./Mode";
import type { BusFrame } from "../audio/bus";
import type { Viewport } from "../core/loop";

// --- SIM : convolution anneau + croissance cloche ---------------------------
// U est une MOYENNE PONDÉRÉE (Σw=1) -> ∈[0,1], comparable à mu. Champ vide -> U=0
// -> growth ≈ -1 (décroît). Voisinage ~mu -> growth ≈ +1 (croît). Sig gardé > 0.
const SIM = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D uState; uniform vec2 uTexel;
uniform float uMu, uSig, uDt, uR, uAspect;
const int K = 24;
const float TAU = 6.2831853;
void main(){
  float U = 0.0, W = 0.0;
  // anneau : K points échantillonnés à ~uR (UV), pondérés par une cloche
  // gaussienne sur le rayon (ici tous ~sur l'anneau -> poids ~égaux, mais on garde
  // la forme pour la douceur). Correction d'aspect pour un anneau isotrope.
  for (int i = 0; i < K; i++){
    float ang = (float(i) + 0.5) / float(K) * TAU;
    vec2 dir = vec2(cos(ang) / uAspect, sin(ang));
    // deux couronnes (intérieure/extérieure) autour du rayon nominal -> cloche
    for (int r = 0; r < 2; r++){
      float rr = uR * (r == 0 ? 0.72 : 1.0);
      float t = (rr - uR * 0.86) / (uR * 0.30); // signé -> jamais pow (NaN si base<0)
      float w = exp(-t * t);
      vec2 p = fract(v_uv + dir * rr);
      U += w * texture(uState, p).x;
      W += w;
    }
  }
  U /= max(W, 1e-4);
  float s = max(uSig, 1e-3);
  float growth = 2.0 * exp(-((U - uMu) * (U - uMu)) / (2.0 * s * s)) - 1.0;
  float a = texture(uState, v_uv).x;
  a = clamp(a + uDt * growth, 0.0, 1.0);
  o = vec4(a, U, 0.0, 1.0);
}`;

// --- INJECT : ensemencement local (onset) -----------------------------------
// Tache lisse d'amplitude ~0.5 dans la bande U≈mu, sinon elle décroît aussitôt.
const INJECT = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D uState; uniform vec2 uPos; uniform float uAmp, uRadius, uAspect;
void main(){
  float a = texture(uState, v_uv).x;
  vec2 d = v_uv - uPos; d.x *= uAspect;
  a = clamp(a + uAmp * exp(-dot(d, d) / uRadius), 0.0, 1.0);
  o = vec4(a, 0.0, 0.0, 1.0);
}`;

// --- SEED : champ peuplé et LISSE (patches ~0.2..0.5), pas des germes rares --
// Lenia n'émerge pas du vide : il faut des régions déjà dans la bande U≈mu.
const SEED = `#version 300 es
in vec2 v_uv; out vec4 o;
void main(){
  // bruit multi-échelle doux -> patches larges
  vec2 p = v_uv;
  float n = 0.0;
  n += 0.60 * hash22(floor(p * 6.0)).x;
  n += 0.30 * hash22(floor(p * 12.0) + 7.0).x;
  n += 0.10 * hash22(floor(p * 24.0) + 19.0).x;
  // interpolation grossière pour lisser un peu les blocs
  float a = smoothstep(0.55, 0.95, n) * 0.5;
  o = vec4(a, 0.0, 0.0, 1.0);
}`;

// --- RENDER : densité colorée. max(rgb)=intensité, teinte via hue(). ---------
const RENDER = `#version 300 es
in vec2 v_uv; out vec4 o;
uniform sampler2D uState; uniform float uHue, uBright;
void main(){
  vec2 c = texture(uState, v_uv).xy; // x=A, y=U (dernière convolution)
  float a = c.x;
  float d = smoothstep(0.02, 1.0, a) * (0.35 + uBright);
  // teinte décalée par la densité locale de voisinage (structure des créatures)
  vec3 col = hue(uHue + a * 0.18 + c.y * 0.10) * d;
  o = vec4(col, 1.0);
}`;

export class LeniaMode implements Mode {
  id = "lenia"; family = "continuous" as const;
  private gl!: WebGL2RenderingContext; private res!: Resources;
  private state!: PingPong; private w = 0; private h = 0;
  private pSim: any; private pInj: any; private pSeed: any; private pRender: any;
  private phase = 0;

  init(res: Resources, vp: Viewport): void {
    this.res = res; this.gl = res.gl;
    registerParams(res.matrix.targets, this.id, {
      mu: 0.15, sig: 0.017, R: 0.05, dt: 0.1, injRadius: 0.004, injAmp: 0.6,
    }, {
      mu: [0.08, 0.30], sig: [0.005, 0.05], R: [0.02, 0.09],
      dt: [0.02, 0.25], injRadius: [0.001, 0.02], injAmp: [0, 1.2],
    });
    this.pSim = makeProgram(this.gl, SIM);
    this.pInj = makeProgram(this.gl, INJECT);
    this.pSeed = makeProgram(this.gl, SEED, { common: true });
    this.pRender = makeProgram(this.gl, RENDER, { common: true });
    this.resize(vp);
  }
  resize(vp: Viewport): void {
    this.w = vp.simW; this.h = vp.simH;
    this.state?.dispose();
    // état de sim = simFormat (rule 9) ; NEAREST + REPEAT (tore, wrap doux).
    this.state = new PingPong(this.gl, this.w, this.h, this.res.caps.simFormat, this.gl.NEAREST, this.gl.REPEAT);
    this.reset();
  }
  reset(): void {
    const gl = this.gl;
    bindTarget(gl, this.state.write.fbo, this.w, this.h);
    drawFullscreen(gl, this.pSeed, {});
    this.state.swap();
  }
  update(fr: BusFrame, _dt: number): void {
    const gl = this.gl; const m = this.res.matrix;
    const dt = getParam(m.targets, "lenia.params.dt", 0.1);
    const uni = {
      uTexel: [1 / this.w, 1 / this.h],
      uMu: m.get("lenia.params.mu"),
      uSig: m.get("lenia.params.sig"),
      uDt: dt,
      uR: m.get("lenia.params.R"),
      uAspect: this.w / this.h,
    };
    const SUB = 2;
    for (let s = 0; s < SUB; s++) {
      bindTarget(gl, this.state.write.fbo, this.w, this.h);
      drawFullscreen(gl, this.pSim, { uState: this.state.read.tex, ...uni });
      this.state.swap();
    }
    // ensemencement gardé par l'onset (position dérivée du beat/hash)
    if (fr.onsetFired) {
      this.phase += 0.31;
      const px = 0.5 + Math.cos(this.phase * 6.283) * 0.3;
      const py = 0.5 + Math.sin(this.phase * 4.7) * 0.3;
      bindTarget(gl, this.state.write.fbo, this.w, this.h);
      drawFullscreen(gl, this.pInj, {
        uState: this.state.read.tex, uPos: [px, py],
        uAmp: m.get("lenia.params.injAmp"), uRadius: m.get("lenia.params.injRadius"),
        uAspect: this.w / this.h,
      });
      this.state.swap();
    }
  }
  render(target: WebGLFramebuffer | null, w: number, h: number): void {
    bindTarget(this.gl, target, w, h);
    drawFullscreen(this.gl, this.pRender, {
      uState: this.state.read.tex,
      uHue: this.res.matrix.get("global.baseHue"),
      uBright: this.res.matrix.get("global.brightness") - 1,
    });
  }
  dispose(): void { this.state?.dispose(); unregister(this.res.matrix.targets, this.id); }
}
