// anamnese.ts — MÉMOIRE DE FORME (création originale, famille CONTINUOUS).
//
//   ἀνάμνησις : se ressouvenir. Chez Platon, connaître, c'est se rappeler.
//
// Les 22 autres modes réagissent à l'INSTANT : ce qui sonne maintenant déforme
// l'image maintenant. Celui-ci écoute la FORME du morceau. Il garde une mémoire
// de ce qu'il a entendu et de ce qu'il a montré, et quand la musique revient sur
// elle-même — un refrain, une reprise, une boucle qui se referme — il ne fait pas
// un écho : il RECONVOQUE.
//
//   L'INVARIANT : la mémoire fixe les RÈGLES ; l'image stockée est une PREUVE,
//   jamais une entrée.
//
// La mémoire n'entre dans la simulation que par huit scalaires — la géométrie de
// l'écoulement au moment rejoué. Le champ RECONSTRUIT donc le passé sous ses
// propres règles au lieu de le rejouer. L'image d'alors n'est lue qu'à la
// composition : le présent s'atténue, elle apparaît en retrait, et là où les deux
// ne coïncident pas, une interférence blanche scintille. On voit deux choses à la
// fois : que ça revient, et OÙ ce retour ne colle pas.
//
// La détection est dans src/audio/recurrence.js (testée en Node sur du synthétique
// structuré : elle retrouve la période à 40,0 s près sur un A-B-A-B de 20 s de
// section, et ne se déclenche pas sur un flux sans structure). Trois mesures ont
// façonné cette conception, toutes contre-intuitives — voir l'en-tête de ce fichier.
//
// La différence avec `comb` (mon peigne temporel) est le point entier du mode :
// comb est une ligne à retard accordée sur le TEMPO — il rejoue ce qu'il y avait
// il y a exactement une pulsation, que la musique l'ait mérité ou non. Ici le
// retard n'est pas choisi par l'horloge mais par le CONTENU : la mémoire est
// adressée par ressemblance musicale. Un refrain qui revient 82 s plus tard
// reconvoque l'image d'il y a 82 s.
import { makeProgram, drawFullscreen, bindTarget } from "../core/fullscreen";
import { PingPong, createTarget, type Target } from "../core/pingpong";
import { registerParams, unregister } from "../modmatrix/targets";
import { F } from "../audio/constants";
import { RecurrenceMemory } from "../audio/recurrence.js";
import type { Mode, Resources } from "./Mode";
import type { BusFrame } from "../audio/bus";
import type { Viewport } from "../core/loop";

const SNAP_W = 192, SNAP_H = 108; // résolution des souvenirs (un souvenir est flou)
// 96 couches × 192×108 × RGBA16F ≈ 16 Mo. registry.switch() appelle init() AVANT
// dispose() : les deux modes coexistent un instant en mémoire vidéo partagée.
const LAYERS = 96;                // × 1 s = 96 s de mémoire visuelle
const SCOPE_N = 128;              // cases du spectre de mémoire affiché
const GEOM = 9;                   // scalaires décrivant la géométrie de l'écoulement
// Le 9e est particulier : une PHASE ACCUMULÉE, que l'apparieur ne voit pas. Les
// huit premiers dérivent des mêmes features que l'empreinte, si bien qu'au moment
// où un rappel se déclenche le présent ressemble DÉJÀ au passé — mesuré : la
// mémoire ne déplaçait la géométrie que d'environ une dérive naturelle (ratio
// 0,82 à 1,54). La phase, elle, s'intègre au fil du morceau : deux passages
// musicalement identiques à 40 s d'intervalle en ont des valeurs DIFFÉRENTES.
// Reconvoquer le passé, c'est donc rembobiner cette rotation — une discontinuité
// que la ressemblance musicale ne peut pas produire d'elle-même.

