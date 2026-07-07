// ReactionVisual — scène "next gen" : réaction-diffusion Gray-Scott sur GPU.
//
// Deux "chimies" U,V (canaux R,G d'une texture flottante) évoluent par
// diffusion + réaction, en ping-pong. Système à mémoire pur : l'audio ne dessine
// pas, il MODULE la chimie (feed/kill) et injecte des germes sur les onsets.
//
//   bass     -> feed (croissance des motifs)
//   treble   -> kill (finesse / dissolution)
//   kick/onset-> injection de germes V (nouvelles structures)
//   centroïde -> palette

import { createGL, program, fullscreenTriangle, VS_QUAD, pingPong } from "../gl/glutil.js";
import { config, themeHue } from "../config.js";

const SIM = 512; // grille de simulation (carrée)

const UPDATE_FS = `#version 300 es
precision highp float;
in vec2 uv;
uniform sampler2D uState;
uniform vec2 uTexel;
uniform float uF,uK,uDu,uDv,uVDecay;
uniform vec2 uSeedPos; uniform float uSeed;
out vec4 o;
void main(){
  vec2 c=texture(uState,uv).rg;
  // Laplacien 9 points.
  vec2 lap=
     texture(uState,uv+vec2(-1,-1)*uTexel).rg*0.05
    +texture(uState,uv+vec2( 0,-1)*uTexel).rg*0.20
    +texture(uState,uv+vec2( 1,-1)*uTexel).rg*0.05
    +texture(uState,uv+vec2(-1, 0)*uTexel).rg*0.20
    +c*(-1.0)
    +texture(uState,uv+vec2( 1, 0)*uTexel).rg*0.20
    +texture(uState,uv+vec2(-1, 1)*uTexel).rg*0.05
    +texture(uState,uv+vec2( 0, 1)*uTexel).rg*0.20
    +texture(uState,uv+vec2( 1, 1)*uTexel).rg*0.05;
  float U=c.r, V=c.g;
  float react=U*V*V;
  float dU=uDu*lap.r - react + uF*(1.0-U);
  float dV=uDv*lap.g + react - (uF+uK)*V;
  U+=dU; V+=dV;
  V*=uVDecay;                              // dissolution -> "reset" (fort si audio calme)
  // Injection de germes (audio) autour de uSeedPos.
  float d=distance(uv,uSeedPos);
  V+=uSeed*exp(-d*d*900.0);
  o=vec4(clamp(U,0.0,1.0),clamp(V,0.0,1.0),0.0,1.0);
}`;

const DISPLAY_FS = `#version 300 es
precision highp float;
in vec2 uv;
uniform sampler2D uState;
uniform float uHue,uLevel,uGain;
out vec4 o;
vec3 pal(float t){ return 0.5+0.5*cos(6.2831853*(t+vec3(0.0,0.33,0.67))); }
void main(){
  float V=texture(uState,uv).g;
  float t=smoothstep(0.02,0.35,V);
  vec3 col=pal(0.55+uHue*0.4+V*0.6)*t;          // couleur = harmonie (keyHue)
  col+=pal(uHue)*pow(t,3.0)*0.6*(0.5+uLevel);   // liseré lumineux
  col*=uGain;                                    // gain global = énergie (break sombre, drop vif)
  o=vec4(col,1.0);
}`;

export class ReactionVisual {
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
    this.pUpdate = program(gl, VS_QUAD, UPDATE_FS);
    this.pDisplay = program(gl, VS_QUAD, DISPLAY_FS);

