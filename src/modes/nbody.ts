// nbody.ts — N-body gravitationnel (famille DENSITY, accumulation à décroissance).
// État = orbites RGBA32F : position xy dans ~[-1,1], vélocité zw.
// Update (frag) : gravité vers 2..4 MASSES (uMass[4] positions, uMassW[4] forces) :
//   accel = Σ G·w·dir/(r²+soft) ; vel = vel·damping + accel·dt ; pos += vel·dt ; wrap doux aux bords.
// Les MASSES sont spawnées CÔTÉ CPU sur les onsets (fr.onsetFired) à des positions pilotées
// par le beat/hash, avec une force qui décroît. Un beat = injection d'énergie (masse forte brève).
// Rendu : points additifs colorés par la vitesse (hue(baseHue + speed)), accumulés avec
// décroissance (~0.9) pour des traînées. main.ts tonemappe la densité colorée.
import { makeProgram, drawFullscreen, bindTarget } from "../core/fullscreen";
import { PingPong } from "../core/pingpong";
import { registerParams, unregister } from "../modmatrix/targets";
import { F } from "../audio/constants";
import type { Mode, Resources } from "./Mode";
import type { BusFrame } from "../audio/bus";
import type { Viewport } from "../core/loop";

const ORBIT = 256; // 65 536 particules
const NMASS = 4; // nombre de masses gravitationnelles

// SEED : {common:true} -> hash11/hash22 dispo, PAS de precision ni redéclaration.
// pos xy dans [-1,1], vel zw petite (impulsion initiale aléatoire).
const SEED = `#version 300 es
in vec2 v_uv; out vec4 o;
void main(){
  vec2 p = hash22(v_uv * 131.0) * 2.0 - 1.0;
  vec2 v = (hash22(v_uv * 57.0 + 7.0) - 0.5) * 0.20;
  o = vec4(p, v);
}`;

// STEP : intégrateur gravitationnel. SANS common (precision explicite ; pas de helper).
// uMass : 4 positions (vec2). uMassW : 4 forces. Softening obligatoire (r²+soft).
const STEP = `#version 300 es
precision highp float; in vec2 v_uv; out vec4 o;
uniform sampler2D uOrbit;
uniform vec2 uMass[4];
uniform float uMassW[4];
uniform float uG, uDamp, uDt, uSoft, uVmax;
void main(){
  vec4 s = texture(uOrbit, v_uv);
  vec2 pos = s.xy;
  vec2 vel = s.zw;
  vec2 acc = vec2(0.0);
  for (int i = 0; i < 4; i++) {
    vec2 d = uMass[i] - pos;
    float r2 = dot(d, d) + uSoft;
    float inv = inversesqrt(r2);      // 1/r
    vec2 dir = d * inv;               // direction normalisée
    acc += (uG * uMassW[i] * inv * inv) * dir; // G·w/r² · dir
  }
  vel = vel * uDamp + acc * uDt;
  // clamp de la vitesse (évite les explosions / NaN)
  float sp = length(vel);
  if (sp > uVmax) vel *= uVmax / sp;
  pos += vel * uDt;
  // rebond doux aux bords (garde les particules dans le cadre)
  if (pos.x >  1.0) { pos.x =  1.0; vel.x = -abs(vel.x) * 0.6; }
  if (pos.x < -1.0) { pos.x = -1.0; vel.x =  abs(vel.x) * 0.6; }
  if (pos.y >  1.0) { pos.y =  1.0; vel.y = -abs(vel.y) * 0.6; }
  if (pos.y < -1.0) { pos.y = -1.0; vel.y =  abs(vel.y) * 0.6; }
  o = vec4(pos, vel);
}`;

// POINTS_VS : lit l'orbite, projette, colore par la vitesse. SANS common.
const POINTS_VS = `#version 300 es
precision highp float;
uniform sampler2D uOrbit; uniform int uSize; uniform float uScale, uHue, uSpeedGain;
out vec3 vCol;
vec3 hueRGB(float t){ return 0.5 + 0.5 * cos(6.2831853 * (t + vec3(0.0, 0.33, 0.67))); }
void main(){
  int id = gl_VertexID; int x = id % uSize; int y = id / uSize;
  vec2 uv = (vec2(float(x), float(y)) + 0.5) / float(uSize);
  vec4 s = texture(uOrbit, uv);
  vec2 pos = s.xy;
  float sp = length(s.zw);
  gl_Position = vec4(pos / uScale, 0.0, 1.0);
  gl_PointSize = 1.5;
  // teinte de base décalée par la vitesse (les rapides tirent vers l'autre bout de la palette)
  vCol = hueRGB(uHue + sp * uSpeedGain);
}`;

const POINTS_FS = `#version 300 es
precision highp float; in vec3 vCol; out vec4 o; uniform float uGain;
void main(){ o = vec4(vCol * uGain, 1.0); }`;

