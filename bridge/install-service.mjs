#!/usr/bin/env node
// install-service.mjs — fait tourner le pont tout seul, via un service systemd
// utilisateur. Plus aucune commande à lancer : le pont attend sur son port, et
// n'allume la capture qu'à l'ouverture du visualiseur (voir la porte de veille
// dans viz-bridge.mjs — 0,3 % de CPU en veille contre 6,3 % en capture).
//
//   node bridge/install-service.mjs                  # installe et démarre
//   node bridge/install-service.mjs --source sink    # avec des options de pont
//   node bridge/install-service.mjs --uninstall      # retire tout
//   node bridge/install-service.mjs --print          # montre l'unité, n'écrit rien

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE = resolve(HERE, "viz-bridge.mjs");
const UNIT_DIR = join(homedir(), ".config", "systemd", "user");
const UNIT = "viz-bridge.service";
const UNIT_PATH = join(UNIT_DIR, UNIT);

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
// tout ce qui n'est pas un drapeau de CE script est passé au pont
const passthrough = argv.filter((a) => !["--uninstall", "--print"].includes(a));

const sysctl = (...a) => execFileSync("systemctl", ["--user", ...a], { encoding: "utf8", stdio: "pipe" });

if (flag("--uninstall")) {
  try { sysctl("disable", "--now", UNIT); } catch { /* pas installé */ }
  rmSync(UNIT_PATH, { force: true });
  try { sysctl("daemon-reload"); } catch { /* ignore */ }
  console.log(`[service] ${UNIT} retiré.`);
  process.exit(0);
}

// process.execPath, pas "node" : sous nvm le binaire vit dans ~/.nvm/... qui
// n'est PAS dans le PATH d'un service systemd. Le revers, c'est qu'une mise à
// jour de Node change ce chemin — il faut relancer cette commande.
const NODE = process.execPath;
const exec = [NODE, BRIDGE, ...passthrough].map((p) => (p.includes(" ") ? JSON.stringify(p) : p)).join(" ");

const unit = `[Unit]
Description=Vizualizer audio bridge (PipeWire -> WebSocket)
Documentation=https://github.com/Dr1mS/spicetify-vizualizer
After=pipewire.service pipewire-pulse.service
Wants=pipewire.service

[Service]
Type=simple
ExecStart=${exec}
Restart=always
RestartSec=3
# Le pont dort tant qu'aucun client n'écoute : il peut rester lancé en
# permanence. Nice=5 pour qu'il ne dispute jamais le CPU au décodage audio.
Nice=5

[Install]
WantedBy=default.target
`;

if (flag("--print")) { process.stdout.write(unit); process.exit(0); }

if (!existsSync(BRIDGE)) { console.error(`[service] ${BRIDGE} introuvable.`); process.exit(1); }
try { sysctl("--version"); } catch { console.error("[service] systemd utilisateur indisponible — lance le pont à la main (npm run bridge)."); process.exit(1); }

mkdirSync(UNIT_DIR, { recursive: true });
writeFileSync(UNIT_PATH, unit);
sysctl("daemon-reload");
sysctl("enable", "--now", UNIT);

console.log(`[service] ${UNIT_PATH}`);
console.log(`[service] ExecStart=${exec}`);
console.log("[service] activé et démarré — il repartira à chaque ouverture de session.");
console.log("");
console.log("  systemctl --user status viz-bridge     état");
console.log("  journalctl --user -u viz-bridge -f     journal");
console.log("  node bridge/install-service.mjs --uninstall   tout retirer");
console.log("");
console.log("Note : le chemin de Node est figé dans l'unité. Après une mise à jour");
console.log("de Node (nvm), relance cette commande pour la mettre à jour.");
