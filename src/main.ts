// main.ts — bootstrap. Étape 0 : vérifier crossOriginIsolated + WebGL2.
// (S'étoffe aux étapes suivantes : caps -> audio -> matrix -> loop.)

const coi = crossOriginIsolated;
console.info("[viz] crossOriginIsolated =", coi, "| SharedArrayBuffer =", typeof SharedArrayBuffer !== "undefined");

const canvas = document.getElementById("c") as HTMLCanvasElement;
const gl = canvas.getContext("webgl2", { antialias: false, alpha: false });
console.info("[viz] WebGL2 =", !!gl);

// Exposé pour la vérification headless (preview eval).
(globalThis as unknown as { __viz: unknown }).__viz = {
  crossOriginIsolated: coi,
  hasSAB: typeof SharedArrayBuffer !== "undefined",
  webgl2: !!gl,
  ext: gl
    ? {
        colorBufferFloat: !!gl.getExtension("EXT_color_buffer_float"),
        colorBufferHalfFloat: !!gl.getExtension("EXT_color_buffer_half_float"),
        floatLinear: !!gl.getExtension("OES_texture_float_linear"),
        floatBlend: !!gl.getExtension("EXT_float_blend"),
      }
    : null,
};

const boot = document.getElementById("boot")!;
document.getElementById("start")!.addEventListener("click", () => {
  // L'audio (getUserMedia + ctx.resume) doit être derrière un geste utilisateur.
  boot.classList.add("hidden");
  console.info("[viz] démarrage (audio branché à l'étape 1)");
});
