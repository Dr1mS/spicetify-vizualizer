// kuramoto.ts — grille d'oscillateurs de Kuramoto (famille CONTINUOUS, ping-pong).
// État : R = phase θ (0..1 pour 0..2π), G = fréquence propre ω0 (spread fixe, seedé).
// θ += dt*(ω0 + K * moyenne_voisins sin(2π(θ_j-θ_i))). K (couplage) piloté par
// l'énergie/le grave ; le spectre (u_melf) module localement le couplage ; un onset
// perturbe les phases (splat aléatoire). Rendu : teinte = hue(baseHue + θ),
// densité = synchro locale |moyenne des voisins| -> vagues/spirales de synchro.
import { makeProgram, drawFullscreen, bindTarget } from "../core/fullscreen";
import { PingPong } from "../core/pingpong";
import { registerParams, unregister } from "../modmatrix/targets";
import { MEL_COUNT } from "../audio/constants";
import type { Mode, Resources } from "./Mode";
import type { BusFrame } from "../audio/bus";
import type { Viewport } from "../core/loop";

// SIM : un pas de Kuramoto. {common:true} -> precision + hue/u_mel/u_melf/hash déjà
// prépendus (NE PAS redéclarer). u_feat/u_melCount fournis à la passe pour u_melf().
const SIM = `#version 300 es
in vec2 v_uv; out vec4 o;
uniform sampler2D uState; uniform vec2 uTexel;
uniform float uK,uOmega,uDt,uMelGain;
// somme des sin(2π·Δθ) sur les 8 voisins (couplage Kuramoto)
float coupling(vec2 p, float th){
  float s = 0.0;
  for(int j=-1;j<=1;j++) for(int i=-1;i<=1;i++){
    if(i==0 && j==0) continue;
    float tj = texture(uState, p + vec2(float(i),float(j))*uTexel).x;
    s += sin(TAU*(tj - th));
  }
  return s / 8.0;
}
void main(){
  vec2 c = texture(uState, v_uv).xy;
  float th = c.x;      // phase 0..1
  float w  = c.y;      // fréquence propre (offset seedé)
  // couplage local modulé par le spectre : les bandes actives resserrent la synchro
  float mel = u_melf(v_uv.x);
  float K = uK * (1.0 + uMelGain * mel);
  float dth = uOmega + w + K * coupling(v_uv, th);
  float nth = fract(th + uDt * dth);   // phase repliée sur 0..1 (tore)
  o = vec4(nth, w, 0., 1.);
}`;

// INJECT : un onset perturbe localement les phases (splat gaussien de bruit).
const INJECT = `#version 300 es
in vec2 v_uv; out vec4 o;
uniform sampler2D uState; uniform vec2 uPos; uniform float uAmp,uRadius,uAspect;
void main(){
  vec2 c = texture(uState, v_uv).xy;
  vec2 d = v_uv - uPos; d.x *= uAspect;
  float g = uAmp * exp(-dot(d,d)/uRadius);
  float kick = (hash22(v_uv*311.0 + uPos*57.0).x - 0.5); // déphasage aléatoire
  o = vec4(fract(c.x + g*kick), c.y, 0., 1.);
}`;

// SEED : phase aléatoire + petit étalement de fréquence propre (dynamique riche).
const SEED = `#version 300 es
in vec2 v_uv; out vec4 o;
void main(){
  vec2 h = hash22(v_uv*97.0);
  float th = h.x;                    // phase initiale 0..1
  float w  = (h.y - 0.5) * 0.15;     // ω0 ∈ [-0.075, 0.075]
  o = vec4(th, w, 0., 1.);
}`;

// RENDER : teinte = hue(baseHue + θ) ; densité = synchro locale (|moyenne voisins|).
const RENDER = `#version 300 es
in vec2 v_uv; out vec4 o;
uniform sampler2D uState; uniform vec2 uTexel; uniform float uHue,uBright;
void main(){
  float th = texture(uState, v_uv).x;
  // ordre local r = |moyenne des e^{iθ} des 8 voisins| ∈ 0..1 (1 = synchronisé)
  vec2 acc = vec2(0.0);
  for(int j=-1;j<=1;j++) for(int i=-1;i<=1;i++){
    float tj = texture(uState, v_uv + vec2(float(i),float(j))*uTexel).x;
    acc += vec2(cos(TAU*tj), sin(TAU*tj));
  }
  float r = length(acc) / 9.0;              // cohérence locale
  // MESURÉ : (0.15+uBright)*(0.25+0.75r²) bornait la densité à [0,037 ; 0,15],
  // soit le quart bas de la LUT — 13 niveaux distincts sur 64 à l'écran, d'où
  // l'impression que « tout se ressemble ». On couvre maintenant la rampe, et le
  // cube de r creuse l'écart entre zones synchronisées et désynchronisées (c'est
  // CE contraste qui porte l'information du mode).
  float dens = (1.0 + uBright) * (0.07 + 2.3*r*r*r);
  vec3 col = hue(uHue + th) * dens;
  o = vec4(col, 1.);
}`;

