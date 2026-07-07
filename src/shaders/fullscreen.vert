#version 300 es
// Triangle plein écran sans VBO (utilise gl_VertexID). v_uv ∈ [0,1] sur l'écran.
out vec2 v_uv;
void main() {
  vec2 uv = vec2(gl_VertexID == 1 ? 2.0 : 0.0, gl_VertexID == 2 ? 2.0 : 0.0);
  v_uv = uv;
  gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
}
