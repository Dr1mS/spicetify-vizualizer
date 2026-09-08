// ws-server.mjs — serveur WebSocket minimal (RFC 6455), ZÉRO dépendance.
//
// Sens unique en pratique : le serveur pousse des trames binaires (features) et
// du JSON (meta) ; côté client on ne lit que close/ping. Suffisant pour le pont
// audio, et ça évite d'ajouter `ws` au projet.
//
// Trames serveur -> client : JAMAIS masquées. Trames client -> serveur :
// TOUJOURS masquées (on démasque pour le close/ping).

import { createServer } from "node:http";
import { createHash } from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// Encode une trame serveur (non masquée). opcode: 1=texte, 2=binaire, 8=close, 10=pong.
function encodeFrame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) { head = Buffer.alloc(2); head[1] = len; }
  else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  head[0] = 0x80 | opcode; // FIN + opcode
  return Buffer.concat([head, payload]);
}

// Parseur incrémental des trames client (masquées). Ne remonte que les
// événements utiles : "close", "ping", "text".
function makeParser(onEvent) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (buf.length < 2) return;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const maskOff = off;
      if (masked) off += 4;
      if (buf.length < off + len) return;
      let payload = buf.subarray(off, off + len);
      if (masked) {
        const m = buf.subarray(maskOff, maskOff + 4);
        const out = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ m[i & 3];
        payload = out;
      }
      buf = buf.subarray(off + len);
      if (opcode === 0x8) onEvent("close", payload);
      else if (opcode === 0x9) onEvent("ping", payload);
      else if (opcode === 0x1) onEvent("text", payload);
      // 0x2 (binaire) / 0xA (pong) ignorés : le client ne nous envoie pas de données.
    }
  };
}

export class WsServer {
  /** @param {{port?:number, host?:string, onHttp?:(req,res)=>boolean, onClient?:(send:(d:any)=>void)=>void}} opts */
  constructor(opts = {}) {
    this.port = opts.port ?? 8787;
    this.host = opts.host ?? "127.0.0.1";
    this.onClient = opts.onClient;
    this.clients = new Set();
    this.http = createServer((req, res) => {
      if (opts.onHttp && opts.onHttp(req, res)) return;
      res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end(JSON.stringify({ ok: true, clients: this.clients.size }));
    });
    this.http.on("upgrade", (req, socket) => this._upgrade(req, socket));
  }

  _upgrade(req, socket) {
    const key = req.headers["sec-websocket-key"];
    if (!key) { socket.destroy(); return; }
    const accept = createHash("sha1").update(key + GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.setNoDelay(true);
    const client = { socket, alive: true };
    this.clients.add(client);
    const close = () => { if (!client.alive) return; client.alive = false; this.clients.delete(client); socket.destroy(); };
    socket.on("data", makeParser((ev, payload) => {
      if (ev === "close") { socket.write(encodeFrame(0x8, Buffer.alloc(0))); close(); }
      else if (ev === "ping") socket.write(encodeFrame(0xa, payload));
    }));
    socket.on("error", close);
    socket.on("close", close);
    this.onClient?.((d) => this._send(client, d));
  }

  _send(client, data) {
    if (!client.alive) return;
    // Backpressure : si le socket accumule, on saute la trame (les features sont
    // périssables — mieux vaut en perdre une que prendre du retard).
    if (client.socket.writableLength > 1 << 18) return;
    const isText = typeof data === "string";
    const payload = isText ? Buffer.from(data, "utf8") : Buffer.from(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength ?? data.length);
    client.socket.write(encodeFrame(isText ? 1 : 2, payload));
  }

  broadcast(data) { for (const c of this.clients) this._send(c, data); }

  listen() { return new Promise((res) => this.http.listen(this.port, this.host, res)); }
  close() { for (const c of this.clients) c.socket.destroy(); this.http.close(); }
}
