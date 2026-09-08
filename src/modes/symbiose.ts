// symbiose.ts — ÉCOSYSTÈME (création originale, famille CONTINUOUS).
//
// Six modes ont été demandés ensemble : greenberg, thomas, nbody, spacecol, comb,
// anamnese. Les juxtaposer n'aurait rien donné — un collage se voit. Ils sont donc
// COUPLÉS en un seul monde, chacun gardant sa règle mais nourrissant les autres :
//
//   LE MILIEU (greenberg) — un automate cyclique excitable propage des ondes en
//     spirales. C'est le terrain : tout le reste y vit.
//   LES NAGEURS (thomas + nbody) — des particules suivent le flot cyclique de
//     Thomas, mais DÉVIÉ vers les fronts d'onde du milieu (couplage 1) ; les
//     onsets y jettent les masses transitoires de nbody (couplage 2).
//   LES DENDRITES (spacecol) — elles poussent vers les zones excitées (couplage 3)
//     et RALLUMENT le champ sur leur passage (couplage 4 : la boucle se referme).
//
// Le milieu nourrit donc les agents, qui à leur tour rallument le milieu. C'est la
// symbiose du nom : aucune couche ne se suffit, et l'image naît de leur échange.
//
// Lisibilité : chaque couche occupe une PLAGE D'INTENSITÉ distincte (milieu 0,1-0,5 ;
// dendrites 0,6-1,2 ; nageurs 1-2,5). Le tonemap indexe la LUT sur la densité et ne
// mélange la teinte qu'à 50 % — mesuré ailleurs dans ce projet : c'est le niveau qui
// sépare, la teinte ne fait que confirmer.
import { makeProgram, drawFullscreen, bindTarget } from "../core/fullscreen";
import { PingPong, createTarget, type Target } from "../core/pingpong";
import { registerParams, unregister } from "../modmatrix/targets";
import { F } from "../audio/constants";
import { RecurrenceMemory } from "../audio/recurrence.js";
import type { Mode, Resources } from "./Mode";
import type { BusFrame } from "../audio/bus";
import { decayDt, gainDt } from "../core/loop";
import type { Viewport } from "../core/loop";

const SWIM = 128;        // 16 384 nageurs (nbody en tire 65 536 : trop "brouillon")
const MAX_NODES = 1400;  // dendrites
const MAX_SEG = 2000;
const NMASS = 3;         // masses transitoires (nbody)
// Deux échelles de temps, donc deux anneaux : l'écho de comb porte sur UNE
// pulsation (0,4 s), le rappel d'anamnese sur des dizaines de secondes.
const ECHO_W = 192, ECHO_H = 108, ECHO_K = 24;  // écho : cadence pulsation/4 (~2,4 s)
const MEM_K = 64;                                // rappel : 1 instantané/s (~64 s)

// --- LE MILIEU : règle de Greenberg-Hastings, N états ------------------------
const FIELD = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D uState; uniform vec2 uTexel; uniform float uN;
float st(vec2 off){ return texture(uState, v_uv + off*uTexel).r; }
void main(){
  float s = texture(uState, v_uv).r;
  if (s >= 0.5) { float ns = s + 1.0; o = vec4(ns >= (uN - 0.5) ? 0.0 : ns, 0., 0., 1.); return; }
  float e = 0.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    if (i == 0 && j == 0) continue;
    e += step(0.5, 1.0 - abs(st(vec2(float(i), float(j))) - 1.0));
  }
  o = vec4(e >= 0.5 ? 1.0 : 0.0, 0., 0., 1.);
}`;

// Ensemencement d'un disque d'excités (onset), et repos ailleurs.
const IGNITE_DISC = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D uState; uniform vec2 uPos; uniform float uRadius, uAspect;
void main(){
  float s = texture(uState, v_uv).r;
  vec2 d = v_uv - uPos; d.x *= uAspect;
  o = vec4(dot(d,d) < uRadius*uRadius && s < 0.5 ? 1.0 : s, 0., 0., 1.);
}`;
const SEED = `#version 300 es
in vec2 v_uv; out vec4 o;
void main(){ o = vec4(hash22(v_uv*191.0).x > 0.997 ? 1.0 : 0.0, 0., 0., 1.); }`;

// --- LES NAGEURS : flot de Thomas dévié par le gradient du milieu -------------
const SWIM_SEED = `#version 300 es
in vec2 v_uv; out vec4 o;
void main(){
  vec2 h = hash22(v_uv * 131.0);
  o = vec4((h - 0.5) * 3.4, (hash11(dot(v_uv, vec2(311.7,127.1))) - 0.5) * 3.4, 1.0);
}`;

