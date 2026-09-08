// comb.ts — PEIGNE TEMPOREL (création originale, famille CONTINUOUS).
//
// L'idée : un filtre en peigne, mais dans l'IMAGE. Le son entre par des germes
// (transitoires) et un anneau spectral ; l'image se relit elle-même telle qu'elle
// était il y a EXACTEMENT une pulsation, tournée et redimensionnée d'un cran.
// Les échos retombent donc pile sur le temps, et s'enroulent en spirale : on voit
// le tempo au lieu de l'entendre. Changez de morceau, le peigne se réaccorde.
//
// Le retard est choisi par HORODATAGE, pas en comptant des frames : on garde la
// date de chaque couche et on prend celle la plus proche de « maintenant - période ».
// À 30, 60 ou 144 fps, l'écho tombe au même endroit — un comptage de frames
// désaccorderait le peigne au premier à-coup.
//
// Historique : TEXTURE_2D_ARRAY de K couches, résolution FIXE (indépendante du
// viewport : un écho est doux par nature, et ça évite de tout réallouer quand le
// panneau Spotify change de taille). La baie n'est JAMAIS attachée en écriture :
// on rend dans une cible 2D puis on copie (copyTexSubImage3D) dans la couche.
import { makeProgram, drawFullscreen, bindTarget } from "../core/fullscreen";
import { createTarget, type Target } from "../core/pingpong";
import { registerParams, unregister } from "../modmatrix/targets";
import type { Mode, Resources } from "./Mode";
import type { BusFrame } from "../audio/bus";
import type { Viewport } from "../core/loop";

const HW = 384, HH = 216; // résolution de la ligne à retard (16:9)
const K = 24; // couches : ~0.4 s à 60 fps, assez pour 3 échos à la noire

const STEP = `#version 300 es
precision highp sampler2DArray; // ES 3.0 : pas de précision par défaut pour ce type
in vec2 v_uv; out vec4 o;
uniform sampler2DArray uHist;
uniform float uTap, uFeedback, uSwirl, uZoom, uAspect;
uniform vec2 uHitPos; uniform float uHitAmp, uHitR;
uniform float uSpecGain, uArms, uTime, u_keyHue;
void main(){
  // --- relecture du passé, tournée d'un cran : l'écho s'enroule ---
  vec2 q = v_uv - 0.5; q.x *= uAspect;
  float ca = cos(uSwirl), sa = sin(uSwirl);
  q = mat2(ca, -sa, sa, ca) * q * uZoom;
  q.x /= uAspect; q += 0.5;
  vec3 echo = texture(uHist, vec3(q, uTap)).rgb * uFeedback;
  // hors cadre : pas d'écho (sinon les bords se replient et bavent)
  echo *= step(0.0, q.x) * step(q.x, 1.0) * step(0.0, q.y) * step(q.y, 1.0);

  // --- entrée : anneau spectral (grave au centre, aigu au bord) ---
  vec2 p = v_uv - 0.5; p.x *= uAspect;
  float r = length(p) * 2.0;
  float ang = atan(p.y, p.x);
  float spec = u_melf(clamp(r, 0.0, 1.0)) * uSpecGain;
  spec *= 0.45 + 0.55 * cos(ang * uArms + uTime * 0.7);
  spec *= smoothstep(1.15, 0.35, r);

  // --- entrée : germe de transitoire ---
  vec2 d = v_uv - uHitPos; d.x *= uAspect;
  float hit = uHitAmp * exp(-dot(d, d) / max(uHitR, 1e-5));

  vec3 tint = hue(u_keyHue + r * 0.25);
  o = vec4(min(echo + tint * (spec + hit), vec3(8.0)), 1.0);
}`;

// Rendu : la couche fraîche + les échos à 1, 2, 3 pulsations, chacun teinté un
// cran plus loin dans la palette -> on LIT le rythme dans la séparation de couleur.
const RENDER = `#version 300 es
precision highp sampler2DArray;
in vec2 v_uv; out vec4 o;
uniform sampler2DArray uHist;
uniform float uNow, uT1, uT2, uT3, uTapGain, uBright, uHue;
vec3 tap(float layer, float w, float hueOff){
  vec3 c = texture(uHist, vec3(v_uv, layer)).rgb;
  return c * w * (0.6 + 0.4 * hue(uHue + hueOff));
}
void main(){
  vec3 acc = tap(uNow, 1.0, 0.0)
           + tap(uT1, uTapGain, 0.10)
           + tap(uT2, uTapGain * uTapGain, 0.20)
           + tap(uT3, uTapGain * uTapGain * uTapGain, 0.30);
  o = vec4(acc * (0.5 + uBright), 1.0);
}`;

