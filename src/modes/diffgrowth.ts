// diffgrowth.ts — Differential line growth — famille GROWTH.
// Une COURBE FERMÉE de nœuds (clip [-1,1]). Chaque pas CPU : (a) répulsion courte
// portée entre voisins proches, (b) attraction-ressort vers les 2 voisins sur la
// courbe, (c) subdivision (insère un nœud au milieu d'un segment trop long). La
// courbe s'auto-évite et ondule -> formes organiques. Onset -> booste insertion/
// répulsion (croissance). Accumulation GPU AVEC décroissance (trails), comme spacecol.
// Structure calquée sur spacecol.ts : VBO dynamique + passe decay + copy.
import { makeProgram, drawFullscreen, bindTarget } from "../core/fullscreen";
import { PingPong } from "../core/pingpong";
import { registerParams, unregister } from "../modmatrix/targets";
import { F } from "../audio/constants";
import type { Mode, Resources } from "./Mode";
import type { BusFrame } from "../audio/bus";
import { decayDt, gainDt } from "../core/loop";
import type { Viewport } from "../core/loop";

const MAX_NODES = 1500;   // cap dur : reset si dépassé
const SEED_NODES = 64;    // taille initiale du cercle

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

export class DiffGrowthMode implements Mode {
  id = "diffgrowth"; family = "growth" as const;
  private lastDt = 1 / 60; private lastTime = -1; // décroissance compensée (render() n'a pas dt)
  private gl!: WebGL2RenderingContext; private res!: Resources;
  private accum!: PingPong; private w = 0; private h = 0;
  private pDecay: any; private pSeg: any; private pCopy: any;
  private vao!: WebGLVertexArrayObject; private vbo!: WebGLBuffer;
  // état CPU : courbe fermée de nœuds
  private nx = new Float32Array(MAX_NODES); private ny = new Float32Array(MAX_NODES); private nCount = 0;
  // VBO d'arêtes : boucle fermée -> nCount segments (line loop dévroulée en LINES)
  private lineBuf = new Float32Array(MAX_NODES * 4);
  private lineVerts = 0;
  // buffers de travail (déplacements par nœud), (ré)alloués à MAX_NODES une fois
  private fx = new Float32Array(MAX_NODES); private fy = new Float32Array(MAX_NODES);
  private growBoost = 0; // décroît chaque frame, monté par les onsets