// L'état est (x,y,z) de Thomas ; la projection 2D sert à lire le champ.
const SWIM_STEP = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D uOrbit, uField;
uniform vec2 uTexel;
uniform float uDt, uB, uScale, uSurf, uAspect, uN;
uniform vec2 uMass[3]; uniform float uMassW[3];
// excitation lue dans le milieu : 1 juste sur le front, 0 ailleurs
float exc(vec2 uv){ float s = texture(uField, uv).r; return 1.0 - abs(s - 1.0) < 0.5 ? 1.0 : 0.0; }
void main(){
  vec3 p = texture(uOrbit, v_uv).xyz;
  // flot cyclique symétrique (Thomas)
  vec3 d = vec3(sin(p.y) - uB*p.x, sin(p.z) - uB*p.y, sin(p.x) - uB*p.z);

  // COUPLAGE 1 : le nageur est attiré par les fronts d'onde du milieu. On lit
  // l'excitation autour de sa position projetée et on descend son gradient.
  vec2 uv = vec2(p.x / (uScale * uAspect), p.y / uScale) * 0.5 + 0.5;
  if (uv.x > 0.02 && uv.x < 0.98 && uv.y > 0.02 && uv.y < 0.98) {
    float e = 3.0 * uTexel.x * 6.0;
    float gx = exc(uv + vec2(e,0.)) - exc(uv - vec2(e,0.));
    float gy = exc(uv + vec2(0.,e)) - exc(uv - vec2(0.,e));
    d.xy += vec2(gx, gy) * uSurf;
  }
  // COUPLAGE 2 : les masses transitoires de nbody (spawnées sur les onsets)
  for (int i = 0; i < 3; i++) {
    vec2 md = uMass[i] - p.xy;
    float r2 = dot(md, md) + 0.05;
    d.xy += md * (uMassW[i] / r2) * 0.12;
  }
  p += d * uDt;
  o = vec4(clamp(p, vec3(-6.0), vec3(6.0)), 1.0);
}`;

// Points des nageurs : projection + couleur par profondeur z.
const SWIM_VS = `#version 300 es
precision highp float;
uniform sampler2D uOrbit; uniform int uSize; uniform float uScale, uHue, uAspect;
out vec3 vCol;
vec3 hueRGB(float t){ return 0.5 + 0.5 * cos(6.2831853 * (t + vec3(0.0, 0.33, 0.67))); }
void main(){
  int id = gl_VertexID; int x = id % uSize; int y = id / uSize;
  vec2 uv = (vec2(float(x), float(y)) + 0.5) / float(uSize);
  vec3 p = texture(uOrbit, uv).xyz;
  gl_Position = vec4(p.x / (uScale * uAspect), p.y / uScale, 0.0, 1.0);
  gl_PointSize = 1.6;
  vCol = hueRGB(uHue + 0.15 + p.z * 0.06);
}`;
const SWIM_FS = `#version 300 es
precision highp float; in vec3 vCol; out vec4 o; uniform float uGain;
void main(){ o = vec4(vCol * uGain, 1.0); }`;

// --- LES DENDRITES : segments (spacecol) -------------------------------------
const SEG_VS = `#version 300 es
layout(location=0) in vec2 a_pos;
void main(){ gl_Position = vec4(a_pos, 0., 1.); }`;
const SEG_FS = `#version 300 es
precision highp float; out vec4 o; uniform vec3 uCol;
void main(){ o = vec4(uCol, 1.); }`;

// Points d'ALLUMAGE : les pointes de dendrites rallument le milieu (couplage 4).
// Rendu avec blendEquation(MAX) dans le champ : une case au repos passe à 1, une
// case réfractaire reste inchangée — la règle du CA n'est pas violée.
const SPARK_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 a_pos;
void main(){ gl_Position = vec4(a_pos, 0., 1.); gl_PointSize = 2.0; }`;
const SPARK_FS = `#version 300 es
precision highp float; out vec4 o;
void main(){ o = vec4(1.0, 0.0, 0.0, 1.0); }`;

