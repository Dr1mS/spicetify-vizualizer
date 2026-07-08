// buddhabrot.ts — Buddhabrot / Nebulabrot (famille DENSITY, accumulation additive).
// Rendu probabiliste des trajectoires d'échappement de Mandelbrot.
// Orbites en RGBA32F : (cx, cy, zx, zy). c est un point aléatoire du plan complexe,
// z itère z = z² + c. On ACCUMULE la position z de CHAQUE orbite à chaque frame.
// À l'échappée (|z|>2) OU après un tirage aléatoire (borne d'itérations statistique),
// on RESEED c à un nouveau point aléatoire, z=0. Ainsi seules les trajectoires qui
// finissent par s'échapper contribuent continuellement -> la nébuleuse 'buddha' émerge.
// Audio : la RÉGION (offset de c) et la teinte pilotées par le spectre ; onset = pulse.
import { makeProgram, drawFullscreen, bindTarget } from "../core/fullscreen";
import { PingPong, createTarget, type Target } from "../core/pingpong";
import { registerParams, unregister } from "../modmatrix/targets";
import type { Mode, Resources } from "./Mode";
import type { BusFrame } from "../audio/bus";
import type { Viewport } from "../core/loop";

const ORBIT = 256; // 65 536 orbites

// SEED : c aléatoire dans [-2,1]×[-1.2,1.2] (hash22 de uv), z=0. {common:true}.
const SEED = `#version 300 es
in vec2 v_uv; out vec4 o;
void main(){
  vec2 h = hash22(v_uv * 131.0 + 7.0);
  vec2 c = vec2(mix(-2.0, 1.0, h.x), mix(-1.2, 1.2, h.y));
  o = vec4(c, 0.0, 0.0); // (cx,cy,zx,zy) ; z=0
}`;

// STEP : z = z² + c (complexe). Reseed si |z|>2 (échappée), si tirage aléatoire
// (borne d'itérations statistique -> évite les points prisonniers de l'ensemble),
// ou si NaN/Inf. Reseed = nouveau c aléatoire fonction de (uv, uTime), z=0.
// {common:true} -> hash22/TAU déjà présents, ne pas redéclarer precision/hash.
const STEP = `#version 300 es
in vec2 v_uv; out vec4 o;
uniform sampler2D uOrbit;
uniform float uTime;    // varié chaque frame (seed du reseed)
uniform float uReseed;  // proba de reseed par frame (borne d'itérations)
uniform vec2  uOffset;  // décalage audio de la région c
void main(){
  vec4 s = texture(uOrbit, v_uv);
  vec2 c = s.xy;
  vec2 z = s.zw;
  // z = z² + c  (complexe : zx'=zx²-zy²+cx, zy'=2·zx·zy+cy)
  vec2 zn = vec2(z.x*z.x - z.y*z.y + c.x, 2.0*z.x*z.y + c.y);
  float r2 = dot(zn, zn);
  // tirage de reseed (indépendant par frame via uTime)
  float roll = hash22(v_uv * 71.3 + uTime * vec2(1.7, 2.9)).x;
  bool escaped = r2 > 4.0;
  bool bad = !(r2 == r2) || r2 > 1.0e12; // NaN/Inf guard
  bool aged = roll < uReseed;
  if (escaped || bad || aged) {
    vec2 h = hash22(v_uv * 131.0 + uTime * vec2(3.1, 5.7) + 13.0);
    vec2 nc = vec2(mix(-2.0, 1.0, h.x), mix(-1.2, 1.2, h.y)) + uOffset;
    o = vec4(nc, 0.0, 0.0);
  } else {
    o = vec4(c, zn);
  }
}`;

// POINTS (vertex) : chaque orbite -> un point à sa position z courante, mappée écran.
// Échelle ~/2.2 et léger décalage x pour centrer la nébuleuse (le buddha est décalé).
const POINTS_VS = `#version 300 es
uniform sampler2D uOrbit; uniform int uSize;
uniform float uScale; uniform vec2 uCenter;
void main(){
  int id = gl_VertexID; int x = id % uSize; int y = id / uSize;
  vec2 uv = (vec2(float(x), float(y)) + 0.5) / float(uSize);
  vec2 z = texture(uOrbit, uv).zw;
  vec2 p = (z - uCenter) / uScale;
  gl_Position = vec4(p, 0.0, 1.0);
  gl_PointSize = 1.0;
}`;

// POINTS (fragment) : contribution additive colorée (teinte via uCol).
const POINTS_FS = `#version 300 es
precision highp float; out vec4 o; uniform vec3 uCol;
void main(){ o = vec4(uCol, 1.0); }`;

// COPY : densité accumulée -> target (main.ts tonemappe).
const COPY = `#version 300 es
precision highp float; in vec2 v_uv; out vec4 o; uniform sampler2D uTex;
void main(){ o = texture(uTex, v_uv); }`;

