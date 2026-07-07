// ParticlesVisual — scène "next gen" : particules GPU dans un flow field.
//
// État (position xy, vélocité zw) stocké en texture RGBA32F, mis à jour par un
// fragment shader (ping-pong). Force = curl-noise (divergence-free) + impulsions
// audio. Rendu en POINTS additifs sur un buffer à feedback (traînées).
//
//   basse    -> amplitude de turbulence
//   treble   -> finesse du champ (fréquence spatiale)
//   kick     -> impulsion radiale (souffle sur le beat)
//   spectre  -> force par angle (le son sculpte le nuage)
//   centroïde-> palette

import {
  createGL, program, fullscreenTriangle, VS_QUAD,
  createTexture, createFBO, pingPong,
} from "../gl/glutil.js";
import { config, themeHue } from "../config.js";

const SIZE = 256; // 256*256 = 65 536 particules

// --- Bruit simplex 3D (Ashima, domaine public) -----------------------------
const SNOISE = `
vec4 permute(vec4 x){return mod(((x*34.0)+1.0)*x,289.0);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g; vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+1.0*C.xxx; vec3 x2=x0-i2+2.0*C.xxx; vec3 x3=x0-1.0+3.0*C.xxx;
  i=mod(i,289.0);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=1.0/7.0; vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z);
  vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0); m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}`;

const UPDATE_FS = `#version 300 es
precision highp float;
in vec2 uv;
uniform sampler2D uState;
uniform sampler2D uBands;
uniform float uTime,uTreble,uEnergy,uTension,uImpulse,uGather,uFlowScale,uFlowSpeed,uDamping;
out vec4 o;
${SNOISE}
// Potentiel qui évolue LENTEMENT dans le temps -> flux cohérent, pas du bruit.
float psi(vec2 p){ return snoise(vec3(p, uTime*0.05)); }
vec2 curl(vec2 p){
  float e=0.15;
  float dx=psi(p+vec2(e,0.0))-psi(p-vec2(e,0.0));
  float dy=psi(p+vec2(0.0,e))-psi(p-vec2(0.0,e));
  return vec2(dy,-dx);
}
void main(){
  vec4 s=texture(uState,uv);
  vec2 pos=s.xy; vec2 vel=s.zw;
  float scale=uFlowScale+uTreble*1.1;
  vec2 flow=curl(pos*scale);
  // l'ÉNERGIE (drop/break) et la TENSION énergisent le flux
  vec2 f=flow*(0.0026+uEnergy*0.0022+uTension*0.002)*uFlowSpeed;
  vec2 c=pos-0.5; float d=length(c)+1e-4; vec2 dir=c/d;
  f+=dir*uImpulse;                                     // kick/drop/reprise -> souffle DEHORS
  f-=dir*uGather;                                      // accalmie -> aspiration vers le CENTRE
  float ang=atan(c.y,c.x)/6.2831853+0.5;
  float be=texture(uBands,vec2(ang,0.5)).r;
  f+=dir*be*0.0008*uTension;                           // le spectre sculpte
  vel=vel*uDamping+f;
  float sp=length(vel); if(sp>0.03) vel*=0.03/sp;      // clamp -> jamais expulsé
  pos+=vel;
  pos=fract(pos);
  o=vec4(pos,vel);
}`;

const RENDER_VS = `#version 300 es
uniform sampler2D uState;
uniform int uSize;
uniform float uKeyHue,uEnergy,uHats,uPointSize;
out float vSpeed; out float vHue; out float vBright;
void main(){
  int id=gl_VertexID; int x=id%uSize; int y=id/uSize;
  vec2 uv=(vec2(float(x),float(y))+0.5)/float(uSize);
  vec4 s=texture(uState,uv);
  vSpeed=length(s.zw);
  vHue=uKeyHue;                                         // couleur = harmonie/mode couleur
  vBright=0.5+uEnergy*0.9+uHats*0.6;                    // + brillant dans le drop / sur les hats
  gl_Position=vec4(s.xy*2.0-1.0,0.0,1.0);
  gl_PointSize=clamp((1.5+vSpeed*180.0+uEnergy*2.5+uHats*3.0)*uPointSize,1.0,10.0);
}`;

