// VIZ — music visualizer (Web Audio + Canvas 2D)
// Base v1 : capture système via device "Monitor of…" sur PipeWire.

import { AudioEngine } from "./audio.js";
import { RadialVisual } from "./visuals/radial.js";
import { ParticlesVisual } from "./visuals/particles.js";
import { ReactionVisual } from "./visuals/reaction.js";
import { FluidVisual } from "./visuals/fluid.js";
import { SpectrumAnalyzer } from "./visuals/analyzer.js";
import { Spectrogram } from "./visuals/spectrogram.js";
import { buildPanel } from "./controls.js";
import { makeDemo } from "./demo.js";

const $ = (sel) => document.querySelector(sel);

const canvas = $("#stage");
const overlay = $("#overlay");
const deviceSel = $("#device");
const startBtn = $("#start");
const errEl = $("#err");
const hud = $("#hud");
const fpsEl = $("#fps");
const srcNameEl = $("#srcName");
const levelEl = $("#level");
const sceneNameEl = $("#sceneName");

const engine = new AudioEngine({ fftSize: 2048 });
// A/B : ?worklet=1 -> détection d'onsets au hop rate (thread audio). Sinon AnalyserNode.
engine.useWorklet = new URLSearchParams(location.search).has("worklet");
const analyzerEl = $("#analyzer");
const analyzer = new SpectrumAnalyzer(analyzerEl);
const spectroEl = $("#spectro");
const spectrogram = new Spectrogram(spectroEl);
const cfgPanel = $("#panelCfg");
buildPanel(cfgPanel);

// --- Scènes (commutables à chaud) --------------------------------------------
// Chaque scène : { name, vis (start/resize/render), el (son canvas dédié) }.
// Un canvas WebGL par scène -> contextes indépendants, créés à la 1re visite.
const gl1 = $("#gl"), gl2 = $("#gl2"), gl3 = $("#gl3");
const scenes = [
  { name: "Particules", vis: new ParticlesVisual(gl1), el: gl1 },
  { name: "Réaction-diffusion", vis: new ReactionVisual(gl2), el: gl2 },
  { name: "Fluide", vis: new FluidVisual(gl3), el: gl3 },
  { name: "Radial 2D", vis: new RadialVisual(canvas), el: canvas },
];
let sceneIndex = 0;

function selectScene(i) {
  if (i < 0 || i >= scenes.length) return;
  const s = scenes[i];
  try {
    if (!s.vis.started) s.vis.start();
  } catch (e) {
    console.error(e);
    errEl.textContent = "Scène « " + s.name + " » indisponible : " + (e.message || e);
    return; // on reste sur la scène courante
  }
  for (const sc of scenes) sc.el.style.display = sc === s ? "block" : "none";
  s.vis.resize();
  sceneIndex = i;
  if (sceneNameEl) sceneNameEl.textContent = s.name;
}

// Analyseur affiché par défaut (outil de diagnostic).
let showAnalyzer = true;
function applyAnalyzer() {
  analyzerEl.classList.toggle("hidden", !showAnalyzer);
  document.body.classList.toggle("analyzer-on", showAnalyzer);
  if (showAnalyzer) analyzer.resize();
}

// Spectrogramme affiché par défaut (diagnostic du bug intermittent).
let showSpectro = true;
function applySpectro() {
  spectroEl.classList.toggle("hidden", !showSpectro);
  if (showSpectro) spectrogram.resize();
}

let running = false;
let paused = false;
let loopStarted = false;
let srcLabel = "source"; // libellé de la source (pour le HUD après reconnexion)

// Démarre le rendu (commun audio réel + démo).
function beginRender() {
  overlay.classList.add("hidden");
  hud.classList.remove("hidden");
  applyAnalyzer();
  applySpectro();
  running = true;
  paused = false;
  if (!loopStarted) {
    loopStarted = true;
    selectScene(sceneIndex);
    loop();
  }
}

// Mode démo (?demo=1) : pilote le visuel avec une frame synthétique, sans audio.
// Sert au dev du rendu et à la vérification headless (le son système est
// inaccessible en preview).
const DEMO = new URLSearchParams(location.search).has("demo");
const demoFrame = makeDemo();

// --- Périphériques -----------------------------------------------------------

// Trie pour mettre les sources "monitor" (son système) en premier.
function rankLabel(label) {
  const l = label.toLowerCase();
  if (l.includes("monitor")) return 0;
  if (l.includes("loopback") || l.includes("mix")) return 1;
  return 2;
}