export class CombMode implements Mode {
  id = "comb"; family = "continuous" as const;
  private gl!: WebGL2RenderingContext; private res!: Resources;
  private hist!: WebGLTexture; private cur!: Target;
  private pStep: any; private pRender: any;
  private stamps = new Float64Array(K).fill(-1e9);
  private wr = 0; private hits = 0; private aspect = 1;
  private taps = [0, 0, 0, 0];

  init(res: Resources, vp: Viewport): void {
    this.res = res; this.gl = res.gl;
    registerParams(res.matrix.targets, this.id, {
      subdiv: 2, feedback: 0.9, swirl: 0.06, zoom: 1.03, specGain: 0.35, arms: 5,
      hitAmp: 1.2, hitR: 0.006, tapGain: 0.55,
    }, {
      subdiv: [1, 4], feedback: [0, 0.985], swirl: [-0.4, 0.4], zoom: [0.94, 1.07], specGain: [0, 1.5], arms: [0, 12],
      hitAmp: [0, 3], hitR: [0.0008, 0.05], tapGain: [0, 0.9],
    });
    this.pStep = makeProgram(this.gl, STEP, { common: true });
    this.pRender = makeProgram(this.gl, RENDER, { common: true });

    const gl = this.gl;
    this.hist = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.hist);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA16F, HW, HH, K);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.cur = createTarget(gl, HW, HH, gl.RGBA16F, gl.LINEAR, gl.CLAMP_TO_EDGE);
    this.resize(vp);
    this.reset();
  }

  // La ligne à retard est à résolution fixe : un changement de taille ne coûte rien.
  resize(vp: Viewport): void { this.aspect = vp.simW / Math.max(1, vp.simH); }

  reset(): void {
    const gl = this.gl;
    // Vide les couches (rendu noir dans `cur` puis copie dans chacune).
    bindTarget(gl, this.cur.fbo, HW, HH);
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.hist);
    for (let i = 0; i < K; i++) gl.copyTexSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, i, 0, 0, HW, HH);
    this.stamps.fill(-1e9);
    this.wr = 0; this.hits = 0; this.taps = [0, 0, 0, 0];
  }

  /** Couche dont l'horodatage est le plus proche de `t` (horloge de rendu). */
  private nearest(t: number): number {
    let best = (this.wr + K - 1) % K, bestD = Infinity;
    for (let i = 0; i < K; i++) {
      if (this.stamps[i] < -1e8) continue;
      const d = Math.abs(this.stamps[i] - t);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  update(fr: BusFrame, _dt: number, time: number): void {
    const gl = this.gl; const m = this.res.matrix;
    const bpm = Math.min(220, Math.max(40, fr.bpm || 120));
    const subdiv = Math.max(1, m.get("comb.params.subdiv"));
    const period = 60 / bpm / subdiv; // le retard EST la pulsation (ou sa division)

    const tap1 = this.nearest(time - period);
    if (fr.onsetFired) this.hits++;
    const a = this.hits * 2.399963; // angle d'or : les germes tournent sans se répéter
    const hitPos = [0.5 + Math.cos(a) * 0.28, 0.5 + Math.sin(a) * 0.28];

    bindTarget(gl, this.cur.fbo, HW, HH);
    drawFullscreen(gl, this.pStep, {
      uHist: this.hist, uTap: tap1,
      uFeedback: Math.min(0.985, m.get("comb.params.feedback")),
      uSwirl: m.get("comb.params.swirl"), uZoom: m.get("comb.params.zoom"),
      uAspect: this.aspect, uTime: time,
      uHitPos: hitPos, uHitAmp: fr.onsetFired ? m.get("comb.params.hitAmp") : 0,
      uHitR: m.get("comb.params.hitR"),
      uSpecGain: m.get("comb.params.specGain"), uArms: Math.round(m.get("comb.params.arms")),
      ...this.res.feat.uniforms(fr), // u_feat/u_melCount (u_melf) + u_keyHue
    });

    // Publication : la cible 2D devient la couche courante de la ligne à retard.
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.hist);
    gl.copyTexSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, this.wr, 0, 0, HW, HH);
    this.stamps[this.wr] = time;
    const now = this.wr;
    this.wr = (this.wr + 1) % K;
    this.taps = [now, tap1, this.nearest(time - 2 * period), this.nearest(time - 3 * period)];
  }

  render(target: WebGLFramebuffer | null, w: number, h: number): void {
    bindTarget(this.gl, target, w, h);
    drawFullscreen(this.gl, this.pRender, {
      uHist: this.hist,
      uNow: this.taps[0], uT1: this.taps[1], uT2: this.taps[2], uT3: this.taps[3],
      uTapGain: this.res.matrix.get("comb.params.tapGain"),
      uBright: this.res.matrix.get("global.brightness") - 1,
      uHue: this.res.matrix.get("global.baseHue"),
    });
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteTexture(this.hist);
    gl.deleteTexture(this.cur.tex); gl.deleteFramebuffer(this.cur.fbo);
    unregister(this.res.matrix.targets, this.id);
  }
}