const RENDER_FS = `#version 300 es
precision highp float;
in float vSpeed; in float vHue; in float vBright;
uniform float uHueSpread;
out vec4 o;
vec3 pal(float t){
  return 0.5+0.5*cos(6.2831853*(t+vec3(0.0,0.33,0.67)));
}
void main(){
  vec2 dd=gl_PointCoord-0.5; float r=length(dd);
  if(r>0.5) discard;
  float a=smoothstep(0.5,0.0,r)*vBright;               // brillance ∝ énergie
  float h=fract(vHue+vSpeed*18.0*uHueSpread);          // teinte + variété selon la vitesse
  vec3 col=pal(h);
  o=vec4(col*a*0.7,a*0.7);
}`;

const FADE_FS = `#version 300 es
precision highp float;
in vec2 uv; uniform sampler2D uTex; uniform float uFade; out vec4 o;
void main(){ o=texture(uTex,uv)*uFade; }`;

const BLIT_FS = `#version 300 es
precision highp float;
in vec2 uv; uniform sampler2D uTex; uniform float uGain; out vec4 o;
void main(){
  vec3 c=texture(uTex,uv).rgb * uGain;   // gain global = énergie (break sombre, drop éclatant)
  c=c/(c+1.0);
  o=vec4(c,1.0);
}`;

export class ParticlesVisual {
  constructor(canvas) {
    this.canvas = canvas;
    this.started = false;
    this.w = 0;
    this.h = 0;
  }

  start() {
    const { gl, canRenderFloat } = createGL(this.canvas);
    if (!canRenderFloat) throw new Error("EXT_color_buffer_float requis (rendu flottant).");
    this.gl = gl;
    this.quad = fullscreenTriangle(gl);
    this.emptyVao = gl.createVertexArray();

    this.pUpdate = program(gl, VS_QUAD, UPDATE_FS);
    this.pRender = program(gl, RENDER_VS, RENDER_FS);
    this.pFade = program(gl, VS_QUAD, FADE_FS);
    this.pBlit = program(gl, VS_QUAD, BLIT_FS);

    // État initial : positions aléatoires, vélocité nulle.
    const seed = new Float32Array(SIZE * SIZE * 4);
    for (let i = 0; i < SIZE * SIZE; i++) {
      seed[i * 4] = Math.random();
      seed[i * 4 + 1] = Math.random();
    }
    this.state = pingPong(gl, SIZE, SIZE, seed, gl.NEAREST);

    // Texture des bandes (64x1), mise à jour chaque frame.
    this.bandData = new Float32Array(64 * 4);
    this.bandTex = createTexture(gl, 64, 1, this.bandData, gl.LINEAR, gl.CLAMP_TO_EDGE);

    this.started = true;
    this.resize();
  }

  resize() {
    if (!this.gl) return;
    const dpr = 1; // GL en résolution CSS (perf du buffer à feedback)
    this.w = Math.floor(window.innerWidth * dpr);
    this.h = Math.floor(window.innerHeight * dpr);
    this.canvas.width = this.w;
    this.canvas.height = this.h;
    const gl = this.gl;
    if (this.screen) {
      gl.deleteTexture(this.screen.src.tex);
      gl.deleteTexture(this.screen.dst.tex);
      gl.deleteFramebuffer(this.screen.src);
      gl.deleteFramebuffer(this.screen.dst);
    }
    this.screen = pingPong(gl, this.w, this.h, null, gl.LINEAR);
  }