// ---------------------------------------------------------------------------
// Le champ. L'écoulement est ANALYTIQUE : trois tourbillons + une rotation
// d'ensemble, dont les positions et les forces viennent du vecteur de géométrie.
// Il est donc CONTINU en g : interpoler entre deux moments musicaux interpole
// entre deux écoulements, et le retour à une géométrie passée est un morphing,
// pas une coupure.
const ADVECT = `#version 300 es
precision highp float;
precision highp sampler2DArray; // ES 3.0 : ce type n'a pas de précision par défaut
in vec2 v_uv; out vec4 o;
uniform sampler2D uDye;
uniform vec2 uTexel;
uniform float uG[9];
uniform float uAdvect, uFade, uInject, uFilament, uAspect, uTime;
uniform float uKeyHue;

vec2 rot90(vec2 p){ return vec2(-p.y, p.x); }

// écoulement au point p (repère centré, corrigé de l'aspect)
vec2 flow(vec2 p){
  // La constellation entière est tournée de la phase accumulée uG[8].
  float cp = cos(uG[8]), sp = sin(uG[8]);
  p = mat2(cp, -sp, sp, cp) * p;
  vec2 v = rot90(p) * uG[6];                    // rotation d'ensemble
  for (int k = 0; k < 3; k++) {
    vec2 c = vec2(uG[k * 2], uG[k * 2 + 1]);
    vec2 d = p - c;
    float r2 = dot(d, d) + 0.02;
    v += rot90(d) * (uG[7] * (0.35 + 0.65 * float(3 - k)) / r2) * 0.06;
  }
  return v;
}

void main(){
  vec2 p = (v_uv - 0.5) * vec2(uAspect, 1.0);
  // advection semi-lagrangienne : on va CHERCHER la matière en amont
  vec2 back = p - flow(p) * uAdvect;
  vec2 uvb = back / vec2(uAspect, 1.0) + 0.5;
  vec3 c = texture(uDye, uvb).rgb * uFade; // uFade = exp(-decay*dt), calculé au CPU

  // injection : des filaments fins, éclairés par le spectre à leur rayon
  float r = length(p);
  float ang = atan(p.y, p.x);
  float band = u_melf(clamp(r * 1.15, 0.0, 1.0));
  float fil = sin(ang * uFilament + r * 26.0 - uTime * 0.9);
  fil = pow(max(0.0, fil), 3.0);
  // L'injection est normalisée par le fondu : l'état stationnaire vaut ~uInject,
  // quel que soit uFade. Sans ça, inject=0,5 avec fade=0,982 donnait 0,5/(1-0,982)
  // ≈ 27 — l'image saturait en blanc dès les premières secondes (constaté).
  c += hue(uKeyHue + r * 0.3) * (band * fil * uInject * 12.0 * (1.0 - uFade));

  // NOTE — l'invariant du mode : la simulation ne lit JAMAIS l'image stockée.
  // La mémoire n'entre ici que par uG[], la géométrie de l'écoulement. Réinjecter
  // le souvenir dans le champ ferait de ce mode un comb à index adressé par
  // contenu ; et c'est aussi ce qui faisait blanchir l'image (un souvenir
  // reconvoqué se retrouvait photographié une seconde plus tard — souvenir d'un
  // souvenir, qui s'emballe). Le champ RECONSTRUIT le passé sous ses propres
  // règles ; l'image d'alors ne sert que de PREUVE, à la composition.
  o = vec4(min(c, vec3(6.0)), 1.0);
}`;

// Copie du champ vers la résolution des souvenirs.
const SNAP = `#version 300 es
precision highp float; in vec2 v_uv; out vec4 o; uniform sampler2D uTex;
void main(){ o = texture(uTex, v_uv); }`;

