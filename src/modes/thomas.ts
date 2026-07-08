// thomas.ts — attracteur de Thomas (flot 3D symétrique cyclique, famille DENSITY).
// Intégration d'Euler : x += dt·(sin(y) − b·x) ; y += dt·(sin(z) − b·y) ; z += dt·(sin(x) − b·z).
// Chaque orbite est un point 3D projeté en 2D (rotation lente uRot) et accumulé en additif.
// Couleur par coordonnée (x,y,z) -> RGB, teintée par global.baseHue. main.ts tonemappe.
import { makeProgram, drawFullscreen, bindTarget } from "../core/fullscreen";
import { PingPong, createTarget, type Target } from "../core/pingpong";
import { registerParams, unregister } from "../modmatrix/targets";
import type { Mode, Resources } from "./Mode";
import type { BusFrame } from "../audio/bus";
import type { Viewport } from "../core/loop";

const ORBIT = 256; // 65 536 orbites

// SEED : {common:true} -> hash11/hash22 dispo, PAS de precision ni redéclaration.
const SEED = `#version 300 es
in vec2 v_uv; out vec4 o;
void main(){
  vec2 h = hash22(v_uv * 131.0);
  float z = hash11(dot(v_uv, vec2(311.7, 127.1)));
  o = vec4((h - 0.5) * 4.0, (z - 0.5) * 4.0, 1.0);
}`;

// STEP : intégrateur (lit l'état précédent, ajoute l'incrément d'Euler). SANS common.
const STEP = `#version 300 es
precision highp float; in vec2 v_uv; out vec4 o;
uniform sampler2D uOrbit; uniform float uDt, uB;
void main(){
  vec3 p = texture(uOrbit, v_uv).xyz;
  p.x += uDt * (sin(p.y) - uB * p.x);
  p.y += uDt * (sin(p.z) - uB * p.y);
  p.z += uDt * (sin(p.x) - uB * p.z);
  o = vec4(p, 1.0);
}`;

// POINTS_VS : projette (x,y) après rotation uRot, colore par (x,y,z). SANS common.
const POINTS_VS = `#version 300 es
precision highp float;
uniform sampler2D uOrbit; uniform int uSize; uniform float uScale, uRot, uHue;
out vec3 vCol;
vec3 hueRGB(float t){ return 0.5 + 0.5 * cos(6.2831853 * (t + vec3(0.0, 0.33, 0.67))); }
void main(){
  int id = gl_VertexID; int x = id % uSize; int y = id / uSize;
  vec2 uv = (vec2(float(x), float(y)) + 0.5) / float(uSize);
  vec3 p = texture(uOrbit, uv).xyz;
  float cr = cos(uRot), sr = sin(uRot);
  vec2 q = mat2(cr, -sr, sr, cr) * p.xy;
  gl_Position = vec4(q / uScale, 0.0, 1.0);
  gl_PointSize = 1.4;
  // teinte de base (baseHue) modulée par la coordonnée z pour la profondeur
  vec3 base = hueRGB(uHue);
  vec3 depth = 0.5 + 0.5 * (p / uScale);
  vCol = base * depth;
}`;

const POINTS_FS = `#version 300 es
precision highp float; in vec3 vCol; out vec4 o; uniform float uGain;
void main(){ o = vec4(vCol * uGain, 1.0); }`;

const COPY = `#version 300 es
precision highp float; in vec2 v_uv; out vec4 o; uniform sampler2D uTex;
void main(){ o = texture(uTex, v_uv); }`;

export class ThomasMode implements Mode {
  id = "thomas"; family = "density" as const;
  private gl!: WebGL2RenderingContext; private res!: Resources;
  private orbit!: PingPong; private accum!: Target; private w = 0; private h = 0;
  private rot = 0;
  private pSeed: any; private pStep: any; private pPoints: any; private pCopy: any;
  private emptyVao!: WebGLVertexArrayObject;

  init(res: Resources, vp: Viewport): void {
    this.res = res; this.gl = res.gl;
    registerParams(res.matrix.targets, this.id,
      { dt: 0.15, b: 0.19, scale: 6.0, rotSpeed: 0.15, gain: 0.20 },
      { dt: [0.05, 0.3], b: [0.10, 0.35], scale: [3.0, 9.0], rotSpeed: [0.0, 1.0], gain: [0.03, 0.22] });
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
    this.orbit = new PingPong(this.gl, ORBIT, ORBIT, this.res.caps.simFormat);
    if (this.accum) { this.gl.deleteTexture(this.accum.tex); this.gl.deleteFramebuffer(this.accum.fbo); }
    this.accum = createTarget(this.gl, this.w, this.h, this.res.caps.accumFormat);
    this.reset();
  }

  reset(): void {
    this.rot = 0;
    bindTarget(this.gl, this.orbit.write.fbo, ORBIT, ORBIT);
    drawFullscreen(this.gl, this.pSeed, {});
    this.orbit.swap();
  }

  update(_fr: BusFrame, dt: number, _time: number): void {
    const m = this.res.matrix;
    // rotation lente accumulée (modulable via thomas.params.rotSpeed)
    this.rot += dt * m.get("thomas.params.rotSpeed");
    // pas d'intégration du flot de Thomas (uDt = param fixe ~0.15, PAS le dt de frame)
    bindTarget(this.gl, this.orbit.write.fbo, ORBIT, ORBIT);
    drawFullscreen(this.gl, this.pStep, {
      uOrbit: this.orbit.read.tex,
      uDt: m.get("thomas.params.dt"),
      uB: m.get("thomas.params.b"),
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
    gl.uniform1i(gl.getUniformLocation(this.pPoints.program, "uOrbit"), 0);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.orbit.read.tex);
    gl.uniform1i(gl.getUniformLocation(this.pPoints.program, "uSize"), ORBIT);
    gl.uniform1f(gl.getUniformLocation(this.pPoints.program, "uScale"), this.res.matrix.get("thomas.params.scale") || 6.0);
    gl.uniform1f(gl.getUniformLocation(this.pPoints.program, "uRot"), this.rot);
    gl.uniform1f(gl.getUniformLocation(this.pPoints.program, "uHue"), this.res.matrix.get("global.baseHue"));
    gl.uniform1f(gl.getUniformLocation(this.pPoints.program, "uGain"), this.res.matrix.get("thomas.params.gain") || 0.20);
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
