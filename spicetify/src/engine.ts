// engine.ts — le moteur du visualiseur, sans React : canvas -> GL -> modes.
//
// Copie fidèle de la boucle de src/main.ts (bus -> mod matrix -> mode -> tonemap),
// à deux différences près : la source audio est le pont WebSocket, et tout est
// démontable proprement (Spotify monte/démonte la page à chaque navigation).

import { createGL } from "../../src/core/gl";
import { probeCaps, type Caps } from "../../src/core/caps";
import { makeProgram, drawFullscreen, bindTarget } from "../../src/core/fullscreen";
import { createTarget, type Target } from "../../src/core/pingpong";
import { FeatureTexture } from "../../src/core/featureTexture";
import { RenderLoop, type Viewport } from "../../src/core/loop";
import { makeLUT, LUT_NAMES } from "../../src/post/lut";
import { ModMatrix } from "../../src/modmatrix/matrix";
import { ModeRegistry } from "../../src/modes/registry";
import type { BusFrame } from "../../src/audio/bus";
import toneFrag from "../../src/post/tonemap.frag?raw";
import { WsBus } from "./wsbus";

const KEY_MODE = "viz.spicetify.mode";
const KEY_LUT = "viz.spicetify.lut";
const IDLE: BusFrame = { feat: new Float32Array(64), bpm: 120, beatPhase: 0, nextBeat: 0, lockConf: 0, onsetFired: false, kickFired: false, snareFired: false, hatsFired: false };

const store = {
  get(k: string, d: number): number { try { const v = localStorage.getItem(k); return v === null ? d : Number(v); } catch { return d; } },
  set(k: string, v: number): void { try { localStorage.setItem(k, String(v)); } catch { /* ignore */ } },
};

export interface Engine {
  bus: WsBus;
  matrix: ModMatrix;
  names: string[];
  index(): number;
  modeName(): string;
  lutName(): string;
  switchMode(i: number): void;
  cycleMode(d: number): void;
  cycleLut(): void;
  reset(): void;
  resize(): void;
  /** Une frame, avec getError() après chaque étape (diagnostic console). */
  debugFrame(): Record<string, number>;
  /** État interne du mode courant, s'il en publie un. */
  modeDebug(): unknown;
  /**
   * Ré-attache l'UI (le moteur survit aux navigations en mode fond : React a
   * détruit la page, tous les nœuds et callbacks capturés sont périmés).
   */
  rebind(onStatus: (s: string) => void, onMode: (n: string) => void, hud?: HTMLElement): void;
  /**
   * Mode « fond » : l'image reste PLEINE et OPAQUE dans le rectangle `rect`
   * (px CSS, origine en haut à gauche : [gauche, haut, largeur, hauteur]) et
   * déborde autour avec l'opacité `opacite` (1 = pas de débordement).
   * Le rectangle est fourni par l'appelant, jamais mesuré ici : une mesure DOM
   * dans la boucle de rendu force un recalcul de mise en page de tout xpui à
   * chaque image.
   */
  setFond(opacite: number, rect: [number, number, number, number] | null): void;
  /** Erreurs GL collantes relevées pendant l'init (0 = propre). */
  initErrors: Record<string, number>;
  dispose(): void;
}

