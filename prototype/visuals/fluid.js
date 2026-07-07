// FluidVisual — scène "next gen" : fluide de Stam (stable fluids) sur GPU.
//
// Champ de vélocité incompressible + colorant advecté. L'audio injecte des
// "splats" (force + couleur) ; le solveur de pression (Jacobi) garde le champ
// sans divergence -> volutes d'encre organiques.
//
//   kick/onset -> splats (souffle + encre)
//   bass       -> intensité de la force
//   spectre    -> position angulaire des splats
//   centroïde  -> couleur de l'encre
//
// Pipeline/frame : advect(vel) -> splat -> divergence -> pressure(Jacobi xN)
//                  -> project -> advect(dye) -> display.

import { createGL, program, fullscreenTriangle, VS_QUAD, pingPong, createTexture, createFBO } from "../gl/glutil.js";
import { config, themeHue } from "../config.js";

const SIM = 256; // grille de simulation

const ADVECT_FS = `#version 300 es
precision highp float;
in vec2 uv;
uniform sampler2D uVel, uSrc;
uniform vec2 uTexel; uniform float uDt, uDiss;
out vec4 o;
void main(){
  vec2 vel=texture(uVel,uv).xy;
  vec2 coord=uv-uDt*vel*uTexel;      // remonte le long du flux
  o=texture(uSrc,coord)*uDiss;
}`;

const SPLAT_FS = `#version 300 es
precision highp float;
in vec2 uv;
uniform sampler2D uTarget;
uniform vec2 uPoint; uniform vec3 uValue; uniform float uRadius; uniform float uAspect;
out vec4 o;
void main(){
  vec2 p=uv-uPoint; p.x*=uAspect;
  float g=exp(-dot(p,p)/uRadius);
  o=vec4(texture(uTarget,uv).xyz+uValue*g,1.0);
}`;

const DIVERGENCE_FS = `#version 300 es
precision highp float;
in vec2 uv; uniform sampler2D uVel; uniform vec2 uTexel; out vec4 o;
void main(){
  float L=texture(uVel,uv-vec2(uTexel.x,0.0)).x;
  float R=texture(uVel,uv+vec2(uTexel.x,0.0)).x;
  float B=texture(uVel,uv-vec2(0.0,uTexel.y)).y;
  float T=texture(uVel,uv+vec2(0.0,uTexel.y)).y;
  o=vec4(0.5*((R-L)+(T-B)),0.0,0.0,1.0);
}`;

const PRESSURE_FS = `#version 300 es
precision highp float;
in vec2 uv; uniform sampler2D uPressure,uDivergence; uniform vec2 uTexel; out vec4 o;
void main(){
  float L=texture(uPressure,uv-vec2(uTexel.x,0.0)).x;
  float R=texture(uPressure,uv+vec2(uTexel.x,0.0)).x;
  float B=texture(uPressure,uv-vec2(0.0,uTexel.y)).x;
  float T=texture(uPressure,uv+vec2(0.0,uTexel.y)).x;
  float d=texture(uDivergence,uv).x;
  o=vec4((L+R+B+T-d)*0.25,0.0,0.0,1.0);
}`;

const GRADIENT_FS = `#version 300 es
precision highp float;
in vec2 uv; uniform sampler2D uPressure,uVel; uniform vec2 uTexel; out vec4 o;
void main(){
  float L=texture(uPressure,uv-vec2(uTexel.x,0.0)).x;
  float R=texture(uPressure,uv+vec2(uTexel.x,0.0)).x;
  float B=texture(uPressure,uv-vec2(0.0,uTexel.y)).x;
  float T=texture(uPressure,uv+vec2(0.0,uTexel.y)).x;
  vec2 v=texture(uVel,uv).xy-0.5*vec2(R-L,T-B);
  o=vec4(v,0.0,1.0);
}`;

const DISPLAY_FS = `#version 300 es
precision highp float;
in vec2 uv; uniform sampler2D uDye; uniform float uGain; out vec4 o;
void main(){
  vec3 c=texture(uDye,uv).rgb * uGain;   // gain global = énergie (breakdown sombre, drop éclatant)
  c=c/(c+1.0);                            // tonemap
  o=vec4(c,1.0);
}`;

function hueRGB(h) {
  // palette cosinus -> [r,g,b]
  const f = (p) => 0.5 + 0.5 * Math.cos(2 * Math.PI * (h + p));
  return [f(0), f(0.33), f(0.67)];
}

export class FluidVisual {
  constructor(canvas) {
    this.canvas = canvas;
    this.started = false;
    this.w = 0;
    this.h = 0;
    this.time = 0;
  }

