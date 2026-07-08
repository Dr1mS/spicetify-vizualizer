// neuralca.ts — Neural Cellular Automata (famille CONTINUOUS, ping-pong).
// État = RGBA : canaux 0..2 = latents SIGNÉS (bornés par tanh, ∈[-1,1]),
// canal 3 = 'alive' (scalaire de vie POSITIF ∈[0,1]). POIDS FIXES choisis à la
// main (pas d'entraînement). PERCEPTION par cellule : [identité, sobelX·état,
// sobelY·état, laplacien·état] (8 voisins). UPDATE : petite 'couche' fixe =
// combinaisons linéaires des perceptions + tanh -> couplage réaction-diffusion
// entre canaux (motifs mouvants auto-organisés, PAS d'explosion). Masque alive :
// une cellule ne bouge que si un voisin a alpha>0.1. Onset = germe une cellule
// vivante. Rendu : latents -> couleur (mix hue(baseHue)), intensité = |latent|.
// Réactivité : gain de perception & taux pilotés par le spectre (u_melf + routes).
import { makeProgram, drawFullscreen, bindTarget } from "../core/fullscreen";
import { PingPong } from "../core/pingpong";
import { registerParams, unregister, getParam } from "../modmatrix/targets";
import type { Mode, Resources } from "./Mode";
import type { BusFrame } from "../audio/bus";
import type { Viewport } from "../core/loop";

// --- SIM : perception (sobel/laplacien) + couche fixe + tanh -----------------
// {common:true} -> precision/hue/u_mel/u_melf/TAU/hash déjà préfixés : ne PAS
// les redéclarer. On échantillonne les 8 voisins une fois, on en dérive les 4
// perceptions par canal, puis une petite règle linéaire fixe + tanh sur les
// latents (bornés par construction) et un canal 'alive' positif diffusé.
const SIM = `#version 300 es
in vec2 v_uv; out vec4 o;
uniform sampler2D uState; uniform vec2 uTexel;
uniform float uDt;        // pas d'intégration (borné CPU-side)
uniform float uPGain;     // gain de perception (piloté spectre)
uniform float uRate;      // taux d'update (piloté spectre)
uniform float uMelAmt;    // gain de la modulation spectrale spatiale

void main(){
  vec2 t = uTexel;
  // 8 voisins + centre (canaux 0..2 = latents, w = alive)
  vec4 c  = texture(uState, v_uv);
  vec4 n  = texture(uState, v_uv + vec2( 0.0,  t.y));
  vec4 s  = texture(uState, v_uv + vec2( 0.0, -t.y));
  vec4 e  = texture(uState, v_uv + vec2( t.x,  0.0));
  vec4 w  = texture(uState, v_uv + vec2(-t.x,  0.0));
  vec4 ne = texture(uState, v_uv + vec2( t.x,  t.y));
  vec4 nw = texture(uState, v_uv + vec2(-t.x,  t.y));
  vec4 se = texture(uState, v_uv + vec2( t.x, -t.y));
  vec4 sw = texture(uState, v_uv + vec2(-t.x, -t.y));

  // masque alive : la cellule ne se met à jour que si un voisin (ou elle) vit.
  float maxAlpha = max(max(max(c.w, n.w), max(s.w, e.w)),
                       max(max(w.w, ne.w), max(nw.w, max(se.w, sw.w))));
  float alive = step(0.1, maxAlpha);

  // --- perceptions (sur les 3 latents) : sobel X, sobel Y, laplacien ---------
  vec3 sobX = (ne.xyz + 2.0*e.xyz + se.xyz) - (nw.xyz + 2.0*w.xyz + sw.xyz);
  vec3 sobY = (nw.xyz + 2.0*n.xyz + ne.xyz) - (sw.xyz + 2.0*s.xyz + se.xyz);
  vec3 lap  = (n.xyz + s.xyz + e.xyz + w.xyz)
            + 0.5*(ne.xyz + nw.xyz + se.xyz + sw.xyz)
            - 6.0*c.xyz;
  sobX *= 0.125; sobY *= 0.125;   // normalisation ~sobel
  // modulation spectrale spatiale : la bande mel locale enfle la perception là
  // où le spectre est chaud (réactivité audio -> zones plus vivantes).
  float pg = uPGain * (1.0 + uMelAmt * u_melf(v_uv.x));

  vec3 id = c.xyz;
  // --- couche FIXE : couplage réaction-diffusion inter-canaux ----------------
  // dérivées choisies à la main pour une dynamique vivante bornée :
  //  canal0 : diffuse (lap) + tourne selon le gradient (sobel) -> ondes glissantes
  //  canal1 : activé par canal0, tourné par sobel Y -> anti-phase, motifs cibles
  //  canal2 : lent, inhibé par canal1 -> réservoir/refractaire
  vec3 d;
  d.x = pg * ( 0.55*lap.x + 0.60*sobX.y - 0.45*sobY.z + 0.35*id.y - 0.30*id.z );
  d.y = pg * ( 0.50*lap.y - 0.55*sobX.x + 0.40*sobY.z + 0.45*id.x - 0.25*id.y );
  d.z = pg * ( 0.30*lap.z + 0.35*sobX.y + 0.25*id.y   - 0.20*id.z );

  // intégration bornée : nouvel état = tanh(état + dt*d) -> latents ∈(-1,1).
  vec3 nl = tanh(id + uRate * uDt * d);

  // --- alive : scalaire de vie POSITIF, diffusé + entretenu par l'activité ----
  // moyenne des alphas voisins (diffusion) ; gain si latents actifs, léger déclin.
  float avgA = (n.w + s.w + e.w + w.w + ne.w + nw.w + se.w + sw.w) * 0.125;
  float act  = length(nl);                 // vitalité des latents ∈[0,~1.7]
  float na   = mix(c.w, avgA, 0.25);       // diffusion douce de la vie
  na += uRate * uDt * (0.6 * act - 0.15);  // gagne si actif, décline sinon
  na = clamp(na, 0.0, 1.0);

  // hors zone vivante : on GÈLE la cellule (latents & alive inchangés).
  vec3 outL = mix(id, nl, alive);
  float outA = mix(c.w, na, alive);
  o = vec4(outL, outA);
}`;

