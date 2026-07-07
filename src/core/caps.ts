// caps.ts — sondage des capacités GPU (jamais supposées) + smoke-test 16F.
import { makeProgram, drawFullscreen } from "./fullscreen";

export interface Caps {
  floatRenderable: boolean; // EXT_color_buffer_float (RGBA32F+16F renderable)
  halfRenderable: boolean; // EXT_color_buffer_half_float (16F)
  floatLinear: boolean; // OES_texture_float_linear
  halfLinear: boolean; // OES_texture_half_float_linear
  floatBlend: boolean; // EXT_float_blend (blend vers 32F)
  simFormat: number; // internalformat des buffers de sim/état
  accumFormat: number; // internalformat des buffers d'accumulation (density/growth)
  accumBlend: boolean; // le blend additif est-il utilisable sur accumFormat ?
}

export function probeCaps(gl: WebGL2RenderingContext): Caps {
  const floatRenderable = !!gl.getExtension("EXT_color_buffer_float");
  const halfRenderable = !!gl.getExtension("EXT_color_buffer_half_float");
  const floatLinear = !!gl.getExtension("OES_texture_float_linear");
  const halfLinear = !!gl.getExtension("OES_texture_half_float_linear");
  const floatBlend = !!gl.getExtension("EXT_float_blend");

  if (!floatRenderable && !halfRenderable) throw new Error("Aucune texture float rendable (EXT_color_buffer_float/half_float requis).");

  const simFormat = floatRenderable ? gl.RGBA32F : gl.RGBA16F;

  // Accumulation : 16F blende gratuitement mais peut BANDER (précision). On teste.
  let accumFormat: number = gl.RGBA16F;
  let accumBlend = true;
  const bands16 = smokeTestBanding(gl, gl.RGBA16F);
  if (bands16) {
    // 16F bande -> 32F si possible (blend 32F nécessite EXT_float_blend)
    if (floatRenderable && floatBlend) { accumFormat = gl.RGBA32F; accumBlend = true; }
    else if (floatRenderable) { accumFormat = gl.RGBA32F; accumBlend = false; } // accumulation manuelle
    else { accumFormat = gl.RGBA16F; accumBlend = true; } // pas le choix
  }

  return { floatRenderable, halfRenderable, floatLinear, halfLinear, floatBlend, simFormat, accumFormat, accumBlend };
}

// Rend N quads additifs de 1/N dans un FBO 1×1 du format donné, relit : si la
// somme plafonne bien sous 1, le format bande (précision insuffisante).
function smokeTestBanding(gl: WebGL2RenderingContext, internal: number): boolean {
  const N = 4096;
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, 1, 1, 0, gl.RGBA, internal === gl.RGBA16F ? gl.HALF_FLOAT : gl.FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) { cleanup(); return true; } // incomplet -> considère bandé
  gl.viewport(0, 0, 1, 1);
  gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);

  let banded = true;
  try {
    const pi = makeProgram(gl, `#version 300 es
precision highp float; out vec4 o; uniform float u_v; void main(){ o = vec4(u_v); }`);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    for (let i = 0; i < N; i++) drawFullscreen(gl, pi, { u_v: 1 / N });
    gl.disable(gl.BLEND);
    const out = new Float32Array(4);
    // lecture : RGBA/FLOAT (float renderable requis pour readPixels float)
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, out);
    banded = out[0] < 0.9; // devrait atteindre ~1.0 si pas de banding
  } catch { banded = true; }
  cleanup();
  return banded;

  function cleanup() {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(tex);
  }
}
