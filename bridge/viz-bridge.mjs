#!/usr/bin/env node
// viz-bridge.mjs — pont audio PipeWire -> features -> WebSocket.
//
//   pw-record (sortie de Spotify)  ->  PCM f32 stéréo brut sur stdout
//     -> downmix mono -> analyser.worklet.js (LE fichier expédié, joué dans Node)
//     -> trame de 51 floats (mel[32] + rms/flux/onsets/…) à ~94 Hz
//     -> WebSocket binaire vers le client (mod Spicetify, ou n'importe quelle page).
//
// Pourquoi un pont : le client Spotify décode l'audio en natif, aucun MediaElement
// ni getUserMedia n'est accessible depuis son moteur de rendu. Le seul chemin vers
// du VRAI temps réel est une capture système. Les features sont calculées ICI
// (pas dans Spotify) : zéro AudioWorklet à charger côté client, CPU hors du player.
//
// Sources (--source) :
//   app  (défaut) — SEULEMENT la sortie de l'application `--app` (Spotify) :
//                   capture non liée (--target 0) + pw-link sur ses ports de
//                   sortie. Ni micro, ni son des autres applis.
//   sink          — le monitor du sink : tout le son système.
//   mic           — la source d'entrée par défaut (micro).
//
// La capture ne tourne QUE quand un client écoute (voir « porte de veille » plus
// bas) : le pont peut donc rester lancé en permanence — service systemd — sans
// rien coûter tant que le visualiseur n'est pas ouvert.
//
// Usage :  node bridge/viz-bridge.mjs [--source app|sink|mic] [--app spotify]
//                                     [--target <noeud>] [--port 8787] [--list]
//                                     [--eager] [-v]

import { spawn } from "node:child_process";
import { WsServer } from "./ws-server.mjs";
import { loadWorklet } from "./worklet-host.mjs";
import { F, FEAT_LEN, MEL_COUNT } from "./layout.mjs";
import { pwDump, readNodes, defaultSink, portsOf, linkSet, appNodes, link } from "./pw.mjs";

const RATE = 48000;
const CHANNELS = 2;
const NODE_NAME = `viz-bridge-${process.pid}`; // unique : on doit retrouver NOS ports
const RELINK_MS = 2000; // l'app détruit/recrée son flux (pause, pub, redémarrage)
const SILENCE_MS = 60; // comble le flux quand l'app ne joue pas

// --- args ------------------------------------------------------------------
const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def; };
const has = (name) => argv.includes(name);
const PORT = Number(arg("--port", 8787));
const VERBOSE = has("-v") || has("--verbose");
const APP = arg("--app", "spotify");
const SOURCE = arg("--source", "app"); // app | sink | mic
const TARGET = arg("--target", null);
const EAGER = has("--eager"); // capture en continu, même sans client (débogage)

// --- parseur PCM en flux -----------------------------------------------------
// pw-record écrit un en-tête WAV vers un FICHIER, mais du PCM BRUT vers stdout
// (il ne peut pas revenir écrire les tailles). On accepte les deux : si le flux
// commence par "RIFF" on saute les chunks jusqu'à "data", sinon c'est déjà du PCM.
function makePcmParser(onPcm, onFormat) {
  let head = Buffer.alloc(0);
  let state = "sniff"; // sniff -> (wav|raw) -> data
  let rem = Buffer.alloc(0); // octets d'un float incomplet

  const emit = (chunk) => {
    const buf = rem.length ? Buffer.concat([rem, chunk]) : chunk;
    const usable = buf.length - (buf.length % 4);
    rem = Buffer.from(buf.subarray(usable));
    if (usable === 0) return;
    // Copie alignée : une vue Float32 exige un offset multiple de 4.
    const aligned = Buffer.from(buf.subarray(0, usable));
    onPcm(new Float32Array(aligned.buffer, aligned.byteOffset, usable / 4));
  };

  return (chunk) => {
    if (state === "data") return emit(chunk);
    head = Buffer.concat([head, chunk]);
    if (head.length < 12) return;
    if (state === "sniff") {
      state = head.toString("ascii", 0, 4) === "RIFF" ? "wav" : "raw";
      if (state === "raw") { onFormat({ raw: true }); const h = head; head = Buffer.alloc(0); state = "data"; return emit(h); }
    }
    let o = 12;
    while (o + 8 <= head.length) {
      const id = head.toString("ascii", o, o + 4);
      const sz = head.readUInt32LE(o + 4);
      if (id === "fmt " && o + 24 <= head.length)
        onFormat({ format: head.readUInt16LE(o + 8), channels: head.readUInt16LE(o + 10), rate: head.readUInt32LE(o + 12), bits: head.readUInt16LE(o + 22) });
      if (id === "data") { const rest = head.subarray(o + 8); head = Buffer.alloc(0); state = "data"; return emit(rest); }
      if (o + 8 + sz > head.length) return; // chunk incomplet : on attend
      o += 8 + sz + (sz & 1);
    }
  };
}

