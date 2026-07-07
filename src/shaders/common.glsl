// common.glsl — helpers partagés (préfixés aux frags de modes via makeProgram).
// Pas de #include natif en GLSL : on concatène cette chaîne côté JS.

// --- bus de features -------------------------------------------------------
// u_feat = texture R32F de MEL[32] (1 ligne). u_mel(i) lit la bande i (0..31).
uniform sampler2D u_feat;
uniform float u_melCount;
float u_mel(int i) { return texelFetch(u_feat, ivec2(i, 0), 0).r; }
// bande mel interpolée en 0..1
float u_melf(float x) {
  float f = clamp(x, 0.0, 1.0) * (u_melCount - 1.0);
  int i = int(floor(f));
  float t = fract(f);
  return mix(u_mel(i), u_mel(min(i + 1, int(u_melCount) - 1)), t);
}

// --- utilitaires -----------------------------------------------------------
const float TAU = 6.2831853;
vec2 wrap01(vec2 p) { return fract(p); }                 // tore
float hash11(float n) { return fract(sin(n * 43758.5453) * 12.9898); }
vec2 hash22(vec2 p) { p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3))); return fract(sin(p) * 43758.5453); }
// palette cosinus (Iñigo Quílez) — teinte 0..1
vec3 palette(float t, vec3 a, vec3 b, vec3 c, vec3 d) { return a + b * cos(TAU * (c * t + d)); }
vec3 hue(float t) { return palette(t, vec3(0.5), vec3(0.5), vec3(1.0), vec3(0.0, 0.33, 0.67)); }
