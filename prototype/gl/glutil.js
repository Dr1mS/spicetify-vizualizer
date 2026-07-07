// glutil — socle WebGL2 minimal partagé par les scènes "next gen".
// Contexte + float textures, compilation, quad plein écran, FBO ping-pong.

export function createGL(canvas) {
  const gl = canvas.getContext("webgl2", {
    antialias: false,
    alpha: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
  });
  if (!gl) throw new Error("WebGL2 non supporté par ce navigateur.");

  // Rendu vers des textures flottantes (indispensable pour les simulations).
  const extCBF = gl.getExtension("EXT_color_buffer_float");
  const extLF = gl.getExtension("OES_texture_float_linear");
  // Type de rendu : 32F si possible, sinon 16F.
  const floatType = gl.FLOAT;
  return {
    gl,
    canRenderFloat: !!extCBF,
    canFilterFloat: !!extLF,
    floatType,
  };
}

export function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error("Shader:\n" + log + "\n--- source ---\n" + numbered(src));
  }
  return sh;
}

export function program(gl, vsSrc, fsSrc) {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
  const p = gl.createProgram();
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error("Link:\n" + gl.getProgramInfoLog(p));
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  // Cache des locations d'uniforms à la demande.
  const uCache = {};
  p.u = (name) => (uCache[name] ??= gl.getUniformLocation(p, name));
  return p;
}

// Un triangle plein écran (VAO) — couvre le viewport, moins de fragments qu'un quad.
export function fullscreenTriangle(gl) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  return vao;
}

export const VS_QUAD = `#version 300 es
layout(location=0) in vec2 p;
out vec2 uv;
void main(){ uv = p*0.5+0.5; gl_Position = vec4(p,0.0,1.0); }`;

// Texture flottante RGBA (données optionnelles). filter=NEAREST par défaut.
export function createTexture(gl, w, h, data = null, filter = gl.NEAREST, wrap = gl.CLAMP_TO_EDGE) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  tex.width = w;
  tex.height = h;
  return tex;
}

export function createFBO(gl, tex) {
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  fbo.tex = tex;
  return fbo;
}

// Paire ping-pong (deux textures + FBO). swap() échange src/dst.
export function pingPong(gl, w, h, data = null, filter = gl.NEAREST, wrap = gl.CLAMP_TO_EDGE) {
  let a = createFBO(gl, createTexture(gl, w, h, data, filter, wrap));
  let b = createFBO(gl, createTexture(gl, w, h, null, filter, wrap));
  return {
    get src() { return a; },
    get dst() { return b; },
    swap() { const t = a; a = b; b = t; },
    w, h,
  };
}

function numbered(src) {
  return src.split("\n").map((l, i) => `${i + 1}: ${l}`).join("\n");
}