export class BuddhabrotMode implements Mode {
  id = "buddhabrot"; family = "density" as const;
  private gl!: WebGL2RenderingContext; private res!: Resources;
  private orbit!: PingPong; private accum!: Target; private w = 0; private h = 0;
  private pSeed: any; private pStep: any; private pPoints: any; private pCopy: any;
  private emptyVao!: WebGLVertexArrayObject;
  private time = 0; private pulse = 0;

  init(res: Resources, vp: Viewport): void {
    this.res = res; this.gl = res.gl;
    registerParams(res.matrix.targets, this.id, {
      scale: 2.2, reseed: 0.02, melWarp: 0.35, hue: 0.0, gain: 0.9,
    }, {
      scale: [1.2, 4.0], reseed: [0.003, 0.15], melWarp: [0.0, 1.2], hue: [0.0, 1.0], gain: [0.3, 2.0],
    });
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
    this.orbit = new PingPong(this.gl, ORBIT, ORBIT, this.gl.RGBA32F);
    if (this.accum) { this.gl.deleteTexture(this.accum.tex); this.gl.deleteFramebuffer(this.accum.fbo); }
    this.accum = createTarget(this.gl, this.w, this.h, this.res.caps.accumFormat);
    this.reset();
  }

  reset(): void {
    bindTarget(this.gl, this.orbit.write.fbo, ORBIT, ORBIT);
    drawFullscreen(this.gl, this.pSeed, {});
    this.orbit.swap();
    this.pulse = 0;
  }

  update(fr: BusFrame, dt: number, time: number): void {
    const m = this.res.matrix; const gl = this.gl;
    this.time = time;
    // décroissance du pulse d'onset (borné)
    const d = Math.min(Math.max(dt, 0), 0.1);
    this.pulse = Math.max(0, this.pulse - d * 3.0);
    if (fr.onsetFired) this.pulse = Math.min(1.5, this.pulse + 0.9);

    // RÉACTIVITÉ audio : le spectre décale la région c échantillonnée -> la nébuleuse
    // se déforme/dérive au rythme. mel grave -> x, mel aigu -> y.
    const melWarp = m.get("buddhabrot.params.melWarp");
    const beat = fr.beatPhase; // 0..1, phase du beat
    const bass = this.melAvg(fr, 0.0, 0.2);  // bandes graves
    const high = this.melAvg(fr, 0.6, 1.0);  // bandes aiguës
    const ox = melWarp * (bass - 0.15) * 0.6 + Math.cos(beat * 6.2831) * 0.03 * melWarp;
    const oy = melWarp * (high - 0.1) * 0.6;

    // pas d'itération de toutes les orbites (z = z² + c, reseed géré côté shader)
    bindTarget(gl, this.orbit.write.fbo, ORBIT, ORBIT);
    drawFullscreen(gl, this.pStep, {
      uOrbit: this.orbit.read.tex,
      uTime: time,
      uReseed: m.get("buddhabrot.params.reseed"),
      uOffset: [ox, oy] as [number, number],
    });
    this.orbit.swap();
  }

  // moyenne d'une plage normalisée [x0,x1] du spectre mel (0..1).
  // MEL[0..31] = feat indices 19..50 (F.MEL0=19, MEL_COUNT=32).
  private melAvg(fr: BusFrame, x0: number, x1: number): number {
    const MEL0 = 19, N = 32;
    const i0 = Math.max(0, Math.min(N - 1, Math.floor(x0 * (N - 1))));
    const i1 = Math.max(i0, Math.min(N - 1, Math.floor(x1 * (N - 1))));
    let s = 0;
    for (let i = i0; i <= i1; i++) s += fr.feat[MEL0 + i] || 0;
    const v = s / (i1 - i0 + 1);
    return Math.max(0, Math.min(1, v));
  }

  render(target: WebGLFramebuffer | null, w: number, h: number): void {
    const gl = this.gl;
    // accumulation additive des positions z de toutes les orbites
    bindTarget(gl, this.accum.fbo, this.w, this.h);
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(this.pPoints.program);
    gl.uniform1i(gl.getUniformLocation(this.pPoints.program, "uOrbit"), 0);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.orbit.read.tex);
    gl.uniform1i(gl.getUniformLocation(this.pPoints.program, "uSize"), ORBIT);
    const m = this.res.matrix;
    const scale = m.get("buddhabrot.params.scale") || 2.2;
    gl.uniform1f(gl.getUniformLocation(this.pPoints.program, "uScale"), scale);
    // buddha centré : l'ensemble s'étale ~[-2,0.6] en x -> centre décalé
    gl.uniform2f(gl.getUniformLocation(this.pPoints.program, "uCenter"), -0.55, 0.0);
    // couleur : teinte de base + param hue ; intensité pulsée par l'onset
    const hueBase = m.get("global.baseHue") + m.get("buddhabrot.params.hue");
    const col = hueRGB(hueBase);
    const gain = (m.get("buddhabrot.params.gain") || 0.9) * (1.0 + this.pulse * 0.8);
    const c = 0.03 * gain; // contribution/point ~0.03 (beaucoup d'accumulation)
    gl.uniform3f(gl.getUniformLocation(this.pPoints.program, "uCol"), col[0] * c, col[1] * c, col[2] * c);
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
