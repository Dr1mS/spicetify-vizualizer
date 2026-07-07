// controls.js — panneau de contrôle généré depuis SCHEMA, lié à `config`.

import { SCHEMA, config, saveConfig, resetConfig, exportConfig, importConfig } from "./config.js";

export function buildPanel(root) {
  root.innerHTML = "";
  const head = el("div", "cfg-head");
  head.innerHTML = "<b>Réglages</b><span class='cfg-hint'>[C] fermer</span>";
  root.appendChild(head);

  for (const [g, group] of Object.entries(SCHEMA)) {
    const sec = el("div", "cfg-sec");
    const title = el("div", "cfg-title", group.label);
    sec.appendChild(title);
    for (const [k, p] of Object.entries(group.params)) {
      sec.appendChild(control(g, k, p));
    }
    root.appendChild(sec);
  }

  // Actions : reset / export / import.
  const actions = el("div", "cfg-actions");
  const bReset = el("button", "cfg-btn", "Réinitialiser");
  bReset.onclick = () => { resetConfig(); buildPanel(root); };
  const bExport = el("button", "cfg-btn", "Exporter");
  bExport.onclick = () => {
    navigator.clipboard?.writeText(exportConfig());
    bExport.textContent = "Copié ✓";
    setTimeout(() => (bExport.textContent = "Exporter"), 1200);
  };
  const bImport = el("button", "cfg-btn", "Importer");
  bImport.onclick = () => {
    const json = prompt("Colle un preset JSON :");
    if (json) { try { importConfig(json); buildPanel(root); } catch (e) { alert("JSON invalide"); } }
  };
  actions.append(bReset, bExport, bImport);
  root.appendChild(actions);
}

function control(g, k, p) {
  const row = el("div", "cfg-row");
  const lab = el("label", "cfg-label", p.label);
  row.appendChild(lab);

  if (p.type === "select") {
    const sel = document.createElement("select");
    sel.className = "cfg-input";
    for (const o of p.options) {
      const opt = document.createElement("option");
      opt.value = o; opt.textContent = o;
      if (config[g][k] === o) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.onchange = () => { config[g][k] = sel.value; saveConfig(); };
    row.appendChild(sel);
  } else {
    const val = el("span", "cfg-val", fmt(config[g][k], p));
    const input = document.createElement("input");
    input.type = "range";
    input.className = "cfg-slider";
    input.min = p.min; input.max = p.max; input.step = p.step;
    input.value = config[g][k];
    input.oninput = () => {
      const v = p.int ? parseInt(input.value, 10) : parseFloat(input.value);
      config[g][k] = v;
      val.textContent = fmt(v, p);
      saveConfig();
    };
    lab.appendChild(val);
    row.appendChild(input);
  }
  return row;
}

function fmt(v, p) {
  if (p.int) return "" + v;
  const d = p.step < 0.01 ? 4 : p.step < 0.1 ? 3 : 2;
  return (+v).toFixed(d);
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
