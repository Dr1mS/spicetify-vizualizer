// greenberg.ts — automate cyclique de Greenberg-Hastings (famille CONTINUOUS, ping-pong).
// CA excitable à N états discrets : repos(0) -> excité(1) si un voisin est excité,
// puis période réfractaire (2..N-1) qui retombe au repos. Donne des spirales
// DISCRÈTES (version cellular-automaton des ondes cibles/spirales de FHN).
//
// Encodage : l'état entier s ∈ {0,1,..,N-1} est stocké TEL QUEL (float exact) dans
// le canal R du buffer de sim. Les comparaisons se font par seuil (< 0.5) -> robuste
// même en 16F (petits entiers exacts). L'avancée temporelle du CA est cadencée
// CPU-side (pas discrets), modulée par l'audio ; les onsets ensemencent des excités.
import { makeProgram, drawFullscreen, bindTarget } from "../core/fullscreen";
import { PingPong } from "../core/pingpong";
import { registerParams, unregister, getParam } from "../modmatrix/targets";
import type { Mode, Resources } from "./Mode";
import type { BusFrame } from "../audio/bus";
import type { Viewport } from "../core/loop";

// --- pas du CA : lit l'état des 8 voisins (Moore), applique la règle GH ---------
// Pas de common : shader pur entier, on déclare la précision nous-mêmes.
const STEP = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D uState; uniform vec2 uTexel; uniform float uN;
float st(vec2 off){ return texture(uState, v_uv + off*uTexel).r; }
void main(){
  float s = texture(uState, v_uv).r;
  if (s >= 0.5) {
    // réfractaire : avance d'un cran, retombe au repos en fin de cycle
    float ns = s + 1.0;
    o = vec4(ns >= (uN - 0.5) ? 0.0 : ns, 0., 0., 1.);
    return;
  }
  // repos : compte les voisins excités (état 1)
  float e = 0.0;
  e += step(0.5, 1.0 - abs(st(vec2( 1., 0.)) - 1.0));
  e += step(0.5, 1.0 - abs(st(vec2(-1., 0.)) - 1.0));
  e += step(0.5, 1.0 - abs(st(vec2( 0., 1.)) - 1.0));
  e += step(0.5, 1.0 - abs(st(vec2( 0.,-1.)) - 1.0));
  e += step(0.5, 1.0 - abs(st(vec2( 1., 1.)) - 1.0));
  e += step(0.5, 1.0 - abs(st(vec2(-1., 1.)) - 1.0));
  e += step(0.5, 1.0 - abs(st(vec2( 1.,-1.)) - 1.0));
  e += step(0.5, 1.0 - abs(st(vec2(-1.,-1.)) - 1.0));
  o = vec4(e >= 0.5 ? 1.0 : 0.0, 0., 0., 1.); // ≥1 voisin excité -> devient excité
}`;

// --- injection : un onset ensemence des cellules EXCITÉES (état 1) --------------
// {common:true} -> u_mel/u_feat + hash22 disponibles ; NE PAS redéclarer precision.
const INJECT = `#version 300 es
in vec2 v_uv; out vec4 o;
uniform sampler2D uState; uniform vec2 uPos; uniform float uRadius,uAspect,uDensity,uSpec;
void main(){
  float s = texture(uState, v_uv).r;
  vec2 d = v_uv - uPos; d.x *= uAspect;
  float g = exp(-dot(d,d)/uRadius);           // noyau gaussien autour de l'onset
  // grain aléatoire modulé par le spectre local (bande mel selon x) -> germes épars
  float rnd = hash22(v_uv*131.0 + uPos*7.0).x;
  float mel = u_melf(v_uv.x);
  float gate = uDensity + uSpec * mel;
  bool seed = (s < 0.5) && (rnd < gate * g);  // n'ensemence que des cellules au repos
  o = vec4(seed ? 1.0 : s, 0., 0., 1.);
}`;

// --- seed initial : quasi tout au repos, quelques excités épars (amorce spirales) --
const SEED = `#version 300 es
in vec2 v_uv; out vec4 o;
uniform float uN;
void main(){
  vec2 r = hash22(v_uv*97.0);
  // rares excités (état 1) + quelques réfractaires aléatoires -> brise la symétrie
  float s = 0.0;
  if (r.x > 0.985) s = 1.0;
  else if (r.y > 0.97) s = floor(r.x * (uN - 1.0)) + 1.0; // réfractaire aléatoire
  o = vec4(s, 0., 0., 1.);
}`;

// --- rendu : couleur selon l'état, densité pour les états actifs ----------------
const RENDER = `#version 300 es
in vec2 v_uv; out vec4 o;
uniform sampler2D uState; uniform float uHue,uBright,uN;
void main(){
  float s = texture(uState, v_uv).r;
  float phase = s / max(uN - 1.0, 1.0);       // 0..1 le long du cycle
  float alive = step(0.5, s);                 // repos -> noir
  // densité : pic sur le front excité (s=1), décroît sur la queue réfractaire
  float dens = alive * (0.35 + 0.65 * (1.0 - phase));
  vec3 col = hue(uHue + phase * 0.85) * dens * (0.6 + uBright);
  o = vec4(col, 1.);
}`;

const N_MIN = 8;
const N_MAX = 16;

export class GreenbergMode implements Mode {
  id = "greenberg"; family = "continuous" as const;
  private gl!: WebGL2RenderingContext; private res!: Resources;
  private state!: PingPong; private w = 0; private h = 0;
  private pStep: any; private pInject: any; private pSeed: any; private pRender: any;
  private acc = 0;    // accumulateur temporel pour cadencer les pas discrets
  private phase = 0;  // position d'injection dérivée des onsets

  init(res: Resources, vp: Viewport): void {
    this.res = res; this.gl = res.gl;
    registerParams(res.matrix.targets, this.id, {
      states: 12,        // N (états du cycle) — 8..16
      rate: 22,          // pas de CA par seconde (cadence de propagation)
      injRadius: 0.02,   // rayon du noyau d'injection (onset)
      injDensity: 0.05,  // densité de germes de base
      injSpectral: 0.9,  // gain de germes piloté par le spectre (mel)
    }, {
      states: [N_MIN, N_MAX], rate: [4, 60], injRadius: [0.004, 0.08],
      injDensity: [0, 0.4], injSpectral: [0, 2.5],
    });
    this.pStep = makeProgram(this.gl, STEP);
    this.pInject = makeProgram(this.gl, INJECT, { common: true });
    this.pSeed = makeProgram(this.gl, SEED, { common: true });
    this.pRender = makeProgram(this.gl, RENDER, { common: true });
    this.resize(vp);
  }

  resize(vp: Viewport): void {
    this.w = vp.simW; this.h = vp.simH;
    this.state?.dispose();
    // état de sim = simFormat, NEAREST + REPEAT (tore -> spirales qui bouclent)
    this.state = new PingPong(this.gl, this.w, this.h, this.res.caps.simFormat, this.gl.NEAREST, this.gl.REPEAT);
    this.reset();
  }

  reset(): void {
    const gl = this.gl;
    const N = this.states();
    bindTarget(gl, this.state.write.fbo, this.w, this.h);
    drawFullscreen(gl, this.pSeed, { uN: N });
    this.state.swap();
    this.acc = 0;
  }

  private states(): number {
    const n = Math.round(getParam(this.res.matrix.targets, "greenberg.params.states", 12));
    return Math.max(N_MIN, Math.min(N_MAX, n));
  }

  update(fr: BusFrame, dt: number): void {
    const gl = this.gl; const m = this.res.matrix;
    const N = this.states();

    // Cadence du CA : rate (piloté par l'énergie via la mod-matrix) -> vitesse de
    // propagation des fronts. On dérive le nb de pas discrets à faire cette frame.
    const rate = m.get("greenberg.params.rate", 22);
    const stepsPerSec = Math.max(1, rate);
    this.acc += dt * stepsPerSec;
    let steps = Math.floor(this.acc);
    this.acc -= steps;
    if (steps > 6) steps = 6; // borne : évite l'explosion après un stall

    const uTexel = [1 / this.w, 1 / this.h];
    for (let s = 0; s < steps; s++) {
      bindTarget(gl, this.state.write.fbo, this.w, this.h);
      drawFullscreen(gl, this.pStep, { uState: this.state.read.tex, uTexel, uN: N });
      this.state.swap();
    }

    // Onset -> ensemencement d'excités. Position dérivée du beat/hash (comme fhn).
    if (fr.onsetFired) {
      this.phase += 0.31;
      const px = 0.5 + Math.cos(this.phase * 6.283) * 0.32;
      const py = 0.5 + Math.sin(this.phase * 4.7) * 0.32;
      bindTarget(gl, this.state.write.fbo, this.w, this.h);
      drawFullscreen(gl, this.pInject, {
        uState: this.state.read.tex,
        uPos: [px, py],
        uRadius: m.get("greenberg.params.injRadius", 0.02),
        uAspect: this.w / this.h,
        uDensity: m.get("greenberg.params.injDensity", 0.05),
        uSpec: m.get("greenberg.params.injSpectral", 0.9),
        ...this.res.feat.uniforms(fr), // u_feat + u_melCount pour u_mel/u_melf
      });
      this.state.swap();
    }
  }

  render(target: WebGLFramebuffer | null, w: number, h: number): void {
    bindTarget(this.gl, target, w, h);
    drawFullscreen(this.gl, this.pRender, {
      uState: this.state.read.tex,
      uHue: this.res.matrix.get("global.baseHue"),
      uBright: this.res.matrix.get("global.brightness") - 1,
      uN: this.states(),
    });
  }

  dispose(): void { this.state?.dispose(); unregister(this.res.matrix.targets, this.id); }
}