// Rendu : le champ + l'interférence présent/souvenir + le spectre de mémoire.
const RENDER = `#version 300 es
precision highp float;
precision highp sampler2DArray;
in vec2 v_uv; out vec4 o;
uniform sampler2D uDye, uScope;
uniform sampler2DArray uHist;
uniform vec2 uTexel;
uniform float uGhostLayer, uEnv, uDiff, uGhostShow, uScopeAmt, uScopeLag, uBright, uHue;
uniform vec2 uCmpTexel; // pas d'échantillonnage COMMUN aux deux comparés

vec3 grad(sampler2D t, vec2 uv, vec2 e){
  vec3 gx = texture(t, uv + vec2(e.x, 0.0)).rgb - texture(t, uv - vec2(e.x, 0.0)).rgb;
  vec3 gy = texture(t, uv + vec2(0.0, e.y)).rgb - texture(t, uv - vec2(0.0, e.y)).rgb;
  return abs(gx) + abs(gy);
}
vec3 gradA(sampler2DArray t, vec2 uv, float l, vec2 e){
  vec3 gx = texture(t, vec3(uv + vec2(e.x, 0.0), l)).rgb - texture(t, vec3(uv - vec2(e.x, 0.0), l)).rgb;
  vec3 gy = texture(t, vec3(uv + vec2(0.0, e.y), l)).rgb - texture(t, vec3(uv - vec2(0.0, e.y), l)).rgb;
  return abs(gx) + abs(gy);
}

void main(){
  vec3 c = texture(uDye, v_uv).rgb;

  if (uEnv > 0.002) {
    // Pendant la reconvocation, le présent s'EFFACE un peu pour faire de la place
    // à ce qui ne colle pas : c'est l'écart qu'on vient regarder.
    c *= 1.0 - 0.38 * uEnv;
    // La preuve : l'image d'alors, très en retrait. Elle n'entre pas dans la
    // simulation (invariant du mode), on la donne seulement à voir.
    vec3 g = texture(uHist, vec3(v_uv, uGhostLayer)).rgb;
    c += g * uGhostShow * uEnv;
    // INTERFÉRENCE : on compare les CONTOURS, pas les niveaux — sinon la simple
    // différence de luminosité entre les deux passages écraserait tout, et on ne
    // verrait que "c'est plus fort maintenant", pas "ce n'est pas la même forme".
    // En GRIS NEUTRE : le tonemap indexe une LUT sur la densité et ne mélange la
    // teinte du mode qu'à 50 % — une couleur saturée y perdrait le haut de la
    // rampe, un résidu neutre le prend en entier.
    // Les deux gradients sont pris au PAS DU SOUVENIR (192×108), pas à celui du
    // champ vif : sinon on compare des filaments fins à une image floue et le
    // résidu n'est que le haut du spectre du présent — une brume, pas un écart.
    vec3 dNow = grad(uDye, v_uv, uCmpTexel);
    vec3 dThen = gradA(uHist, v_uv, uGhostLayer, uCmpTexel);
    float interf = length(abs(dNow - dThen)) * uDiff * uEnv;
    c += vec3(interf);
  }

  // SPECTRE DE MÉMOIRE : bande fine en bas — pour chaque décalage possible, la
  // force avec laquelle le présent lui ressemble. C'est l'écoute rendue visible.
  if (uScopeAmt > 0.001 && v_uv.y < 0.045) {
    float v = texture(uScope, vec2(v_uv.x, 0.5)).r;
    float h = v * 0.038;
    float on = step(0.006, v_uv.y) * step(v_uv.y, 0.006 + h);
    float mark = smoothstep(0.006, 0.0, abs(v_uv.x - uScopeLag)) * step(v_uv.y, 0.044);
    c += (hue(uHue + 0.15) * on * 0.55 + hue(uHue + 0.5) * mark * 0.9) * uScopeAmt;
  }
  o = vec4(c * (0.55 + uBright), 1.0);
}`;

export class AnamneseMode implements Mode {
  id = "anamnese"; family = "continuous" as const;
  private gl!: WebGL2RenderingContext; private res!: Resources;
  private dye!: PingPong; private snap!: Target;
  private hist!: WebGLTexture; private scopeTex!: WebGLTexture;
  private pAdvect: any; private pSnap: any; private pRender: any;
  private w = 0; private h = 0; private aspect = 1;

