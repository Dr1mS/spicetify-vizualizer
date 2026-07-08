// aizawa.ts — attracteur d'Aizawa (3D projeté, famille DENSITY, accumulation additive).
// Système (Euler, dt~0.01) :
//   x' += dt*((z-b)*x - d*y)
//   y' += dt*(d*x + (z-b)*y)
//   z' += dt*(c + a*z - z^3/3 - (x^2+y^2)*(1+e*z) + f*z*x^3)
// Orbites RGB projetées (x,y) avec rotation temporelle. a et c pilotés par le spectre.
import { makeProgram, drawFullscreen, bindTarget } from "../core/fullscreen";
import { PingPong, createTarget, type Target } from "../core/pingpong";
import { registerParams, unregister } from "../modmatrix/targets";
import type { Mode, Resources } from "./Mode";
import type { BusFrame } from "../audio/bus";
import type { Viewport } from "../core/loop";

const ORBIT = 256; // 65 536 orbites
const SUBSTEPS = 6; // sous-pas d'Euler par frame (convergence + densité)

// Seed serré (x,y ∈ ~[-1,1], z ∈ ~[0,1]) : Euler diverge depuis un seed large.
const SEED = `#version 300 es
in vec2 v_uv; out vec4 o;
void main(){ vec2 h = hash22(v_uv*131.0);
  o = vec4((h.x - 0.5) * 2.0, (h.y - 0.5) * 2.0, hash11(dot(v_uv, vec2(53.7, 91.3))), 1.); }`;

// Intégration Euler + garde anti-explosion (NaN échoue le <, donc re-seed).
const STEP = `#version 300 es
in vec2 v_uv; out vec4 o;
uniform sampler2D uOrbit; uniform float uA,uB,uC,uD,uE,uF,uDt; uniform int uSub;
void main(){
  vec3 p = texture(uOrbit, v_uv).xyz;
  for (int i = 0; i < 32; i++) {
    if (i >= uSub) break;
    float x = p.x, y = p.y, z = p.z;
    float dx = (z - uB) * x - uD * y;
    float dy = uD * x + (z - uB) * y;
    float dz = uC + uA * z - z*z*z/3.0 - (x*x + y*y)*(1.0 + uE*z) + uF*z*x*x*x;
    p += uDt * vec3(dx, dy, dz);
  }
  if (!(dot(p, p) < 1e6)) {
    vec2 h = hash22(v_uv*131.0 + 7.0);
    p = vec3((h.x - 0.5) * 2.0, (h.y - 0.5) * 2.0, hash11(dot(v_uv, vec2(11.1, 47.9))));
  }
  o = vec4(p, 1.);
}`;

// Projection (x,y) avec rotation par le temps ; z -> décalage de teinte (orbites RGB).
const POINTS_VS = `#version 300 es
uniform sampler2D uOrbit; uniform int uSize; uniform float uScale, uRot;
out float vHue;
void main(){ int id=gl_VertexID; int x=id%uSize; int y=id/uSize;
  vec2 uv=(vec2(float(x),float(y))+0.5)/float(uSize);
  vec3 p = texture(uOrbit,uv).xyz;
  float cr = cos(uRot), sr = sin(uRot);
  vec2 q = vec2(cr*p.x - sr*p.y, sr*p.x + cr*p.y);
  vHue = p.z;
  gl_Position = vec4(q/uScale, 0., 1.); gl_PointSize = 1.0; }`;

const POINTS_FS = `#version 300 es
precision highp float; in float vHue; out vec4 o;
uniform vec3 uCol; uniform float uWeight, uHueSpan;
vec3 hueRGB(float h){ return 0.5 + 0.5*cos(6.2831853*(h + vec3(0.0, 0.33, 0.67))); }
void main(){
  // Teinte de base modulée par la profondeur z (orbites RGB), intensité = uWeight.
  vec3 c = mix(uCol, hueRGB(clamp(vHue*0.15, 0.0, 1.0)*uHueSpan), 0.5);
  o = vec4(c * uWeight, 1.0); }`;

const COPY = `#version 300 es
precision highp float; in vec2 v_uv; out vec4 o; uniform sampler2D uTex;
void main(){ o = texture(uTex, v_uv); }`;

