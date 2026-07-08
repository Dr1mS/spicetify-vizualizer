// chladni.ts — figures de Chladni / cymatique (famille DENSITY, DIRECT).
// Densité(x,y) = motif de plaque = Σ_k w_k · cos(n_k·π·x)·cos(m_k·π·y), les
// poids w_k étant les bandes mel présentes (piloté LITTÉRALEMENT par le spectre).
// Les lignes NODALES (motif ≈ 0) sont éclairées : d = pow(1 - |motif|, P).
// Pas de ping-pong, pas d'accumulation : un seul frag plein écran vers target.
import { makeProgram, drawFullscreen, bindTarget } from "../core/fullscreen";
import { registerParams, unregister } from "../modmatrix/targets";
import { MEL_COUNT } from "../audio/constants";
import type { Mode, Resources } from "./Mode";
import type { BusFrame } from "../audio/bus";
import type { Viewport } from "../core/loop";

// {common:true} -> precision + hue/u_mel/u_melf/u_feat/u_melCount/TAU déjà
// prépendus (NE PAS redéclarer). PI n'est PAS dans common.glsl -> local.
const RENDER = `#version 300 es
in vec2 v_uv; out vec4 o;
uniform float uPower, uWarp, uMelGain, uAnim, uPulse, uHue, uBright, uTime, uAspect;

const float PI = 3.14159265;
// 8 modes (n,m) entiers croissants : de plus en plus de lignes nodales.
const int NMODES = 8;
const vec2 MODES[8] = vec2[8](
  vec2(1.0, 2.0), vec2(2.0, 3.0), vec2(3.0, 5.0), vec2(4.0, 5.0),
  vec2(5.0, 7.0), vec2(6.0, 7.0), vec2(7.0, 9.0), vec2(8.0, 11.0)
);

void main(){
  // repère centré [-1..1], corrigé de l'aspect (figures carrées sur 16:9).
  vec2 p = v_uv * 2.0 - 1.0;
  p.x *= uAspect;
  // léger warp/zoom respirant + animation de phase très lente.
  float s = 1.0 + 0.15 * sin(uTime * 0.11) + uWarp;
  vec2 xy = p * s;
  float x = xy.x * 0.5 + 0.5;
  float y = xy.y * 0.5 + 0.5;

  float motif = 0.0;
  float wsum = 1e-3;
  for (int k = 0; k < NMODES; k++){
    vec2 nm = MODES[k];
    // poids = bande mel correspondante (étalée sur 0..1) + socle constant.
    float band = u_melf(float(k) / float(NMODES - 1));
    float w = 0.04 + band * uMelGain;
    // phase animée : les figures ondulent avec le temps.
    float ph = uAnim * uTime * (0.3 + 0.05 * float(k));
    motif += w * cos(nm.x * PI * x + ph) * cos(nm.y * PI * y - ph);
    wsum += w;
  }
  motif /= wsum; // motif ∈ [-1,1] : le spectre morphe la FORME (contraste stable).

  // lignes nodales éclairées ; l'onset (uPulse) affûte + illumine.
  float P = uPower + uPulse * 6.0;
  float d = pow(clamp(1.0 - abs(motif), 0.0, 1.0), P);
  d *= (0.5 + uBright) + uPulse * 0.6;

  // couleur = teinte de base, sortie = densité colorée (main.ts tonemappe).
  vec3 col = hue(uHue + motif * 0.08) * d;
  o = vec4(col, 1.0);
}`;

export class ChladniMode implements Mode {
  id = "chladni"; family = "density" as const;
  private gl!: WebGL2RenderingContext; private res!: Resources;
  private w = 0; private h = 0;
  private pRender: any;
  private time = 0; private pulse = 0;

  init(res: Resources, vp: Viewport): void {
    this.res = res; this.gl = res.gl;
    registerParams(res.matrix.targets, this.id,
      { power: 8.0, warp: 0.0, melGain: 1.6, anim: 1.0 },
      { power: [2, 24], warp: [-0.4, 0.8], melGain: [0, 4], anim: [0, 3] });
    this.pRender = makeProgram(this.gl, RENDER, { common: true });
    this.resize(vp);
  }
  resize(vp: Viewport): void {
    this.w = vp.simW; this.h = vp.simH;
    this.reset();
  }
  reset(): void {
    this.pulse = 0;
  }
  update(fr: BusFrame, dt: number, time: number): void {
    this.time = time;
    // onset -> flash d'intensité + affûtage des lignes nodales, puis décroissance.
    if (fr.onsetFired) this.pulse = 1.0;
    this.pulse *= Math.exp(-dt * 6.0);
  }
  render(target: WebGLFramebuffer | null, w: number, h: number): void {
    const gl = this.gl; const m = this.res.matrix;
    bindTarget(gl, target, w, h);
    drawFullscreen(gl, this.pRender, {
      uPower: m.get("chladni.params.power"),
      uWarp: m.get("chladni.params.warp"),
      uMelGain: m.get("chladni.params.melGain"),
      uAnim: m.get("chladni.params.anim"),
      uPulse: this.pulse,
      uHue: m.get("global.baseHue"),
      uBright: m.get("global.brightness") - 1,
      uTime: this.time,
      uAspect: this.h > 0 ? this.w / this.h : 1,
      // u_feat + u_melCount pour u_mel/u_melf (feat.update() a déjà tourné cette frame).
      u_feat: this.res.feat.tex,
      u_melCount: MEL_COUNT,
    });
  }
  dispose(): void { unregister(this.res.matrix.targets, this.id); }
}