  private mem = new RecurrenceMemory();
  private geom = new Float32Array(GEOM);       // géométrie courante
  private geomTarget = new Float32Array(GEOM); // géométrie dictée par le son
  private geomRing: Float32Array[] = [];       // une géométrie par fenêtre
  private layerWindow = new Int32Array(LAYERS).fill(-1); // fenêtre stockée par couche
  private scope = new Float32Array(SCOPE_N);
  private scopePix = new Float32Array(SCOPE_N * 4);
  private geomOffset = 0;
  private wasActive = false; private sinceEnter = 1e3; private lastAudioT = -1;
  // Diagnostic de l'objection la plus sérieuse qu'on puisse faire à ce mode : si
  // la géométrie du présent ressemble DÉJÀ à celle du passage rejoué (les deux
  // dérivent de features corrélées), le morphing ne déplace rien et la mémoire
  // n'agit pas vraiment sur la simulation. On mesure donc l'écart reconvoqué et
  // on le compare à la variation naturelle de la géométrie.
  private ecartRappel = 0; private variationNaturelle = 0;
  private phase = 0; // phase accumulée : la seule dimension invisible à l'apparieur
  private wr = 0; private lastSnapWindow = -1; private ghostLayer = 0; private ghostValid = false;

  init(res: Resources, vp: Viewport): void {
    this.res = res; this.gl = res.gl;
    registerParams(res.matrix.targets, this.id, {
      advect: 0.55, decay: 1.1, inject: 0.5, filament: 7, vortex: 1.0, swirl: 0.35,
      ghost: 0.18, diff: 1.1, morph: 0.85, scope: 0.3, memSense: 0.25,
    }, {
      advect: [0.05, 1.6], decay: [0.1, 4], inject: [0, 2.5], filament: [1, 18], vortex: [0, 3], swirl: [-1.2, 1.2],
      ghost: [0, 0.5], diff: [0, 4], morph: [0, 1], scope: [0, 1], memSense: [0.08, 0.6],
    });
    const gl = this.gl;
    this.pAdvect = makeProgram(gl, ADVECT, { common: true });
    this.pSnap = makeProgram(gl, SNAP);
    this.pRender = makeProgram(gl, RENDER, { common: true });

    // Les souvenirs sont à résolution FIXE : un redimensionnement du panneau
    // Spotify ne doit pas jeter la mémoire du morceau en cours.
    this.hist = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.hist);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA16F, SNAP_W, SNAP_H, LAYERS);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.snap = createTarget(gl, SNAP_W, SNAP_H, gl.RGBA16F, gl.LINEAR, gl.CLAMP_TO_EDGE);

    this.scopeTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.scopeTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, SCOPE_N, 1, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.resize(vp);
  }

  resize(vp: Viewport): void {
    this.w = vp.simW; this.h = vp.simH; this.aspect = vp.simW / Math.max(1, vp.simH);
    this.dye?.dispose();
    this.dye = new PingPong(this.gl, this.w, this.h, this.gl.RGBA16F, this.gl.LINEAR, this.gl.CLAMP_TO_EDGE);
    this.clearDye();
  }

  private clearDye(): void {
    const gl = this.gl;
    for (const t of [this.dye.read, this.dye.write]) {
      bindTarget(gl, t.fbo, this.w, this.h);
      gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    }
  }

  reset(): void {
    const gl = this.gl;
    this.clearDye();
    bindTarget(gl, this.snap.fbo, SNAP_W, SNAP_H);
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.hist);
    for (let i = 0; i < LAYERS; i++) gl.copyTexSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, i, 0, 0, SNAP_W, SNAP_H);
    this.layerWindow.fill(-1);
    this.mem.reset();
    this.geomRing.length = 0; this.geomOffset = 0;
    this.wasActive = false; this.sinceEnter = 1e3; this.lastAudioT = -1;
    this.wr = 0; this.lastSnapWindow = -1; this.ghostValid = false;
    this.geom.fill(0); this.geomTarget.fill(0); this.phase = 0;
    this.scope.fill(0);
  }

  /** Géométrie dictée par le son : 3 tourbillons + rotation + force. */
  private computeGeom(fr: BusFrame, m: { get(p: string): number }): void {
    const f = fr.feat;
    const band = (a: number, b: number) => { let s = 0; for (let i = a; i < b; i++) s += f[F.MEL0 + i]; return s / (b - a); };
    const bass = band(0, 6), mid = band(12, 20), treble = band(26, 32);
    const key = f[F.KEY_HUE], cen = f[F.CENTROID];
    const g = this.geomTarget;
    const a0 = key * 6.2831853;
    g[0] = Math.cos(a0) * (0.15 + 0.45 * bass);
    g[1] = Math.sin(a0) * (0.15 + 0.45 * bass);
    g[2] = Math.cos(a0 + 2.09) * (0.2 + 0.4 * mid);
    g[3] = Math.sin(a0 + 2.09) * (0.2 + 0.4 * mid);
    g[4] = Math.cos(a0 + 4.19) * (0.25 + 0.35 * treble);
    g[5] = Math.sin(a0 + 4.19) * (0.25 + 0.35 * treble);
    g[6] = m.get("anamnese.params.swirl") * (0.4 + 1.2 * cen);
    g[7] = m.get("anamnese.params.vortex") * (0.5 + 1.0 * (bass + treble) * 0.5);
    g[8] = this.phase; // intégrée dans update(), pas dérivée de l'instant
  }

  update(fr: BusFrame, dt: number, time: number): void {
    const gl = this.gl; const m = this.res.matrix;

    // --- la mémoire écoute ---------------------------------------------------
    // Le pont livre ~94 trames/s, le rendu tourne à 60-144 fps : sans ce garde,
    // la même trame serait comptée deux fois (ou pas du tout) selon la machine.
    // Seuil de proéminence réglable : plus bas = mémoire plus prompte à
    // reconnaître (et plus prompte à se tromper). Défaut 0,25 = valeur mesurée.
    this.mem.o.minProminence = m.get("anamnese.params.memSense");
    // BUG CORRIGÉ (constaté en clientèle) : quand le pont est hors ligne, le
    // moteur passe une trame de REPOS dont l'horodatage vaut 0. La mémoire
    // prenait ce 0 comme origine, puis les vraies trames arrivaient à t=6417 s
    // (le pont tourne depuis des heures) : la condition d'émission était alors
    // toujours vraie, chaque frame fermait une fenêtre d'un seul échantillon,
    // et la mémoire restait morte POUR TOUJOURS — sans la moindre erreur.
    const tAudio = fr.feat[F.T_FRAME];
    const closed = tAudio > 0 && tAudio !== this.lastAudioT
      ? (this.lastAudioT = tAudio, this.mem.push(fr.feat.subarray(F.MEL0, F.MEL0 + 32), tAudio))
      : false;
    this.mem.update(dt);
    const st = this.mem.state;

    // L'INSTANT de la reconnaissance. L'enveloppe seule ferait un fondu ; un
    // souvenir qui revient, ça se remarque d'un coup, puis ça s'installe. On
    // marque donc l'entrée par une brève secousse — sur l'interférence
    // seulement, pas sur le fantôme : l'image ne doit pas sauter, c'est le
    // CONSTAT DE L'ÉCART qui doit frapper.
    this.sinceEnter += dt;
    if (st.active && !this.wasActive) this.sinceEnter = 0;
    this.wasActive = st.active;

    // La phase avance TOUJOURS, au rythme du souffle demandé. ~0,02-0,04 rad/s :
    // environ 1 radian de décalage pour un rappel à 40 s — visible, pas étourdissant.
    this.phase = (this.phase + (0.015 + 0.02 * Math.abs(m.get("anamnese.params.swirl"))) * dt) % (2 * Math.PI);

    this.computeGeom(fr, m);
    // La géométrie suit le son ; pendant un rappel, elle est TIRÉE vers celle du
    // passage rejoué : le champ ne recopie pas l'image d'alors, il en retrouve
    // les règles et la reconstruit lui-même. C'est là toute la différence entre
    // se souvenir et rejouer un enregistrement.
    const recalled = this.mem.recalledIndex();
    const past = recalled >= 0 ? (this.geomRing[recalled - this.geomOffset] ?? null) : null;
    const morph = past ? st.env * m.get("anamnese.params.morph") : 0;
    if (past) {
      let d = 0;
      for (let i = 0; i < GEOM - 1; i++) { const x = this.geomTarget[i] - past[i]; d += x * x; }
      let ph = (past[GEOM - 1] - this.geomTarget[GEOM - 1]) % (2 * Math.PI);
      if (ph > Math.PI) ph -= 2 * Math.PI; if (ph < -Math.PI) ph += 2 * Math.PI;
      this.ecartRappel = Math.sqrt(d + ph * ph);
    }
    const ref = this.geomRing[this.geomRing.length - 61]; // ~30 s plus tôt (dérive naturelle)
    if (ref) {
      let d = 0;
      for (let i = 0; i < GEOM - 1; i++) { const x = this.geomTarget[i] - ref[i]; d += x * x; }
      let ph = (ref[GEOM - 1] - this.geomTarget[GEOM - 1]) % (2 * Math.PI);
      if (ph > Math.PI) ph -= 2 * Math.PI; if (ph < -Math.PI) ph += 2 * Math.PI;
      this.variationNaturelle += (Math.sqrt(d + ph * ph) - this.variationNaturelle) * 0.02;
    }
    const k = 1 - Math.exp(-dt / 0.25);
    for (let i = 0; i < GEOM - 1; i++) {
      const target = past ? this.geomTarget[i] * (1 - morph) + past[i] * morph : this.geomTarget[i];
      this.geom[i] += (target - this.geom[i]) * k;
    }
    // la phase s'interpole sur l'ARC LE PLUS COURT (sinon un rappel ferait faire
    // au champ un tour complet au lieu d'un rembobinage)
    const arc = (a: number, b: number): number => { let d = (b - a) % (2 * Math.PI); if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI; return d; };
    const tgtPhase = past ? this.geomTarget[GEOM - 1] + arc(this.geomTarget[GEOM - 1], past[GEOM - 1]) * morph : this.geomTarget[GEOM - 1];
    this.geom[GEOM - 1] += arc(this.geom[GEOM - 1], tgtPhase) * k;

    if (closed) {
      // même numérotation ABSOLUE que la mémoire : geomRing[i - geomOffset]
      this.geomRing.push(Float32Array.from(this.geom));
      if (this.geomRing.length > 512) { this.geomRing.shift(); this.geomOffset++; }
      this.updateScope();
    }

    // --- quelle couche de mémoire reconvoquer ? ------------------------------
    this.ghostValid = false;
    if (recalled >= 0) {
      const layer = this.layerOf(recalled);
      if (layer >= 0) { this.ghostLayer = layer; this.ghostValid = true; }
    }

    // --- le champ avance -----------------------------------------------------
    bindTarget(gl, this.dye.write.fbo, this.w, this.h);
    drawFullscreen(gl, this.pAdvect, {
      uDye: this.dye.read.tex,
      uTexel: [1 / this.w, 1 / this.h], uG: this.geom,
      uAdvect: m.get("anamnese.params.advect") * 0.02,
      // décroissance en 1/s : à 144 fps un facteur PAR FRAME ferait disparaître
      // le champ 2,4× plus vite qu'à 60 — le mode n'aurait pas le même aspect
      // selon la machine.
      uFade: Math.exp(-Math.max(0.01, m.get("anamnese.params.decay")) * Math.min(dt, 1 / 20)),
      uInject: m.get("anamnese.params.inject"),
      uFilament: Math.round(m.get("anamnese.params.filament")),
      uAspect: this.aspect, uTime: time,
      uKeyHue: fr.feat[F.KEY_HUE],
      ...this.res.feat.uniforms(fr),
    });
    this.dye.swap();

    // --- on garde une trace de ce qu'on a montré (1 souvenir/seconde) --------
    if (closed && st.windows !== this.lastSnapWindow && st.windows % 2 === 0) {
      this.lastSnapWindow = st.windows;
      bindTarget(gl, this.snap.fbo, SNAP_W, SNAP_H);
      drawFullscreen(gl, this.pSnap, { uTex: this.dye.read.tex });
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.hist);
      gl.copyTexSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, this.wr, 0, 0, SNAP_W, SNAP_H);
      this.layerWindow[this.wr] = st.windows - 1;
      this.wr = (this.wr + 1) % LAYERS;
    }
  }

  /** Couche contenant le souvenir de la fenêtre `w` (±1), ou -1. */
  private layerOf(w: number): number {
    for (let i = 0; i < LAYERS; i++) if (this.layerWindow[i] >= 0 && Math.abs(this.layerWindow[i] - w) <= 1) return i;
    return -1;
  }

  /** Le spectre de mémoire, rééchantillonné pour l'affichage. */
  private updateScope(): void {
    const p = this.mem.peaks, lo = this.mem.lagMin, hi = this.mem.lagMax;
    for (let i = 0; i < SCOPE_N; i++) {
      const a = lo + ((hi - lo) * i) / SCOPE_N, b = lo + ((hi - lo) * (i + 1)) / SCOPE_N;
      let mx = 0;
      for (let L = Math.floor(a); L <= Math.min(hi, Math.ceil(b)); L++) mx = Math.max(mx, p[L] || 0);
      this.scope[i] = this.scope[i] * 0.6 + mx * 0.4;
      this.scopePix[i * 4] = this.scope[i];
    }
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.scopeTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, SCOPE_N, 1, gl.RGBA, gl.FLOAT, this.scopePix);
  }

  render(target: WebGLFramebuffer | null, w: number, h: number): void {
    const gl = this.gl; const m = this.res.matrix;
    const st = this.mem.state;
    const lagX = st.lagSec > 0 ? (st.lagSec / this.mem.hop - this.mem.lagMin) / (this.mem.lagMax - this.mem.lagMin) : -1;
    bindTarget(gl, target, w, h);
    drawFullscreen(gl, this.pRender, {
      uDye: this.dye.read.tex, uHist: this.hist, uScope: this.scopeTex,
      uTexel: [1 / this.w, 1 / this.h],
      uCmpTexel: [1 / SNAP_W, 1 / SNAP_H],
      uGhostLayer: this.ghostLayer,
      uEnv: this.ghostValid ? st.env : 0,
      uDiff: m.get("anamnese.params.diff") * (1 + 0.9 * Math.exp(-this.sinceEnter / 0.3)),
      uGhostShow: m.get("anamnese.params.ghost"),
      uScopeAmt: m.get("anamnese.params.scope"),
      uScopeLag: lagX,
      uBright: this.res.matrix.get("global.brightness") - 1,
      uHue: this.res.matrix.get("global.baseHue"),
    });
  }

  /** Ce que la mémoire entend, en clair. */
  debug(): unknown {
    const st = this.mem.state;
    return {
      actif: st.active, proéminence: +st.z.toFixed(3), décalage_s: +st.lagSec.toFixed(1),
      enveloppe: +st.env.toFixed(3), fenêtres: st.windows,
      souvenir_disponible: this.ghostValid, couche: this.ghostLayer,
      // > 1 : la mémoire déplace la géométrie PLUS que sa dérive naturelle.
      // < 1 : le morphing est un quasi-non-événement (l'objection tient).
      geom_ecart_rappel: +this.ecartRappel.toFixed(3),
      geom_variation_naturelle: +this.variationNaturelle.toFixed(3),
      geom_ratio: +(this.ecartRappel / Math.max(1e-3, this.variationNaturelle)).toFixed(2),
      plateau_s: +(st.plateauSec ?? 0).toFixed(1),
      _t0: +(this.mem.t0 ?? -1).toFixed(2), _tDernier: +this.lastAudioT.toFixed(2),
      _accN: this.mem.accN, _prochaineEmission: +(this.mem.nextEmit ?? 0).toFixed(2),
    };
  }

  dispose(): void {
    const gl = this.gl;
    this.dye?.dispose();
    if (this.snap) { gl.deleteTexture(this.snap.tex); gl.deleteFramebuffer(this.snap.fbo); }
    gl.deleteTexture(this.hist); gl.deleteTexture(this.scopeTex);
    unregister(this.res.matrix.targets, this.id);
  }
}
