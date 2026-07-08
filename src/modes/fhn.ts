// fhn.ts — FitzHugh-Nagumo (famille CONTINUOUS, ping-pong).
// Média excitable : un onset = stimulation locale -> onde propagée + réfractaire
// -> spirales/ondes cibles. u=excitation, v=récupération.
import { makeProgram, drawFullscreen, bindTarget } from "../core/fullscreen";
import { PingPong } from "../core/pingpong";
import { registerParams, unregister, getParam } from "../modmatrix/targets";
import type { Mode, Resources } from "./Mode";
import type { BusFrame } from "../audio/bus";
import type { Viewport } from "../core/loop";

const SIM = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D uState; uniform vec2 uTexel;
uniform float uA,uB,uEps,uDu,uDv,uDt;
vec2 lap(vec2 p){
  vec2 c = texture(uState,p).xy;
  vec2 e = texture(uState,p+vec2(uTexel.x,0.)).xy + texture(uState,p-vec2(uTexel.x,0.)).xy
         + texture(uState,p+vec2(0.,uTexel.y)).xy + texture(uState,p-vec2(0.,uTexel.y)).xy;
  vec2 d = texture(uState,p+uTexel).xy + texture(uState,p-uTexel).xy
         + texture(uState,p+vec2(uTexel.x,-uTexel.y)).xy + texture(uState,p+vec2(-uTexel.x,uTexel.y)).xy;
  return e*0.2 + d*0.05 - c;
}
void main(){
  vec2 c = texture(uState,v_uv).xy; float u=c.x, v=c.y; vec2 L=lap(v_uv);
  float du = uDu*L.x + u - u*u*u/3.0 - v;
  float dv = uDv*L.y + uEps*(u + uA - uB*v);
  o = vec4(u + du*uDt, v + dv*uDt, 0., 1.);
}`;

const INJECT = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D uState; uniform vec2 uPos; uniform float uAmp,uRadius,uAspect;
void main(){
  vec2 c = texture(uState,v_uv).xy;
  vec2 d = v_uv - uPos; d.x *= uAspect;
  c.x += uAmp * exp(-dot(d,d)/uRadius);
  o = vec4(c, 0., 1.);
}`;

const SEED = `#version 300 es
in vec2 v_uv; out vec4 o;
void main(){
  float n = hash22(v_uv*97.0).x;
  o = vec4(-1.13 + (n>0.995 ? 1.6 : 0.0), -0.54, 0., 1.); // repos + rares germes
}`;

const RENDER = `#version 300 es
in vec2 v_uv; out vec4 o;
uniform sampler2D uState; uniform float uHue,uBright;
void main(){
  vec2 c = texture(uState,v_uv).xy;
  float d = smoothstep(-0.3, 1.2, c.x) * (0.25 + uBright);
  vec3 col = hue(uHue + c.y*0.12) * d;
  o = vec4(col, 1.);
}`;

export class FHNMode implements Mode {
  id = "fhn"; family = "continuous" as const;
  private gl!: WebGL2RenderingContext; private res!: Resources;
  private state!: PingPong; private w = 0; private h = 0;
  private pSim: any; private pInj: any; private pSeed: any; private pRender: any;
  private phase = 0;

  init(res: Resources, vp: Viewport): void {
    this.res = res; this.gl = res.gl;
    registerParams(res.matrix.targets, this.id, {
      a: 0.7, b: 0.8, epsilon: 0.08, Du: 1.0, Dv: 0.0, injRadius: 0.0016, injAmp: 1.2,
    }, { a: [0.5, 0.9], b: [0.4, 1.4], epsilon: [0.02, 0.2], Du: [0.2, 1.8], injAmp: [0, 3] });
    this.pSim = makeProgram(this.gl, SIM);
    this.pInj = makeProgram(this.gl, INJECT);
    this.pSeed = makeProgram(this.gl, SEED, { common: true });
    this.pRender = makeProgram(this.gl, RENDER, { common: true });
    this.resize(vp);
  }
  resize(vp: Viewport): void {
    this.w = vp.simW; this.h = vp.simH;
    this.state?.dispose();
    this.state = new PingPong(this.gl, this.w, this.h, this.gl.RGBA16F, this.gl.NEAREST, this.gl.REPEAT);
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
    const Du = getParam(m.targets, "fhn.params.Du", 1);
    const CFL_DT = Math.min(0.22 / Math.max(Du, 0.001), 0.25); // stabilité (Du·dt ≤ 0.22)
    const uni = { uTexel: [1 / this.w, 1 / this.h], uA: m.get("fhn.params.a"), uB: m.get("fhn.params.b"), uEps: m.get("fhn.params.epsilon"), uDu: Du, uDv: m.get("fhn.params.Dv"), uDt: CFL_DT };
    const SUB = 3;
    for (let s = 0; s < SUB; s++) {
      bindTarget(gl, this.state.write.fbo, this.w, this.h);
      drawFullscreen(gl, this.pSim, { uState: this.state.read.tex, ...uni });
      this.state.swap();
    }
    // injection gardée par l'onset (une par onset, position dérivée du beat/hash)
    if (fr.onsetFired) {
      this.phase += 0.31;
      const px = 0.5 + Math.cos(this.phase * 6.283) * 0.3;
      const py = 0.5 + Math.sin(this.phase * 4.7) * 0.3;
      bindTarget(gl, this.state.write.fbo, this.w, this.h);
      drawFullscreen(gl, this.pInj, { uState: this.state.read.tex, uPos: [px, py], uAmp: m.get("fhn.params.injAmp"), uRadius: m.get("fhn.params.injRadius"), uAspect: this.w / this.h });
      this.state.swap();
    }
  }
  render(target: WebGLFramebuffer | null, w: number, h: number): void {
    bindTarget(this.gl, target, w, h);
    drawFullscreen(this.gl, this.pRender, { uState: this.state.read.tex, uHue: this.res.matrix.get("global.baseHue"), uBright: this.res.matrix.get("global.brightness") - 1 });
  }
  dispose(): void { this.state?.dispose(); unregister(this.res.matrix.targets, this.id); }
}
