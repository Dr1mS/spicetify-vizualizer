// stitch.ts — TISSAGE SOUS TENSION (création originale, famille DENSITY).
//
// L'idée : au lieu d'un champ, une ÉTOFFE. Des fils (chaînes de noeuds) sont
// tendus entre deux ancres ; ils se tendent (ressort le long du fil), s'évitent
// (répulsion par le gradient d'un champ de densité — c'est ce qui produit
// l'entrelacs plutôt qu'un paquet), et respirent avec le son (rotation + poussée
// radiale). À chaque frappe, un fil est DÉCROCHÉ et rejeté ailleurs : la trame
// se recoud en rythme. Le dessin est un tissu qui se refait sous l'oreille.
//
// Rien de tout ça n'est un système nommé : c'est une relaxation de contraintes
// pilotée par le rythme. La stabilité tient à trois garde-fous (dt borné par la
// raideur, vitesse clampée, position clampée) — sans eux, une route de la
// mod matrix qui monte la tension enverrait les positions à NaN, et un NaN dans
// une texture de position ne se voit pas : ça rend juste NOIR.
import { makeProgram, drawFullscreen, bindTarget } from "../core/fullscreen";
import { PingPong, createTarget, type Target } from "../core/pingpong";
import { registerParams, unregister } from "../modmatrix/targets";
import { F } from "../audio/constants";
import type { Mode, Resources } from "./Mode";
import type { BusFrame } from "../audio/bus";
import { decayDt, gainDt } from "../core/loop";
import type { Viewport } from "../core/loop";

const THREADS = 36; // fils (assez pour tisser, assez peu pour qu'on les distingue)
const NODES = 64; // noeuds par fil
const DENS = 96; // champ de densité (répulsion)

const STEP = `#version 300 es
precision highp float;
out vec4 o;
uniform sampler2D uState, uAnch, uDens;
uniform float uStiff, uRepel, uDamp, uDt, uVmax, uSwirl, uSpread;
uniform int uNodes;
void main(){
  ivec2 ij = ivec2(gl_FragCoord.xy);
  int i = ij.x;
  vec4 anch = texelFetch(uAnch, ivec2(ij.y, 0), 0);
  if (i == 0) { o = vec4(anch.xy, 0.0, 0.0); return; }            // ancre A
  if (i == uNodes - 1) { o = vec4(anch.zw, 0.0, 0.0); return; }   // ancre B
  vec4 s = texelFetch(uState, ij, 0);
  vec2 p = s.xy, v = s.zw;
  vec2 a = texelFetch(uState, ivec2(i - 1, ij.y), 0).xy;
  vec2 b = texelFetch(uState, ivec2(i + 1, ij.y), 0).xy;
  vec2 f = (a + b - 2.0 * p) * uStiff;                            // tension du fil
  // répulsion : le fil descend le gradient de densité -> les fils s'entrelacent
  vec2 uv = p * 0.5 + 0.5;
  float t = 1.0 / 96.0;
  float gx = texture(uDens, uv + vec2(t, 0.0)).r - texture(uDens, uv - vec2(t, 0.0)).r;
  float gy = texture(uDens, uv + vec2(0.0, t)).r - texture(uDens, uv - vec2(0.0, t)).r;
  f -= vec2(gx, gy) * uRepel;
  // souffle : rotation autour du centre + poussée radiale (pilotés par l'audio)
  float rl = max(length(p), 1e-3);
  f += vec2(-p.y, p.x) / rl * uSwirl + p / rl * uSpread;
  v = (v + f * uDt) * uDamp;
  float sp = length(v);
  if (sp > uVmax) v *= uVmax / sp;                                // garde-fou 1
  p = clamp(p + v * uDt, vec2(-1.35), vec2(1.35));                // garde-fou 2
  o = vec4(p, v);
}`;

// Points de densité : tous les noeuds, additifs, en basse résolution.
const DENS_VS = `#version 300 es
precision highp float;
uniform sampler2D uState; uniform int uNodes;
void main(){
  int id = gl_VertexID; int nd = id % uNodes; int th = id / uNodes;
  vec2 p = texelFetch(uState, ivec2(nd, th), 0).xy;
  gl_Position = vec4(p, 0.0, 1.0);
  gl_PointSize = 3.0;
}`;
const DENS_FS = `#version 300 es
precision highp float; out vec4 o;
void main(){ o = vec4(1.0); }`;

// Les segments : 2 sommets par segment, indexés par gl_VertexID (aucun buffer).
const LINE_VS = `#version 300 es
precision highp float;
uniform sampler2D uState; uniform int uNodes;
uniform float uAspect, uHue, uTense;
out vec3 vCol;
vec3 hueRGB(float t){ return 0.5 + 0.5 * cos(6.2831853 * (t + vec3(0.0, 0.33, 0.67))); }
void main(){
  int seg = gl_VertexID / 2, k = gl_VertexID % 2;
  int per = uNodes - 1;
  int th = seg / per, nd = seg % per + k;
  vec2 p = texelFetch(uState, ivec2(nd, th), 0).xy;
  vec2 q = texelFetch(uState, ivec2(min(nd + 1, uNodes - 1), th), 0).xy;
  float taut = length(q - p) * float(uNodes) * 0.5;   // segment étiré = fil tendu
  gl_Position = vec4(p.x / uAspect, p.y, 0.0, 1.0);
  vCol = hueRGB(uHue + float(th) * 0.017 + taut * uTense);
}`;
const LINE_FS = `#version 300 es
precision highp float; in vec3 vCol; out vec4 o; uniform float uGain;
void main(){ o = vec4(vCol * uGain, 1.0); }`;

