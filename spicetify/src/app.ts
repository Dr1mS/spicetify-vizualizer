// app.ts — la page custom app Spicetify : React (celui de Spotify) autour du moteur.
//
// Spicetify appelle le `render()` global (ajouté en footer du bundle) et monte
// l'élément retourné dans la vue principale. On monte/démonte proprement : chaque
// navigation dans Spotify détruit puis recrée la page.

import { injectCSS } from "./style";
import { startEngine, type Engine } from "./engine";
import { mountMatrixUI } from "../../src/modmatrix/ui";

// Typage minimal des APIs Spicetify utilisées (pas de @types/react dans le projet).
type El = unknown;
interface ReactLike {
  createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): El;
  useRef<T>(init: T): { current: T };
  useState<T>(init: T | (() => T)): [T, (v: T | ((p: T) => T)) => void];
  useEffect(fn: () => void | (() => void), deps?: unknown[]): void;
}
interface KeyEvt { key: string; preventDefault(): void; stopPropagation(): void }
declare const Spicetify: {
  React: ReactLike;
  ReactDOM: { createPortal(children: unknown, container: Element, key?: string): El };
  Player: {
    data?: { item?: { name?: string; artists?: { name?: string }[] } };
    addEventListener(e: string, cb: () => void): void;
    removeEventListener(e: string, cb: () => void): void;
  };
};
declare const __VIZ_BRIDGE_CMD__: string;

// La COUCHE porte le canvas ET toute l'UI du visualiseur dans le MÊME contexte
// d'empilement. Elle vit soit dans la page (mode panneau), soit dans <body> en
// position fixe (mode fond) — et dans ce cas elle SURVIT au démontage de la page,
// ce qui permet de naviguer dans Spotify pendant que le visualiseur tourne.
let persistant: { eng: Engine; canvas: HTMLCanvasElement } | null = null;
let couche: HTMLDivElement | null = null;
let flot: HTMLDivElement | null = null;
// Rectangle du panneau en px CSS, mémorisé : après une navigation la page est
// démontée et ne se mesure plus, mais le centre opaque doit rester où il était.
let paneRect: [number, number, number, number] | null = null;

/** Crée (une seule fois) la couche et sa sous-boîte au rectangle du panneau. */
function assureCouche(): HTMLDivElement {
  if (!flot) {
    couche = document.createElement("div");
    couche.className = "viz-couche";
    flot = document.createElement("div");
    flot.className = "viz-flot";
    couche.appendChild(flot);
  }
  return flot;
}

const URL_KEY = "viz.spicetify.url";
const FOND_KEY = "viz.spicetify.fond"; // 0 = dans le panneau, sinon opacité du débordement
const RESET_KEY = "viz.spicetify.resetOnSong";
const DEFAULT_URL = "ws://127.0.0.1:8787";

const bridgeURL = (): string => { try { return localStorage.getItem(URL_KEY) || DEFAULT_URL; } catch { return DEFAULT_URL; } };
const trackLabel = (): string => {
  const it = Spicetify?.Player?.data?.item;
  if (!it?.name) return "";
  const who = it.artists?.map((a) => a.name).filter(Boolean).join(", ");
  return who ? `${who} — ${it.name}` : it.name;
};

