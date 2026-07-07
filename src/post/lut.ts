// lut.ts — LUT couleur sombre->glow (RGBA8, LINEAR autorisé sans extension float).
// Le glow vient de la densité ; la LUT ne fait que colorer l'intensité tonemappée.

type Stop = [number, [number, number, number]]; // [t, [r,g,b]] en 0..1

export const LUTS: Record<string, Stop[]> = {
  ember: [[0, [0.01, 0.01, 0.03]], [0.35, [0.4, 0.05, 0.15]], [0.65, [0.95, 0.35, 0.1]], [0.85, [1, 0.8, 0.35]], [1, [1, 1, 0.95]]],
  ice: [[0, [0.01, 0.02, 0.04]], [0.4, [0.05, 0.2, 0.45]], [0.7, [0.2, 0.6, 0.95]], [0.9, [0.6, 0.95, 1]], [1, [0.95, 1, 1]]],
  acid: [[0, [0.02, 0.02, 0.02]], [0.35, [0.1, 0.35, 0.1]], [0.6, [0.45, 0.9, 0.15]], [0.85, [0.9, 1, 0.3]], [1, [1, 1, 0.9]]],
  magma: [[0, [0.01, 0.0, 0.02]], [0.3, [0.3, 0.03, 0.35]], [0.6, [0.85, 0.15, 0.4]], [0.85, [1, 0.55, 0.3]], [1, [1, 0.95, 0.8]]],
};

export const LUT_NAMES = Object.keys(LUTS);

function sample(stops: Stop[], t: number): [number, number, number] {
  t = Math.min(1, Math.max(0, t));
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, c0] = stops[i], [t1, c1] = stops[i + 1];
    if (t >= t0 && t <= t1) {
      const k = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
      return [c0[0] + (c1[0] - c0[0]) * k, c0[1] + (c1[1] - c0[1]) * k, c0[2] + (c1[2] - c0[2]) * k];
    }
  }
  return stops[stops.length - 1][1];
}

export function makeLUT(gl: WebGL2RenderingContext, name = "ember"): WebGLTexture {
  const stops = LUTS[name] ?? LUTS.ember;
  const N = 256;
  const data = new Uint8Array(N * 4);
  for (let i = 0; i < N; i++) {
    const c = sample(stops, i / (N - 1));
    data[i * 4] = Math.round(c[0] * 255);
    data[i * 4 + 1] = Math.round(c[1] * 255);
    data[i * 4 + 2] = Math.round(c[2] * 255);
    data[i * 4 + 3] = 255;
  }
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, N, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}