  init(res: Resources, vp: Viewport): void {
    this.res = res; this.gl = res.gl;
    registerParams(res.matrix.targets, this.id,
      {
        repulsion: 0.55,      // force de répulsion courte portée
        repRadius: 0.06,      // rayon de voisinage pour la répulsion
        attraction: 0.22,     // raideur du ressort vers les voisins de courbe
        splitLen: 0.045,      // seuil de longueur de segment -> subdivision
        maxStep: 0.010,       // déplacement max par pas (stabilité)
        melDrive: 0.5,        // gain de la modulation spectrale sur la répulsion
        decay: 0.955,         // décroissance des trails
        bright: 1.0,          // gain de couleur des lignes
      },
      {
        repulsion: [0.0, 1.5], repRadius: [0.02, 0.15], attraction: [0.0, 0.8],
        splitLen: [0.02, 0.12], maxStep: [0.003, 0.03], melDrive: [0.0, 2.0],
        decay: [0.9, 0.99], bright: [0.2, 3],
      });
    this.pDecay = makeProgram(this.gl, DECAY);
    this.pSeg = makeProgram(this.gl, SEG_FS, { vert: SEG_VS });
    this.pCopy = makeProgram(this.gl, COPY);
    this.vao = this.gl.createVertexArray()!;
    this.vbo = this.gl.createBuffer()!;
    this.gl.bindVertexArray(this.vao);
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.vbo);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, this.lineBuf.byteLength, this.gl.DYNAMIC_DRAW);
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

  reset(): void { this.seedCircle(); this.growBoost = 0; this.lineVerts = 0; }

  private seedCircle(): void {
    const r = 0.25;
    this.nCount = SEED_NODES;
    for (let i = 0; i < SEED_NODES; i++) {
      const a = (i / SEED_NODES) * 6.2831853;
      // léger bruit initial pour casser la symétrie parfaite
      const rr = r * (1.0 + 0.04 * Math.sin(a * 5.0));
      this.nx[i] = Math.cos(a) * rr;
      this.ny[i] = Math.sin(a) * rr;
    }
  }

  // insère un nœud au milieu du segment i->i+1 (décale la queue d'un cran)
  private insertAt(i: number): void {
    const n = this.nCount;
    const j = (i + 1) % n;
    const mx = (this.nx[i] + this.nx[j]) * 0.5;
    const my = (this.ny[i] + this.ny[j]) * 0.5;
    // décale [i+1 .. n-1] d'un cran vers la droite, puis pose le milieu en i+1
    for (let k = n; k > i + 1; k--) { this.nx[k] = this.nx[k - 1]; this.ny[k] = this.ny[k - 1]; }
    this.nx[i + 1] = mx; this.ny[i + 1] = my;
    this.nCount = n + 1;
  }

  update(fr: BusFrame, dt: number, time: number): void {
    // Le dt fourni est BORNÉ à 1/20 s par RenderLoop (protection des simulations
    // après un blocage). Pour la décroissance il faut le temps RÉELLEMENT écoulé,
    // sinon la compensation ne corrige qu'un tiers du problème quand le rAF est
    // bridé à ~1,3 Hz (fenêtre non focalisée).
    const reel = this.lastTime < 0 ? dt : Math.min(1, Math.max(1 / 1000, time - this.lastTime));
    this.lastTime = time; this.lastDt = reel;
    const m = this.res.matrix;
    const n = this.nCount;
    if (n < 3) { this.lineVerts = 0; return; }

    // onset -> impulsion de croissance (booste répulsion + insertion)
    if (fr.onsetFired) this.growBoost = Math.min(this.growBoost + 0.6, 1.5);
    this.growBoost *= 0.90;

    // params modulables
    let repulsion = m.get("diffgrowth.params.repulsion");
    const repR = m.get("diffgrowth.params.repRadius");
    const attraction = m.get("diffgrowth.params.attraction");
    let splitLen = m.get("diffgrowth.params.splitLen");
    const maxStep = m.get("diffgrowth.params.maxStep");
    const melDrive = m.get("diffgrowth.params.melDrive");

    // Réactivité spectrale : les basses gonflent la répulsion (la courbe respire),
    // + le boost d'onset. splitLen rétrécit sur onset -> subdivision (croissance).
    const feat = fr.feat;
    const bassE = 0.5 * (feat[F.MEL0] + feat[F.MEL0 + 2]);
    repulsion *= 1.0 + melDrive * bassE + 0.8 * this.growBoost;
    splitLen *= 1.0 - 0.35 * this.growBoost;

    const repR2 = repR * repR;
    const fx = this.fx, fy = this.fy;
    for (let i = 0; i < n; i++) { fx[i] = 0; fy[i] = 0; }

    // (a) RÉPULSION courte portée (déjà mise à l'échelle par `repulsion`) : O(n²)
    // borné par MAX_NODES=1500 -> OK CPU/frame.
    for (let i = 0; i < n; i++) {
      const xi = this.nx[i], yi = this.ny[i];
      for (let jj = i + 1; jj < n; jj++) {
        let dx = xi - this.nx[jj], dy = yi - this.ny[jj];
        const d2 = dx * dx + dy * dy;
        if (d2 > 0 && d2 < repR2) {
          const d = Math.sqrt(d2);
          // poids linéaire décroissant jusqu'au rayon, normalisé par la distance
          const w = repulsion * (repR - d) / repR / d;
          dx *= w; dy *= w;
          fx[i] += dx; fy[i] += dy;
          fx[jj] -= dx; fy[jj] -= dy;
        }
      }
    }

    // (b) ATTRACTION-RESSORT vers les 2 voisins de courbe (i-1, i+1)
    for (let i = 0; i < n; i++) {
      const p = (i - 1 + n) % n, q = (i + 1) % n;
      const cx = (this.nx[p] + this.nx[q]) * 0.5 - this.nx[i];
      const cy = (this.ny[p] + this.ny[q]) * 0.5 - this.ny[i];
      fx[i] += cx * attraction; fy[i] += cy * attraction;
    }

    // intégration : force combinée (rép + attraction) clampée à maxStep, dans [-1,1]
    for (let i = 0; i < n; i++) {
      let dxi = 0, dyi = 0;
      const l = Math.hypot(fx[i], fy[i]);
      if (l > 1e-6) {
        const s = Math.min(l, maxStep) / l;
        dxi = fx[i] * s; dyi = fy[i] * s;
      }
      let nxx = this.nx[i] + dxi, nyy = this.ny[i] + dyi;
      if (nxx < -0.98) nxx = -0.98; else if (nxx > 0.98) nxx = 0.98;
      if (nyy < -0.98) nyy = -0.98; else if (nyy > 0.98) nyy = 0.98;
      this.nx[i] = nxx; this.ny[i] = nyy;
    }

    // (c) SUBDIVISION : au repos 1 insertion/frame (la plus longue arête > seuil) ;
    // sur onset, growBoost augmente le budget d'insertions -> la courbe pousse par
    // à-coups sur les beats. Reset si on atteint le cap dur.
    const s2 = splitLen * splitLen;
    const budget = 1 + Math.floor(this.growBoost * 2); // 1 au repos, jusqu'à ~4 sur onset
    for (let ins = 0; ins < budget; ins++) {
      let best = -1, bestD = s2;
      for (let i = 0; i < this.nCount; i++) {
        const j = (i + 1) % this.nCount;
        const dx = this.nx[j] - this.nx[i], dy = this.ny[j] - this.ny[i];
        const d = dx * dx + dy * dy;
        if (d > bestD) { bestD = d; best = i; }
      }
      if (best < 0) break; // plus aucune arête au-dessus du seuil
      if (this.nCount >= MAX_NODES) { this.reset(); return; }
      this.insertAt(best);
    }

    // construit le VBO d'arêtes : boucle fermée -> nCount segments = 2*nCount sommets
    const c = this.nCount, buf = this.lineBuf;
    for (let i = 0; i < c; i++) {
      const j = (i + 1) % c, o = i * 4;
      buf[o] = this.nx[i]; buf[o + 1] = this.ny[i];
      buf[o + 2] = this.nx[j]; buf[o + 3] = this.ny[j];
    }
    this.lineVerts = c * 2;
  }

  render(target: WebGLFramebuffer | null, w: number, h: number): void {
    const gl = this.gl; const m = this.res.matrix;
    // décroissance : accum.read * decay -> accum.write
    bindTarget(gl, this.accum.write.fbo, this.w, this.h);
    drawFullscreen(gl, this.pDecay, { uTex: this.accum.read.tex, uDecay: decayDt(m.get("diffgrowth.params.decay"), this.lastDt) });
    // courbe entière (additif) par-dessus
    if (this.lineVerts > 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.lineBuf.subarray(0, this.lineVerts * 2));
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
      gl.useProgram(this.pSeg.program);
      const col = hueRGB(m.get("global.baseHue")); const b = m.get("diffgrowth.params.bright");
      const bd = gainDt(b, this.lastDt); // dépôt compensé (voir gainDt)
      gl.uniform3f(gl.getUniformLocation(this.pSeg.program, "uCol"), col[0] * bd, col[1] * bd, col[2] * bd);
      gl.bindVertexArray(this.vao);
      gl.drawArrays(gl.LINES, 0, this.lineVerts);
      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
    }
    this.accum.swap();
    bindTarget(gl, target, w, h);
    drawFullscreen(gl, this.pCopy, { uTex: this.accum.read.tex });
  }

  dispose(): void {
    this.accum?.dispose();
    this.gl.deleteBuffer(this.vbo);
    this.gl.deleteVertexArray(this.vao);
    unregister(this.res.matrix.targets, this.id);
  }
}

function hueRGB(h: number): [number, number, number] {
  const f = (p: number) => 0.5 + 0.5 * Math.cos(2 * Math.PI * (h + p));
  return [f(0), f(0.33), f(0.67)];
}