    // État initial : U=1 partout, V=0 avec quelques taches aléatoires.
    const seed = new Float32Array(SIM * SIM * 4);
    for (let i = 0; i < SIM * SIM; i++) {
      seed[i * 4] = 1.0;
      seed[i * 4 + 1] = 0.0;
      seed[i * 4 + 3] = 1.0;
    }
    for (let s = 0; s < 40; s++) {
      const cx = (Math.random() * SIM) | 0;
      const cy = (Math.random() * SIM) | 0;
      for (let y = -6; y <= 6; y++)
        for (let x = -6; x <= 6; x++) {
          const px = (cx + x + SIM) % SIM;
          const py = (cy + y + SIM) % SIM;
          seed[(py * SIM + px) * 4 + 1] = 0.9;
        }
    }
    this.state = pingPong(gl, SIM, SIM, seed, gl.LINEAR, gl.REPEAT);

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

  render(frame) {
    const gl = this.gl;
    this.time += 0.016;

    const energy = frame.energy ?? frame.level;

    // Germe selon la VOIX qui frappe : chaque élément à sa place (priorité).
    let seedPos = [0.5, 0.5];
    let seedAmt = 0;
    if (frame.reentryFlag) { seedPos = [0.5, 0.5]; seedAmt = 0.95; }        // reprise = explosion
    else if (frame.dropFlag) { seedPos = [0.5, 0.5]; seedAmt = 0.7; }        // drop
    else if (frame.kickFlag) { seedPos = [0.5, 0.5]; seedAmt = 0.5; }        // kick = centre
    else if (frame.snareFlag) { seedPos = [(this._side = !this._side) ? 0.25 : 0.75, 0.5]; seedAmt = 0.5; } // snare = côtés
    else if (frame.hatsFlag) { seedPos = [0.2 + 0.6 * ((this.time * 6.3) % 1), 0.82]; seedAmt = 0.3; }     // hats = haut
    else if (frame.breakActive) { seedPos = [0.5, 0.5]; seedAmt = 0.03 * (frame.anticipation || 0); }       // accalmie : germe central qui monte

    // Paramètres Gray-Scott modulés par l'audio.
    const F = config.reaction.feed + frame.bass * 0.02 * config.global.reactivity;
    const K = config.reaction.kill + frame.treble * 0.006;

    gl.disable(gl.BLEND);
    gl.useProgram(this.pUpdate);
    gl.uniform2f(this.pUpdate.u("uTexel"), 1 / SIM, 1 / SIM);
    gl.uniform1f(this.pUpdate.u("uF"), F);
    gl.uniform1f(this.pUpdate.u("uK"), K);
    gl.uniform1f(this.pUpdate.u("uDu"), 0.2);
    gl.uniform1f(this.pUpdate.u("uDv"), 0.1);
    // Dissolution : QUASI NULLE tant qu'il y a du son (les motifs propagent et
    // vivent), sensible seulement au silence prolongé (l'écran se vide alors).
    const decay = 1 - (config.reaction.decay + (frame.breakActive ? 0.004 : Math.max(0, 0.4 - energy) * 0.006));
    gl.uniform1f(this.pUpdate.u("uVDecay"), decay);
    gl.bindVertexArray(this.quad);

    // Plusieurs itérations de sim par frame.
    for (let it = 0; it < config.reaction.iterations; it++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.state.dst);
      gl.viewport(0, 0, SIM, SIM);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.state.src.tex);
      gl.uniform1i(this.pUpdate.u("uState"), 0);
      // germe uniquement à la 1re itération.
      gl.uniform2f(this.pUpdate.u("uSeedPos"), seedPos[0], seedPos[1]);
      gl.uniform1f(this.pUpdate.u("uSeed"), it === 0 ? seedAmt : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      this.state.swap();
    }

    // Affichage vers le canvas.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.w, this.h);
    gl.useProgram(this.pDisplay);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.state.src.tex);
    gl.uniform1i(this.pDisplay.u("uState"), 0);
    gl.uniform1f(this.pDisplay.u("uHue"), themeHue(frame, this.time)); // couleur = mode couleur
    gl.uniform1f(this.pDisplay.u("uLevel"), frame.level);
    gl.uniform1f(this.pDisplay.u("uGain"), (0.45 + energy * 1.0) * config.reaction.brightness * config.global.brightness); // break sombre, drop vif
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }
}