export class KuramotoMode implements Mode {
  id = "kuramoto"; family = "continuous" as const;
  private gl!: WebGL2RenderingContext; private res!: Resources;
  private state!: PingPong; private w = 0; private h = 0;
  private pSim: any; private pInj: any; private pSeed: any; private pRender: any;
  private phase = 0;

  init(res: Resources, vp: Viewport): void {
    this.res = res; this.gl = res.gl;
    registerParams(res.matrix.targets, this.id, {
      K: 0.6, omega: 0.02, melGain: 1.2, injRadius: 0.004, injAmp: 0.6,
    }, {
      K: [0.0, 2.0], omega: [-0.1, 0.1], melGain: [0, 4], injRadius: [0.001, 0.02], injAmp: [0, 1.5],
    });
    this.pSim = makeProgram(this.gl, SIM, { common: true });
    this.pInj = makeProgram(this.gl, INJECT, { common: true });
    this.pSeed = makeProgram(this.gl, SEED, { common: true });
    this.pRender = makeProgram(this.gl, RENDER, { common: true });
    this.resize(vp);
  }
  resize(vp: Viewport): void {
    this.w = vp.simW; this.h = vp.simH;
    this.state?.dispose();
    this.state = new PingPong(this.gl, this.w, this.h, this.res.caps.simFormat, this.gl.NEAREST, this.gl.CLAMP_TO_EDGE);
    this.reset();
  }
  reset(): void {
    const gl = this.gl;
    bindTarget(gl, this.state.write.fbo, this.w, this.h);
    drawFullscreen(gl, this.pSeed, {});
    this.state.swap();
  }
  update(fr: BusFrame, dt: number): void {
    const gl = this.gl; const m = this.res.matrix;
    // dt de sim borné pour la stabilité (θ replié en fract, mais on évite les grands pas)
    const simDt = Math.min(Math.max(dt, 1 / 240), 1 / 30);
    const feat = { u_feat: this.res.feat.tex, u_melCount: MEL_COUNT };
    const uni = {
      uTexel: [1 / this.w, 1 / this.h] as [number, number],
      uK: m.get("kuramoto.params.K"),
      uOmega: m.get("kuramoto.params.omega"),
      uMelGain: m.get("kuramoto.params.melGain"),
      uDt: simDt,
      ...feat,
    };
    const SUB = 2;
    for (let s = 0; s < SUB; s++) {
      bindTarget(gl, this.state.write.fbo, this.w, this.h);
      drawFullscreen(gl, this.pSim, { uState: this.state.read.tex, ...uni });
      this.state.swap();
    }
    // onset -> perturbation locale des phases (position dérivée du beat/hash)
    if (fr.onsetFired) {
      this.phase += 0.31;
      const px = 0.5 + Math.cos(this.phase * 6.283) * 0.32;
      const py = 0.5 + Math.sin(this.phase * 4.7) * 0.32;
      bindTarget(gl, this.state.write.fbo, this.w, this.h);
      drawFullscreen(gl, this.pInj, {
        uState: this.state.read.tex, uPos: [px, py] as [number, number],
        uAmp: m.get("kuramoto.params.injAmp"), uRadius: m.get("kuramoto.params.injRadius"),
        uAspect: this.w / this.h, ...feat,
      });
      this.state.swap();
    }
  }
  render(target: WebGLFramebuffer | null, w: number, h: number): void {
    bindTarget(this.gl, target, w, h);
    drawFullscreen(this.gl, this.pRender, {
      uState: this.state.read.tex,
      uTexel: [1 / this.w, 1 / this.h] as [number, number],
      uHue: this.res.matrix.get("global.baseHue"),
      uBright: this.res.matrix.get("global.brightness") - 1,
    });
  }
  dispose(): void { this.state?.dispose(); unregister(this.res.matrix.targets, this.id); }
}