// --- inventaire -------------------------------------------------------------
const dump0 = await pwDump();
const nodes0 = readNodes(dump0);
const DEFAULT_SINK = defaultSink(dump0) || nodes0.find((n) => n.cls === "Audio/Sink")?.name;

if (has("--list")) {
  console.log("Sorties d'application (--source app --app <nom>) :");
  const streams = nodes0.filter((n) => n.cls === "Stream/Output/Audio");
  if (!streams.length) console.log("  (aucune — lance la lecture dans l'app)");
  for (const n of streams) console.log(`    ${(n.app || n.name).padEnd(24)} node.name=${n.name}`);
  console.log("\nPériphériques (--source sink|mic --target <name>) :");
  for (const n of nodes0.filter((x) => x.cls !== "Stream/Output/Audio"))
    console.log(`  ${n.name === DEFAULT_SINK ? "*" : " "} ${n.cls.padEnd(12)} ${n.name}${n.desc ? "  — " + n.desc : ""}`);
  console.log("\n  * = sink par défaut. --source sink capture TOUT le son système ;");
  console.log("  --source app ne capture que l'application visée (défaut : spotify).");
  process.exit(0);
}

const SOURCE_LABEL = SOURCE === "app" ? `app:${APP}` : SOURCE === "sink" ? `sink:${TARGET || DEFAULT_SINK}` : `mic:${TARGET || "défaut"}`;

// --- features ---------------------------------------------------------------
const frame = new Float32Array(FEAT_LEN);
const bytes = Buffer.from(frame.buffer);
let frames = 0, lastRms = 0;

const srv = new WsServer({
  port: PORT,
  onClient: (send) => {
    send(JSON.stringify({ type: "hello", protocol: 1, sampleRate: RATE, featLen: FEAT_LEN, melCount: MEL_COUNT, source: SOURCE_LABEL }));
    console.log(`[bridge] client connecté (${srv.clients.size})`);
    demarrer();
  },
  onClose: (restants) => {
    console.log(`[bridge] client parti (${restants})`);
    if (!restants) arreter();
  },
});

const worklet = loadWorklet({
  sampleRate: RATE, layout: F, melCount: MEL_COUNT, featLen: FEAT_LEN,
  onFrame: (f) => {
    frames++;
    frame.set(f);
    frame[F.SEQ] = frames; // le seqlock n'a pas de sens ici : compteur de trames
    lastRms = f[F.RMS];
    if (srv.clients.size) srv.broadcast(bytes);
  },
});

// --- capture ----------------------------------------------------------------
let child = null, retry = 0, stopping = false, linked = 0;
// `stopping` = le processus s'éteint ; `arretVoulu` = on a coupé la capture
// exprès (plus aucun client). Sans les distinguer, le handler `close` de
// pw-record relancerait la capture qu'on vient d'éteindre, après son backoff.
let actif = false, arretVoulu = false, relinkT = null;
let lastPcm = 0, lastFill = Date.now();
const mono = new Float32Array(16384);
const zeros = new Float32Array(RATE); // 1 s de silence

