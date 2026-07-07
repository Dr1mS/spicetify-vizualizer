#version 300 es
precision highp float;
// Démo de validation du cœur de rendu (Step 3) : densité procédurale pilotée
// par les features. Remplacée par les vrais modes au Step 5.
in vec2 v_uv;
uniform float u_time, u_onset, u_energy, u_keyHue, u_beatPhase, u_rms;
out vec4 o;
void main() {
  vec2 p = v_uv * 2.0 - 1.0;
  float r = length(p);
  // anneau qui suit la phase du beat + éclat sur l'onset
  float ring = exp(-abs(r - u_beatPhase) * 10.0) * (0.5 + u_rms);
  float burst = smoothstep(0.7, 0.0, r) * u_onset * 2.0;
  float bands = u_melf(clamp(r, 0.0, 1.0)) * 0.8;
  float d = ring + burst + bands * (0.3 + u_energy);
  vec3 col = hue(u_keyHue + r * 0.15 + u_time * 0.02) * d;
  o = vec4(col, 1.0);
}
