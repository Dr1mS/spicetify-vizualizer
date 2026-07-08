// ising.ts — modèle d'Ising 2D / verre de spin (famille CONTINUOUS, ping-pong).
// État = spin s ∈ {0,1} (canal R ; représente -1/+1 via 2s-1) sur un tore
// (NEAREST + REPEAT). À haute température le système est DÉSORDONNÉ (bruit) ;
// en refroidissant, des DOMAINES magnétiques cohérents se forment et grossissent.
//
// Mise à jour en DAMIER : à chaque pas on ne touche que les cellules de parité
// (x+y+frame)%2==0, l'autre parité à la frame suivante. Cela évite les races de
// voisinage (deux cellules voisines ne sont jamais mises à jour simultanément).
//
// Metropolis : pour une cellule active, H = somme des 4 spins voisins ; le flip
// coûte dE = 2*(2s-1)*H ; on FLIP si dE<0, sinon si hash(uv+uTime) < exp(-dE/T).
// T (température) est pilotée par l'audio : énergie/rms hautes -> désordre ;
// basses -> domaines. Un onset = coup thermique (T monte brièvement, CPU-side).
//
// Encodage : s ∈ {0,1} stocké tel quel (entier exact, robuste même en 16F).
import { makeProgram, drawFullscreen, bindTarget } from "../core/fullscreen";
import { PingPong } from "../core/pingpong";
import { registerParams, unregister, getParam } from "../modmatrix/targets";
import type { Mode, Resources } from "./Mode";
import type { BusFrame } from "../audio/bus";
import type { Viewport } from "../core/loop";

