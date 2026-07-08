#version 300 es
precision highp float;
// Tonemap partagé : densité accumulée -> log/exp -> LUT sombre->glow -> sRGB.
// Le GLOW vient de la DENSITÉ (accumulation), pas d'un bloom post fake.
in vec2 v_uv;
uniform sampler2D u_src; // buffer float (densité / couleur)
uniform sampler2D u_lut; // LUT RGBA8 sombre->glow (LINEAR)
uniform float u_exposure;
uniform float u_hueShift; // décale la teinte de la LUT
uniform float u_beatFlash; // gain de sortie pulsé sur le beat
out vec4 o;

void main() {
  vec3 c = texture(u_src, v_uv).rgb;
  float d = max(c.r, max(c.g, c.b)); // densité
  // tonemap : saturation douce (glow proportionnel à la densité)
  float t = 1.0 - exp(-d * u_exposure);
  vec3 lut = texture(u_lut, vec2(clamp(t + u_hueShift * 0.0, 0.0, 1.0), 0.5)).rgb;
  // si le buffer porte une teinte (rgb non gris), on la mélange légèrement
  float chroma = length(c - vec3(d)) ;
  vec3 tinted = mix(lut, lut * (0.4 + 0.6 * normalize(c + 1e-4)), clamp(chroma * 2.0, 0.0, 0.5));
  o = vec4(tinted * (1.0 + u_beatFlash), 1.0); // flash de sortie sur le beat

}