function recordArgs() {
  const a = ["-P", `node.name=${NODE_NAME}`, "--rate", String(RATE), "--channels", String(CHANNELS), "--format", "f32", "--latency", "256"];
  if (SOURCE === "app") a.push("--target", "0"); // aucun lien auto : on câble nous-mêmes
  else if (SOURCE === "sink") a.push("-P", "stream.capture.sink=true", "--target", TARGET || DEFAULT_SINK);
  else if (TARGET) a.push("--target", TARGET); // mic explicite ; sinon source par défaut
  a.push("-");
  return a;
}

function capture() {
  if (stopping) return;
  const args = recordArgs();
  if (VERBOSE) console.log("[bridge] pw-record", args.join(" "));
  child = spawn("pw-record", args, { stdio: ["ignore", "pipe", "pipe"] });

  const parse = makePcmParser(
    (pcm) => {
      lastPcm = Date.now(); lastFill = lastPcm;
      // downmix stéréo -> mono (le worklet n'analyse qu'un canal)
      const n = (pcm.length / CHANNELS) | 0;
      const m = n <= mono.length ? mono.subarray(0, n) : new Float32Array(n);
      for (let i = 0; i < n; i++) m[i] = (pcm[i * 2] + pcm[i * 2 + 1]) * 0.5;
      worklet.feed(m);
    },
    (fmt) => {
      if (VERBOSE) console.log("[bridge] flux", fmt.raw ? "PCM brut f32 stéréo" : fmt);
      if (!fmt.raw && (fmt.format !== 3 || fmt.bits !== 32)) console.error("[bridge] ⚠ format inattendu (f32 attendu) :", fmt);
      if (!fmt.raw && fmt.rate !== RATE) console.error(`[bridge] ⚠ pw-record renvoie ${fmt.rate} Hz, le worklet en attend ${RATE}`);
    },
  );

  child.stdout.on("data", (d) => { retry = 0; parse(d); });
  child.stderr.on("data", (d) => { const s = String(d).trim(); if (s) console.error("[pw-record]", s); });
  child.on("error", (e) => console.error("[bridge] pw-record introuvable ?", e.message));
  child.on("close", (code) => {
    child = null;
    if (stopping || arretVoulu) return;
    const delay = Math.min(5000, 250 * 2 ** retry++);
    console.error(`[bridge] pw-record s'est arrêté (code ${code}) — relance dans ${delay} ms`);
    setTimeout(capture, delay);
  });
}

// --- porte de veille --------------------------------------------------------
// MESURÉ : capture + FFT + mel + onsets à ~94 Hz coûtent 6,3 % d'un coeur en
// continu — y compris sur du silence, Spotify en pause. Un pont lancé au
// démarrage de la session paierait ça 24 h/24 pour rien. On n'allume donc la
// chaîne qu'à partir du premier client, et on l'éteint au dernier départ ; le
// serveur WebSocket, lui, reste à l'écoute (c'est lui le point de rendez-vous).
function demarrer() {
  if (actif || stopping) return;
  actif = true; arretVoulu = false; retry = 0;
  // Sans ce recalage, fillSilence() injecterait d'un coup tout le silence
  // « accumulé » depuis le dernier arrêt.
  lastPcm = lastFill = Date.now();
  capture();
  if (SOURCE === "app") relinkT = setTimeout(relink, 400);
  console.log("[bridge] capture allumée");
}

function arreter() {
  if (!actif || EAGER) return;
  actif = false; arretVoulu = true; linked = 0;
  clearTimeout(relinkT);
  child?.kill();
  console.log("[bridge] capture éteinte — le pont reste à l'écoute sur le port");
}