// --- pas Metropolis en damier ---------------------------------------------------
// Pas de common : shader pur, on déclare precision + un hash local (uv+temps).
const STEP = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D uState; uniform vec2 uTexel; uniform float uTemp, uParity, uTime;
float h11(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float sp(vec2 off){ return 2.0 * texture(uState, v_uv + off*uTexel).r - 1.0; } // spin voisin -1/+1
void main(){
  float s = texture(uState, v_uv).r;                 // 0 ou 1
  ivec2 ip = ivec2(gl_FragCoord.xy);
  // damier : ne met à jour que la parité active cette frame
  if (mod(float(ip.x + ip.y) + uParity, 2.0) >= 0.5) { o = vec4(s, 0., 0., 1.); return; }
  float spin = 2.0 * s - 1.0;                         // -1 / +1
  float Hn = sp(vec2( 1., 0.)) + sp(vec2(-1., 0.))
           + sp(vec2( 0., 1.)) + sp(vec2( 0.,-1.));   // somme des 4 voisins
  float dE = 2.0 * spin * Hn;                          // coût énergétique du flip
  float r = h11(v_uv * 511.0 + uTime);
  float T = max(uTemp, 0.02);
  bool flip = (dE < 0.0) || (r < exp(-dE / T));       // Metropolis
  float ns = flip ? (1.0 - s) : s;
  o = vec4(ns, 0., 0., 1.);
}`;

// --- coup thermique local (onset) : randomise des spins autour d'un point --------
// {common:true} -> u_mel/u_melf + hash22 dispo ; NE PAS redéclarer precision.
const KICK = `#version 300 es
in vec2 v_uv; out vec4 o;
uniform sampler2D uState; uniform vec2 uPos; uniform float uRadius, uAspect, uAmount, uSpec;
void main(){
  float s = texture(uState, v_uv).r;
  vec2 d = v_uv - uPos; d.x *= uAspect;
  float g = exp(-dot(d,d) / uRadius);                 // noyau gaussien autour de l'onset
  float mel = u_melf(v_uv.x);                          // grain modulé par le spectre local
  float rnd = hash22(v_uv * 173.0 + uPos * 11.0).x;
  float gate = (uAmount + uSpec * mel) * g;           // proba de re-randomiser ce spin
  float flipped = step(0.5, hash22(v_uv * 91.0 + uPos).y); // nouveau spin aléatoire
  o = vec4((rnd < gate) ? flipped : s, 0., 0., 1.);
}`;

// --- seed : spins aléatoires 50/50 (état paramagnétique de départ) --------------
const SEED = `#version 300 es
in vec2 v_uv; out vec4 o;
void main(){
  float r = hash22(v_uv * 97.0).x;
  o = vec4(step(0.5, r), 0., 0., 1.);
}`;

// --- rendu : domaines colorés + frontières éclairées ----------------------------
// Densité = |s - moyenne des 4 voisins| -> pic sur les parois de domaine.
const RENDER = `#version 300 es
in vec2 v_uv; out vec4 o;
uniform sampler2D uState; uniform vec2 uTexel; uniform float uHue, uBright, uEdge;
float st(vec2 off){ return texture(uState, v_uv + off*uTexel).r; }
void main(){
  float s = st(vec2(0.));
  float nb = 0.25 * (st(vec2(1.,0.)) + st(vec2(-1.,0.)) + st(vec2(0.,1.)) + st(vec2(0.,-1.)));
  float edge = abs(s - nb);                            // 0 à l'intérieur, ~1 aux parois
  // intérieur de domaine : teinte selon le spin (up vs down), luminosité modérée ;
  // parois : surbrillance additive nette -> structure lisible.
  float body = 0.10 + 0.14 * s;                        // up plus clair que down
  float wall = uEdge * edge;                           // frontières éclairées
  float dens = (body + wall) * (0.6 + uBright);
  vec3 col = hue(uHue + s * 0.5 + edge * 0.15) * dens;
  o = vec4(col, 1.);
}`;

export class IsingMode implements Mode {
  id = "ising"; family = "continuous" as const;
  private gl!: WebGL2RenderingContext; private res!: Resources;
  private state!: PingPong; private w = 0; private h = 0;
  private pStep: any; private pKick: any; private pSeed: any; private pRender: any;
  private parity = 0;    // parité de damier alternée à chaque pas
  private time = 0;      // horloge accumulée -> varie le hash du pas
  private heat = 0;      // coup thermique décroissant déclenché par les onsets
  private phase = 0;     // position d'injection dérivée des onsets

  init(res: Resources, vp: Viewport): void {
    this.res = res; this.gl = res.gl;
    registerParams(res.matrix.targets, this.id, {
      temp: 2.2,          // température de base (unités J=1 ; Tc≈2.27 pour Ising 2D)
      substeps: 3,        // pas Metropolis par frame (paires de damier)
      edge: 1.1,          // gain de surbrillance des parois de domaine
      kickRadius: 0.03,   // rayon du coup thermique (onset)
      kickAmount: 0.5,    // fraction de spins re-randomisés au coeur du coup
      kickSpectral: 0.6,  // gain du grain piloté par le spectre (mel)
      onsetHeat: 1.6,     // élévation de T injectée par un onset
    }, {
      temp: [0.4, 4.0], substeps: [1, 8], edge: [0, 3],
      kickRadius: [0.005, 0.1], kickAmount: [0, 1], kickSpectral: [0, 2],
      onsetHeat: [0, 4],
    });
    this.pStep = makeProgram(this.gl, STEP);
    this.pKick = makeProgram(this.gl, KICK, { common: true });
    this.pSeed = makeProgram(this.gl, SEED, { common: true });
    this.pRender = makeProgram(this.gl, RENDER, { common: true });
    this.resize(vp);
  }

  resize(vp: Viewport): void {
    this.w = vp.simW; this.h = vp.simH;
    this.state?.dispose();
    // état de sim = simFormat ; NEAREST + REPEAT (tore -> domaines qui bouclent)
    this.state = new PingPong(this.gl, this.w, this.h, this.res.caps.simFormat, this.gl.NEAREST, this.gl.REPEAT);
    this.reset();
  }

  reset(): void {
    const gl = this.gl;
    bindTarget(gl, this.state.write.fbo, this.w, this.h);
    drawFullscreen(gl, this.pSeed, {});
    this.state.swap();
    this.parity = 0; this.time = 0; this.heat = 0;
  }

  update(fr: BusFrame, dt: number): void {
    const gl = this.gl; const m = this.res.matrix;
    // borne dt pour la robustesse (stall) et fais avancer l'horloge du hash
    const d = Math.min(Math.max(dt, 0), 0.1);
    this.time += d * 60;

    // coup thermique global : décroît en ~0.3 s
    this.heat = Math.max(0, this.heat - d * 3.0);
    if (fr.onsetFired) this.heat = Math.max(this.heat, m.get("ising.params.onsetHeat", 1.6));

    const baseTemp = m.get("ising.params.temp", 2.2);
    const T = Math.max(0.02, baseTemp + this.heat);

    let sub = Math.round(getParam(m.targets, "ising.params.substeps", 3));
    sub = Math.max(1, Math.min(8, sub));

    const uTexel = [1 / this.w, 1 / this.h];
    for (let s = 0; s < sub; s++) {
      bindTarget(gl, this.state.write.fbo, this.w, this.h);
      drawFullscreen(gl, this.pStep, {
        uState: this.state.read.tex, uTexel,
        uTemp: T, uParity: this.parity, uTime: this.time + s * 0.618,
      });
      this.state.swap();
      this.parity = this.parity === 0 ? 1 : 0; // alterne le damier -> couvre tout
    }

    // onset -> coup thermique LOCAL (re-randomise un patch de spins autour d'un point)
    if (fr.onsetFired) {
      this.phase += 0.31;
      const px = 0.5 + Math.cos(this.phase * 6.283) * 0.32;
      const py = 0.5 + Math.sin(this.phase * 4.7) * 0.32;
      bindTarget(gl, this.state.write.fbo, this.w, this.h);
      drawFullscreen(gl, this.pKick, {
        uState: this.state.read.tex,
        uPos: [px, py],
        uRadius: m.get("ising.params.kickRadius", 0.03),
        uAspect: this.w / this.h,
        uAmount: m.get("ising.params.kickAmount", 0.5),
        uSpec: m.get("ising.params.kickSpectral", 0.6),
        ...this.res.feat.uniforms(fr), // u_feat + u_melCount pour u_mel/u_melf
      });
      this.state.swap();
    }
  }

  render(target: WebGLFramebuffer | null, w: number, h: number): void {
    bindTarget(this.gl, target, w, h);
    drawFullscreen(this.gl, this.pRender, {
      uState: this.state.read.tex,
      uTexel: [1 / this.w, 1 / this.h],
      uHue: this.res.matrix.get("global.baseHue"),
      uBright: this.res.matrix.get("global.brightness") - 1,
      uEdge: this.res.matrix.get("ising.params.edge", 1.1),
    });
  }

  dispose(): void { this.state?.dispose(); unregister(this.res.matrix.targets, this.id); }
}
