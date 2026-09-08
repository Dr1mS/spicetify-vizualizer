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
// Mode « fond » : rectangle du PANNEAU en pixels du tampon (x0,y0,x1,y1) et
// opacité AU-DELÀ. Dans le panneau l'image reste pleine et opaque ; autour elle
// déborde en transparence sur l'interface. u_outAlpha = 1 -> comportement normal.
uniform vec4 u_pane;
uniform float u_outAlpha;
uniform float u_feather; // largeur du dégradé au bord du panneau (px)
out vec4 o;

// Rotation de teinte autour de l'axe des gris (Rodrigues) : u_hueShift en tours.
vec3 rotHue(vec3 c, float a) {
  const vec3 k = vec3(0.5773502691896258);
  float ca = cos(a), sa = sin(a);
  return c * ca + cross(k, c) * sa + k * dot(k, c) * (1.0 - ca);
}

void main() {
  vec3 c = texture(u_src, v_uv).rgb;
  float d = max(c.r, max(c.g, c.b)); // densité
  // Tonemap à ÉPAULE LONGUE (Reinhard) au lieu d'une saturation exponentielle.
  // MESURÉ dans le client : avec 1-exp(-d*1.6), une densité de 2 donnait déjà
  // t=0,96 et tout ce qui dépassait tombait dans les 15 % supérieurs de la LUT,
  // qui finissent en blanc — sur kuramoto, 98,8 % de l'image passait au-dessus de
  // 0,75 avec seulement 13 niveaux distincts sur 64. Les deux courbes coïncident
  // dans les tons moyens (0,55 à d=0,5) ; celle-ci continue de séparer ensuite
  // (d=3 : 0,88 au lieu de 0,99), donc les différences restent visibles.
  float de = d * u_exposure;
  float t = de / (1.0 + de);
  vec3 lut = texture(u_lut, vec2(clamp(t, 0.0, 1.0), 0.5)).rgb;
  // si le buffer porte une teinte (rgb non gris), on la mélange légèrement
  float chroma = length(c - vec3(d)) ;
  vec3 tinted = mix(lut, lut * (0.4 + 0.6 * normalize(c + 1e-4)), clamp(chroma * 2.0, 0.0, 0.5));
  tinted = rotHue(tinted, u_hueShift * 6.2831853);
  // Opacité PAR PIXEL. Dans le panneau : 1, l'image est pleine. Au-delà :
  // PROPORTIONNELLE À LA LUMINANCE, pas constante. La LUT vaut (0,01 0,01 0,03) à
  // t=0, donc avec un alpha constant chaque pixel de fond — la majorité de l'image
  // sur les modes épars — se composait comme un voile gris uniforme : à 15 %,
  // TOUTE l'interface Spotify s'assombrissait de 15 % pendant que les traînées
  // qu'on voulait voir déborder n'apparaissaient qu'à 15 %. Les deux moitiés
  // ratées d'un coup. Avec a ~ t le noir est strictement transparent (interface
  // intacte) et seules les traînées débordent — la sémantique de `screen` qu'on
  // avait avant, mais décidée par pixel au lieu d'un mode de fusion CSS.
  vec2 p = gl_FragCoord.xy;
  float f = max(1.0, u_feather);
  // smoothstep exige edge0 < edge1 (résultat INDÉFINI sinon, GLSL ES 3.00 §8.3) :
  // les bords descendants sont écrits en 1 - smoothstep, pas en bornes inversées.
  float dans = smoothstep(u_pane.x - f, u_pane.x + f, p.x)
             * (1.0 - smoothstep(u_pane.z - f, u_pane.z + f, p.x))
             * smoothstep(u_pane.y - f, u_pane.y + f, p.y)
             * (1.0 - smoothstep(u_pane.w - f, u_pane.w + f, p.y));
  // u_outAlpha = 1 => opaque PARTOUT, sans exception : hors du mode débordement le
  // rectangle envoyé est le tampon entier, non gonflé du feather, et le dégradé
  // mordrait alors 18 px à l'intérieur (a = 0,28 dans les coins sur un pixel
  // sombre) — un liseré que le fond #05060a du panneau rendait presque invisible.
  float a = u_outAlpha >= 1.0 ? 1.0 : mix(u_outAlpha * clamp(t, 0.0, 1.0), 1.0, dans);
  o = vec4(tinted * (1.0 + u_beatFlash), a); // flash de sortie sur le beat

}
