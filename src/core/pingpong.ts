// pingpong.ts — double-FBO float pour l'état de simulation (swap chaque frame).
// Sim/état -> NEAREST + CLAMP_TO_EDGE (le filtrage float n'est pas garanti).

export interface Target {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
}

export function fmtType(gl: WebGL2RenderingContext, internal: number): number {
  return internal === gl.RGBA16F ? gl.HALF_FLOAT : gl.FLOAT;
}

export function createTarget(
  gl: WebGL2RenderingContext, w: number, h: number, internal: number,
  filter: number = gl.NEAREST, wrap: number = gl.CLAMP_TO_EDGE, data: ArrayBufferView | null = null,
): Target {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, gl.RGBA, fmtType(gl, internal), data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  const fbo = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error("FBO incomplet (format non rendable ?)");
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { tex, fbo };
}

export class PingPong {
  a: Target;
  b: Target;
  constructor(
    public gl: WebGL2RenderingContext, public w: number, public h: number, public internal: number,
    public filter: number = gl.NEAREST, public wrap: number = gl.CLAMP_TO_EDGE, seed: ArrayBufferView | null = null,
  ) {
    this.a = createTarget(gl, w, h, internal, filter, wrap, seed);
    this.b = createTarget(gl, w, h, internal, filter, wrap, null);
  }
  get read(): Target { return this.a; }
  get write(): Target { return this.b; }
  swap(): void { const t = this.a; this.a = this.b; this.b = t; }
  resize(w: number, h: number, seed: ArrayBufferView | null = null): void {
    if (w === this.w && h === this.h) return;
    this.dispose();
    this.w = w; this.h = h;
    this.a = createTarget(this.gl, w, h, this.internal, this.filter, this.wrap, seed);
    this.b = createTarget(this.gl, w, h, this.internal, this.filter, this.wrap, null);
  }
  dispose(): void {
    const gl = this.gl;
    for (const t of [this.a, this.b]) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fbo); }
  }
}