// --- INJECT : germe une cellule vivante (onset) -----------------------------
// splat gaussien : alive->1 + latents aléatoires signés (graine de croissance).
const INJECT = `#version 300 es
in vec2 v_uv; out vec4 o;
uniform sampler2D uState; uniform vec2 uPos;
uniform float uRadius, uAspect, uSeed;
void main(){
  vec4 c = texture(uState, v_uv);
  vec2 dd = v_uv - uPos; dd.x *= uAspect;
  float g = exp(-dot(dd, dd) / uRadius);
  // latents aléatoires signés (hash de la position + seed variable par onset)
  vec2 r1 = hash22(v_uv * 41.0 + uSeed);
  vec2 r2 = hash22(v_uv * 71.0 - uSeed);
  vec3 rl = (vec3(r1, r2.x) - 0.5) * 2.0;
  vec3 lat = mix(c.xyz, rl, g);
  float a  = clamp(c.w + g, 0.0, 1.0);
  o = vec4(lat, a);
}`;

// --- SEED : quelques amas vivants sur fond mort (pas le vide total) ----------
// il faut des cellules alive>0.1 dès la frame 1 sinon le masque gèle tout.
const SEED = `#version 300 es
in vec2 v_uv; out vec4 o;
void main(){
  vec2 cell = floor(v_uv * 10.0);
  float r = hash22(cell * 5.7).x;
  float alive = 0.0;
  vec3 lat = vec3(0.0);
  if (r > 0.62) {
    vec2 c = (cell + 0.5) / 10.0;
    vec2 dd = v_uv - c;
    float g = exp(-dot(dd, dd) * 700.0);
    alive = g;
    // latents initiaux signés, corrélés à la cellule -> amas distincts
    vec2 q1 = hash22(cell * 13.1);
    float q2 = hash22(cell * 27.3 + 4.0).x;
    lat = (vec3(q1, q2) - 0.5) * 2.0 * g;
  }
  o = vec4(lat, clamp(alive, 0.0, 1.0));
}`;

