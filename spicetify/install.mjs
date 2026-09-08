#!/usr/bin/env node
// install.mjs — installe la custom app dans Spicetify puis applique.
//
//   spicetify/dist/index.js + manifest.json  ->  ~/.config/spicetify/CustomApps/viz/
//   puis `spicetify config custom_apps viz` (en PRÉSERVANT les apps déjà là)
//   puis `spicetify apply` (qui redémarre Spotify).
//
// Usage : node spicetify/install.mjs [--no-apply] [--name viz]

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const APP = arg("--name", "viz");
const APPLY = !argv.includes("--no-apply");

const bin = ["spicetify", join(homedir(), ".spicetify", "spicetify"), join(homedir(), "spicetify-cli", "spicetify")]
  .find((p) => { try { execFileSync(p, ["--version"], { stdio: "ignore" }); return true; } catch { return false; } });
if (!bin) { console.error("spicetify introuvable (ni dans le PATH, ni dans ~/.spicetify)."); process.exit(1); }

const src = join(HERE, "dist", "index.js");
if (!existsSync(src)) { console.error("spicetify/dist/index.js manquant — lance d'abord : npm run build:spicetify"); process.exit(1); }

const cfgPath = execFileSync(bin, ["-c"], { encoding: "utf8" }).trim();
const dest = join(dirname(cfgPath), "CustomApps", APP);
mkdirSync(dest, { recursive: true });
copyFileSync(src, join(dest, "index.js"));
copyFileSync(join(HERE, "manifest.json"), join(dest, "manifest.json"));
console.log(`[install] copié dans ${dest}`);

// Enregistrement : `spicetify config custom_apps <name>` AJOUTE à la liste
// (il ne la remplace pas), mais on vérifie quand même — perdre marketplace
// serait un joli dégât collatéral.
const before = readFileSync(cfgPath, "utf8").match(/^custom_apps\s*=\s*(.*)$/m)?.[1] ?? "";
if (!before.split("|").map((s) => s.trim()).filter(Boolean).includes(APP)) {
  execFileSync(bin, ["config", "custom_apps", APP], { stdio: "inherit" });
}
const after = readFileSync(cfgPath, "utf8").match(/^custom_apps\s*=\s*(.*)$/m)?.[1] ?? "";
console.log(`[install] custom_apps : "${before}" -> "${after}"`);
for (const app of before.split("|").map((s) => s.trim()).filter(Boolean)) {
  if (!after.includes(app)) console.error(`[install] ⚠ "${app}" a disparu de la config — remets-le : ${bin} config custom_apps ${app}`);
}

if (APPLY) {
  console.log("[install] spicetify apply (Spotify va redémarrer)…");
  execFileSync(bin, ["apply"], { stdio: "inherit" });
} else {
  console.log(`[install] pas d'apply. Pour l'appliquer : ${bin} apply`);
}
