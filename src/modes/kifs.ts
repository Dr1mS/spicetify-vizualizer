// kifs.ts — KIFS raymarching (famille DENSITY, rendu DIRECT sans ping-pong/accum).
// SDF fractale par folds itérés (Kaleidoscopic IFS) : dans une boucle ~8 itérations
// on replie p (abs + rotations + scale), on accumule le facteur d'échelle, distance
// à une boîte. Raymarche depuis une caméra en orbite lente (uTime), ~64 pas. Sortie =
// densité colorée : glow ~ 1/(1+dist parcourue) + AO ; teinte = hue(baseHue + profondeur).
// Les params de fold (scale, offset, angle) sont morphés par bass/centroid via la matrix ;
// le spectre (u_melf) et les onsets (u_onset stashé) pilotent glow et respiration.
// Effet « cathédrale » fractale 3D. {common:true}.
import { makeProgram, drawFullscreen, bindTarget } from "../core/fullscreen";
import { registerParams, unregister } from "../modmatrix/targets";
import { MEL_COUNT } from "../audio/constants";
import type { Mode, Resources } from "./Mode";
import type { BusFrame } from "../audio/bus";
import type { Viewport } from "../core/loop";

// RENDER : raymarch plein écran. {common:true} -> precision + hue/u_mel/u_melf/hash/TAU
// déjà prépendus (NE PAS redéclarer, ni u_feat/u_melCount qui sont dans common.glsl).
const RENDER = `#version 300 es
in vec2 v_uv; out vec4 o;
uniform float uTime, uAspect;
uniform float uScale, uOffset, uAngle, uGlow, uOnset, uHue, uBright;

// rotation 2D (pour replier autour d'axes)
mat2 rot(float a){ float s = sin(a), c = cos(a); return mat2(c, -s, s, c); }

// SDF fractale KIFS : replie p en boucle, accumule l'échelle. Retourne la distance
// signée à la boîte finale (dé-scalée par le produit des facteurs d'échelle).
float mapKIFS(vec3 p, out float trap){
  float s = 1.0;                         // produit cumulé des échelles (pour dé-scaler)
  float m = 1e9;                         // orbit trap (min distance à l'origine)
  float ang = uAngle + 0.15 * uOnset;    // un onset donne un léger twist supplémentaire
  vec3 off = vec3(uOffset);
  for(int i = 0; i < 8; i++){
    p = abs(p);                          // repli kaléidoscopique (miroirs)
    // rotations sur deux plans -> structure « cathédrale »
    p.xy = rot(ang) * p.xy;
    p.yz = rot(ang * 0.7) * p.yz;
    p = p * uScale - off * (uScale - 1.0); // scale autour de l'offset
    m = min(m, length(p));               // trap
    s *= uScale;                         // suit l'échelle pour normaliser la distance
  }
  // distance à une boîte, ramenée à l'espace monde par /s
  vec3 d = abs(p) - vec3(1.0);
  float box = length(max(d, 0.0)) + min(max(d.x, max(d.y, d.z)), 0.0);
  trap = m;
  return box / s;
}

void main(){
  // repère écran -1..1 corrigé de l'aspect
  vec2 uv = (v_uv * 2.0 - 1.0);
  uv.x *= uAspect;

  // caméra en orbite lente ; respiration douce du rayon sur les basses (u_melf(0.05))
  float bassPump = u_melf(0.05);
  float t = uTime * 0.15;
  float rad = 3.2 - 0.5 * bassPump;
  vec3 ro = vec3(cos(t) * rad, 0.6 * sin(t * 0.6), sin(t) * rad);
  vec3 fwd = normalize(-ro);
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), fwd));
  vec3 up = cross(fwd, right);
  vec3 rd = normalize(fwd * 1.4 + uv.x * right + uv.y * up);

  // raymarch
  float dist = 0.0;      // distance parcourue
  float trap = 1e9;      // orbit trap au point d'arrêt
  float glowAcc = 0.0;   // glow volumétrique accumulé (proximité de la surface)
  float hit = 0.0;
  for(int i = 0; i < 72; i++){
    vec3 p = ro + rd * dist;
    float dtr;
    float dS = mapKIFS(p, dtr);
    // glow : plus le rayon frôle la surface, plus il accumule de lumière
    glowAcc += exp(-dS * 22.0);
    if(dS < 0.0012){ trap = dtr; hit = 1.0; break; }
    dist += dS * 0.85;   // pas prudent (le SDF folded surestime un peu)
    trap = dtr;
    if(dist > 12.0) break;
  }

  // AO grossier : normale par gradient + occlusion par sondes le long de la normale
  float ao = 1.0;
  if(hit > 0.5){
    vec3 p = ro + rd * dist;
    vec2 e = vec2(0.0018, 0.0);
    float dtr;
    vec3 n = normalize(vec3(
      mapKIFS(p + e.xyy, dtr) - mapKIFS(p - e.xyy, dtr),
      mapKIFS(p + e.yxy, dtr) - mapKIFS(p - e.yxy, dtr),
      mapKIFS(p + e.yyx, dtr) - mapKIFS(p - e.yyx, dtr)));
    float occ = 0.0, sca = 1.0;
    for(int k = 1; k <= 4; k++){
      float hstep = 0.02 * float(k);
      float dd;
      float ds = mapKIFS(p + n * hstep, dd);
      occ += (hstep - ds) * sca;
      sca *= 0.6;
    }
    ao = clamp(1.0 - 2.0 * occ, 0.2, 1.0);
  }

  // densité : glow volumétrique + réponse au « hit », le tout attenué par la distance
  float fog = 1.0 / (1.0 + dist * dist * 0.05);
  float mel = u_melf(clamp(trap * 0.25, 0.0, 1.0)); // le trap indexe le spectre -> couleur audio
  float dens = (glowAcc * 0.02 * uGlow + hit * 0.6 * ao) * fog;
  dens *= (0.5 + 0.9 * mel);                 // le spectre module l'intensité
  dens *= (0.6 + uBright);                    // brightness globale
  dens += 0.35 * uOnset * fog;                // flash d'onset

  // teinte : baseHue + profondeur (trap) -> dégradé « vitrail »
  float hueT = uHue + 0.35 * trap + 0.08 * dist + 0.15 * uOnset;
  vec3 col = hue(hueT) * dens;

  o = vec4(col, 1.0);
}`;

