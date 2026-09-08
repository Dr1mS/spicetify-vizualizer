// hocket.ts — CARTOGRAPHIE RYTHMIQUE (création originale, famille CONTINUOUS).
//
// L'idée : chaque voix percussive est un PEUPLE qui conquiert le plan. Un kick,
// une caisse claire, un charley plantent un germe ; le territoire se propage par
// contagion de proche en proche, avec une force qui décroît à chaque case gagnée
// (le front s'arrête donc à une distance proportionnelle à l'énergie du coup).
// L'image finit par être la CARTE du groove : qui joue, où, et depuis quand.
//
// État (RGBA16F) : R = propriétaire (0=kick, 1=snare, 2=hats, 3=onset "autre"),
// G = force (0..1), B = âge depuis la conquête (s), A = libre.
//
// Deux règles rendent la carte lisible plutôt que bouillonnante :
//   - MARGE d'hystérésis : un voisin ne prend une case que s'il dépasse
//     l'occupant d'une marge — sans ça le réseau oscille à chaque frame ;
//   - la propriété SURVIT à la force : une région conquise garde sa couleur en
//     sourdine (plancher de luminosité) même sans nouveau coup. La carte persiste.
import { makeProgram, drawFullscreen, bindTarget } from "../core/fullscreen";
import { PingPong } from "../core/pingpong";
import { registerParams, unregister } from "../modmatrix/targets";
import type { Mode, Resources } from "./Mode";
import type { BusFrame } from "../audio/bus";
import { decayDt } from "../core/loop";
import type { Viewport } from "../core/loop";


const SEED = `#version 300 es
in vec2 v_uv; out vec4 o;
void main(){
  // Personne ne possède rien : propriétaire "onset", force nulle, âge élevé.
  o = vec4(3.0, 0.0, 9.0, 0.0);
}`;

// Un pas de conquête. Chaque case regarde ses 8 voisins et cède au plus fort,
// à condition qu'il dépasse la MARGE. La force transmise est amputée (uYield),
// ce qui borne la portée d'un coup.
const STEP = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D uState; uniform vec2 uTexel;
uniform float uDecay, uSpread, uMargin, uYield, uDt;
void main(){
  vec4 me = texture(uState, v_uv);
  float owner = me.r;
  float str = me.g * uDecay;
  float bestS = -1.0; float bestO = owner;
  for (int i = 0; i < 8; i++) {
    vec2 d = vec2(
      i == 0 ? 1.0 : i == 1 ? -1.0 : i == 4 ? 1.0 : i == 5 ? -1.0 : i == 6 ? 1.0 : i == 7 ? -1.0 : 0.0,
      i == 2 ? 1.0 : i == 3 ? -1.0 : i == 4 ? 1.0 : i == 5 ? -1.0 : i == 6 ? -1.0 : i == 7 ? 1.0 : 0.0);
    vec4 n = texture(uState, v_uv + d * uTexel);
    float claim = n.g * uSpread * (abs(d.x * d.y) > 0.5 ? 0.7071 : 1.0); // diagonale plus chère
    if (claim > bestS) { bestS = claim; bestO = n.r; }
  }
  float age = me.b + uDt;
  if (bestO != owner && bestS > str + uMargin) { owner = bestO; str = bestS * uYield; age = 0.0; }
  else str = max(str, bestS * uYield * 0.5); // l'allié consolide, sans conquête
  o = vec4(owner, clamp(str, 0.0, 1.5), age, 0.0);
}`;

// Germe d'un coup : disque gaussien, prend la case si la force dépasse l'occupant.
const SEEDHIT = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D uState; uniform vec2 uPos; uniform float uOwner, uAmp, uRadius, uAspect;
void main(){
  vec4 c = texture(uState, v_uv);
  vec2 d = v_uv - uPos; d.x *= uAspect;
  float g = uAmp * exp(-dot(d, d) / max(uRadius, 1e-5));
  if (g > c.g) { c.r = uOwner; c.g = g; c.b = 0.0; }
  o = c;
}`;

// Rendu : une teinte par voix, luminosité = force (avec plancher pour que la
// carte reste lisible entre deux coups), coutures = frontières entre peuples.
const RENDER = `#version 300 es
in vec2 v_uv; out vec4 o;
uniform sampler2D uState; uniform vec2 uTexel;
uniform float uHue, uBright, uFloor, uSeam, uAgeFade;
void main(){
  vec4 c = texture(uState, v_uv);
  float owner = c.r;
  // frontière : un voisin d'un autre peuple
  float seam = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 d = vec2(i == 0 ? 1.0 : i == 1 ? -1.0 : 0.0, i == 2 ? 1.0 : i == 3 ? -1.0 : 0.0);
    seam += abs(texture(uState, v_uv + d * uTexel).r - owner) > 0.5 ? 1.0 : 0.0;
  }
  float fresh = exp(-c.b * uAgeFade);           // éclat des conquêtes récentes
  // Chaque voix occupe une PLAGE D'INTENSITÉ distincte : le tonemap mappe la
  // densité sur la LUT, donc jouer sur la seule teinte ne suffirait pas à
  // distinguer les peuples — c'est le niveau qui les sépare, la teinte confirme.
  float lvl = 0.30 + owner * 0.20;
  float lum = lvl * (uFloor + c.g) * (0.75 + 0.45 * fresh) * (1.0 + uBright);
  vec3 col = hue(uHue + owner * 0.23) * lum * 1.5;
  col += hue(uHue + owner * 0.23 + 0.5) * seam * uSeam * (0.35 + 0.65 * fresh);
  o = vec4(col, 1.0);
}`;

