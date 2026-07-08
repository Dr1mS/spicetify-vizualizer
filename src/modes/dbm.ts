// dbm.ts — Dielectric Breakdown Model / figures de Lichtenberg (foudre) — famille GROWTH.
// Deux champs en ping-pong (état float RGBA) : canal R = masque CLUSTER C (1=amas),
// canal G = POTENTIEL φ, canal B = MASQUE DE NAISSANCE (1 la frame où une cellule
// rejoint l'amas, sinon 0 ; recalculé à chaque croissance, jamais décru).
//
// Par frame :
//   (1) RELAXATION de Laplace de φ par Jacobi (N itérations). Chaque itération
//       RECONDUIT R et B inchangés et RÉAPPLIQUE les CL à chaque passe :
//       φ=1 aux bords de l'écran, φ=0 là où C=1. (Sinon l'intérieur lave les CL.)
//   (2) CROISSANCE : cellules de FRONTIÈRE (adjacentes à l'amas, pas amas) ->
//       proba de devenir amas ∝ φ^η (DBM). hash(uv+uTime) < (φ^η)*taux. Damier
//       (parité (x+y+frame)&1) pour des filaments fins (pas des blobs). η (branchitude)
//       et le taux sont pilotés par l'audio ; le taux bondit sur onset -> ÉCLAIR.
//       On sample u_melf(uv.x) pour moduler LOCALEMENT le taux (nourriture spectrale).
//   Rendu (family growth) : accumulation À DÉCROISSANCE du front de naissance B :
//       accum = accum*decay + B*bright  -> figure de foudre lumineuse, hue(baseHue).
//
// La décroissance vit UNIQUEMENT dans l'accum (B n'est jamais décru). uTime varié
// par passe pour décorréler le hash. Laplace complet (Jacobi borné 4..20 iters).
import { makeProgram, drawFullscreen, bindTarget } from "../core/fullscreen";
import { PingPong } from "../core/pingpong";
import { registerParams, unregister, getParam } from "../modmatrix/targets";
import type { Mode, Resources } from "./Mode";
import type { BusFrame } from "../audio/bus";
import type { Viewport } from "../core/loop";

// --- germination : amas = disque au centre, φ=0 partout, B=0.
const SEED = `#version 300 es
in vec2 v_uv; out vec4 o;
uniform float uAspect;
void main(){
  vec2 d = v_uv - 0.5; d.x *= uAspect;
  float c = (dot(d,d) < 0.0009) ? 1.0 : 0.0;   // rayon ~0.03
  o = vec4(c, 0.0, 0.0, 1.0);
}`;