const DECAY = `#version 300 es
precision highp float; in vec2 v_uv; out vec4 o; uniform sampler2D uTex; uniform float uDecay;
void main(){ o = texture(uTex, v_uv) * uDecay; }`;
const COPY = `#version 300 es
precision highp float; in vec2 v_uv; out vec4 o; uniform sampler2D uTex;
void main(){ o = texture(uTex, v_uv); }`;

export class StitchMode implements Mode {
  id = "stitch"; family = "density" as const;
  private lastDt = 1 / 60; private lastTime = -1; // décroissance compensée (render() n'a pas dt)
  private gl!: WebGL2RenderingContext; private res!: Resources;
  private state!: PingPong; private ink!: PingPong; private dens!: Target;
  private anchTex!: WebGLTexture;
  private pStep: any; private pDens: any; private pLine: any; private pDecay: any; private pCopy: any;
  private emptyVao!: WebGLVertexArrayObject;
  private anch = new Float32Array(THREADS * 4);
  private w = 0; private h = 0; private aspect = 1; private stitches = 0;

  init(res: Resources, vp: Viewport): void {
    this.res = res; this.gl = res.gl;
    registerParams(res.matrix.targets, this.id, {
      stiff: 34, repel: 0.9, damp: 0.965, dt: 0.05, vmax: 2.4,
      swirl: 0.03, spread: 0.0, gain: 0.5, decay: 0.82, tense: 0.35, anchorR: 0.95,
    }, {
      stiff: [2, 90], repel: [0, 2.5], damp: [0.9, 0.999], dt: [0.01, 0.09], vmax: [0.3, 5],
      swirl: [-0.6, 0.6], spread: [-0.5, 0.5], gain: [0.05, 1.5], decay: [0.6, 0.97], tense: [0, 1.5], anchorR: [0.3, 1.3],
    });
    const gl = this.gl;
    this.pStep = makeProgram(gl, STEP);
    this.pDens = makeProgram(gl, DENS_FS, { vert: DENS_VS });
    this.pLine = makeProgram(gl, LINE_FS, { vert: LINE_VS });
    this.pDecay = makeProgram(gl, DECAY);
    this.pCopy = makeProgram(gl, COPY);
    this.emptyVao = gl.createVertexArray()!;
    this.anchTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.anchTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, THREADS, 1, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.state = new PingPong(gl, NODES, THREADS, res.caps.simFormat);
    this.dens = createTarget(gl, DENS, DENS, res.caps.accumFormat, gl.LINEAR, gl.CLAMP_TO_EDGE);
    this.resize(vp);
  }

  resize(vp: Viewport): void {
    this.w = vp.simW; this.h = vp.simH; this.aspect = vp.simW / Math.max(1, vp.simH);
    this.ink?.dispose();
    this.ink = new PingPong(this.gl, this.w, this.h, this.res.caps.accumFormat);
    this.reset();
  }

  /** Ancres d'un fil : deux points d'un cercle, presque opposés. */
  private setAnchor(t: number, seed: number, radius: number): void {
    const a = seed * 2.399963; // angle d'or
    const spanned = a + Math.PI * (0.75 + 0.5 * ((seed * 0.618034) % 1));
    this.anch[t * 4] = Math.cos(a) * radius;
    this.anch[t * 4 + 1] = Math.sin(a) * radius;
    this.anch[t * 4 + 2] = Math.cos(spanned) * radius;
    this.anch[t * 4 + 3] = Math.sin(spanned) * radius;
  }

