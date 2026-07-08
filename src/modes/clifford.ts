// clifford.ts — attracteur de Clifford (famille DENSITY, accumulation additive).
// x' = sin(a·y) + c·cos(a·x) ; y' = sin(b·x) + d·cos(b·y).
// a,b sont des fréquences (morphées fort par le spectre) ; c,d des amplitudes
// (morphées doucement). Bases a=-1.4, b=1.6, c=1.0, d=0.7. Même structure
// orbites + accumulation additive que dejong.ts.
import { makeProgram, drawFullscreen, bindTarget } from "../core/fullscreen";
import { PingPong, createTarget, type Target } from "../core/pingpong";
import { registerParams, unregister } from "../modmatrix/targets";
import type { Mode, Resources } from "./Mode";
import type { BusFrame } from "../audio/bus";
import type { Viewport } from "../core/loop";

const ORBIT = 256; // 65 536 orbites

const SEED = `#version 300 es
in vec2 v_uv; out vec4 o;
void main(){ vec2 h = hash22(v_uv*131.0); o = vec4((h - 0.5) * 4.0, 0., 1.); }`;

const STEP = `#version 300 es
precision highp float; in vec2 v_uv; out vec4 o;
uniform sampler2D uOrbit; uniform float uA,uB,uC,uD;
void main(){ vec2 p = texture(uOrbit,v_uv).xy;
  o = vec4(sin(uA*p.y) + uC*cos(uA*p.x), sin(uB*p.x) + uD*cos(uB*p.y), 0., 1.); }`;

const POINTS_VS = `#version 300 es
uniform sampler2D uOrbit; uniform int uSize; uniform float uScale;
void main(){ int id=gl_VertexID; int x=id%uSize; int y=id/uSize;
  vec2 uv=(vec2(float(x),float(y))+0.5)/float(uSize);
  vec2 p = texture(uOrbit,uv).xy;
  gl_Position = vec4(p/uScale, 0., 1.); gl_PointSize = 1.0; }`;

const POINTS_FS = `#version 300 es
precision highp float; out vec4 o; uniform vec3 uCol;
void main(){ o = vec4(uCol, 1.0); }`;

const COPY = `#version 300 es
precision highp float; in vec2 v_uv; out vec4 o; uniform sampler2D uTex;
void main(){ o = texture(uTex, v_uv); }`;

export class CliffordMode implements Mode {
  id = "clifford"; family = "density" as const;
  private gl!: WebGL2RenderingContext; private res!: Resources;
  private orbit!: PingPong; private accum!: Target; private w = 0; private h = 0;
  private pSeed: any; private pStep: any; private pPoints: any; private pCopy: any;
  private emptyVao!: WebGLVertexArrayObject;

  init(res: Resources, vp: Viewport): void {
    this.res = res; this.gl = res.gl;
    registerParams(res.matrix.targets, this.id,
      { a: -1.4, b: 1.6, c: 1.0, d: 0.7, warp: 0, scale: 2.0, hue: 0 },
      { a: [-3, 3], b: [-3, 3], c: [0, 1.5], d: [0, 1.5], warp: [0, 1], scale: [1.2, 3] });
    this.pSeed = makeProgram(this.gl, SEED, { common: true });
    this.pStep = makeProgram(this.gl, STEP);
    this.pPoints = makeProgram(this.gl, POINTS_FS, { vert: POINTS_VS });
    this.pCopy = makeProgram(this.gl, COPY);
    this.emptyVao = this.gl.createVertexArray()!;
    this.resize(vp);
  }
  resize(vp: Viewport): void {
    this.w = vp.simW; this.h = vp.simH;
    this.orbit?.dispose();
    this.orbit = new PingPong(this.gl, ORBIT, ORBIT, this.gl.RGBA32F);
    if (this.accum) { this.gl.deleteTexture(this.accum.tex); this.gl.deleteFramebuffer(this.accum.fbo); }
    this.accum = createTarget(this.gl, this.w, this.h, this.res.caps.accumFormat);
    this.reset();
  }
  reset(): void {
    bindTarget(this.gl, this.orbit.write.fbo, ORBIT, ORBIT);
    drawFullscreen(this.gl, this.pSeed, {});
    this.orbit.swap();
  }
  update(_fr: BusFrame): void {
    const m = this.res.matrix; const warp = m.get("clifford.params.warp");
    // warp (piloté par les onsets) module les FRÉQUENCES a,b uniquement — jamais
    // les amplitudes c,d (elles agrandiraient l'étendue et déborderaient scale).
    bindTarget(this.gl, this.orbit.write.fbo, ORBIT, ORBIT);
    drawFullscreen(this.gl, this.pStep, {
      uOrbit: this.orbit.read.tex,
      uA: m.get("clifford.params.a") + warp, uB: m.get("clifford.params.b") - warp,
      uC: m.get("clifford.params.c"), uD: m.get("clifford.params.d"),
    });
    this.orbit.swap();
  }
  render(target: WebGLFramebuffer | null, w: number, h: number): void {
    const gl = this.gl;
    // accumulation additive des orbites
    bindTarget(gl, this.accum.fbo, this.w, this.h);
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(this.pPoints.program);
    // uniforms manuels (draw de points sans quad plein écran)
    gl.uniform1i(gl.getUniformLocation(this.pPoints.program, "uOrbit"), 0);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.orbit.read.tex);
    gl.uniform1i(gl.getUniformLocation(this.pPoints.program, "uSize"), ORBIT);
    gl.uniform1f(gl.getUniformLocation(this.pPoints.program, "uScale"), this.res.matrix.get("clifford.params.scale") || 2.0);
    const hueBase = this.res.matrix.get("global.baseHue");
    const col = hueRGB(hueBase);
    gl.uniform3f(gl.getUniformLocation(this.pPoints.program, "uCol"), col[0] * 0.09, col[1] * 0.09, col[2] * 0.09);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.POINTS, 0, ORBIT * ORBIT);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
    // copie densité -> target (main tonemappe)
    bindTarget(gl, target, w, h);
    drawFullscreen(gl, this.pCopy, { uTex: this.accum.tex });
  }
  dispose(): void {
    this.orbit?.dispose();
    if (this.accum) { this.gl.deleteTexture(this.accum.tex); this.gl.deleteFramebuffer(this.accum.fbo); }
    unregister(this.res.matrix.targets, this.id);
  }
}

function hueRGB(h: number): [number, number, number] {
  const f = (p: number) => 0.5 + 0.5 * Math.cos(2 * Math.PI * (h + p));
  return [f(0), f(0.33), f(0.67)];
}
