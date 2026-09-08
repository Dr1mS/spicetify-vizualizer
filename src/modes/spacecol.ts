// spacecol.ts — Space colonization (Runions) — famille GROWTH.
// Dendrites qui poussent vers des attracteurs spawnés sur les onsets. Accumulation
// GPU AVEC décroissance (sinon saturation blanche en réactif continu).
// Logique de croissance = CPU minimal ; GPU = accumulation+décroissance des segments.
import { makeProgram, drawFullscreen, bindTarget } from "../core/fullscreen";
import { PingPong } from "../core/pingpong";
import { registerParams, unregister } from "../modmatrix/targets";
import type { Mode, Resources } from "./Mode";
import type { BusFrame } from "../audio/bus";
import { decayDt, gainDt } from "../core/loop";
import type { Viewport } from "../core/loop";

const MAX_NODES = 3000;
const MAX_SEG = 4000;

const DECAY = `#version 300 es
precision highp float; in vec2 v_uv; out vec4 o; uniform sampler2D uTex; uniform float uDecay;
void main(){ o = texture(uTex,v_uv) * uDecay; }`;

const SEG_VS = `#version 300 es
layout(location=0) in vec2 a_pos; // clip space
void main(){ gl_Position = vec4(a_pos, 0., 1.); }`;
const SEG_FS = `#version 300 es
precision highp float; out vec4 o; uniform vec3 uCol;
void main(){ o = vec4(uCol, 1.); }`;

const COPY = `#version 300 es
precision highp float; in vec2 v_uv; out vec4 o; uniform sampler2D uTex;
void main(){ o = texture(uTex, v_uv); }`;

export class SpaceColMode implements Mode {
  id = "spacecol"; family = "growth" as const;
  private lastDt = 1 / 60; private lastTime = -1; // décroissance compensée (render() n'a pas dt)
  private gl!: WebGL2RenderingContext; private res!: Resources;
  private accum!: PingPong; private w = 0; private h = 0;
  private pDecay: any; private pSeg: any; private pCopy: any;
  private vao!: WebGLVertexArrayObject; private vbo!: WebGLBuffer;
  private segBuf = new Float32Array(MAX_SEG * 4);
  // état CPU
  private nx = new Float32Array(MAX_NODES); private ny = new Float32Array(MAX_NODES); private nCount = 0;
  private ax: number[] = []; private ay: number[] = [];
  private site = 0;