// DECAY : copie l'accumulation précédente atténuée (traînées). SANS common.
const DECAY = `#version 300 es
precision highp float; in vec2 v_uv; out vec4 o; uniform sampler2D uTex; uniform float uDecay;
void main(){ o = texture(uTex, v_uv) * uDecay; }`;

const COPY = `#version 300 es
precision highp float; in vec2 v_uv; out vec4 o; uniform sampler2D uTex;
void main(){ o = texture(uTex, v_uv); }`;

export class NBodyMode implements Mode {
  id = "nbody"; family = "density" as const;
  private gl!: WebGL2RenderingContext; private res!: Resources;
  private orbit!: PingPong; private accum!: PingPong; private w = 0; private h = 0;
  private pSeed: any; private pStep: any; private pPoints: any; private pDecay: any; private pCopy: any;
  private emptyVao!: WebGLVertexArrayObject;
  // masses CPU : positions (4×vec2 aplaties) et forces (4×float), avec durée de vie.
  private massPos = new Float32Array(NMASS * 2);
  private massW = new Float32Array(NMASS);
  private massLife = new Float32Array(NMASS);
  private massMax = new Float32Array(NMASS); // force initiale (pour la décroissance)
  private spawnCursor = 0;
  private time = 0;

  init(res: Resources, vp: Viewport): void {
    this.res = res; this.gl = res.gl;
    registerParams(res.matrix.targets, this.id,
      { g: 0.35, damp: 0.985, dt: 0.020, soft: 0.02, vmax: 3.0,
        scale: 1.15, gain: 0.12, decay: 0.90, speedGain: 0.25, massForce: 1.0 },
      { g: [0.05, 1.2], damp: [0.95, 0.999], dt: [0.005, 0.05], soft: [0.005, 0.1], vmax: [1.0, 6.0],
        scale: [0.8, 2.0], gain: [0.04, 0.22], decay: [0.80, 0.97], speedGain: [0.0, 0.8], massForce: [0.3, 3.0] });
    this.pSeed = makeProgram(this.gl, SEED, { common: true });
    this.pStep = makeProgram(this.gl, STEP);
    this.pPoints = makeProgram(this.gl, POINTS_FS, { vert: POINTS_VS });
    this.pDecay = makeProgram(this.gl, DECAY);
    this.pCopy = makeProgram(this.gl, COPY);
    this.emptyVao = this.gl.createVertexArray()!;
    this.resize(vp);
  }

  resize(vp: Viewport): void {
    this.w = vp.simW; this.h = vp.simH;
    this.orbit?.dispose();
    this.orbit = new PingPong(this.gl, ORBIT, ORBIT, this.res.caps.simFormat);
    this.accum?.dispose();
    this.accum = new PingPong(this.gl, this.w, this.h, this.res.caps.accumFormat);
    this.reset();
  }

  reset(): void {
    this.time = 0;
    // masses initiales : deux masses fixes légères (le système ne part pas mort avant le 1er onset).
    this.massPos.fill(0);
    this.massW.fill(0);
    this.massLife.fill(0);
    this.massMax.fill(0);
    this.spawnCursor = 0;
    this.massPos[0] = -0.35; this.massPos[1] = 0.0; this.massW[0] = 0.6; this.massMax[0] = 0.6; this.massLife[0] = 1e9;
    this.massPos[2] = 0.35; this.massPos[3] = 0.0; this.massW[1] = 0.6; this.massMax[1] = 0.6; this.massLife[1] = 1e9;
    // seed des orbites
    bindTarget(this.gl, this.orbit.write.fbo, ORBIT, ORBIT);
    drawFullscreen(this.gl, this.pSeed, {});
    this.orbit.swap();
    // vide l'accumulation
    const gl = this.gl;
    for (const t of [this.accum.read, this.accum.write]) {
      bindTarget(gl, t.fbo, this.w, this.h);
      gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    }
  }

  private spawnMass(fr: BusFrame): void {
    // position pilotée par le beat + hash (déterministe mais dispersé)
    const seed = this.time * 13.13 + this.spawnCursor * 7.0;
    const rx = fract(Math.sin(seed * 91.7) * 43758.5453);
    const ry = fract(Math.sin(seed * 57.3 + 1.0) * 24634.6345);
    // rayon lié à la phase du beat, angle au hash -> spawn sur un anneau modulé
    const ang = rx * Math.PI * 2.0;
    const rad = 0.35 + 0.45 * ((fr.beatPhase + ry) % 1);
    // ne pas écraser une masse "ancre" (slots 0,1) : cible les slots transitoires 2,3
    const slot = (this.spawnCursor % (NMASS - 2)) + 2;
    this.massPos[slot * 2] = Math.cos(ang) * rad;
    this.massPos[slot * 2 + 1] = Math.sin(ang) * rad;
    // force forte et brève, mise à l'échelle par massForce et la force de l'onset
    const force = this.res.matrix.get("nbody.params.massForce") || 1.0;
    const strength = force * (1.0 + 1.5 * clamp01(fr.feat[F.ONSET_STR]));
    this.massMax[slot] = strength;
    this.massW[slot] = strength;
    this.massLife[slot] = 0.9; // s de vie
    this.spawnCursor++;
  }