// COUPLAGE 5 : les nageurs BROUTENT le milieu. Là où ils passent, la cellule
// retombe au repos — ils creusent des rivières sombres dans le labyrinthe. C'est
// ce qui empêche l'automate d'occuper toute la surface : il est mangé.
// Rendu avec blendEquation(MIN) : min(0, état) = 0, et rien d'autre n'est touché.
const GRAZE_VS = `#version 300 es
precision highp float;
uniform sampler2D uOrbit; uniform int uSize; uniform float uScale, uAspect, uEvery;
void main(){
  int id = gl_VertexID * int(uEvery);
  int x = id % uSize; int y = (id / uSize) % uSize;
  vec2 uv = (vec2(float(x), float(y)) + 0.5) / float(uSize);
  vec3 p = texture(uOrbit, uv).xyz;
  gl_Position = vec4(p.x / (uScale * uAspect), p.y / uScale, 0.0, 1.0);
  gl_PointSize = 2.0;
}`;
const GRAZE_FS = `#version 300 es
precision highp float; out vec4 o;
void main(){ o = vec4(0.0, 0.0, 0.0, 1.0); }`;

const DECAY = `#version 300 es
precision highp float; in vec2 v_uv; out vec4 o; uniform sampler2D uTex; uniform float uDecay;
void main(){ o = texture(uTex,v_uv) * uDecay; }`;

// --- COMPOSITION : milieu (bas) + encre des agents (haut) --------------------
const COMPOSE = `#version 300 es
in vec2 v_uv; out vec4 o;
uniform sampler2D uField, uInk;
uniform float uN, uHue, uFieldGain, uBright;
void main(){
  float s = texture(uField, v_uv).r;
  // excité = crête ; réfractaire = traîne décroissante ; repos = fond
  float exc = 1.0 - min(1.0, abs(s - 1.0));
  float refr = s > 1.5 ? max(0.0, 1.0 - (s - 1.0) / max(1.0, uN - 2.0)) : 0.0;
  float dens = (0.10 + 0.40 * exc + 0.22 * refr) * uFieldGain;
  vec3 col = hue(uHue) * dens;
  col += texture(uInk, v_uv).rgb;              // agents : plage d'intensité au-dessus
  o = vec4(col * (1.0 + uBright), 1.0);
}`;

// Réduction pour la ligne à retard.
const SNAP = `#version 300 es
precision highp float; in vec2 v_uv; out vec4 o; uniform sampler2D uTex;
void main(){ o = texture(uTex, v_uv); }`;

// --- LA MÉMOIRE : l'écho calé sur la pulsation (comb) + le rappel (anamnese) --
// L'écho rejoue l'image d'il y a exactement une pulsation, tournée d'un cran :
// les fantômes retombent sur le temps. Le rappel, lui, ne rejoue RIEN — il montre
// l'ÉCART entre le présent et le passage musicalement semblable (l'invariant
// d'anamnese : la mémoire fixe les règles, l'image stockée est une preuve).
const MEMORY = `#version 300 es
precision highp float;          // sans elle, aucune variable float n'a de précision
precision highp sampler2DArray; // ES 3.0 : ce type n'en a pas par défaut
in vec2 v_uv; out vec4 o;
uniform sampler2D uComp;
uniform sampler2DArray uEcho;   // anneau court : l'écho à une pulsation
uniform sampler2DArray uMem;    // anneau long : le passage musicalement semblable
uniform vec2 uCmpTexel;
uniform float uEchoLayer, uEchoGain, uSwirl, uAspect;
uniform float uRecallLayer, uRecallEnv, uDiff;
vec3 gradC(vec2 uv, vec2 e){
  return abs(texture(uComp, uv+vec2(e.x,0.)).rgb - texture(uComp, uv-vec2(e.x,0.)).rgb)
       + abs(texture(uComp, uv+vec2(0.,e.y)).rgb - texture(uComp, uv-vec2(0.,e.y)).rgb);
}
vec3 gradM(vec2 uv, float l, vec2 e){
  return abs(texture(uMem, vec3(uv+vec2(e.x,0.),l)).rgb - texture(uMem, vec3(uv-vec2(e.x,0.),l)).rgb)
       + abs(texture(uMem, vec3(uv+vec2(0.,e.y),l)).rgb - texture(uMem, vec3(uv-vec2(0.,e.y),l)).rgb);
}
void main(){
  vec3 c = texture(uComp, v_uv).rgb;
  // écho : l'image d'il y a une pulsation, tournée autour du centre
  if (uEchoGain > 0.001) {
    vec2 q = (v_uv - 0.5) * vec2(uAspect, 1.0);
    float ca = cos(uSwirl), sa = sin(uSwirl);
    q = mat2(ca, -sa, sa, ca) * q;
    q = q / vec2(uAspect, 1.0) + 0.5;
    vec3 e = texture(uEcho, vec3(q, uEchoLayer)).rgb;
    e *= step(0.0, q.x) * step(q.x, 1.0) * step(0.0, q.y) * step(q.y, 1.0);
    c += e * uEchoGain;
  }
  // rappel : là où le retour ne coïncide pas, une interférence neutre
  if (uRecallEnv > 0.002) {
    c *= 1.0 - 0.25 * uRecallEnv;
    float interf = length(abs(gradC(v_uv, uCmpTexel) - gradM(v_uv, uRecallLayer, uCmpTexel)));
    c += vec3(interf * uDiff * uRecallEnv);
  }
  o = vec4(c, 1.0);
}`;

