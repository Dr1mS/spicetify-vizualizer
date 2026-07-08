// smoothlife.ts — SmoothLife (famille CONTINUOUS, ping-pong).
// Ancêtre continu de Life : état a∈[0,1] (canal R) sur un tore. Par pas on
// échantillonne un DISQUE intérieur (rayon ri) -> M et un ANNEAU (ri..ra) -> N,
// puis a_next = clamp(a + dt*(2·s(N,M) − 1)) avec s = sigmoïdes birth/death.
// Onset ensemence des taches ; le spectre (u_melf) module localement le seuil
// de naissance -> blobs/gliders lisses qui "respirent" au rythme.
import { makeProgram, drawFullscreen, bindTarget } from "../core/fullscreen";
import { PingPong } from "../core/pingpong";
import { registerParams, unregister, getParam } from "../modmatrix/targets";
import type { Mode, Resources } from "./Mode";
import type { BusFrame } from "../audio/bus";
import type { Viewport } from "../core/loop";

// --- passe de simulation (un pas SmoothLife). {common:true} -> u_mel/u_melf,
// precision et hue sont déjà préfixés : NE PAS les redéclarer ici.
const SIM = `#version 300 es
in vec2 v_uv; out vec4 o;
uniform sampler2D uState; uniform vec2 uTexel;
uniform float uRi, uRa;                 // rayons disque / anneau (UV)
uniform float uB1, uB2, uD1, uD2;       // seuils birth/death
uniform float uAlphaN, uAlphaM;         // douceur des sigmoïdes
uniform float uDt, uAspect, uMelAmt;    // pas, aspect, gain spectre

// sigmoïde logistique lisse
float sig(float x, float a, float w){ return 1.0/(1.0 + exp(-(x-a)*4.0/w)); }
float sig_ab(float x, float a, float b, float w){ return sig(x,a,w)*(1.0 - sig(x,b,w)); }
// règle de transition : mélange birth (M mort) / death (M vivant) selon M
float trans(float n, float m){
  float bw = uAlphaN, dw = uAlphaN;
  float birth = sig_ab(n, uB1, uB2, bw);
  float death = sig_ab(n, uD1, uD2, dw);
  return mix(birth, death, sig(m, 0.5, uAlphaM));
}

// motif d'échantillonnage : 24 rayons, 2 couronnes -> disque + anneau
const int RAYS = 24;
void main(){
  float a = texture(uState, v_uv).r;
  float sumM = 0.0, cntM = 0.0;  // disque intérieur
  float sumN = 0.0, cntN = 0.0;  // anneau extérieur
  for (int k = 0; k < RAYS; k++){
    float ang = (float(k) + 0.5) / float(RAYS) * TAU;
    vec2 dir = vec2(cos(ang), sin(ang));
    dir.x /= uAspect;            // rayons ~isotropes en écran
    // disque : 2 échantillons intérieurs
    vec2 dA = dir * (uRi * 0.5);
    vec2 dB = dir * (uRi * 0.95);
    sumM += texture(uState, v_uv + dA).r + texture(uState, v_uv + dB).r; cntM += 2.0;
    // anneau : 2 échantillons entre ri et ra
    vec2 dC = dir * mix(uRi, uRa, 0.4);
    vec2 dD = dir * mix(uRi, uRa, 0.85);
    sumN += texture(uState, v_uv + dC).r + texture(uState, v_uv + dD).r; cntN += 2.0;
  }
  sumM += a; cntM += 1.0;        // centre compte dans le disque
  float M = sumM / cntM;
  float N = sumN / cntN;
  // "nourriture" spectrale : la bande mel locale décale le seuil de naissance,
  // les blobs affluent là où le spectre est chaud (réactivité audio).
  float food = u_melf(v_uv.x) * uMelAmt;
  float s = trans(N, M - food);
  float na = a + uDt * (2.0 * s - 1.0);
  o = vec4(clamp(na, 0.0, 1.0), 0.0, 0.0, 1.0);
}`;

