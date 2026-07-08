// grayscott.ts — Réaction-diffusion Gray-Scott (famille CONTINUOUS, ping-pong).
// Système iconique (coraux, mitose, taches de Turing). État = (U,V) dans (R,G)
// sur un tore. Par pas : Laplacien 9-points de U et V, puis
//   dU = Du*lapU − U*V*V + F*(1−U) ;  dV = Dv*lapV + U*V*V − (F+k)*V.
// F (feed) piloté par le bass, k (kill) par le treble : c'est le couple (F,k) qui
// change RADICALEMENT le motif (points, vers, dédales, mitose). Un onset ensemence
// de nouvelles taches de V. Rendu : densité = smoothstep(V), teinte hue(baseHue+V).
import { makeProgram, drawFullscreen, bindTarget } from "../core/fullscreen";
import { PingPong } from "../core/pingpong";
import { registerParams, unregister, getParam } from "../modmatrix/targets";
import type { Mode, Resources } from "./Mode";
import type { BusFrame } from "../audio/bus";
import type { Viewport } from "../core/loop";

// --- passe de simulation (un pas Gray-Scott). Pas de common ici : precision
// explicite, aucun helper partagé nécessaire. Laplacien 9-points (kernel
// canonique : orthogonaux 0.2, diagonaux 0.05, centre −1) sur les 2 canaux.
const SIM = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D uState; uniform vec2 uTexel;
uniform float uDu, uDv, uF, uK, uDt;
vec2 lap(vec2 p){
  vec2 c = texture(uState, p).xy;
  vec2 e = texture(uState, p + vec2(uTexel.x, 0.0)).xy + texture(uState, p - vec2(uTexel.x, 0.0)).xy
         + texture(uState, p + vec2(0.0, uTexel.y)).xy + texture(uState, p - vec2(0.0, uTexel.y)).xy;
  vec2 d = texture(uState, p + uTexel).xy + texture(uState, p - uTexel).xy
         + texture(uState, p + vec2(uTexel.x, -uTexel.y)).xy + texture(uState, p + vec2(-uTexel.x, uTexel.y)).xy;
  return e * 0.2 + d * 0.05 - c;
}
void main(){
  vec2 c = texture(uState, v_uv).xy;
  float U = c.x, V = c.y;
  vec2 L = lap(v_uv);
  float rxn = U * V * V;
  float dU = uDu * L.x - rxn + uF * (1.0 - U);
  float dV = uDv * L.y + rxn - (uF + uK) * V;
  U = clamp(U + dU * uDt, 0.0, 1.0);
  V = clamp(V + dV * uDt, 0.0, 1.0);
  o = vec4(U, V, 0.0, 1.0);
}`;

// --- injection d'une tache de V (sur onset) : on baisse U et on monte V dans un
// disque gaussien -> nucléation d'un nouveau motif.
const INJECT = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D uState; uniform vec2 uPos; uniform float uAmp, uRadius, uAspect;
void main(){
  vec2 c = texture(uState, v_uv).xy;
  vec2 d = v_uv - uPos; d.x *= uAspect;
  float g = uAmp * exp(-dot(d, d) / uRadius);
  float U = c.x - g;         // consomme U
  float V = c.y + g;         // ensemence V
  o = vec4(clamp(U, 0.0, 1.0), clamp(V, 0.0, 1.0), 0.0, 1.0);
}`;

// --- germination initiale : U=1 partout, V≈0.5 dans quelques cellules (avec U≈0.5
// là) -> vrais germes qui nucléent (V=0 partout serait un point fixe mort).
const SEED = `#version 300 es
in vec2 v_uv; out vec4 o;
void main(){
  vec2 cell = floor(v_uv * 14.0);
  float r = hash22(cell * 11.7).x;
  float U = 1.0, V = 0.0;
  if (r > 0.80) {
    vec2 c = (cell + 0.5) / 14.0;
    vec2 dd = v_uv - c;
    float blob = exp(-dot(dd, dd) * 1400.0);
    V = 0.5 * blob;
    U = 1.0 - 0.5 * blob;
  }
  o = vec4(U, V, 0.0, 1.0);
}`;