export class KifsMode implements Mode {
  id = "kifs"; family = "density" as const;
  private gl!: WebGL2RenderingContext; private res!: Resources;
  private w = 0; private h = 0;
  private pRender: any;
  private time = 0;   // horloge stashée depuis update()
  private pulse = 0;  // enveloppe d'onset qui décroît (stashée depuis update())

  init(res: Resources, vp: Viewport): void {
    this.res = res; this.gl = res.gl;
    // params de fold morphables (bass/centroid via la matrix)
    registerParams(res.matrix.targets, this.id,
      { scale: 1.85, offset: 1.1, angle: 0.5, glow: 1.0 },
      { scale: [1.4, 2.4], offset: [0.4, 1.8], angle: [0.0, 3.14159], glow: [0.2, 3.0] });
    this.pRender = makeProgram(this.gl, RENDER, { common: true });
    this.resize(vp);
  }

  resize(vp: Viewport): void {
    // rendu DIRECT : aucun buffer à (ré)allouer, on ne retient que la résolution de sim.
    this.w = vp.simW; this.h = vp.simH;
    this.reset();
  }

  reset(): void {
    this.time = 0;
    this.pulse = 0;
  }

  update(fr: BusFrame, dt: number, time: number): void {
    this.time = time;
    // enveloppe d'onset : saut à 1 sur un onset, décroissance exponentielle sinon
    const decay = Math.pow(0.0008, Math.min(dt, 1 / 20)); // ~ -30 dB / s
    this.pulse = fr.onsetFired ? 1 : this.pulse * decay;
  }

  render(target: WebGLFramebuffer | null, w: number, h: number): void {
    const gl = this.gl; const m = this.res.matrix;
    bindTarget(gl, target, w, h);
    drawFullscreen(gl, this.pRender, {
      // spectre (obligatoire pour u_melf/u_mel dans le frag {common:true})
      u_feat: this.res.feat.tex,
      u_melCount: MEL_COUNT,
      // temps + aspect
      uTime: this.time,
      uAspect: this.w / this.h,
      // params de fold morphés par la matrix (bass/centroid)
      uScale: m.get("kifs.params.scale"),
      uOffset: m.get("kifs.params.offset"),
      uAngle: m.get("kifs.params.angle"),
      uGlow: m.get("kifs.params.glow"),
      // audio direct : onset stashé + teinte/brightness globales
      uOnset: this.pulse,
      uHue: m.get("global.baseHue"),
      uBright: m.get("global.brightness") - 1,
    });
  }

  dispose(): void {
    unregister(this.res.matrix.targets, this.id);
  }
}