export class SymbioseMode implements Mode {
  id = "symbiose"; family = "continuous" as const;
  private lastDt = 1 / 60; private lastTime = -1; // décroissance compensée (render() n'a pas dt)
  private gl!: WebGL2RenderingContext; private res!: Resources;
  private field!: PingPong; private swim!: PingPong; private ink!: PingPong;
  private pField: any; private pIgnite: any; private pSeed: any;
  private pSwimSeed: any; private pSwimStep: any; private pSwimPts: any;
  private pSeg: any; private pSpark: any; private pGraze: any; private pDecay: any; private pCompose: any;
  private emptyVao!: WebGLVertexArrayObject;
  private segVao!: WebGLVertexArrayObject; private segVbo!: WebGLBuffer;
  private sparkVao!: WebGLVertexArrayObject; private sparkVbo!: WebGLBuffer;
  private w = 0; private h = 0; private aspect = 1;
  // mémoire : ligne à retard (comb) + reconnaissance de forme (anamnese)
  private comp!: Target; private snap!: Target; private hist!: WebGLTexture; private memTex!: WebGLTexture;
  private pSnap: any; private pMemory: any;
  private stamps = new Float64Array(ECHO_K).fill(-1e9); private wr = 0;
  private winOf = new Int32Array(MEM_K).fill(-1); private mwr = 0;
  private mem = new RecurrenceMemory();
  private lastAudioT = -1; private lastSnapWin = -1; private nextEcho = 0;
  private echoLayer = 0; private recallLayer = 0; private recallOk = false; private beatPeriod = 0.5;

  // dendrites (CPU, comme spacecol)
  private nx = new Float32Array(MAX_NODES); private ny = new Float32Array(MAX_NODES); private nCount = 0;
  private ax: number[] = []; private ay: number[] = [];
  private segBuf = new Float32Array(MAX_SEG * 4); private nSeg = 0;
  private sparkBuf = new Float32Array(MAX_NODES * 2); private nSpark = 0;
  // masses transitoires (nbody)
  private massPos = new Float32Array(NMASS * 2); private massW = new Float32Array(NMASS);
  private massLife = new Float32Array(NMASS); private spawn = 0;
  private phase = 0; private acc = 0;

