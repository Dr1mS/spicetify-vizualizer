// pw.mjs — introspection et câblage PipeWire (pw-dump / pw-link).
//
// Le point clé, vérifié sur cette machine : pour une capture, `pw-record --target
// <sink>` NE capture PAS le monitor du sink — WirePlumber ignore la cible et
// retombe sur la SOURCE PAR DÉFAUT (donc le micro). Deux façons correctes :
//   - monitor d'un sink : -P stream.capture.sink=true --target <sink>
//   - sortie d'UNE application : --target 0 (aucun lien auto) puis `pw-link` des
//     ports de sortie de l'app vers nos ports d'entrée. Non intrusif : l'app
//     continue de jouer vers les enceintes (un port accepte plusieurs liens).

import { execFile } from "node:child_process";

const run = (cmd, args) => new Promise((res) => {
  execFile(cmd, args, { maxBuffer: 64 << 20 }, (err, stdout, stderr) => res({ err, stdout: stdout || "", stderr: stderr || "" }));
});

export async function pwDump() {
  const { stdout } = await run("pw-dump", []);
  try { return JSON.parse(stdout); } catch { return []; }
}

const props = (o) => (o.info && o.info.props) || o.props || {};

/** Noeuds audio : sinks, sources et flux applicatifs. */
export function readNodes(dump) {
  const nodes = [];
  for (const o of dump) {
    if (!String(o.type || "").endsWith("Node")) continue;
    const p = props(o);
    const cls = p["media.class"] || "";
    if (!/^(Audio\/(Sink|Source)|Stream\/Output\/Audio)$/.test(cls)) continue;
    nodes.push({
      id: o.id, serial: p["object.serial"], cls,
      name: p["node.name"] || "", app: p["application.name"] || "",
      desc: p["node.description"] || p["node.nick"] || "",
    });
  }
  return nodes;
}

/** Sink par défaut (métadonnée "default"). */
export function defaultSink(dump) {
  for (const o of dump) {
    if (o.type !== "PipeWire:Interface:Metadata" || props(o)["metadata.name"] !== "default") continue;
    for (const m of o.metadata || []) if (m.key === "default.audio.sink") return m.value?.name ?? null;
  }
  return null;
}

/** Ports d'un ensemble de noeuds, par direction. { "FL": [id, …], … } */
export function portsOf(dump, nodeIds, direction) {
  const want = new Set(nodeIds);
  const out = {};
  for (const o of dump) {
    if (!String(o.type || "").endsWith("Port")) continue;
    const p = props(o);
    if (!want.has(p["node.id"]) || p["port.direction"] !== direction) continue;
    const chan = String(p["port.name"] || "").replace(/^(input|output|monitor|capture|playback)_?/, "") || "MONO";
    (out[chan] ||= []).push(o.id);
  }
  return out;
}

/** Liens existants, sous forme d'ensemble "outPort>inPort". */
export function linkSet(dump) {
  const s = new Set();
  for (const o of dump) {
    if (o.type !== "PipeWire:Interface:Link") continue;
    const p = props(o);
    s.add(`${p["link.output.port"]}>${p["link.input.port"]}`);
  }
  return s;
}

/** Noeuds de flux d'une application (match sur node.name OU application.name). */
export function appNodes(nodes, needle) {
  const n = needle.toLowerCase();
  return nodes.filter((x) => x.cls === "Stream/Output/Audio" && (x.name.toLowerCase().includes(n) || x.app.toLowerCase().includes(n)));
}

export async function link(outPort, inPort) {
  const { err, stderr } = await run("pw-link", [String(outPort), String(inPort)]);
  // "File exists" = déjà câblé : ce n'est pas une erreur pour nous.
  if (err && !/exists/i.test(stderr)) return stderr.trim() || String(err.message || err);
  return null;
}