export function startEngine(canvas: HTMLCanvasElement, hud0: HTMLElement, url: string, onStatus0: (s: string) => void, onMode0: (name: string) => void): Engine {
  let onStatus = onStatus0, onMode = onMode0, hud = hud0;
  const gl = createGL(canvas);
  const initErrors: Record<string, number> = {};
  const caps: Caps = probeCaps(gl);
  initErrors.caps = gl.getError();
  const bus = new WsBus(url);
  bus.onStatus = onStatus;
  onStatus(bus.status);

  const matrix = new ModMatrix();
  const feat = new FeatureTexture(gl);
  const tone = makeProgram(gl, toneFrag);
  let lutIdx = Math.min(LUT_NAMES.length - 1, Math.max(0, store.get(KEY_LUT, 0)));
  let lut = makeLUT(gl, LUT_NAMES[lutIdx]);

  // Sim un peu plus douce que le banc d'essai : Spotify tourne souvent sur iGPU
  // et le player continue de décoder à côté.
  let fondAlpha = 1;
  let paneRect: [number, number, number, number] | null = null;

  const loop = new RenderLoop(canvas, 0.7);
  const registry = new ModeRegistry({ gl, caps, feat, matrix }, loop.vp);
  let scene: Target = createTarget(gl, loop.vp.simW, loop.vp.simH, caps.simFormat);
  loop.onResize((vp: Viewport) => {
    gl.deleteTexture(scene.tex); gl.deleteFramebuffer(scene.fbo);
    scene = createTarget(gl, vp.simW, vp.simH, caps.simFormat);
    registry.resize(vp);
  });

  initErrors.firstMode = gl.getError();

  const saved = store.get(KEY_MODE, 0);
  if (saved > 0) registry.switch(saved);
  onMode(registry.names[registry.index]);

  // Uniformes du tonemap : UN seul endroit, partagé par la boucle et debugFrame()
  // — sinon le diagnostic dessine avec les uniformes de la frame précédente (ou
  // avec des zéros au tout premier appel, donc une image entièrement transparente
  // tout en rendant des codes d'erreur GL propres).
  const FEATHER = 18;
  function toneUniforms(vp: Viewport): Record<string, unknown> {
    // Rectangle du panneau en pixels du tampon. gl_FragCoord a son origine EN BAS
    // à gauche, le rectangle CSS en haut à gauche : d'où l'inversion en Y. On le
    // GONFLE du feather pour que le dégradé se joue entièrement DEHORS : sinon le
    // panneau n'était plein qu'une fois rétréci de 18 px, et un liseré sombre
    // faisait le tour de l'image (a = 0,51 dans les coins).
    const d = vp.dpr, f = FEATHER * d;
    let pane: [number, number, number, number] = [0, 0, vp.dispW, vp.dispH];
    if (fondAlpha < 1) {
      // pas de panneau (page démontée : on navigue ailleurs dans Spotify) =>
      // rectangle vide HORS de l'écran, donc translucidité uniforme. Sans ça la
      // bibliothèque qu'on est en train de parcourir resterait cachée derrière
      // un rectangle opaque qui ne correspond plus à rien.
      pane = [-1e6, -1e6, -1e6, -1e6];
      if (paneRect) {
        const [x, y, w, h] = paneRect;
        pane = [x * d - f, (vp.cssH - y - h) * d - f, (x + w) * d + f, (vp.cssH - y) * d + f];
      }
    }
    return {
      u_pane: pane, u_outAlpha: fondAlpha, u_feather: f,
      u_src: scene.tex, u_lut: lut,
      u_exposure: matrix.get("global.exposure"), u_hueShift: matrix.get("global.hueShift"),
      u_beatFlash: matrix.get("global.beatFlash"),
    };
  }

  let fps = 60, fpsT = 0, fpsN = 0, rate = 0, rateT = 0;
  // GEL sous ~5 fps. Chromium bride le rAF à ~1 Hz quand la fenêtre est occultée ;
  // à ce rythme les simulations sont sous-échantillonnées et ne produisent plus
  // que du bruit (constaté : nbody devient un semis de points brillants). Personne
  // ne regarde une fenêtre cachée : on fige l'image au lieu de la salir, et elle
  // repart intacte au retour. Économise aussi le GPU pendant ce temps.
  let lastReal = -1;
  loop.start((dt: number, time: number, vp: Viewport) => {
    const reel = lastReal < 0 ? dt : time - lastReal;
    lastReal = time;
    if (reel > 0.2) { hud.textContent = `${registry.names[registry.index]} · en pause (fenêtre masquée)`; return; }
    const fr = bus.status === "live" ? bus.read() : IDLE;
    matrix.apply(fr, dt);
    feat.update(fr);
    registry.update(fr, dt, time);
    registry.render(scene.fbo, vp.simW, vp.simH);
    bindTarget(gl, null, vp.dispW, vp.dispH);
    drawFullscreen(gl, tone, toneUniforms(vp));

    fpsN++;
    if (time - fpsT > 0.5) { fps = fpsN / (time - fpsT); fpsT = time; fpsN = 0; }
    if (time - rateT > 1) { rate = bus.rate(); rateT = time; }
    hud.textContent = `${registry.index + 1}/${registry.count} ${registry.names[registry.index]} · ${LUT_NAMES[lutIdx]} · ${Math.round(fps)} fps · ${Math.round(fr.bpm)} bpm · lock ${fr.lockConf.toFixed(2)} · pont ${rate}/s`;
  });

  const api: Engine = {
    bus, matrix, initErrors,
    names: registry.names,
    index: () => registry.index,
    modeName: () => registry.names[registry.index],
    lutName: () => LUT_NAMES[lutIdx],
    switchMode(i) { registry.switch(i); store.set(KEY_MODE, registry.index); onMode(registry.names[registry.index]); },
    cycleMode(d) { registry.cycle(d); store.set(KEY_MODE, registry.index); onMode(registry.names[registry.index]); },
    cycleLut() { lutIdx = (lutIdx + 1) % LUT_NAMES.length; gl.deleteTexture(lut); lut = makeLUT(gl, LUT_NAMES[lutIdx]); store.set(KEY_LUT, lutIdx); },
    reset() { registry.current.reset(); },
    modeDebug() { return registry.current.debug?.() ?? null; },
    setFond(opacite, rect) {
      const v = Number(opacite);
      fondAlpha = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
      // rect null = pas de panneau : plus AUCUNE zone opaque (voir toneUniforms).
      paneRect = rect;
    },
    rebind(s2, m2, hud2) {
      onStatus = s2; onMode = m2; bus.onStatus = s2;
      if (hud2) hud = hud2; // le nœud capturé au démarrage est détaché depuis
      s2(bus.status); m2(registry.names[registry.index]);
    },
    debugFrame() {
      const errs: Record<string, number> = {};
      while (gl.getError() !== 0) { /* purge */ }
      const vp = loop.vp;
      const fr = bus.status === "live" ? bus.read() : IDLE;
      matrix.apply(fr, 1 / 60); errs.matrix = gl.getError();
      feat.update(fr); errs.feat = gl.getError();
      registry.update(fr, 1 / 60, performance.now() / 1000); errs.update = gl.getError();
      registry.render(scene.fbo, vp.simW, vp.simH); errs.render = gl.getError();
      bindTarget(gl, null, vp.dispW, vp.dispH); errs.bind = gl.getError();
      drawFullscreen(gl, tone, toneUniforms(vp));
      errs.tonemap = gl.getError();
      return errs;
    },
    resize() { loop.resize(); },
    dispose() {
      loop.stop();
      bus.dispose();
      registry.current.dispose();
      gl.deleteTexture(scene.tex); gl.deleteFramebuffer(scene.fbo);
      gl.deleteTexture(lut); gl.deleteTexture(feat.tex);
      // Rend le contexte au pilote : sinon Chromium en garde un nombre limité et
      // les remontages successifs finissent par échouer.
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      if ((globalThis as Record<string, unknown>).__viz === api) delete (globalThis as Record<string, unknown>).__viz;
    },
  };

  // Poignée de debug, comme __render dans src/main.ts (console de Spotify /
  // pilotage CDP : __viz.switchMode(7), __viz.bus.status, ...).
  (globalThis as Record<string, unknown>).__viz = api;
  return api;
}