  init(res: Resources, vp: Viewport): void {
    this.res = res; this.gl = res.gl;
    registerParams(res.matrix.targets, this.id, {
      states: 6, fieldRate: 18, ignite: 0.05, fieldGain: 0.40,
      swimDt: 0.055, b: 0.19, scale: 3.4, surf: 0.9, swimGain: 0.075, massForce: 1.0, graze: 1.0,
      grow: 1.0, dendGain: 1.6, spark: 1.0, inkDecay: 0.93, bright: 0.0,
      echo: 0.35, echoSwirl: 0.05, diff: 1.0,
    }, {
      states: [4, 16], fieldRate: [4, 60], ignite: [0.01, 0.2], fieldGain: [0, 2.5],
      swimDt: [0.01, 0.15], b: [0.1, 0.35], scale: [2, 6], surf: [0, 3], swimGain: [0, 0.25], massForce: [0, 3], graze: [0, 4],
      grow: [0, 3], dendGain: [0, 4], spark: [0, 3], inkDecay: [0.7, 0.98], bright: [-0.4, 1.5],
      echo: [0, 0.8], echoSwirl: [-0.3, 0.3], diff: [0, 3],
    });
    const gl = this.gl;
    this.pField = makeProgram(gl, FIELD);
    this.pIgnite = makeProgram(gl, IGNITE_DISC);
    this.pSeed = makeProgram(gl, SEED, { common: true });
    this.pSwimSeed = makeProgram(gl, SWIM_SEED, { common: true });
    this.pSwimStep = makeProgram(gl, SWIM_STEP);
    this.pSwimPts = makeProgram(gl, SWIM_FS, { vert: SWIM_VS });
    this.pSeg = makeProgram(gl, SEG_FS, { vert: SEG_VS });
    this.pSpark = makeProgram(gl, SPARK_FS, { vert: SPARK_VS });
    this.pGraze = makeProgram(gl, GRAZE_FS, { vert: GRAZE_VS });
    this.pDecay = makeProgram(gl, DECAY);
    this.pCompose = makeProgram(gl, COMPOSE, { common: true });
    this.pSnap = makeProgram(gl, SNAP);
    this.pMemory = makeProgram(gl, MEMORY);

    this.hist = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.hist);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA16F, ECHO_W, ECHO_H, ECHO_K);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.memTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.memTex);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA16F, ECHO_W, ECHO_H, MEM_K);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.snap = createTarget(gl, ECHO_W, ECHO_H, gl.RGBA16F, gl.LINEAR, gl.CLAMP_TO_EDGE);

    this.emptyVao = gl.createVertexArray()!;
    this.segVao = gl.createVertexArray()!; this.segVbo = gl.createBuffer()!;
    gl.bindVertexArray(this.segVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.segVbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.segBuf.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.sparkVao = gl.createVertexArray()!; this.sparkVbo = gl.createBuffer()!;
    gl.bindVertexArray(this.sparkVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.sparkVbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.sparkBuf.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.swim = new PingPong(gl, SWIM, SWIM, res.caps.simFormat);
    this.resize(vp);
  }

  resize(vp: Viewport): void {
    this.w = vp.simW; this.h = vp.simH; this.aspect = vp.simW / Math.max(1, vp.simH);
    this.field?.dispose();
    this.field = new PingPong(this.gl, this.w, this.h, this.res.caps.simFormat, this.gl.NEAREST, this.gl.CLAMP_TO_EDGE);
    this.ink?.dispose();
    this.ink = new PingPong(this.gl, this.w, this.h, this.res.caps.accumFormat);
    if (this.comp) { this.gl.deleteTexture(this.comp.tex); this.gl.deleteFramebuffer(this.comp.fbo); }
    // 16F explicite (pas accumFormat, qui peut valoir 32F) : le filtrage linéaire
    // d'une cible 32F passe par un chemin lent sur cette carte — mesuré à 36 ms/frame.
    this.comp = createTarget(this.gl, this.w, this.h, this.gl.RGBA16F, this.gl.LINEAR, this.gl.CLAMP_TO_EDGE);
    this.reset();
  }

  reset(): void {
    const gl = this.gl;
    bindTarget(gl, this.field.write.fbo, this.w, this.h);
    drawFullscreen(gl, this.pSeed, {});
    this.field.swap();
    bindTarget(gl, this.swim.write.fbo, SWIM, SWIM);
    drawFullscreen(gl, this.pSwimSeed, {});
    this.swim.swap();
    for (const t of [this.ink.read, this.ink.write]) {
      bindTarget(gl, t.fbo, this.w, this.h);
      gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    }
    this.nCount = 0; this.ax.length = 0; this.ay.length = 0;
    this.nx[0] = 0; this.ny[0] = 0; this.nCount = 1;
    this.massPos.fill(0); this.massW.fill(0); this.massLife.fill(0);
    this.phase = 0; this.acc = 0; this.nSeg = 0; this.nSpark = 0;
    this.mem.reset(); this.stamps.fill(-1e9); this.winOf.fill(-1);
    this.wr = 0; this.mwr = 0; this.lastAudioT = -1; this.lastSnapWin = -1;
    this.nextEcho = 0; this.recallOk = false;
  }

  /** Croissance des dendrites (Runions), avec les attracteurs posés par l'audio. */
  private growDendrites(step: number): void {
    this.nSeg = 0; this.nSpark = 0;
    if (!this.ax.length || this.nCount >= MAX_NODES - 2) return;
    // un attracteur tire le noeud le plus proche vers lui
    for (let a = 0; a < this.ax.length && this.nCount < MAX_NODES - 2; a++) {
      let best = -1, bd = 1e9;
      for (let i = 0; i < this.nCount; i++) {
        const dx = this.ax[a] - this.nx[i], dy = this.ay[a] - this.ny[i];
        const d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = i; }
      }
      if (best < 0) continue;
      if (bd < 0.004) { this.ax.splice(a, 1); this.ay.splice(a, 1); a--; continue; } // atteint
      const dx = this.ax[a] - this.nx[best], dy = this.ay[a] - this.ny[best];
      const n = Math.hypot(dx, dy) || 1;
      const px = this.nx[best] + (dx / n) * step, py = this.ny[best] + (dy / n) * step;
      const id = this.nCount++;
      this.nx[id] = px; this.ny[id] = py;
      if (this.nSeg < MAX_SEG) {
        const o = this.nSeg++ * 4;
        this.segBuf[o] = this.nx[best]; this.segBuf[o + 1] = this.ny[best];
        this.segBuf[o + 2] = px; this.segBuf[o + 3] = py;
      }
      // COUPLAGE 4 : la pointe rallume le milieu
      if (this.nSpark < MAX_NODES) { const s = this.nSpark++ * 2; this.sparkBuf[s] = px; this.sparkBuf[s + 1] = py; }
    }
  }

  update(fr: BusFrame, dt: number, time: number): void {
    // Le dt fourni est BORNÉ à 1/20 s par RenderLoop (protection des simulations
    // après un blocage). Pour la décroissance il faut le temps RÉELLEMENT écoulé,
    // sinon la compensation ne corrige qu'un tiers du problème quand le rAF est
    // bridé à ~1,3 Hz (fenêtre non focalisée).
    const reel = this.lastTime < 0 ? dt : Math.min(1, Math.max(1 / 1000, time - this.lastTime));
    this.lastTime = time; this.lastDt = reel;
    const gl = this.gl; const m = this.res.matrix;
    const N = Math.max(4, Math.round(m.get("symbiose.params.states")));

    // --- LA MÉMOIRE écoute (anamnese) ---------------------------------------
    // Garde sur l'horodatage : sans audio le moteur passe une trame de repos à 0,
    // qui empoisonnerait l'origine d'horloge (constaté sur anamnese).
    const tAudio = fr.feat[F.T_FRAME];
    if (tAudio > 0 && tAudio !== this.lastAudioT) {
      this.lastAudioT = tAudio;
      this.mem.push(fr.feat.subarray(F.MEL0, F.MEL0 + 32), tAudio);
    }
    this.mem.update(dt);
    this.beatPeriod = 60 / Math.min(240, Math.max(60, fr.bpm || 120));

    // --- masses transitoires (nbody) : décroissance puis spawn sur onset ------
    for (let i = 0; i < NMASS; i++) {
      if (this.massLife[i] > 0) { this.massLife[i] -= dt; this.massW[i] = Math.max(0, this.massW[i] * (this.massLife[i] / 0.8)); }
    }
    if (fr.onsetFired) {
      this.phase += 0.31;
      const px = Math.cos(this.phase * 6.283) * 1.4, py = Math.sin(this.phase * 4.7) * 1.4;
      const s = this.spawn++ % NMASS;
      this.massPos[s * 2] = px; this.massPos[s * 2 + 1] = py;
      this.massW[s] = m.get("symbiose.params.massForce") * (0.6 + 1.2 * Math.min(1, fr.feat[F.ONSET_STR]));
      this.massLife[s] = 0.8;
      // COUPLAGE 3 : l'attracteur de dendrite est posé là où l'onde va passer
      const ux = 0.5 + Math.cos(this.phase * 6.283) * 0.34, uy = 0.5 + Math.sin(this.phase * 4.7) * 0.34;
      this.ax.push(ux * 2 - 1); this.ay.push(uy * 2 - 1);
      if (this.ax.length > 24) { this.ax.shift(); this.ay.shift(); }
      // et l'onset allume le milieu
      bindTarget(gl, this.field.write.fbo, this.w, this.h);
      drawFullscreen(gl, this.pIgnite, {
        uState: this.field.read.tex, uPos: [ux, uy],
        uRadius: m.get("symbiose.params.ignite"), uAspect: this.aspect,
      });
      this.field.swap();
    }

    // --- LE MILIEU avance (cadence fixe, indépendante du frame rate) ---------
    this.acc += dt * Math.max(1, m.get("symbiose.params.fieldRate"));
    // Plafond haut quand le rendu s'effondre : à 1,2 fps un plafond de 3 privait
    // le milieu de 80 % de ses pas (3,6/s au lieu de 18). Le coût reste borné.
    let steps = Math.min(this.lastDt > 0.1 ? 14 : 3, Math.floor(this.acc));
    this.acc -= steps;
    while (steps-- > 0) {
      bindTarget(gl, this.field.write.fbo, this.w, this.h);
      drawFullscreen(gl, this.pField, { uState: this.field.read.tex, uTexel: [1 / this.w, 1 / this.h], uN: N });
      this.field.swap();
    }

    // --- LES DENDRITES poussent ---------------------------------------------
    this.growDendrites(0.012 * Math.max(0.1, m.get("symbiose.params.grow")));

    // --- COUPLAGE 4 : les pointes rallument le milieu (blend MAX) ------------
    if (this.nSpark > 0 && m.get("symbiose.params.spark") > 0.01) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.sparkVbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.sparkBuf.subarray(0, this.nSpark * 2));
      bindTarget(gl, this.field.read.fbo, this.w, this.h); // on écrit DANS l'état courant
      gl.enable(gl.BLEND); gl.blendEquation(gl.MAX);
      gl.useProgram(this.pSpark.program);
      gl.bindVertexArray(this.sparkVao);
      gl.drawArrays(gl.POINTS, 0, this.nSpark);
      gl.bindVertexArray(null);
      gl.blendEquation(gl.FUNC_ADD); gl.disable(gl.BLEND);
    }

    // --- COUPLAGE 5 : les nageurs broutent le milieu (blend MIN) -------------
    const graze = m.get("symbiose.params.graze");
    if (graze > 0.01) {
      bindTarget(gl, this.field.read.fbo, this.w, this.h);
      gl.enable(gl.BLEND); gl.blendEquation(gl.MIN);
      gl.useProgram(this.pGraze.program);
      gl.uniform1i(gl.getUniformLocation(this.pGraze.program, "uOrbit"), 0);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.swim.read.tex);
      gl.uniform1i(gl.getUniformLocation(this.pGraze.program, "uSize"), SWIM);
      gl.uniform1f(gl.getUniformLocation(this.pGraze.program, "uScale"), m.get("symbiose.params.scale"));
      gl.uniform1f(gl.getUniformLocation(this.pGraze.program, "uAspect"), this.aspect);
      // un nageur sur `every` broute : plus le paramètre est haut, plus ils mangent
      const every = Math.max(1, Math.round(8 / Math.max(0.25, graze)));
      gl.uniform1f(gl.getUniformLocation(this.pGraze.program, "uEvery"), every);
      gl.bindVertexArray(this.emptyVao);
      gl.drawArrays(gl.POINTS, 0, Math.floor((SWIM * SWIM) / every));
      gl.bindVertexArray(null);
      gl.blendEquation(gl.FUNC_ADD); gl.disable(gl.BLEND);
    }

    // --- LES NAGEURS ---------------------------------------------------------
    bindTarget(gl, this.swim.write.fbo, SWIM, SWIM);
    drawFullscreen(gl, this.pSwimStep, {
      uOrbit: this.swim.read.tex, uField: this.field.read.tex,
      uTexel: [1 / this.w, 1 / this.h],
      uDt: m.get("symbiose.params.swimDt"), uB: m.get("symbiose.params.b"),
      uScale: m.get("symbiose.params.scale"), uSurf: m.get("symbiose.params.surf"),
      uAspect: this.aspect, uN: N, uMass: this.massPos, uMassW: this.massW,
    });
    this.swim.swap();
  }

  render(target: WebGLFramebuffer | null, w: number, h: number): void {
    const gl = this.gl; const m = this.res.matrix;
    // 1) encre : décroissance, puis agents en additif
    bindTarget(gl, this.ink.write.fbo, this.w, this.h);
    gl.disable(gl.BLEND);
    drawFullscreen(gl, this.pDecay, { uTex: this.ink.read.tex, uDecay: decayDt(Math.min(0.98, m.get("symbiose.params.inkDecay")), this.lastDt) });
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    // nageurs
    gl.useProgram(this.pSwimPts.program);
    gl.uniform1i(gl.getUniformLocation(this.pSwimPts.program, "uOrbit"), 0);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.swim.read.tex);
    gl.uniform1i(gl.getUniformLocation(this.pSwimPts.program, "uSize"), SWIM);
    gl.uniform1f(gl.getUniformLocation(this.pSwimPts.program, "uScale"), m.get("symbiose.params.scale"));
    gl.uniform1f(gl.getUniformLocation(this.pSwimPts.program, "uHue"), m.get("global.baseHue"));
    gl.uniform1f(gl.getUniformLocation(this.pSwimPts.program, "uAspect"), this.aspect);
    gl.uniform1f(gl.getUniformLocation(this.pSwimPts.program, "uGain"), gainDt(m.get("symbiose.params.swimGain"), this.lastDt));
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.POINTS, 0, SWIM * SWIM);
    // dendrites
    if (this.nSeg > 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.segVbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.segBuf.subarray(0, this.nSeg * 4));
      gl.useProgram(this.pSeg.program);
      const c = gainDt(m.get("symbiose.params.dendGain"), this.lastDt);
      gl.uniform3f(gl.getUniformLocation(this.pSeg.program, "uCol"), c, c * 0.85, c * 0.6);
      gl.bindVertexArray(this.segVao);
      gl.drawArrays(gl.LINES, 0, this.nSeg * 2);
    }
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
    this.ink.swap();

    // 2) composition : milieu + encre -> dans une cible (la mémoire la relit)
    bindTarget(gl, this.comp.fbo, this.w, this.h);
    drawFullscreen(gl, this.pCompose, {
      uField: this.field.read.tex, uInk: this.ink.read.tex,
      uN: Math.max(4, Math.round(m.get("symbiose.params.states"))),
      uHue: m.get("global.baseHue"),
      uFieldGain: m.get("symbiose.params.fieldGain"),
      uBright: m.get("symbiose.params.bright") + (m.get("global.brightness") - 1),
    });

    // 3) instantanés : anneau court (écho, cadence pulsation/4) et anneau long
    //    (rappel, 1/s). On réduit une seule fois, on copie dans les deux.
    const st = this.mem.state;
    let reduced = false;
    const reduce = () => {
      if (reduced) return; reduced = true;
      bindTarget(gl, this.snap.fbo, ECHO_W, ECHO_H);
      drawFullscreen(gl, this.pSnap, { uTex: this.comp.tex });
    };
    if (this.lastAudioT > this.nextEcho) {
      this.nextEcho = this.lastAudioT + this.beatPeriod / 4;
      reduce();
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.hist);
      gl.copyTexSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, this.wr, 0, 0, ECHO_W, ECHO_H);
      this.stamps[this.wr] = this.lastAudioT;
      this.wr = (this.wr + 1) % ECHO_K;
    }
    if (st.windows !== this.lastSnapWin && st.windows % 2 === 0) {
      this.lastSnapWin = st.windows;
      reduce();
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.memTex);
      gl.copyTexSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, this.mwr, 0, 0, ECHO_W, ECHO_H);
      this.winOf[this.mwr] = st.windows - 1;
      this.mwr = (this.mwr + 1) % MEM_K;
    }

    // couche d'écho : celle dont l'horodatage approche « maintenant - une pulsation »
    let best = 0, bd = Infinity;
    for (let i = 0; i < ECHO_K; i++) {
      if (this.stamps[i] < -1e8) continue;
      const d = Math.abs(this.stamps[i] - (this.lastAudioT - this.beatPeriod));
      if (d < bd) { bd = d; best = i; }
    }
    this.echoLayer = best;
    // couche de rappel : celle de la fenêtre musicalement semblable
    this.recallOk = false;
    const rec = this.mem.recalledIndex();
    if (rec >= 0) {
      for (let i = 0; i < MEM_K; i++) {
        if (this.winOf[i] >= 0 && Math.abs(this.winOf[i] - rec) <= 1) { this.recallLayer = i; this.recallOk = true; break; }
      }
    }

    // 4) mémoire -> écran
    bindTarget(gl, target, w, h);
    drawFullscreen(gl, this.pMemory, {
      uComp: this.comp.tex, uEcho: this.hist, uMem: this.memTex,
      uCmpTexel: [1 / ECHO_W, 1 / ECHO_H],
      uEchoLayer: this.echoLayer,
      uEchoGain: bd < this.beatPeriod * 0.6 ? m.get("symbiose.params.echo") : 0,
      uSwirl: m.get("symbiose.params.echoSwirl"), uAspect: this.aspect,
      uRecallLayer: this.recallLayer,
      uRecallEnv: this.recallOk ? st.env : 0,
      uDiff: m.get("symbiose.params.diff"),
    });
  }

  /** État de la mémoire (console : __viz.modeDebug()). */
  debug(): unknown {
    const st = this.mem.state;
    return { rappel_actif: st.active, proéminence: +st.z.toFixed(3), décalage_s: +st.lagSec.toFixed(1),
      enveloppe: +st.env.toFixed(3), fenêtres: st.windows, souvenir: this.recallOk,
      pulsation_s: +this.beatPeriod.toFixed(3), couche_echo: this.echoLayer };
  }

  dispose(): void {
    const gl = this.gl;
    this.field?.dispose(); this.swim?.dispose(); this.ink?.dispose();
    if (this.comp) { gl.deleteTexture(this.comp.tex); gl.deleteFramebuffer(this.comp.fbo); }
    if (this.snap) { gl.deleteTexture(this.snap.tex); gl.deleteFramebuffer(this.snap.fbo); }
    gl.deleteTexture(this.hist); gl.deleteTexture(this.memTex);
    gl.deleteBuffer(this.segVbo); gl.deleteBuffer(this.sparkVbo);
    gl.deleteVertexArray(this.segVao); gl.deleteVertexArray(this.sparkVao); gl.deleteVertexArray(this.emptyVao);
    unregister(this.res.matrix.targets, this.id);
  }
}