// --- rendu : densité V -> couleur (teinte globale + léger décalage par V).
// V plafonne ~0.3-0.4 : smoothstep(0.0,0.35,V). Intensité visible (0.35+uBright).
const RENDER = `#version 300 es
in vec2 v_uv; out vec4 o;
uniform sampler2D uState; uniform float uHue, uBright;
void main(){
  float V = texture(uState, v_uv).y;
  float d = smoothstep(0.0, 0.35, V) * (0.35 + uBright);
  vec3 col = hue(uHue + V * 0.5) * d;
  o = vec4(col, 1.0);
}`;

export class GrayScottMode implements Mode {
  id = "grayscott"; family = "continuous" as const;
  private gl!: WebGL2RenderingContext; private res!: Resources;
  private state!: PingPong; private w = 0; private h = 0;
  private pSim: any; private pInj: any; private pSeed: any; private pRender: any;
  private phase = 0;

  init(res: Resources, vp: Viewport): void {
    this.res = res; this.gl = res.gl;
    registerParams(res.matrix.targets, this.id, {
      Du: 0.16, Dv: 0.08, F: 0.037, k: 0.06, rate: 1.0,
      injRadius: 0.004, injAmp: 0.7,
    }, {
      Du: [0.10, 0.24], Dv: [0.04, 0.12], F: [0.02, 0.06], k: [0.05, 0.07],
      rate: [0.4, 1.2], injRadius: [0.001, 0.01], injAmp: [0, 1.5],
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
    // état float : NEAREST + REPEAT (tore) ; format de sim depuis les caps.
    this.state = new PingPong(this.gl, this.w, this.h, this.res.caps.simFormat, this.gl.NEAREST, this.gl.REPEAT);
    this.reset();
  }

  reset(): void {
    const gl = this.gl;
    bindTarget(gl, this.state.write.fbo, this.w, this.h);
    drawFullscreen(gl, this.pSeed, {});
    this.state.swap();
    this.phase = 0;
  }

  update(fr: BusFrame, _dt: number): void {
    const gl = this.gl; const m = this.res.matrix;
    const Du = getParam(m.targets, "grayscott.params.Du", 0.16);
    const Dv = getParam(m.targets, "grayscott.params.Dv", 0.08);
    // pas d'intégration explicite : Gray-Scott standard tourne à dt≈1.0 avec ce
    // kernel (Du·dt=0.16 stable). Borné à 1.2 pour rester sûr.
    const dt = Math.min(getParam(m.targets, "grayscott.params.rate", 1.0), 1.2);
    const uni = {
      uTexel: [1 / this.w, 1 / this.h],
      uDu: Du, uDv: Dv,
      uF: m.get("grayscott.params.F"), uK: m.get("grayscott.params.k"),
      uDt: dt,
    };
    // 3 sous-pas par frame : évolution fluide sans coût excessif.
    const SUB = 3;
    for (let s = 0; s < SUB; s++) {
      bindTarget(gl, this.state.write.fbo, this.w, this.h);
      drawFullscreen(gl, this.pSim, { ...uni, uState: this.state.read.tex });
      this.state.swap();
    }
    // onset -> ensemencement d'une tache de V (position dérivée d'un hash de phase).
    if (fr.onsetFired) {
      this.phase += 0.31;
      const px = 0.5 + Math.cos(this.phase * 6.283) * 0.34;
      const py = 0.5 + Math.sin(this.phase * 4.7) * 0.34;
      bindTarget(gl, this.state.write.fbo, this.w, this.h);
      drawFullscreen(gl, this.pInj, {
        uState: this.state.read.tex, uPos: [px, py],
        uAmp: m.get("grayscott.params.injAmp"),
        uRadius: m.get("grayscott.params.injRadius"), uAspect: this.w / this.h,
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