function VizPage() {
  const React = Spicetify.React;
  const h = React.createElement;
  const flotEl = assureCouche(); // idempotent, sans effet de bord global
  const root = React.useRef<HTMLDivElement | null>(null);
  const cvRef = React.useRef<HTMLCanvasElement | null>(null);
  const hud = React.useRef<HTMLDivElement | null>(null);
  const mm = React.useRef<HTMLDivElement | null>(null);
  const engine = React.useRef<Engine | null>(null);

  const [status, setStatus] = React.useState("connecting");
  const [mode, setMode] = React.useState("");
  const [track, setTrack] = React.useState(trackLabel());
  const [mmOpen, setMmOpen] = React.useState(false);
  const [fond, setFond] = React.useState(() => { try { return Number(localStorage.getItem(FOND_KEY)) || 0; } catch { return 0; } });
  const fondRef = React.useRef(fond); fondRef.current = fond;
  const [plein, setPlein] = React.useState(false);
  const pleinRef = React.useRef(plein); pleinRef.current = plein;
  const [error, setError] = React.useState("");
  const [resetOnSong, setResetOnSong] = React.useState(() => { try { return localStorage.getItem(RESET_KEY) !== "0"; } catch { return true; } });
  const resetRef = React.useRef(resetOnSong);
  resetRef.current = resetOnSong;

  /**
   * Mesure le panneau UNE fois par changement de mise en page (pas par image :
   * un getBoundingClientRect dans la boucle de rendu force un recalcul de mise
   * en page de tout xpui 60 fois par seconde) et diffuse le rectangle au flot
   * (position de la barre et du HUD) comme au shader (zone opaque).
   */
  function majRect(op = fondRef.current): void {
    const el = root.current;
    if (el) {
      const r = el.getBoundingClientRect();
      // rect nul = nœud détaché (page démontée) : on garde le dernier connu
      if (r.width >= 1 && r.height >= 1) paneRect = [r.left, r.top, r.width, r.height];
    }
    const dehors = op > 0 && !pleinRef.current;
    if (dehors && flot && paneRect) {
      const [x, y, w, hh] = paneRect;
      flot.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${hh}px`;
    } else if (flot) flot.style.cssText = "";
    engine.current?.setFond(dehors ? op : 1, paneRect);
  }

  /** Place la couche : dans la page (panneau) ou en fond fixe de tout Spotify. */
  function placerCouche(op: number): void {
    const cou = couche;
    const parent = op > 0 ? document.body : root.current;
    // pas de parent = page démontée : on ne touche à RIEN. Sinon on retirait la
    // classe `fond` sans pouvoir replacer la couche, qui restait dans <body> en
    // position absolue — barre et HUD collés au coin de la fenêtre.
    if (!cou || !parent) return;
    cou.classList.toggle("fond", op > 0 && !pleinRef.current);
    if (cou.parentElement !== parent) parent.appendChild(cou);
    majRect(op);
    engine.current?.resize();
  }

  React.useEffect(() => {
    injectCSS();
    const cou = assureCouche().parentElement as HTMLDivElement;
    let eng: Engine | null = null;
    try {
      // la couche est attachée AVANT startEngine : le canvas doit avoir sa taille
      // définitive au premier resize, sinon le premier tampon est alloué à la
      // taille de la fenêtre puis réalloué.
      (fondRef.current > 0 ? document.body : root.current!).appendChild(cou);
      cou.classList.toggle("fond", fondRef.current > 0);
      if (persistant) {
        eng = persistant.eng;
        cvRef.current = persistant.canvas;
      } else {
        const cv = document.createElement("canvas");
        cv.className = "viz-canvas";
        cou.insertBefore(cv, flotEl);
        cvRef.current = cv;
        eng = startEngine(cv, hud.current!, bridgeURL(), setStatus, setMode);
      }
      engine.current = eng;
      // le moteur a pu survivre à une navigation : callbacks ET nœud du HUD sont
      // ceux de la page précédente, périmés.
      eng.rebind(setStatus, setMode, hud.current!);
      setMode(eng.modeName());
      mountMatrixUI(mm.current!, eng.matrix);
      majRect();
      eng.resize();
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
      // sans ce nettoyage, chaque visite laissait un canvas orphelin et un
      // contexte GL perdu — Chromium en limite le nombre.
      cvRef.current?.remove();
      cvRef.current = null;
      persistant = null;
      engine.current = null;
      return () => { cou.remove(); };
    }

    // La vue Spotify se redimensionne sans event `resize` (sidebar, now playing).
    const ro = new ResizeObserver(() => { majRect(); eng?.resize(); });
    ro.observe(root.current!);
    const onWin = () => majRect();
    addEventListener("resize", onWin);
    const onFs = () => setPlein(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);

    const onSong = () => { setTrack(trackLabel()); if (resetRef.current) eng?.reset(); };
    Spicetify.Player.addEventListener("songchange", onSong);
    root.current?.focus();

    return () => {
      ro.disconnect();
      removeEventListener("resize", onWin);
      document.removeEventListener("fullscreenchange", onFs);
      Spicetify.Player.removeEventListener("songchange", onSong);
      if (fondRef.current > 0 && eng && cvRef.current) {
        // fond actif : la couche reste dans <body>, le moteur continue de tourner.
        // Plus de panneau : l'image devient uniformément translucide, sinon le
        // rectangle opaque cacherait la page qu'on vient d'ouvrir.
        paneRect = null;
        eng.setFond(fondRef.current, null);
        persistant = { eng, canvas: cvRef.current };
      } else {
        eng?.dispose();
        cvRef.current?.remove();
        cou.remove();
        persistant = null;
      }
      engine.current = null;
    };
  }, []);

  // L'effet de bord est ICI, pas dans l'updater de setFond : React 18 évalue
  // l'updater deux fois (chemin rapide + rendu), ce qui déplaçait le canvas et
  // réallouait les tampons deux fois par clic.
  React.useEffect(() => { placerCouche(fond); }, [fond, plein]);

  const onKey = (e: KeyEvt) => {
    const eng = engine.current;
    if (!eng) return;
    const k = e.key.toLowerCase();
    let handled = true;
    if (k >= "1" && k <= "9") eng.switchMode(Number(k) - 1);
    else if (k === "0") eng.switchMode(9);
    else if (k === "arrowright" || k === "]") eng.cycleMode(1);
    else if (k === "arrowleft" || k === "[") eng.cycleMode(-1);
    else if (k === "m") setMmOpen((v) => !v);
    else if (k === "l") eng.cycleLut();
    else if (k === "r") eng.reset();
    else if (k === "f") toggleFullscreen();
    else if (k === "b") cycleFond();
    else handled = false;
    // Spotify écoute les flèches et les chiffres globalement : on coupe la remontée
    // pour ne pas piloter la lecture en même temps que le visualiseur.
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  };

  /** Paliers du débordement. Le noir étant transparent (alpha ~ luminance dans le
   *  tonemap), seules les traînées débordent — mais MESURÉ à l'écran sur symbiose,
   *  qui remplit toute l'image : à 100 % l'interface disparaît quand même, à 55 %
   *  elle reste lisible mais chargée. D'où 30 % (discret) et 60 % (franc). */
  const cycleFond = () => setFond((v) => {
    const n = v === 0 ? 0.3 : v < 0.45 ? 0.6 : 0;
    try { localStorage.setItem(FOND_KEY, String(n)); } catch { /* ignore */ }
    return n;
  });

  const toggleFullscreen = () => {
    try {
      // en mode fond le canvas n'est plus dans .viz-root : c'est la COUCHE qu'il
      // faut promouvoir, sinon le ::backdrop du plein écran masque l'image.
      const cible = (fondRef.current > 0 ? couche : root.current) as HTMLElement | null;
      if (!document.fullscreenElement) void cible?.requestFullscreen();
      else void document.exitFullscreen();
    } catch { /* ignore */ }
  };

  const btn = (key: string, label: string, title: string, onClick: () => void, on = false) =>
    h("button", { key, className: "viz-btn" + (on ? " on" : ""), title, onClick }, label);

  const bar = h("div", { key: "bar", className: "viz-bar" }, [
    h("span", { key: "dot", className: "viz-dot " + status, title: status === "live" ? `pont connecté · source ${engine.current?.bus.bridgeInfo.source ?? "?"} (${bridgeURL()})` : "pont hors ligne" }),
    btn("prev", "‹", "mode précédent  [←]", () => engine.current?.cycleMode(-1)),
    h("span", { key: "name", className: "viz-mode" }, mode || "—"),
    btn("next", "›", "mode suivant  [→]", () => engine.current?.cycleMode(1)),
    btn("lut", "LUT", "palette suivante  [L]", () => engine.current?.cycleLut()),
    btn("reset", "↻", "repartir de zéro  [R]", () => engine.current?.reset()),
    btn("mm", "Matrix", "mod matrix audio→visuel  [M]", () => setMmOpen((v) => !v), mmOpen),
    btn("song", "♪↻", "réinitialiser à chaque piste", () => setResetOnSong((v) => { const n = !v; try { localStorage.setItem(RESET_KEY, n ? "1" : "0"); } catch { /* ignore */ } return n; }), resetOnSong),
    btn("fond", fond > 0 ? `▣ ${Math.round(fond * 100)} %` : "▣",
      fond > 0
        ? `débordement sur Spotify à ${Math.round(fond * 100)} % — le centre reste plein  [B]`
        : "déborder autour du panneau, sur tout Spotify (le centre reste plein)  [B]",
      cycleFond, fond > 0),
    btn("fs", "⛶", "plein écran  [F]", toggleFullscreen),
  ]);

  const overlay = error
    ? h("div", { key: "ov", className: "viz-overlay" }, h("div", { className: "viz-card" }, [
        h("h2", { key: "t" }, "Rendu indisponible"),
        h("p", { key: "p" }, "Le contexte WebGL2 n'a pas pu démarrer dans ce client Spotify."),
        h("code", { key: "c" }, error),
      ]))
    : status !== "live"
      ? h("div", { key: "ov", className: "viz-overlay" }, h("div", { className: "viz-card" }, [
          h("h2", { key: "t" }, "Pont audio hors ligne"),
          h("p", { key: "p" }, "Spotify décode l'audio en natif : aucune page ne peut le lire. Le pont capture la sortie de Spotify via PipeWire (ni micro, ni autres applis) et envoie les features ici. Lance-le, la connexion se fait toute seule :"),
          h("code", { key: "c" }, __VIZ_BRIDGE_CMD__),
          h("p", { key: "p2" }, `Reconnexion automatique · ${bridgeURL()}`),
        ]))
      : null;

  // Tout l'habillage vit dans la couche, au-dessus du canvas et dans le même
  // contexte d'empilement que lui : c'est la seule façon qu'il reste visible
  // quand la couche passe dans <body> par-dessus l'interface de Spotify.
  const habillage = [
    bar,
    h("div", { key: "h", className: "viz-hud", ref: hud }, "…"),
    track ? h("div", { key: "t", className: "viz-track" }, track) : null,
    h("div", { key: "m", className: "viz-mm" + (mmOpen ? "" : " viz-hidden"), ref: mm }),
    overlay,
  ];

  return h("div", { className: "viz-root", ref: root, tabIndex: -1, onKeyDown: onKey },
    Spicetify.ReactDOM.createPortal(habillage, flotEl, "flot"));
}

export function render() {
  injectCSS();
  return Spicetify.React.createElement(VizPage);
}