async function populateDevices() {
  try {
    // Un getUserMedia préalable débloque les labels des périphériques.
    const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
    probe.getTracks().forEach((t) => t.stop());
  } catch {
    /* on liste quand même, labels éventuellement vides */
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = devices
    .filter((d) => d.kind === "audioinput")
    .sort((a, b) => rankLabel(a.label) - rankLabel(b.label));

  deviceSel.innerHTML = "";
  for (const d of inputs) {
    const opt = document.createElement("option");
    opt.value = d.deviceId;
    opt.textContent = d.label || `Entrée ${deviceSel.length + 1}`;
    deviceSel.appendChild(opt);
  }
  if (!inputs.length) {
    const opt = document.createElement("option");
    opt.textContent = "Aucune entrée détectée";
    opt.disabled = true;
    deviceSel.appendChild(opt);
  }
}

// --- Démarrage ---------------------------------------------------------------

async function start() {
  errEl.textContent = "";
  try {
    const deviceId = deviceSel.value || undefined;
    const label = deviceSel.selectedOptions[0]?.textContent ?? "—";
    await engine.connect(deviceId);

    const st = engine.trackSettings || {};
    srcLabel = label;
    const mode = engine._workletReady ? " · worklet" : "";
    // ⚠AEC visible si l'annulation d'écho est restée active (cause probable des coupures).
    srcNameEl.textContent = label + mode + (st.echoCancellation ? "  ⚠AEC ON" : "");
    beginRender();
  } catch (e) {
    console.error(e);
    errEl.textContent =
      "Impossible d'accéder à l'audio : " + (e.message || e.name || e);
  }
}

// --- Boucle de rendu ---------------------------------------------------------

let lastFps = performance.now();
let frames = 0;
let silentFrames = 0; // frames consécutives quasi muettes (détection capture cassée)
let lastReconnect = 0;

// Reconnexion (rebind sur le nœud PipeWire vivant après pause/resume).
async function reconnect(reason) {
  lastReconnect = performance.now();
  silentFrames = 0;
  srcNameEl.textContent = "reconnexion…";
  const ok = await engine.reconnect();
  const st = engine.trackSettings || {};
  srcNameEl.textContent =
    (ok ? "" : "⚠ échec — ") + srcLabel + (st.echoCancellation ? "  ⚠AEC ON" : "");
}

function loop() {
  requestAnimationFrame(loop);
  if (!running) return;

  const frame = DEMO ? demoFrame() : engine.sample();
  if (!paused) {
    scenes[sceneIndex].vis.render(frame);
    if (showAnalyzer) analyzer.render(frame);
    if (showSpectro) spectrogram.render(frame);
  }

  // Auto-reconnexion : si le signal reste ~nul un moment (capture cassée après
  // un suspend PipeWire), on rebind sur le nœud vivant. Cooldown pour ne pas
  // spammer getUserMedia pendant un vrai silence.
  if (!DEMO && !paused && running) {
    if (frame.raw < 0.004) silentFrames++;
    else silentFrames = 0;
    if (silentFrames > 150 && performance.now() - lastReconnect > 5000) {
      reconnect("silence prolongé");
    }
  }

  frames++;
  const now = performance.now();
  if (now - lastFps >= 500) {
    fpsEl.textContent = Math.round((frames * 1000) / (now - lastFps)) + " fps";
    const pct = Math.round(frame.raw * 100);
    if (engine.trackMuted) {
      levelEl.textContent = "⚠ CAPTURE COUPÉE";
      levelEl.style.color = "var(--err)";
    } else {
      levelEl.textContent = "niv " + pct + "%";
      levelEl.style.color = pct > 1 ? "var(--fg)" : "var(--err)";
    }
    frames = 0;
    lastFps = now;
  }
}

// --- Raccourcis clavier ------------------------------------------------------

window.addEventListener("keydown", (e) => {
  if (!running) return;
  switch (e.key.toLowerCase()) {
    case " ":
      e.preventDefault();
      paused = !paused;
      break;
    case "f":
      if (!document.fullscreenElement) document.documentElement.requestFullscreen();
      else document.exitFullscreen();
      break;
    case "a":
      showAnalyzer = !showAnalyzer;
      applyAnalyzer();
      break;
    case "s":
      showSpectro = !showSpectro;
      applySpectro();
      break;
    case "c":
      cfgPanel.classList.toggle("hidden");
      break;
    case "r":
      if (!DEMO) reconnect("manuel");
      break;
    case "h":
      hud.classList.toggle("hidden");
      break;
    default:
      // Chiffres 1..N : sélection directe de scène.
      if (/^[0-9]$/.test(e.key)) {
        const n = e.key === "0" ? 9 : parseInt(e.key, 10) - 1;
        selectScene(n);
      }
  }
});

window.addEventListener("resize", () => {
  if (loopStarted) scenes[sceneIndex].vis.resize();
});

startBtn.addEventListener("click", start);
deviceSel.addEventListener("focus", populateDevices, { once: true });

if (DEMO) {
  // Démarre le rendu immédiatement, sans audio.
  srcNameEl.textContent = "DÉMO (frame synthétique)";
  beginRender();
} else {
  populateDevices();
}

// Hook de dev/vérification (inoffensif) : pilotage manuel des scènes hors rAF.
window.__viz = { scenes, selectScene, spectrogram, analyzer, frame: () => (DEMO ? demoFrame() : engine.sample()) };
