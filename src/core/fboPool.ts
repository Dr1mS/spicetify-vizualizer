// fboPool.ts — pool de cibles float prêtées aux modes (hot-swap sans réalloc/fuite).
import { createTarget, type Target } from "./pingpong";

interface Entry { key: string; target: Target; inUse: boolean; }

export class FboPool {
  private entries: Entry[] = [];
  constructor(public gl: WebGL2RenderingContext) {}

  private key(w: number, h: number, internal: number, filter: number, wrap: number): string {
    return `${w}x${h}:${internal}:${filter}:${wrap}`;
  }

  acquire(w: number, h: number, internal: number, filter = this.gl.NEAREST, wrap = this.gl.CLAMP_TO_EDGE): Target {
    const key = this.key(w, h, internal, filter, wrap);
    let e = this.entries.find((x) => x.key === key && !x.inUse);
    if (!e) { e = { key, target: createTarget(this.gl, w, h, internal, filter, wrap), inUse: false }; this.entries.push(e); }
    e.inUse = true;
    return e.target;
  }

  release(target: Target): void {
    const e = this.entries.find((x) => x.target === target);
    if (e) e.inUse = false;
  }

  // Libère tout ce qui ne correspond plus (ex. après resize).
  purge(w: number, h: number): void {
    const gl = this.gl;
    this.entries = this.entries.filter((e) => {
      if (e.inUse) return true;
      if (e.key.startsWith(`${w}x${h}:`)) return true;
      gl.deleteTexture(e.target.tex); gl.deleteFramebuffer(e.target.fbo);
      return false;
    });
  }
}
