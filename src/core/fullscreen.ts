// fullscreen.ts — programmes (twgl) + passe fullscreen-triangle sans VBO.
import * as twgl from "twgl.js";
import fsVert from "../shaders/fullscreen.vert?raw";
import commonGlsl from "../shaders/common.glsl?raw";

// GLSL n'a pas de #include : on préfixe la précision PUIS `common.glsl` juste
// après la ligne #version (la précision doit précéder tout usage de float).
export function withCommon(frag: string): string {
  const nl = frag.indexOf("\n");
  const version = frag.slice(0, nl + 1); // "#version 300 es\n"
  return version + "precision highp float;\nprecision highp int;\n" + commonGlsl + "\n" + frag.slice(nl + 1);
}

export function makeProgram(gl: WebGL2RenderingContext, frag: string, opts?: { common?: boolean; vert?: string }): twgl.ProgramInfo {
  const f = opts?.common ? withCommon(frag) : frag;
  let error: string | null = null;
  const pi = twgl.createProgramInfo(gl, [opts?.vert ?? fsVert, f], { errorCallback: (m) => (error = m) });
  if (error || !pi.program) throw new Error("Shader:\n" + error);
  return pi;
}

let _vao: WebGLVertexArrayObject | null = null;
export function drawFullscreen(gl: WebGL2RenderingContext, pi: twgl.ProgramInfo, uniforms: Record<string, unknown>): void {
  gl.useProgram(pi.program);
  twgl.setUniforms(pi, uniforms);
  if (!_vao) _vao = gl.createVertexArray();
  gl.bindVertexArray(_vao);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.bindVertexArray(null);
}

export function bindTarget(gl: WebGL2RenderingContext, fbo: WebGLFramebuffer | null, w: number, h: number): void {
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.viewport(0, 0, w, h);
}