// --- une itération de relaxation de Laplace (Jacobi) sur φ (canal G).
// R (cluster) et B (naissance) reconduits inchangés. CL réappliquées CHAQUE passe.
const RELAX = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D uState; uniform vec2 uTexel;
void main(){
  vec4 s = texture(uState, v_uv);
  float c = s.r;
  // bord de l'écran : Dirichlet φ=1 (électrode lointaine à haut potentiel).
  if (v_uv.x < uTexel.x || v_uv.x > 1.0 - uTexel.x ||
      v_uv.y < uTexel.y || v_uv.y > 1.0 - uTexel.y) {
    o = vec4(c, 1.0, s.b, 1.0); return;
  }
  // amas : Dirichlet φ=0 (conducteur mis à la masse).
  if (c > 0.5) { o = vec4(c, 0.0, s.b, 1.0); return; }
  // intérieur libre : moyenne des 4 voisins (Laplace = 0).
  float l = texture(uState, v_uv + vec2(-uTexel.x, 0.0)).g;
  float r = texture(uState, v_uv + vec2( uTexel.x, 0.0)).g;
  float d = texture(uState, v_uv + vec2(0.0, -uTexel.y)).g;
  float u = texture(uState, v_uv + vec2(0.0,  uTexel.y)).g;
  float phi = 0.25 * (l + r + d + u);
  o = vec4(c, clamp(phi, 0.0, 1.0), s.b, 1.0);
}`;

// --- croissance stochastique : frontière -> amas avec proba ∝ φ^η (damier).
// {common:true} -> u_melf/hash22/precision déjà préfixés (NE PAS redéclarer).
const GROW = `#version 300 es
in vec2 v_uv; out vec4 o;
uniform sampler2D uState; uniform vec2 uTexel;
uniform float uEta, uRate, uTime, uMelAmt;
uniform vec2 uSimRes;   // (w,h) pour la parité damier
void main(){
  vec4 s = texture(uState, v_uv);
  float c = s.r;
  // déjà amas : reste amas, éteint son masque de naissance (B géré cette frame).
  if (c > 0.5) { o = vec4(c, s.g, 0.0, 1.0); return; }
  // cellule libre : est-elle en FRONTIÈRE (>=1 voisin amas) ?
  float nc = texture(uState, v_uv + vec2(-uTexel.x, 0.0)).r
           + texture(uState, v_uv + vec2( uTexel.x, 0.0)).r
           + texture(uState, v_uv + vec2(0.0, -uTexel.y)).r
           + texture(uState, v_uv + vec2(0.0,  uTexel.y)).r;
  if (nc < 0.5) { o = vec4(0.0, s.g, 0.0, 1.0); return; }  // pas frontière
  // parité damier (x+y+frame)&1 -> filaments fins, pas de blobs.
  ivec2 px = ivec2(floor(v_uv * uSimRes));
  int frame = int(floor(uTime * 60.0));
  if (((px.x + px.y + frame) & 1) == 1) { o = vec4(0.0, s.g, 0.0, 1.0); return; }
  // proba DBM : φ^η * taux, modulé localement par le spectre (nourriture).
  float phi = clamp(s.g, 0.0, 1.0);
  float p = pow(max(phi, 0.0), uEta);
  float food = 1.0 + uMelAmt * u_melf(v_uv.x);
  float thresh = clamp(p * uRate * food, 0.0, 1.0);
  float rnd = hash22(v_uv * uSimRes + vec2(uTime * 91.7, uTime * 47.3)).x;
  if (rnd < thresh) {
    o = vec4(1.0, 0.0, 1.0, 1.0);   // nouvel amas : C=1, φ=0, B=1 (naissance)
  } else {
    o = vec4(0.0, s.g, 0.0, 1.0);
  }
}`;

// --- accumulation à décroissance : accum = accum*decay + B*bright.
// B (canal .b de l'état) = front de naissance de CETTE frame -> glow qui décroît.
const ACCUM = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D uAccum; uniform sampler2D uState;
uniform float uDecay, uBright, uHue;
uniform vec3 uHueRGB;
void main(){
  vec3 prev = texture(uAccum, v_uv).rgb * uDecay;
  float birth = texture(uState, v_uv).b;
  vec3 add = uHueRGB * (birth * uBright);
  o = vec4(prev + add, 1.0);
}`;