// --- injection d'une tache lisse (sur onset)
const INJECT = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D uState; uniform vec2 uPos; uniform float uAmp, uRadius, uAspect;
void main(){
  float a = texture(uState, v_uv).r;
  vec2 d = v_uv - uPos; d.x *= uAspect;
  a += uAmp * exp(-dot(d,d)/uRadius);
  o = vec4(clamp(a, 0.0, 1.0), 0.0, 0.0, 1.0);
}`;

// --- germination initiale : quelques taches aléatoires sur fond mort
const SEED = `#version 300 es
in vec2 v_uv; out vec4 o;
void main(){
  vec2 cell = floor(v_uv * 12.0);
  float r = hash22(cell * 7.3).x;
  float blob = 0.0;
  if (r > 0.72) {
    vec2 c = (cell + 0.5) / 12.0;
    vec2 d = v_uv - c;
    blob = exp(-dot(d,d) * 900.0);
  }
  o = vec4(clamp(blob, 0.0, 1.0), 0.0, 0.0, 1.0);
}`;

// --- rendu : densité a -> couleur (teinte globale + léger décalage par densité)
const RENDER = `#version 300 es
in vec2 v_uv; out vec4 o;
uniform sampler2D uState; uniform float uHue, uBright;
void main(){
  float a = texture(uState, v_uv).r;
  float d = smoothstep(0.06, 0.9, a) * (0.35 + uBright);
  vec3 col = hue(uHue + a * 0.14) * d;
  o = vec4(col, 1.0);
}`;

export class SmoothLifeMode implements Mode {
  id = "smoothlife"; family = "continuous" as const;
  private gl!: WebGL2RenderingContext; private res!: Resources;
  private state!: PingPong; private w = 0; private h = 0;
  private pSim: any; private pInj: any; private pSeed: any; private pRender: any;
  private phase = 0;

  init(res: Resources, vp: Viewport): void {
    this.res = res; this.gl = res.gl;
    registerParams(res.matrix.targets, this.id, {
      ri: 0.03, ra: 0.09, b1: 0.26, b2: 0.46, d1: 0.34, d2: 0.52,
      alphaN: 0.028, alphaM: 0.147, rate: 0.14, melAmt: 0.0,
      injRadius: 0.004, injAmp: 0.9,
    }, {
      ri: [0.015, 0.05], ra: [0.05, 0.14], b1: [0.15, 0.35], b2: [0.35, 0.6],
      d1: [0.25, 0.45], d2: [0.45, 0.7], alphaN: [0.01, 0.06], alphaM: [0.05, 0.3],
      rate: [0.05, 0.3], melAmt: [0, 0.25], injAmp: [0, 2],
    });
    this.pSim = makeProgram(this.gl, SIM, { common: true });
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
  }

  update(fr: BusFrame, _dt: number): void {
    const gl = this.gl; const m = this.res.matrix;
    const ri = getParam(m.targets, "smoothlife.params.ri", 0.03);
    const ra = Math.max(getParam(m.targets, "smoothlife.params.ra", 0.09), ri + 0.01);
    // pas d'intégration : borné pour la stabilité (2·s−1 ∈ [−1,1]).
    const dt = Math.min(getParam(m.targets, "smoothlife.params.rate", 0.14), 0.35);
    const uni = {
      uTexel: [1 / this.w, 1 / this.h],
      uRi: ri, uRa: ra,
      uB1: m.get("smoothlife.params.b1"), uB2: m.get("smoothlife.params.b2"),
      uD1: m.get("smoothlife.params.d1"), uD2: m.get("smoothlife.params.d2"),
      uAlphaN: Math.max(m.get("smoothlife.params.alphaN"), 1e-3),
      uAlphaM: Math.max(m.get("smoothlife.params.alphaM"), 1e-3),
      uDt: dt, uAspect: this.w / this.h, uMelAmt: m.get("smoothlife.params.melAmt"),
      // features audio dans le shader (main.ts ne les lie qu'au tonemap).
      u_feat: this.res.feat.tex, u_melCount: 32,
    };
    // deux sous-pas par frame pour une évolution fluide sans coûter trop cher.
    const SUB = 2;
    for (let s = 0; s < SUB; s++) {
      bindTarget(gl, this.state.write.fbo, this.w, this.h);
      drawFullscreen(gl, this.pSim, { ...uni, uState: this.state.read.tex });
      this.state.swap();
    }
    // onset -> ensemencement d'une tache (position dérivée d'un hash de phase).
    if (fr.onsetFired) {
      this.phase += 0.31;
      const px = 0.5 + Math.cos(this.phase * 6.283) * 0.32;
      const py = 0.5 + Math.sin(this.phase * 4.7) * 0.32;
      bindTarget(gl, this.state.write.fbo, this.w, this.h);
      drawFullscreen(gl, this.pInj, {
        uState: this.state.read.tex, uPos: [px, py],
        uAmp: m.get("smoothlife.params.injAmp"),
        uRadius: m.get("smoothlife.params.injRadius"), uAspect: this.w / this.h,
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