  render(frame) {
    const gl = this.gl;
    const cfg = config.particles, react = config.global.reactivity;
    this.time = (this.time || 0) + 0.016;

    // Impulsion radiale (souffle DEHORS) : kick < drop < reprise, avec chute.
    const ki = cfg.kickImpulse * react;
    this.impulse = (this.impulse || 0) * 0.86;
    if (frame.kickFlag) this.impulse = Math.max(this.impulse, 0.004 * ki);
    if (frame.dropFlag) this.impulse = Math.max(this.impulse, 0.012 * ki);
    if (frame.reentryFlag) this.impulse = Math.max(this.impulse, 0.02 * ki);
    // Aspiration vers le centre pendant l'accalmie (monte avec l'anticipation).
    const gatherTarget = frame.breakActive ? 0.0016 * (0.3 + (frame.anticipation || 0)) : 0;
    this.gather = (this.gather || 0) * 0.9 + gatherTarget * 0.1;

    // MAJ texture des bandes.
    const b = frame.bands;
    for (let i = 0; i < 64; i++) this.bandData[i * 4] = b[i] || 0;
    gl.bindTexture(gl.TEXTURE_2D, this.bandTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 64, 1, gl.RGBA, gl.FLOAT, this.bandData);

    // --- 1) MAJ de l'état (particules) -------------------------------------
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.state.dst);
    gl.viewport(0, 0, SIZE, SIZE);
    gl.useProgram(this.pUpdate);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.state.src.tex);
    gl.uniform1i(this.pUpdate.u("uState"), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.bandTex);
    gl.uniform1i(this.pUpdate.u("uBands"), 1);
    gl.uniform1f(this.pUpdate.u("uTime"), this.time);
    gl.uniform1f(this.pUpdate.u("uTreble"), frame.treble);
    gl.uniform1f(this.pUpdate.u("uEnergy"), frame.energy ?? frame.level);
    gl.uniform1f(this.pUpdate.u("uTension"), frame.tension || 0);
    gl.uniform1f(this.pUpdate.u("uImpulse"), this.impulse);
    gl.uniform1f(this.pUpdate.u("uGather"), this.gather);
    gl.uniform1f(this.pUpdate.u("uFlowScale"), cfg.flowScale);
    gl.uniform1f(this.pUpdate.u("uFlowSpeed"), cfg.flowSpeed * react);
    gl.uniform1f(this.pUpdate.u("uDamping"), cfg.damping);
    gl.bindVertexArray(this.quad);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.state.swap();

    // --- 2) feedback : fade de l'écran précédent ---------------------------
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.screen.dst);
    gl.viewport(0, 0, this.w, this.h);
    gl.useProgram(this.pFade);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.screen.src.tex);
    gl.uniform1i(this.pFade.u("uTex"), 0);
    gl.uniform1f(this.pFade.u("uFade"), Math.min(0.985, cfg.trail + (frame.energy ?? frame.level) * 0.04));
    gl.bindVertexArray(this.quad);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // --- 3) dessin additif des particules ----------------------------------
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.useProgram(this.pRender);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.state.src.tex);
    gl.uniform1i(this.pRender.u("uState"), 0);
    gl.uniform1i(this.pRender.u("uSize"), SIZE);
    gl.uniform1f(this.pRender.u("uKeyHue"), themeHue(frame, this.time));
    gl.uniform1f(this.pRender.u("uEnergy"), frame.energy ?? frame.level);
    gl.uniform1f(this.pRender.u("uHats"), frame.hats || 0);
    gl.uniform1f(this.pRender.u("uPointSize"), cfg.pointSize);
    gl.uniform1f(this.pRender.u("uHueSpread"), config.global.hueSpread);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.POINTS, 0, SIZE * SIZE);
    gl.disable(gl.BLEND);
    this.screen.swap();

    // --- 4) blit vers le canvas --------------------------------------------
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.w, this.h);
    gl.useProgram(this.pBlit);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.screen.src.tex);
    gl.uniform1i(this.pBlit.u("uTex"), 0);
    // Gain global = énergie × éclat (config) × luminosité globale.
    gl.uniform1f(this.pBlit.u("uGain"), (0.4 + (frame.energy ?? frame.level) * 1.3) * cfg.brightness * config.global.brightness);
    gl.bindVertexArray(this.quad);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }
}