// --- sortie : copie de l'accum vers la scène (densité colorée).
const COPY = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D uTex;
void main(){ o = vec4(texture(uTex, v_uv).rgb, 1.0); }`;

export class DbmMode implements Mode {
  id = "dbm";
  family = "growth" as const;
  private gl!: WebGL2RenderingContext;
  private res!: Resources;
  private state!: PingPong;   // R=cluster, G=φ, B=naissance
  private accum!: PingPong;   // glow décroissant du front
  private w = 0; private h = 0;
  private pSeed: any; private pRelax: any; private pGrow: any; private pAccum: any; private pCopy: any;
  private time = 0;
  private growBoost = 0;      // enveloppe d'éclair (spiked on onset), décroît

  init(res: Resources, vp: Viewport): void {
    this.res = res; this.gl = res.gl;
    registerParams(res.matrix.targets, this.id, {
      eta: 1.2,        // branchitude (DBM) : 1 = dense, >2 = filaments
      rate: 1.6,       // taux de croissance de base
      iters: 18,       // itérations Jacobi par frame
      melAmt: 0.6,     // gain de la nourriture spectrale locale
      decay: 0.94,     // décroissance du glow d'accumulation
      bright: 0.32,    // intensité additive du front de naissance
      kickBoost: 1.8,  // amplitude de l'éclair sur onset/kick
    }, {
      eta: [1.0, 6.0], rate: [0.05, 2.0], iters: [4, 20], melAmt: [0, 2],
      decay: [0.85, 0.985], bright: [0.05, 0.4], kickBoost: [0, 4],
    });
    this.pSeed = makeProgram(this.gl, SEED, { common: true });
    this.pRelax = makeProgram(this.gl, RELAX);
    this.pGrow = makeProgram(this.gl, GROW, { common: true });
    this.pAccum = makeProgram(this.gl, ACCUM);
    this.pCopy = makeProgram(this.gl, COPY);
    this.resize(vp);
  }

  resize(vp: Viewport): void {
    this.w = vp.simW; this.h = vp.simH;
    this.state?.dispose();
    this.accum?.dispose();
    // état : entiers exacts (C,B ∈ {0,1}) tenus par simFormat ; NEAREST + CLAMP.
    this.state = new PingPong(this.gl, this.w, this.h, this.res.caps.simFormat, this.gl.NEAREST, this.gl.CLAMP_TO_EDGE);
    this.accum = new PingPong(this.gl, this.w, this.h, this.res.caps.accumFormat, this.gl.NEAREST, this.gl.CLAMP_TO_EDGE);
    this.reset();
  }

  reset(): void {
    const gl = this.gl;
    // amas seedé au centre, φ=0, B=0.
    bindTarget(gl, this.state.write.fbo, this.w, this.h);
    drawFullscreen(gl, this.pSeed, { uAspect: this.w / this.h });
    this.state.swap();
    // accum vidé.
    bindTarget(gl, this.accum.write.fbo, this.w, this.h);
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    this.accum.swap();
    this.time = 0; this.growBoost = 0;
  }

  update(fr: BusFrame, dt: number, time: number): void {
    const gl = this.gl; const m = this.res.matrix;
    this.time = time;
    const bdt = Math.min(Math.max(dt, 0), 0.05); // dt borné
    // éclair : onset/kick font bondir le taux ; décroissance exponentielle bornée.
    this.growBoost *= Math.exp(-bdt * 6.0);
    if (fr.onsetFired || fr.kickFired) {
      this.growBoost = Math.min(this.growBoost + getParam(m.targets, "dbm.params.kickBoost", 1.8), 6.0);
    }
    const texel: [number, number] = [1 / this.w, 1 / this.h];

    // (1) relaxation de Laplace : N itérations Jacobi bornées.
    const iters = Math.min(Math.max(Math.round(getParam(m.targets, "dbm.params.iters", 14)), 4), 20);
    for (let i = 0; i < iters; i++) {
      bindTarget(gl, this.state.write.fbo, this.w, this.h);
      drawFullscreen(gl, this.pRelax, { uState: this.state.read.tex, uTexel: texel });
      this.state.swap();
    }

    // (2) croissance stochastique (une passe damier).
    const eta = Math.min(Math.max(m.get("dbm.params.eta"), 0.5), 8.0);
    const rate = Math.max(m.get("dbm.params.rate"), 0) * (1.0 + this.growBoost);
    bindTarget(gl, this.state.write.fbo, this.w, this.h);
    drawFullscreen(gl, this.pGrow, {
      uState: this.state.read.tex, uTexel: texel,
      uEta: eta, uRate: Math.min(rate, 4.0), uTime: time,
      uMelAmt: Math.max(m.get("dbm.params.melAmt"), 0),
      uSimRes: [this.w, this.h],
      // sample u_melf dans ce frag -> lier features ici (main.ts ne les lie qu'au tonemap).
      u_feat: this.res.feat.tex, u_melCount: 32,
    });
    this.state.swap();
  }

  render(target: WebGLFramebuffer | null, w: number, h: number): void {
    const gl = this.gl; const m = this.res.matrix;
    const huev = m.get("global.baseHue");
    const col = hueRGB(huev);
    // accum = accum*decay + B*bright (la décroissance vit ICI, uniquement).
    bindTarget(gl, this.accum.write.fbo, this.w, this.h);
    drawFullscreen(gl, this.pAccum, {
      uAccum: this.accum.read.tex, uState: this.state.read.tex,
      uDecay: Math.min(Math.max(m.get("dbm.params.decay"), 0.0), 0.999),
      uBright: Math.max(m.get("dbm.params.bright"), 0),
      uHue: huev, uHueRGB: col,
    });
    this.accum.swap();
    // copie -> scène.
    bindTarget(gl, target, w, h);
    drawFullscreen(gl, this.pCopy, { uTex: this.accum.read.tex });
  }

  dispose(): void {
    this.state?.dispose();
    this.accum?.dispose();
    unregister(this.res.matrix.targets, this.id);
  }
}

// teinte -> RGB (même palette cosinus que hue() côté GLSL), CPU.
function hueRGB(h: number): [number, number, number] {
  const f = (p: number) => 0.5 + 0.5 * Math.cos(2 * Math.PI * (h + p));
  return [f(0), f(0.33), f(0.67)];
}