// Câblage : nos ports d'entrée <- ports de sortie de l'application. À refaire
// périodiquement, l'app détruisant/recréant son flux (pause, pub, redémarrage).
async function relink() {
  if (stopping || !actif || SOURCE !== "app" || !child) return;
  const dump = await pwDump();
  const nodes = readNodes(dump);
  const self = dump.filter((o) => String(o.type || "").endsWith("Node") && ((o.info && o.info.props) || {})["node.name"] === NODE_NAME).map((o) => o.id);
  if (!self.length) return; // pw-record pas encore enregistré
  const ins = portsOf(dump, self, "in");
  const targets = appNodes(nodes, APP);
  if (!targets.length) { if (linked) { console.log(`[bridge] flux "${APP}" disparu — en attente`); linked = 0; } return; }
  const outs = portsOf(dump, targets.map((n) => n.id), "out");
  const existing = linkSet(dump);
  const inChans = Object.keys(ins);
  let made = 0;
  for (const [chan, outPorts] of Object.entries(outs)) {
    // Canal homonyme, sinon (source mono) on l'envoie sur toutes nos entrées.
    const dests = ins[chan] ? ins[chan] : inChans.length === 1 || !ins[inChans[0]] ? [] : Object.values(ins).flat();
    for (const o of outPorts) for (const i of dests) {
      if (existing.has(`${o}>${i}`)) continue;
      const err = await link(o, i);
      if (err) console.error(`[bridge] pw-link ${o} -> ${i} : ${err}`);
      else made++;
    }
  }
  const total = Object.values(outs).flat().length;
  if (made || (total && !linked)) console.log(`[bridge] branché sur "${targets[0].app || targets[0].name}" (${total} port(s)${made ? `, ${made} lien(s) créé(s)` : ""})`);
  linked = total;
}

// Comble le silence : sans flux (app en pause), le worklet ne recevrait plus rien
// et le client basculerait à tort en "pont hors ligne". On lui donne du zéro au
// rythme réel — les features retombent doucement à zéro, la connexion tient.
function fillSilence() {
  if (!actif) return;
  const now = Date.now();
  if (now - lastPcm < 2 * SILENCE_MS) return;
  const n = Math.min(zeros.length, Math.round(((now - lastFill) * RATE) / 1000));
  if (n <= 0) return;
  lastFill = now;
  worklet.feed(zeros.subarray(0, n));
}

srv.http.on("error", (e) => {
  if (e.code === "EADDRINUSE") console.error(`[bridge] port ${PORT} déjà pris — un autre pont tourne déjà ? (--port pour en changer)`);
  else console.error("[bridge]", e.message);
  process.exit(1);
});
await srv.listen();
if (SOURCE === "app") setInterval(relink, RELINK_MS).unref?.();
const fill = setInterval(fillSilence, SILENCE_MS);
fill.unref?.();
if (EAGER) demarrer();

console.log(`[bridge] source : ${SOURCE_LABEL}${SOURCE === "app" ? " (ni micro, ni autres applis)" : ""}`);
console.log(`[bridge] WebSocket : ws://127.0.0.1:${PORT}  (features ${FEAT_LEN}f32 @ ~${(RATE / 512).toFixed(0)} Hz)`);
console.log(EAGER ? "[bridge] --eager : capture en continu" : "[bridge] en veille — la capture démarre au premier client");

// Battement de coeur : rend visible un flux muet (le mode d'échec classique).
let prevFrames = 0;
setInterval(() => {
  const d = frames - prevFrames; prevFrames = frames;
  const live = Date.now() - lastPcm < 500;
  if (!actif) { if (VERBOSE) console.log("[bridge] veille · 0 client"); return; }
  const line = `[bridge] ${d} trames/s · ${live ? `rms ${lastRms.toFixed(3)}` : "silence (app en pause ?)"} · ${srv.clients.size} client(s)`;
  if (VERBOSE) console.log(line);
  else if (d === 0) console.error("[bridge] ⚠ aucune trame — la capture est morte ?");
}, 1000).unref?.();

const bye = () => { stopping = true; child?.kill(); srv.close(); process.exit(0); };
process.on("SIGINT", bye);
process.on("SIGTERM", bye);