  private uploadAnchors(): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.anchTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, THREADS, 1, gl.RGBA, gl.FLOAT, this.anch);
  }

  reset(): void {
    const gl = this.gl;
    const R = this.res.matrix.get("stitch.params.anchorR") || 0.95;
    for (let t = 0; t < THREADS; t++) this.setAnchor(t, t, R);
    this.uploadAnchors();
    // Chaque fil part droit entre ses ancres, avec un peu de bruit (sinon les
    // fils sont colinéaires et la répulsion n'a rien à casser).
    const data = new Float32Array(NODES * THREADS * 4);
    for (let t = 0; t < THREADS; t++) {
      const ax = this.anch[t * 4], ay = this.anch[t * 4 + 1], bx = this.anch[t * 4 + 2], by = this.anch[t * 4 + 3];
      for (let n = 0; n < NODES; n++) {
        const u = n / (NODES - 1);
        const j = (t * NODES + n) * 4;
        const wob = Math.sin(u * Math.PI) * 0.12 * Math.sin(t * 2.7 + u * 9.0);
        data[j] = ax + (bx - ax) * u - (by - ay) * wob;
        data[j + 1] = ay + (by - ay) * u + (bx - ax) * wob;
        data[j + 2] = 0; data[j + 3] = 0;
      }
    }
    for (const tgt of [this.state.read, this.state.write]) {
      gl.bindTexture(gl.TEXTURE_2D, tgt.tex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, NODES, THREADS, gl.RGBA, gl.FLOAT, data);
    }
    for (const tgt of [this.ink.read, this.ink.write]) {
      bindTarget(gl, tgt.fbo, this.w, this.h);
      gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    }
    this.stitches = 0;
  }

  update(fr: BusFrame, dt: number, time: number): void {
    // Le dt fourni est BORNÉ à 1/20 s par RenderLoop (protection des simulations
    // après un blocage). Pour la décroissance il faut le temps RÉELLEMENT écoulé,
    // sinon la compensation ne corrige qu'un tiers du problème quand le rAF est
    // bridé à ~1,3 Hz (fenêtre non focalisée).
    const reel = this.lastTime < 0 ? dt : Math.min(1, Math.max(1 / 1000, time - this.lastTime));
    this.lastTime = time; this.lastDt = reel;
    const gl = this.gl; const m = this.res.matrix;

    // Recoudre : une frappe décroche un fil et le rejette ailleurs.
    const R = Math.max(0.2, m.get("stitch.params.anchorR"));
    if (fr.kickFired || fr.snareFired) {
      const t = this.stitches % THREADS;
      this.setAnchor(t, this.stitches + (fr.kickFired ? 0 : 0.5), R * (fr.kickFired ? 1 : 0.72));
      this.stitches++;
      this.uploadAnchors();
    }

    // 1) champ de densité : tous les noeuds, additif
    bindTarget(gl, this.dens.fbo, DENS, DENS);
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(this.pDens.program);
    gl.uniform1i(gl.getUniformLocation(this.pDens.program, "uState"), 0);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.state.read.tex);
    gl.uniform1i(gl.getUniformLocation(this.pDens.program, "uNodes"), NODES);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.POINTS, 0, NODES * THREADS);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);

    // 2) relaxation. dt borné par la raideur (CFL) : stiff·dt² < 1.
    const stiff = Math.max(1, m.get("stitch.params.stiff"));
    const dtp = Math.min(m.get("stitch.params.dt"), 0.8 / Math.sqrt(stiff));
    const treble = melBand(fr, 22, 32);
    bindTarget(gl, this.state.write.fbo, NODES, THREADS);
    drawFullscreen(gl, this.pStep, {
      uState: this.state.read.tex, uAnch: this.anchTex, uDens: this.dens.tex,
      uStiff: stiff, uRepel: m.get("stitch.params.repel"), uDamp: Math.min(0.999, m.get("stitch.params.damp")),
      uDt: dtp, uVmax: m.get("stitch.params.vmax"),
      uSwirl: m.get("stitch.params.swirl"), uSpread: m.get("stitch.params.spread") + treble * 0.08,
      uNodes: NODES,
    });
    this.state.swap();
  }

  render(target: WebGLFramebuffer | null, w: number, h: number): void {
    const gl = this.gl; const m = this.res.matrix;
    // encre atténuée (traînées de tissage)
    bindTarget(gl, this.ink.write.fbo, this.w, this.h);
    gl.disable(gl.BLEND);
    drawFullscreen(gl, this.pDecay, { uTex: this.ink.read.tex, uDecay: decayDt(Math.min(0.97, m.get("stitch.params.decay")), this.lastDt) });
    // segments additifs
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(this.pLine.program);
    gl.uniform1i(gl.getUniformLocation(this.pLine.program, "uState"), 0);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.state.read.tex);
    gl.uniform1i(gl.getUniformLocation(this.pLine.program, "uNodes"), NODES);
    gl.uniform1f(gl.getUniformLocation(this.pLine.program, "uAspect"), this.aspect);
    gl.uniform1f(gl.getUniformLocation(this.pLine.program, "uHue"), m.get("global.baseHue"));
    gl.uniform1f(gl.getUniformLocation(this.pLine.program, "uTense"), m.get("stitch.params.tense"));
    gl.uniform1f(gl.getUniformLocation(this.pLine.program, "uGain"), gainDt(m.get("stitch.params.gain"), this.lastDt));
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.LINES, 0, THREADS * (NODES - 1) * 2);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
    this.ink.swap();
    bindTarget(gl, target, w, h);
    drawFullscreen(gl, this.pCopy, { uTex: this.ink.read.tex });
  }

  dispose(): void {
    const gl = this.gl;
    this.state?.dispose(); this.ink?.dispose();
    if (this.dens) { gl.deleteTexture(this.dens.tex); gl.deleteFramebuffer(this.dens.fbo); }
    gl.deleteTexture(this.anchTex);
    unregister(this.res.matrix.targets, this.id);
  }
}

// moyenne d'une plage de bandes mel (F.MEL0 = base des 32 bandes)
function melBand(fr: BusFrame, a: number, b: number): number {
  let s = 0;
  for (let i = a; i < b; i++) s += fr.feat[F.MEL0 + i];
  return s / Math.max(1, b - a);
}