// --- RENDER : latents -> couleur. max(rgb)=intensité, teinte via hue(). ------
// intensité = longueur du vecteur latent (pondérée par alive pour éviter le
// bruit dans les zones mortes). teinte décalée par les canaux latents.
const RENDER = `#version 300 es
in vec2 v_uv; out vec4 o;
uniform sampler2D uState; uniform float uHue, uBright;
void main(){
  vec4 c = texture(uState, v_uv);
  float mag = length(c.xyz) * smoothstep(0.05, 0.4, c.w); // vitalité visible
  float d = clamp(mag, 0.0, 1.5) * (0.45 + uBright);
  // teinte : baseHue + structure des latents (canal0 vs canal2)
  float tint = uHue + c.x * 0.12 - c.z * 0.08;
  vec3 col = hue(tint) * d;
  o = vec4(col, 1.0);
}`;

export class NeuralCAMode implements Mode {
  id = "neuralca"; family = "continuous" as const;
  private gl!: WebGL2RenderingContext; private res!: Resources;
  private state!: PingPong; private w = 0; private h = 0;
  private pSim: any; private pInj: any; private pSeed: any; private pRender: any;
  private phase = 0; private seed = 0;

  init(res: Resources, vp: Viewport): void {
    this.res = res; this.gl = res.gl;
    registerParams(res.matrix.targets, this.id, {
      pGain: 1.0, rate: 0.9, melAmt: 0.6, injRadius: 0.003,
    }, {
      pGain: [0.4, 1.8], rate: [0.3, 1.6], melAmt: [0, 1.5], injRadius: [0.001, 0.01],
    });
    this.pSim = makeProgram(this.gl, SIM, { common: true });
    this.pInj = makeProgram(this.gl, INJECT, { common: true });
    this.pSeed = makeProgram(this.gl, SEED, { common: true });
    this.pRender = makeProgram(this.gl, RENDER, { common: true });
    this.resize(vp);
  }

  resize(vp: Viewport): void {
    this.w = vp.simW; this.h = vp.simH;
    this.state?.dispose();
    // état de sim = simFormat (rule 9) ; NEAREST + REPEAT (tore).
    this.state = new PingPong(this.gl, this.w, this.h, this.res.caps.simFormat, this.gl.NEAREST, this.gl.REPEAT);
    this.reset();
  }

  reset(): void {
    const gl = this.gl;
    bindTarget(gl, this.state.write.fbo, this.w, this.h);
    drawFullscreen(gl, this.pSeed, {});
    this.state.swap();
  }

  update(fr: BusFrame, _dt: number): void {
    const gl = this.gl; const m = this.res.matrix;
    // pas d'intégration borné pour la stabilité (tanh borne déjà l'état, mais on
    // garde dt·rate modéré pour une évolution fluide).
    const rate = Math.min(getParam(m.targets, "neuralca.params.rate", 0.9), 1.6);
    const uni = {
      uTexel: [1 / this.w, 1 / this.h],
      uDt: 1.0,
      uPGain: m.get("neuralca.params.pGain"),
      uRate: rate,
      uMelAmt: m.get("neuralca.params.melAmt"),
      // features audio dans le shader (main.ts ne les lie qu'au tonemap).
      u_feat: this.res.feat.tex, u_melCount: 32,
    };
    // substeps 1 (spec) : un pas NCA par frame.
    bindTarget(gl, this.state.write.fbo, this.w, this.h);
    drawFullscreen(gl, this.pSim, { ...uni, uState: this.state.read.tex });
    this.state.swap();

    // onset -> ensemence une cellule vivante (position dérivée d'un hash de phase).
    if (fr.onsetFired) {
      this.phase += 0.31; this.seed += 1.7;
      const px = 0.5 + Math.cos(this.phase * 6.283) * 0.32;
      const py = 0.5 + Math.sin(this.phase * 4.7) * 0.32;
      bindTarget(gl, this.state.write.fbo, this.w, this.h);
      drawFullscreen(gl, this.pInj, {
        uState: this.state.read.tex, uPos: [px, py],
        uRadius: m.get("neuralca.params.injRadius"),
        uAspect: this.w / this.h, uSeed: this.seed,
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
    });
  }

  dispose(): void { this.state?.dispose(); unregister(this.res.matrix.targets, this.id); }
}