export class AizawaMode implements Mode {
  id = "aizawa"; family = "density" as const;
  private gl!: WebGL2RenderingContext; private res!: Resources;
  private orbit!: PingPong; private accum!: Target; private w = 0; private h = 0;
  private pSeed: any; private pStep: any; private pPoints: any; private pCopy: any;
  private emptyVao!: WebGLVertexArrayObject;
  private time = 0; private jolt = 0; // état consommé au draw (rotation + jolt onset)

  init(res: Resources, vp: Viewport): void {
    this.res = res; this.gl = res.gl;
    // a,c pilotés par le spectre : plages étroites (ils décident si l'attracteur existe).
    registerParams(res.matrix.targets, this.id,
      { a: 0.95, b: 0.7, c: 0.6, d: 3.5, e: 0.25, f: 0.1, scale: 2.0, spin: 0.2 },
      { a: [0.7, 1.1], b: [0.5, 0.9], c: [0.3, 0.9], d: [3.0, 4.0], e: [0.1, 0.4], f: [0.0, 0.3], scale: [1.2, 3.0], spin: [0, 1.5] });
    this.pSeed = makeProgram(this.gl, SEED, { common: true });
    this.pStep = makeProgram(this.gl, STEP, { common: true });
    this.pPoints = makeProgram(this.gl, POINTS_FS, { vert: POINTS_VS });
    this.pCopy = makeProgram(this.gl, COPY);
    this.emptyVao = this.gl.createVertexArray()!;
    this.resize(vp);
  }
  resize(vp: Viewport): void {
    this.w = vp.simW; this.h = vp.simH;
    this.orbit?.dispose();
    this.orbit = new PingPong(this.gl, ORBIT, ORBIT, this.res.caps.simFormat);
    if (this.accum) { this.gl.deleteTexture(this.accum.tex); this.gl.deleteFramebuffer(this.accum.fbo); }
    this.accum = createTarget(this.gl, this.w, this.h, this.res.caps.accumFormat);
    this.reset();
  }
  reset(): void {
    this.time = 0; this.jolt = 0;
    bindTarget(this.gl, this.orbit.write.fbo, ORBIT, ORBIT);
    drawFullscreen(this.gl, this.pSeed, {});
    this.orbit.swap();
  }
  update(fr: BusFrame, dt: number, time: number): void {
    this.time = time;
    // Réaction directe aux onsets (rule 8) : jolt décroissant sur spin + teinte.
    if (fr.onsetFired) this.jolt = 1.0;
    this.jolt *= Math.exp(-(dt || 0.016) * 4.0);
    const m = this.res.matrix;
    bindTarget(this.gl, this.orbit.write.fbo, ORBIT, ORBIT);
    drawFullscreen(this.gl, this.pStep, {
      uOrbit: this.orbit.read.tex,
      uA: m.get("aizawa.params.a"), uB: m.get("aizawa.params.b"),
      uC: m.get("aizawa.params.c"), uD: m.get("aizawa.params.d"),
      uE: m.get("aizawa.params.e"), uF: m.get("aizawa.params.f"),
      uDt: 0.01, uSub: SUBSTEPS,
    });
    this.orbit.swap();
  }
  render(target: WebGLFramebuffer | null, w: number, h: number): void {
    const gl = this.gl;
    // accumulation additive des orbites projetées
    bindTarget(gl, this.accum.fbo, this.w, this.h);
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(this.pPoints.program);
    const P = this.pPoints.program;
    gl.uniform1i(gl.getUniformLocation(P, "uOrbit"), 0);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.orbit.read.tex);
    gl.uniform1i(gl.getUniformLocation(P, "uSize"), ORBIT);
    gl.uniform1f(gl.getUniformLocation(P, "uScale"), this.res.matrix.get("aizawa.params.scale") || 2.0);
    // rotation temporelle : spin (param) + jolt d'onset
    const spin = this.res.matrix.get("aizawa.params.spin");
    gl.uniform1f(gl.getUniformLocation(P, "uRot"), this.time * (spin + 0.05) + this.jolt * 1.5);
    const hueBase = this.res.matrix.get("global.baseHue");
    const col = hueRGB(hueBase);
    gl.uniform3f(gl.getUniformLocation(P, "uCol"), col[0], col[1], col[2]);
    gl.uniform1f(gl.getUniformLocation(P, "uWeight"), 0.03 + this.jolt * 0.02);
    gl.uniform1f(gl.getUniformLocation(P, "uHueSpan"), 1.0);
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