  update(fr: BusFrame, dt: number, time: number): void {
    this.time = time;
    const m = this.res.matrix;
    // spawn de masse sur les onsets : injection d'énergie brève et forte
    if (fr.onsetFired) this.spawnMass(fr);

    // décroissance des masses transitoires (slots 2,3), les ancres (life=1e9) restent
    const bass = melBand(fr, 0, 6);
    for (let s = 2; s < NMASS; s++) {
      if (this.massLife[s] < 1e8) {
        this.massLife[s] -= dt;
        if (this.massLife[s] <= 0) { this.massW[s] = 0; this.massLife[s] = 0; this.massMax[s] = 0; }
        else this.massW[s] = this.massMax[s] * (this.massLife[s] / 0.9);
      }
    }
    // les masses ancres respirent avec le beat (pulse prédictif) -> mouvement même sans onset
    const pulse = beatPulse(fr);
    this.massW[0] = 0.6 * (0.7 + 0.9 * pulse);
    this.massW[1] = 0.6 * (0.7 + 0.9 * pulse);

    // gravité modulée par le spectre (bass -> plus de gravité = effondrement rythmé)
    const gParam = m.get("nbody.params.g");
    const g = gParam * (1.0 + 1.2 * clamp01(bass));

    // pas d'intégration (uDt = param fixe, PAS le dt de frame — sim stable)
    bindTarget(this.gl, this.orbit.write.fbo, ORBIT, ORBIT);
    drawFullscreen(this.gl, this.pStep, {
      uOrbit: this.orbit.read.tex,
      uMass: this.massPos,
      uMassW: this.massW,
      uG: g,
      uDamp: m.get("nbody.params.damp"),
      uDt: m.get("nbody.params.dt"),
      uSoft: Math.max(1e-4, m.get("nbody.params.soft")),
      uVmax: m.get("nbody.params.vmax"),
    });
    this.orbit.swap();
  }

  render(target: WebGLFramebuffer | null, w: number, h: number): void {
    const gl = this.gl;
    const m = this.res.matrix;
    // 1) accum.write <- accum.read atténué (traînées à décroissance), blend OFF
    bindTarget(gl, this.accum.write.fbo, this.w, this.h);
    gl.disable(gl.BLEND);
    drawFullscreen(gl, this.pDecay, {
      uTex: this.accum.read.tex,
      uDecay: clamp01(m.get("nbody.params.decay")),
    });
    // 2) points additifs par-dessus (contribution ~0.12)
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(this.pPoints.program);
    gl.uniform1i(gl.getUniformLocation(this.pPoints.program, "uOrbit"), 0);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.orbit.read.tex);
    gl.uniform1i(gl.getUniformLocation(this.pPoints.program, "uSize"), ORBIT);
    gl.uniform1f(gl.getUniformLocation(this.pPoints.program, "uScale"), m.get("nbody.params.scale") || 1.15);
    gl.uniform1f(gl.getUniformLocation(this.pPoints.program, "uHue"), m.get("global.baseHue"));
    gl.uniform1f(gl.getUniformLocation(this.pPoints.program, "uSpeedGain"), m.get("nbody.params.speedGain"));
    gl.uniform1f(gl.getUniformLocation(this.pPoints.program, "uGain"), m.get("nbody.params.gain") || 0.12);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.POINTS, 0, ORBIT * ORBIT);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
    // swap : accum.write devient la nouvelle lecture
    this.accum.swap();
    // 3) copie densité -> target (main tonemappe)
    bindTarget(gl, target, w, h);
    drawFullscreen(gl, this.pCopy, { uTex: this.accum.read.tex });
  }

  dispose(): void {
    this.orbit?.dispose();
    this.accum?.dispose();
    unregister(this.res.matrix.targets, this.id);
  }
}

// --- helpers CPU -------------------------------------------------------------
function fract(x: number): number { return x - Math.floor(x); }
function clamp01(x: number): number { return x < 0 ? 0 : x > 1 ? 1 : x; }
// moyenne d'une plage de bandes mel de la trame brute (F.MEL0 = base des 32 bandes).
function melBand(fr: BusFrame, a: number, b: number): number {
  const f = fr.feat;
  let s = 0;
  for (let i = a; i < b; i++) s += f[F.MEL0 + i];
  return s / (b - a);
}
// pic étroit sur le beat (prédictif) — même forme que apply.ts beatPulse.
function beatPulse(fr: BusFrame): number {
  const lead = 0.045;
  const ph = (fr.beatPhase + lead * (fr.bpm / 60)) % 1;
  const near = Math.min(ph, 1 - ph);
  return Math.exp(-near * near * 120);
}
