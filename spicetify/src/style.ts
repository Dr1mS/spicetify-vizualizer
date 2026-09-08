// style.ts — CSS injecté par l'app (un seul fichier livré : index.js).
export const CSS = `
.viz-root { position: absolute; inset: 0; overflow: hidden; background: #05060a;
  color: #e8ecff; font-family: var(--encore-body-font-stack, system-ui, sans-serif); outline: none; }
.viz-canvas { display: block; position: absolute; inset: 0; width: 100%; height: 100%; z-index: 0; }
/* La COUCHE porte le canvas ET toute l'UI du visualiseur, dans le MÊME contexte
   d'empilement. Sans elle, en mode fond, le canvas passait dans <body> à z-index
   9998 pendant que la barre, le HUD, la mod matrix et le carton « pont hors
   ligne » restaient enfants de .viz-root, prisonniers d'un ancêtre Spotify
   (#main est position:relative; z-index:0, donc un contexte d'empilement dont
   leur z-index 8..14 ne peut PAS sortir) : le mode fond masquait sa propre
   interface, bouton ▣ compris — le seul moyen d'en ressortir. */
.viz-couche { position: absolute; inset: 0; pointer-events: none; }
.viz-couche.fond { position: fixed; z-index: 9998; }
.viz-flot { position: absolute; inset: 0; }           /* = rectangle du panneau */
.viz-couche.fond > .viz-flot { inset: auto; }          /* rect posé en style inline */
.viz-couche .viz-bar, .viz-couche .viz-mm, .viz-couche .viz-overlay { pointer-events: auto; }
/* FOND ANIMÉ : la couche passe dans <body> en position fixe et couvre TOUT
   Spotify. L'opacité est décidée PAR PIXEL dans le tonemap — pleine dans le
   rectangle du panneau, proportionnelle à la luminance au-delà — et l'interface
   reste cliquable au travers (pointer-events: none sur la couche). */
/* Plein écran : c'est la couche qu'on promeut (le canvas n'est plus dans
   .viz-root), et le ::backdrop noir rend le fond sans objet — flot reprend
   inset:0 et le shader repasse en opaque. */
.viz-couche:fullscreen { position: fixed; inset: 0; z-index: auto; background: #05060a; }
.viz-vide { position: absolute; inset: 0; display: grid; place-items: center;
  color: #7f8aa8; font-size: 13px; text-align: center; line-height: 1.6; }
.viz-bar { position: absolute; top: 12px; left: 50%; transform: translateX(-50%); z-index: 12;
  display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-radius: 999px;
  background: rgba(10,12,22,0.62); border: 1px solid rgba(255,255,255,0.08); backdrop-filter: blur(10px);
  opacity: 0.25; transition: opacity 0.18s; }
.viz-root:hover .viz-bar, .viz-bar:hover, .viz-bar:focus-within { opacity: 1; }
/* En mode fond la barre n'est plus DANS .viz-root : le sélecteur de survol
   ci-dessus ne s'applique plus. Sans ce palier elle resterait un fantôme à 25 %
   et le correctif d'empilement ne se verrait pas. */
.viz-couche.fond .viz-bar { opacity: 0.7; }
.viz-couche.fond .viz-bar:hover, .viz-couche.fond .viz-bar:focus-within { opacity: 1; }
.viz-btn { border: 0; border-radius: 8px; padding: 5px 9px; font-size: 11px; cursor: pointer;
  color: #e8ecff; background: rgba(255,255,255,0.07); white-space: nowrap; }
.viz-btn:hover { background: rgba(255,255,255,0.16); }
.viz-btn.on { background: linear-gradient(90deg, #6c7bff, #ff4d9d); color: #fff; }
.viz-mode { min-width: 104px; text-align: center; font-size: 11px; letter-spacing: 0.4px;
  font-variant-numeric: tabular-nums; color: #cfd4ff; }
.viz-dot { width: 8px; height: 8px; border-radius: 50%; background: #556; margin: 0 4px; flex: none; }
.viz-dot.live { background: #1ed760; box-shadow: 0 0 8px #1ed760; }
.viz-dot.offline { background: #ff4d5e; }
.viz-hud { position: absolute; bottom: 12px; left: 50%; transform: translateX(-50%); z-index: 10;
  padding: 5px 13px; border-radius: 999px; font-size: 11px; color: #9aa3c0; font-variant-numeric: tabular-nums;
  background: rgba(10,12,22,0.55); border: 1px solid rgba(255,255,255,0.07); backdrop-filter: blur(8px);
  pointer-events: none; white-space: nowrap; }
.viz-overlay { position: absolute; inset: 0; z-index: 8; display: grid; place-items: center;
  background: radial-gradient(60% 60% at 50% 45%, rgba(12,14,26,0.86), rgba(5,6,10,0.97)); }
.viz-card { max-width: 560px; padding: 26px 30px; border-radius: 16px; text-align: left;
  background: rgba(16,18,32,0.9); border: 1px solid rgba(255,255,255,0.1); }
.viz-card h2 { margin: 0 0 6px; font-size: 19px; }
.viz-card p { margin: 0 0 14px; font-size: 13px; color: #9aa3c0; line-height: 1.5; }
.viz-card code { display: block; padding: 11px 13px; border-radius: 9px; font-size: 12px;
  background: #05060a; border: 1px solid rgba(255,255,255,0.09); color: #b9f6c0; user-select: all;
  overflow-x: auto; white-space: pre; }
.viz-track { position: absolute; bottom: 12px; left: 14px; z-index: 10; max-width: 34%;
  font-size: 11px; color: #7f8aa8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  pointer-events: none; }
.viz-hidden { display: none !important; }
.viz-mm { position: absolute; top: 0; right: 0; width: 340px; max-height: 100%; overflow-y: auto; z-index: 14;
  padding: 12px 12px 30px; font-size: 12px; background: rgba(10,12,22,0.94);
  border-left: 1px solid rgba(255,255,255,0.1); backdrop-filter: blur(10px); }
.mm-head { display: flex; flex-direction: column; margin-bottom: 10px; }
.mm-head b { letter-spacing: 2px; } .mm-hint { color: #778; font-size: 10px; }
.mm-row { display: flex; align-items: center; gap: 3px; margin-bottom: 4px; }
.mm-sel { background: #0c0e1a; color: #e8ecff; border: 1px solid rgba(255,255,255,0.12); border-radius: 5px; font-size: 10px; max-width: 78px; }
.mm-arrow { color: #667; } .mm-amt { width: 46px; accent-color: #ff4d9d; }
.mm-sm { width: 34px; accent-color: #6c7bff; } .mm-v { width: 30px; color: #cdd; font-size: 10px; }
.mm-del { background: none; border: 0; color: #b56; cursor: pointer; font-size: 14px; }
.mm-actions { display: flex; gap: 5px; margin-top: 10px; }
.mm-btn { flex: 1; padding: 6px 2px; font-size: 10px; border: 1px solid rgba(255,255,255,0.14);
  border-radius: 6px; background: rgba(255,255,255,0.05); color: #e8ecff; cursor: pointer; }
`;

export function injectCSS(): void {
  if (document.getElementById("viz-style")) return;
  const el = document.createElement("style");
  el.id = "viz-style";
  el.textContent = CSS;
  document.head.appendChild(el);
}