  start() {
    const glinfo = createGL(this.canvas);
    const gl = glinfo.gl;
    if (!glinfo.canRenderFloat) throw new Error("EXT_color_buffer_float requis.");
    this.gl = gl;
    this.quad = fullscreenTriangle(gl);
    this.pAdvect = program(gl, VS_QUAD, ADVECT_FS);
    this.pSplat = program(gl, VS_QUAD, SPLAT_FS);
    this.pDiv = program(gl, VS_QUAD, DIVERGENCE_FS);
    this.pPressure = program(gl, VS_QUAD, PRESSURE_FS);
    this.pGradient = program(gl, VS_QUAD, GRADIENT_FS);
    this.pDisplay = program(gl, VS_QUAD, DISPLAY_FS);

    this.vel = pingPong(gl, SIM, SIM, null, gl.LINEAR);
    this.dye = pingPong(gl, SIM, SIM, null, gl.LINEAR);
    this.pressure = pingPong(gl, SIM, SIM, null, gl.NEAREST);
    this.divergence = createFBO(gl, createTexture(gl, SIM, SIM, null, gl.NEAREST));

    this.started = true;
    this.resize();
  }

  resize() {
    if (!this.gl) return;
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.canvas.width = this.w;
    this.canvas.height = this.h;
  }

