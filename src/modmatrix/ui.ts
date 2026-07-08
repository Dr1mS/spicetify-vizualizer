// ui.ts — panneau d'édition de la mod matrix (routes source->dest). Éditable à
// chaud : les routes sont mutées en place, applyRoutes les relit chaque frame.
import type { ModMatrix } from "./matrix";
import type { Curve } from "./types";

const SOURCES = ["onset", "onsetFired", "kick", "kickFired", "snare", "hats", "rms", "peak", "flux", "energy", "centroid", "flatness", "keyHue", "beatPhase", "beatPulse", "lockConf", "bass", "lowmid", "mid", "highmid", "treble"];
const CURVES: Curve[] = ["lin", "exp", "log", "pow"];

export function mountMatrixUI(root: HTMLElement, matrix: ModMatrix): () => void {
  const rebuild = () => build(root, matrix, rebuild);
  rebuild();
  return rebuild;
}

function build(root: HTMLElement, matrix: ModMatrix, rebuild: () => void): void {
  root.innerHTML = "";
  const head = document.createElement("div"); head.className = "mm-head";
  head.innerHTML = "<b>Mod Matrix</b><span class='mm-hint'>[M] fermer · le point d'injection audio→visuel</span>";
  root.appendChild(head);

  const dests = [...matrix.targets.keys()];
  matrix.routes.forEach((r, i) => {
    const row = document.createElement("div"); row.className = "mm-row";
    const en = document.createElement("input"); en.type = "checkbox"; en.checked = r.enabled !== false;
    en.onchange = () => { r.enabled = en.checked; matrix.save(); };
    const src = sel(SOURCES, r.source, (v) => { r.source = v; matrix.save(); });
    const arrow = document.createElement("span"); arrow.textContent = "→"; arrow.className = "mm-arrow";
    const dst = sel(dests, r.dest, (v) => { r.dest = v; matrix.save(); });
    const amt = document.createElement("input"); amt.type = "range"; amt.min = "-3"; amt.max = "3"; amt.step = "0.05"; amt.value = String(r.amount); amt.className = "mm-amt";
    const amtV = document.createElement("span"); amtV.className = "mm-v"; amtV.textContent = r.amount.toFixed(2);
    amt.oninput = () => { r.amount = parseFloat(amt.value); amtV.textContent = r.amount.toFixed(2); matrix.save(); };
    const crv = sel(CURVES, r.curve ?? "lin", (v) => { r.curve = v as Curve; matrix.save(); });
    const sm = document.createElement("input"); sm.type = "range"; sm.min = "0"; sm.max = "1"; sm.step = "0.02"; sm.value = String(r.smoothing ?? 0); sm.className = "mm-sm"; sm.title = "smoothing";
    sm.oninput = () => { r.smoothing = parseFloat(sm.value); matrix.save(); };
    const del = document.createElement("button"); del.textContent = "×"; del.className = "mm-del";
    del.onclick = () => { matrix.removeRoute(i); rebuild(); };
    row.append(en, src, arrow, dst, amt, amtV, crv, sm, del);
    root.appendChild(row);
  });

  const actions = document.createElement("div"); actions.className = "mm-actions";
  const bAdd = btn("+ route", () => { matrix.addRoute({ source: "onset", dest: dests[4] ?? "global.brightness", amount: 1, curve: "lin", smoothing: 0 }); rebuild(); });
  const bReset = btn("défaut", () => { matrix.reset(); rebuild(); });
  const bExp = btn("export", () => { navigator.clipboard?.writeText(matrix.exportJSON()); bExp.textContent = "copié ✓"; setTimeout(() => (bExp.textContent = "export"), 1000); });
  const bImp = btn("import", () => { const j = prompt("routes JSON:"); if (j) { try { matrix.importJSON(j); rebuild(); } catch { alert("JSON invalide"); } } });
  actions.append(bAdd, bReset, bExp, bImp);
  root.appendChild(actions);
}

function sel(opts: string[], val: string, on: (v: string) => void): HTMLSelectElement {
  const s = document.createElement("select"); s.className = "mm-sel";
  for (const o of opts) { const opt = document.createElement("option"); opt.value = o; opt.textContent = o; if (o === val) opt.selected = true; s.appendChild(opt); }
  s.onchange = () => on(s.value);
  return s;
}
function btn(label: string, on: () => void): HTMLButtonElement {
  const b = document.createElement("button"); b.className = "mm-btn"; b.textContent = label; b.onclick = on; return b;
}
