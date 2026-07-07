// featureTexture.ts — expose les features aux shaders :
//   - u_feat : data-texture R32F de MEL[32] (NEAREST), MAJ chaque frame ;
//   - uniforms scalaires communs (bpm, beatPhase, onset, rms, ...).
import { F, MEL_COUNT } from "../audio/constants";
import type { BusFrame } from "../audio/bus";

export class FeatureTexture {
  tex: WebGLTexture;
  private data = new Float32Array(MEL_COUNT);

  constructor(public gl: WebGL2RenderingContext) {
    this.tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, MEL_COUNT, 1, 0, gl.RED, gl.FLOAT, this.data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  update(fr: BusFrame): void {
    const gl = this.gl;
    for (let i = 0; i < MEL_COUNT; i++) this.data[i] = fr.feat[F.MEL0 + i];
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, MEL_COUNT, 1, gl.RED, gl.FLOAT, this.data);
  }

  // Uniforms scalaires communs (à étaler sur setUniforms).
  uniforms(fr: BusFrame): Record<string, unknown> {
    const f = fr.feat;
    return {
      u_feat: this.tex,
      u_melCount: MEL_COUNT,
      u_rms: f[F.RMS], u_peak: f[F.PEAK], u_flux: f[F.FLUX],
      u_centroid: f[F.CENTROID], u_flatness: f[F.FLATNESS], u_energy: f[F.ENERGY],
      u_keyHue: f[F.KEY_HUE], u_onset: f[F.ONSET_STR],
      u_kick: f[F.KICK], u_snare: f[F.SNARE], u_hats: f[F.HATS],
      u_bpm: fr.bpm, u_beatPhase: fr.beatPhase, u_lockConf: fr.lockConf,
    };
  }
}
