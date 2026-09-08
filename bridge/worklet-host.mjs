// worklet-host.mjs — exécute le FICHIER worklet expédié (src/audio/analyser.worklet.js)
// dans Node, avec les mêmes stubs que test/worklet-node.test.mjs.
//
// Conséquence : le pont et le navigateur calculent EXACTEMENT les mêmes features
// (même FFT, même mel, mêmes AGC, mêmes détecteurs d'onsets). Zéro duplication DSP.
//
// L'horloge (`currentTime`) avance au rythme des ÉCHANTILLONS consommés, pas du mur :
// T_FRAME est donc une vraie horloge audio, sans dérive si pw-record bufferise.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const WORKLET = fileURLToPath(new URL("../src/audio/analyser.worklet.js", import.meta.url));
const BLOCK = 128; // quantum de rendu (comme le navigateur)

export function loadWorklet({ sampleRate: sr, layout, melCount, featLen, onFrame }) {
  let Proc = null;
  globalThis.sampleRate = sr;
  globalThis.currentTime = 0;
  globalThis.AudioWorkletProcessor = class {
    constructor() { this.port = { postMessage: (d) => onFrame(d) }; }
  };
  globalThis.registerProcessor = (_name, cls) => { Proc = cls; };
  (0, eval)(readFileSync(WORKLET, "utf8"));
  if (!Proc) throw new Error("worklet : registerProcessor jamais appelé");

  const proc = new Proc({ processorOptions: { layout, melCount, featLen, sab: null } });
  let samples = 0;

  return {
    /** Pousse du mono par blocs de 128 (dernier bloc partiel toléré : le hop est
     *  compté en échantillons). Zéro copie : on passe des sous-vues. */
    feed(mono) {
      for (let off = 0; off < mono.length; off += BLOCK) {
        const n = Math.min(BLOCK, mono.length - off);
        globalThis.currentTime = samples / sr;
        proc.process([[mono.subarray(off, off + n)]], [], {});
        samples += n;
      }
    },
    get time() { return samples / sr; },
  };
}