  _pass(prog, dstFbo, setup) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, dstFbo);
    gl.viewport(0, 0, SIM, SIM);
    gl.useProgram(prog);
    setup(prog);
    gl.bindVertexArray(this.quad);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  _tex(unit, tex, loc) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(loc, unit);
  }

  // Injecte force (vel) + encre (col) en un point.
  _splat(px, py, vx, vy, col, rV, rD) {
    const gl = this.gl;
    const asp = this.w / this.h;
    const fm = this._forceMul || 1; // force des impacts (config)
    this._pass(this.pSplat, this.vel.dst, (p) => {
      this._tex(0, this.vel.src.tex, p.u("uTarget"));
      gl.uniform2f(p.u("uPoint"), px, py);
      gl.uniform3f(p.u("uValue"), vx * fm, vy * fm, 0);
      gl.uniform1f(p.u("uRadius"), rV);
      gl.uniform1f(p.u("uAspect"), asp);
    });
    this.vel.swap();
    this._pass(this.pSplat, this.dye.dst, (p) => {
      this._tex(0, this.dye.src.tex, p.u("uTarget"));
      gl.uniform2f(p.u("uPoint"), px, py);
      gl.uniform3f(p.u("uValue"), col[0], col[1], col[2]);
      gl.uniform1f(p.u("uRadius"), rD);
      gl.uniform1f(p.u("uAspect"), asp);
    });
    this.dye.swap();
  }

  // "Boom" radial : anneau de splats poussant vers l'extérieur + encre centrale.
  _boom(cx, cy, power, col, rD) {
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + this.time;
      const ox = Math.cos(a) * 0.04, oy = Math.sin(a) * 0.04;
      this._splat(cx + ox, cy + oy, ox * power * 40, oy * power * 40, col, 0.0006, rD);
    }
  }

  render(frame) {
    const gl = this.gl;
    gl.disable(gl.BLEND);
    this.time += 0.016;
    const texel = 1 / SIM;
    const dt = 1.0;

    // --- advection de la vélocité (par elle-même) --------------------------
    this._pass(this.pAdvect, this.vel.dst, (p) => {
      this._tex(0, this.vel.src.tex, p.u("uVel"));
      this._tex(1, this.vel.src.tex, p.u("uSrc"));
      gl.uniform2f(p.u("uTexel"), texel, texel);
      gl.uniform1f(p.u("uDt"), dt);
      gl.uniform1f(p.u("uDiss"), config.fluid.velDissipation);
    });
    this.vel.swap();

    // === VOIX MUSICALES : chaque élément a sa région + sa couleur ===========
    const cfg = config.fluid, react = config.global.reactivity;
    this._forceMul = cfg.splatForce * react;
    const hue = themeHue(frame, this.time); // couleur = mode couleur (harmonie/fixe/arc-en-ciel)
    const energy = frame.energy !== undefined ? frame.energy : frame.level; // macro-dynamique
    const baseCol = hueRGB(hue);
    const compCol = hueRGB((hue + 0.5) % 1); // complémentaire pour le snare
    const intensity = 0.4 + energy * 1.3; // les impacts sont plus forts dans le drop

    // REPRISE après coupure = l'explosion MAXIMALE (le vrai payoff).
    if (frame.reentryFlag) {
      this._boom(0.5, 0.5, 6.0, [5, 5, 5], 0.035);
    }
    // ACCALMIE : l'encre est ASPIRÉE vers le centre (ça se rassemble, ça monte
    // en tension) — d'autant plus fort que l'anticipation est haute.
    if (frame.breakActive) {
      const ant = frame.anticipation || 0;
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + this.time * 0.5;
        const ox = Math.cos(a) * 0.28, oy = Math.sin(a) * 0.28;
        const g = 0.04 + ant * 0.22; // encre discrète -> l'accalmie reste sombre/calme
        this._splat(0.5 + ox, 0.5 + oy, -ox * (1 + ant * 5), -oy * (1 + ant * 5),
          [baseCol[0] * g, baseCol[1] * g, baseCol[2] * g], 0.0009, 0.0014);
      }
    }
    // DROP : explosion plein écran (le payoff).
    if (frame.dropFlag) {
      this._boom(0.5, 0.5, 3.0 + frame.bass * 2, [2.5, 2.5, 2.5], 0.02);
    }
    // KICK : boom central, couleur de l'harmonie.
    if (frame.kickFlag) {
      const p = (0.5 + frame.bass) * 1.6;
      this._boom(0.5, 0.5, p, [baseCol[0] * intensity, baseCol[1] * intensity, baseCol[2] * intensity], 0.004);
    }
    // SNARE : crack latéral (alterne gauche/droite), couleur complémentaire.
    if (frame.snareFlag) {
      const left = (this._snareSide = !this._snareSide);
      const px = left ? 0.16 : 0.84;
      const vx = (left ? 1 : -1) * 3.0 * (0.5 + frame.snare);
      this._splat(px, 0.5, vx, 0, [compCol[0] * 1.4, compCol[1] * 1.4, compCol[2] * 1.4], 0.0009, 0.0015);
    }
    // HATS : fines étincelles claires en haut (montent).
    if (frame.hatsFlag) {
      const px = 0.2 + 0.6 * ((this.time * 6.3) % 1);
      this._splat(px, 0.9, 0, 2.0, [1.6, 1.7, 2.0], 0.0004, 0.0004);
    }
    // Souffle continu : turbulence & couleur qui montent avec l'énergie
    // (breakdown = calme et sombre, drop = agité et vif).
    {
      const a = this.time * 0.7;
      const turb = 0.5 + energy * 3.0;
      this._splat(0.5 + Math.cos(a) * 0.2, 0.5 + Math.sin(a * 1.2) * 0.2,
        Math.cos(a) * turb, Math.sin(a) * turb,
        [baseCol[0] * energy * 0.6, baseCol[1] * energy * 0.6, baseCol[2] * energy * 0.6], 0.001, 0.0016);
    }

    // --- divergence --------------------------------------------------------
    this._pass(this.pDiv, this.divergence, (p) => {
      this._tex(0, this.vel.src.tex, p.u("uVel"));
      gl.uniform2f(p.u("uTexel"), texel, texel);
    });

    // --- pression (Jacobi) -------------------------------------------------
    for (let i = 0; i < config.fluid.pressureIters; i++) {
      this._pass(this.pPressure, this.pressure.dst, (p) => {
        this._tex(0, this.pressure.src.tex, p.u("uPressure"));
        this._tex(1, this.divergence.tex, p.u("uDivergence"));
        gl.uniform2f(p.u("uTexel"), texel, texel);
      });
      this.pressure.swap();
    }

    // --- projection (soustrait le gradient de pression) --------------------
    this._pass(this.pGradient, this.vel.dst, (p) => {
      this._tex(0, this.pressure.src.tex, p.u("uPressure"));
      this._tex(1, this.vel.src.tex, p.u("uVel"));
      gl.uniform2f(p.u("uTexel"), texel, texel);
    });
    this.vel.swap();

    // --- advection du colorant --------------------------------------------
    this._pass(this.pAdvect, this.dye.dst, (p) => {
      this._tex(0, this.vel.src.tex, p.u("uVel"));
      this._tex(1, this.dye.src.tex, p.u("uSrc"));
      gl.uniform2f(p.u("uTexel"), texel, texel);
      gl.uniform1f(p.u("uDt"), dt);
      gl.uniform1f(p.u("uDiss"), config.fluid.dyeDissipation);
    });
    this.dye.swap();

    // --- affichage ---------------------------------------------------------
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.w, this.h);
    gl.useProgram(this.pDisplay);
    this._tex(0, this.dye.src.tex, this.pDisplay.u("uDye"));
    // Gain global = énergie : breakdown sombre/calme, drop éclatant.
    gl.uniform1f(this.pDisplay.u("uGain"), (0.35 + energy * 1.3) * config.fluid.brightness * config.global.brightness);
    gl.bindVertexArray(this.quad);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }
}