  init(res: Resources, vp: Viewport): void {
    this.res = res; this.gl = res.gl;
    registerParams(res.matrix.targets, this.id,
      { influenceRadius: 0.35, killRadius: 0.05, stepLen: 0.012, spawnCount: 26, spawnSpread: 0.28, decay: 0.955, bright: 1.0 },
      { stepLen: [0.004, 0.03], decay: [0.9, 0.99], bright: [0.2, 3] });
    this.pDecay = makeProgram(this.gl, DECAY);
    this.pSeg = makeProgram(this.gl, SEG_FS, { vert: SEG_VS });
    this.pCopy = makeProgram(this.gl, COPY);
    this.vao = this.gl.createVertexArray()!;
    this.vbo = this.gl.createBuffer()!;
    this.gl.bindVertexArray(this.vao);
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.vbo);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, this.segBuf.byteLength, this.gl.DYNAMIC_DRAW);
    this.gl.enableVertexAttribArray(0);
    this.gl.vertexAttribPointer(0, 2, this.gl.FLOAT, false, 0, 0);
    this.gl.bindVertexArray(null);
    this.resize(vp);
  }
  resize(vp: Viewport): void {
    this.w = vp.simW; this.h = vp.simH;
    this.accum?.dispose();
    this.accum = new PingPong(this.gl, this.w, this.h, this.res.caps.accumFormat);
    this.reset();
  }
  reset(): void { this.seedNodes(); this.ax = []; this.ay = []; }
  private seedNodes(): void {
    this.nCount = 6;
    for (let i = 0; i < 6; i++) { const a = (i / 6) * 6.283; this.nx[i] = Math.cos(a) * 0.05; this.ny[i] = Math.sin(a) * 0.05; }
  }
  private spawn(count: number, spread: number): void {
    if (this.nCount > MAX_NODES * 0.9) this.seedNodes(); // dendrite épuisée -> repart
    this.site += 0.37;
    const cx = Math.cos(this.site * 6.283) * 0.55, cy = Math.sin(this.site * 4.3) * 0.55;
    for (let i = 0; i < count; i++) {
      const a = Math.random() * 6.283, r = Math.sqrt(Math.random()) * spread;
      this.ax.push(cx + Math.cos(a) * r); this.ay.push(cy + Math.sin(a) * r);
    }
    if (this.ax.length > 1200) { this.ax.splice(0, this.ax.length - 1200); this.ay.splice(0, this.ay.length - 1200); }
  }

  update(fr: BusFrame, dt: number, time: number): void {
    // Le dt fourni est BORNÉ à 1/20 s par RenderLoop (protection des simulations
    // après un blocage). Pour la décroissance il faut le temps RÉELLEMENT écoulé,
    // sinon la compensation ne corrige qu'un tiers du problème quand le rAF est
    // bridé à ~1,3 Hz (fenêtre non focalisée).
    const reel = this.lastTime < 0 ? dt : Math.min(1, Math.max(1 / 1000, time - this.lastTime));
    this.lastTime = time; this.lastDt = reel;
    const m = this.res.matrix;
    if (fr.onsetFired) this.spawn(Math.round(m.get("spacecol.params.spawnCount") || 26), m.get("spacecol.params.spawnSpread") || 0.28);
    const infl = m.get("spacecol.params.influenceRadius"), kill = m.get("spacecol.params.killRadius"), step = m.get("spacecol.params.stepLen");
    const n = this.nCount;
    if (this.ax.length === 0 || n === 0) return;
    const dirx = new Float32Array(n), diry = new Float32Array(n), cnt = new Int32Array(n);
    // chaque attracteur -> noeud le plus proche dans le rayon d'influence
    for (let a = 0; a < this.ax.length; a++) {
      let mj = -1, md = infl * infl;
      for (let j = 0; j < n; j++) { const dx = this.ax[a] - this.nx[j], dy = this.ay[a] - this.ny[j]; const d = dx * dx + dy * dy; if (d < md) { md = d; mj = j; } }
      if (mj >= 0) { const dx = this.ax[a] - this.nx[mj], dy = this.ay[a] - this.ny[mj], l = Math.hypot(dx, dy) || 1; dirx[mj] += dx / l; diry[mj] += dy / l; cnt[mj]++; }
    }
    // croissance : nouveaux noeuds + segments
    let seg = 0;
    for (let j = 0; j < n && this.nCount < MAX_NODES; j++) {
      if (cnt[j] === 0) continue;
      const l = Math.hypot(dirx[j], diry[j]) || 1;
      const nxx = this.nx[j] + (dirx[j] / l) * step, nyy = this.ny[j] + (diry[j] / l) * step;
      const k = this.nCount++;
      this.nx[k] = nxx; this.ny[k] = nyy;
      if (seg < MAX_SEG) { const o = seg * 4; this.segBuf[o] = this.nx[j]; this.segBuf[o + 1] = this.ny[j]; this.segBuf[o + 2] = nxx; this.segBuf[o + 3] = nyy; seg++; }
    }
    this.newSeg = seg;
    // suppression des attracteurs atteints (kill radius)
    const kk = kill * kill; const keepX: number[] = [], keepY: number[] = [];
    for (let a = 0; a < this.ax.length; a++) {
      let alive = true;
      for (let j = 0; j < this.nCount; j++) { const dx = this.ax[a] - this.nx[j], dy = this.ay[a] - this.ny[j]; if (dx * dx + dy * dy < kk) { alive = false; break; } }
      if (alive) { keepX.push(this.ax[a]); keepY.push(this.ay[a]); }
    }
    this.ax = keepX; this.ay = keepY;
  }
  private newSeg = 0;

  render(target: WebGLFramebuffer | null, w: number, h: number): void {
    const gl = this.gl; const m = this.res.matrix;
    // décroissance : accum.read * decay -> accum.write
    bindTarget(gl, this.accum.write.fbo, this.w, this.h);
    drawFullscreen(gl, this.pDecay, { uTex: this.accum.read.tex, uDecay: decayDt(m.get("spacecol.params.decay"), this.lastDt) });
    // segments neufs (additif) par-dessus
    if (this.newSeg > 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.segBuf.subarray(0, this.newSeg * 4));
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
      gl.useProgram(this.pSeg.program);
      const col = hueRGB(m.get("global.baseHue")); const b = m.get("spacecol.params.bright");
      const bd = gainDt(b, this.lastDt); // dépôt compensé (voir gainDt)
      gl.uniform3f(gl.getUniformLocation(this.pSeg.program, "uCol"), col[0] * bd, col[1] * bd, col[2] * bd);
      gl.bindVertexArray(this.vao);
      gl.drawArrays(gl.LINES, 0, this.newSeg * 2);
      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
    }
    this.accum.swap();
    bindTarget(gl, target, w, h);
    drawFullscreen(gl, this.pCopy, { uTex: this.accum.read.tex });
  }
  dispose(): void { this.accum?.dispose(); unregister(this.res.matrix.targets, this.id); }
}

function hueRGB(h: number): [number, number, number] {
  const f = (p: number) => 0.5 + 0.5 * Math.cos(2 * Math.PI * (h + p));
  return [f(0), f(0.33), f(0.67)];
}
