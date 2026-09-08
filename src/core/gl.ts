// gl.ts — contexte WebGL2.
export function createGL(canvas: HTMLCanvasElement): WebGL2RenderingContext {
  const gl = canvas.getContext("webgl2", {
    antialias: false,
    // alpha VRAI : le mode « fond » compose par pixel avec l'interface Spotify
    // (opaque dans le panneau, translucide autour). Hors de ce mode, le tonemap
    // écrit 1.0 partout : aucun changement.
    alpha: true,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    powerPreference: "high-performance",
  });
  if (!gl) throw new Error("WebGL2 non supporté par ce navigateur.");
  return gl;
}