export class HocketMode implements Mode {
  id = "hocket"; family = "continuous" as const;
  private gl!: WebGL2RenderingContext; private res!: Resources;
  private state!: PingPong; private w = 0; private h = 0;
  private pStep: any; private pSeed: any; private pHit: any; private pRender: any;
  private hits = 0; private lastTime = -1;

  init(res: Resources, vp: Viewport): void {
    this.res = res; this.gl = res.gl;
    registerParams(res.matrix.targets, this.id, {
      decay: 0.9995, spread: 0.995, margin: 0.02, yield: 0.985,
      kickAmp: 1.0, snareAmp: 0.85, hatsAmp: 0.6, seedR: 0.004, seam: 0.7, floorLum: 0.22, ageFade: 1.2,
    }, {
      decay: [0.995, 1.0], spread: [0.9, 1.0], margin: [0.001, 0.12], yield: [0.9, 1.0],
      kickAmp: [0, 2], snareAmp: [0, 2], hatsAmp: [0, 2], seedR: [0.0004, 0.03], seam: [0, 2], floorLum: [0, 0.6], ageFade: [0.1, 6],
    });
    this.pStep = makeProgram(this.gl, STEP);
    this.pSeed = makeProgram(this.gl, SEED, { common: true });
    this.pHit = makeProgram(this.gl, SEEDHIT);
    this.pRender = makeProgram(this.gl, RENDER, { common: true });
    this.resize(vp);
  }

  resize(vp: Viewport): void {
    this.w = vp.simW; this.h = vp.simH;
    this.state?.dispose();
    // NEAREST : les frontières doivent rester nettes (c'est une carte, pas un flou).
    this.state = new PingPong(this.gl, this.w, this.h, this.gl.RGBA16F, this.gl.NEAREST, this.gl.CLAMP_TO_EDGE);
    this.reset();
  }

  reset(): void {
    const gl = this.gl;
    bindTarget(gl, this.state.write.fbo, this.w, this.h);
    drawFullscreen(gl, this.pSeed, {});
    this.state.swap();
    this.hits = 0;
  }

  // Position d'un germe : un tour d'or par coup, décalé par voix -> les peuples
  // ne se plantent pas toujours au même endroit, mais gardent chacun sa région.
  private seedPos(voice: number): [number, number] {
    const t = this.hits * 0.6180339887 + voice * 0.27;
    const r = 0.16 + 0.3 * ((this.hits * 0.381966 + voice * 0.5) % 1);
    return [0.5 + Math.cos(t * 6.2831853) * r, 0.5 + Math.sin(t * 6.2831853 * 1.37) * r];
  }

  private hit(voice: number, amp: number, radius: number): void {
    const gl = this.gl;
    const [px, py] = this.seedPos(voice);
    this.hits++;
    bindTarget(gl, this.state.write.fbo, this.w, this.h);
    drawFullscreen(gl, this.pHit, {
      uState: this.state.read.tex, uPos: [px, py], uOwner: voice,
      uAmp: amp, uRadius: radius, uAspect: this.w / this.h,
    });
    this.state.swap();
  }

  update(fr: BusFrame, dt: number, time: number): void {
    const gl = this.gl; const m = this.res.matrix;
    // temps RÉEL (dt est borné à 1/20 s par RenderLoop) — voir decayDt()
    const reel = this.lastTime < 0 ? dt : Math.min(1, Math.max(1 / 1000, time - this.lastTime));
    this.lastTime = time;
    const uni = {
      uTexel: [1 / this.w, 1 / this.h],
      uDecay: decayDt(Math.min(1, m.get("hocket.params.decay")), reel, 3), // 3 sous-pas par frame
      uSpread: Math.min(1, m.get("hocket.params.spread")),
      uMargin: Math.max(1e-4, m.get("hocket.params.margin")),
      uYield: Math.min(1, m.get("hocket.params.yield")),
      uDt: dt,
    };
    // Plusieurs pas : le front de conquête doit avancer plus vite qu'un pixel/frame.
    for (let s = 0; s < 3; s++) {
      bindTarget(gl, this.state.write.fbo, this.w, this.h);
      drawFullscreen(gl, this.pStep, { uState: this.state.read.tex, ...uni });
      this.state.swap();
    }
    const r = m.get("hocket.params.seedR");
    if (fr.kickFired) this.hit(0, m.get("hocket.params.kickAmp"), r * 2.2);
    if (fr.snareFired) this.hit(1, m.get("hocket.params.snareAmp"), r * 1.3);
    if (fr.hatsFired) this.hit(2, m.get("hocket.params.hatsAmp"), r * 0.5);
    if (fr.onsetFired && !fr.kickFired && !fr.snareFired) this.hit(3, m.get("hocket.params.kickAmp") * 0.7, r);
  }

  render(target: WebGLFramebuffer | null, w: number, h: number): void {
    bindTarget(this.gl, target, w, h);
    drawFullscreen(this.gl, this.pRender, {
      uState: this.state.read.tex, uTexel: [1 / this.w, 1 / this.h],
      uHue: this.res.matrix.get("global.baseHue"),
      uBright: this.res.matrix.get("global.brightness") - 1,
      uFloor: this.res.matrix.get("hocket.params.floorLum"),
      uSeam: this.res.matrix.get("hocket.params.seam"),
      uAgeFade: this.res.matrix.get("hocket.params.ageFade"),
    });
  }

  dispose(): void { this.state?.dispose(); unregister(this.res.matrix.targets, this.id); }
}
