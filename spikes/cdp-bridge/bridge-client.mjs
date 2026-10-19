// Minimal client for the NDJSON bridge (runs in a plain Node process, not Electron).

import { EventEmitter } from "node:events";
import net from "node:net";

export class BridgeError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

export class BridgeClient extends EventEmitter {
  static connect(socketPath) {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(socketPath);
      sock.once("connect", () => resolve(new BridgeClient(sock)));
      sock.once("error", reject);
    });
  }

  constructor(sock) {
    super();
    this.sock = sock;
    this.nextId = 1;
    this.pending = new Map();
    this.bytesIn = 0;
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", (chunk) => {
      this.bytesIn += chunk.length;
      buf += chunk;
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line) this.#onFrame(JSON.parse(line));
      }
    });
  }

  #onFrame(f) {
    if (f.id != null) {
      const p = this.pending.get(f.id);
      if (!p) return;
      this.pending.delete(f.id);
      if (f.error) p.reject(new BridgeError(f.error.code, f.error.message));
      else p.resolve(f.result);
      return;
    }
    this.emit("event", f);
  }

  send(tabId, method, params, sessionId) {
    const id = this.nextId++;
    const frame = {
      id,
      tabId,
      method,
      ...(params ? { params } : {}),
      ...(sessionId ? { sessionId } : {}),
    };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.sock.write(`${JSON.stringify(frame)}\n`);
    });
  }

  /** Resolve with the first event matching tabId/method/predicate, or reject after timeoutMs. */
  waitFor(tabId, method, pred = () => true, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const onEv = (f) => {
        if (
          (tabId == null || f.tabId === tabId) &&
          f.method === method &&
          pred(f.params ?? {}, f)
        ) {
          clearTimeout(timer);
          this.off("event", onEv);
          resolve(f);
        }
      };
      const timer = setTimeout(() => {
        this.off("event", onEv);
        reject(new BridgeError("TIMEOUT", `waiting for ${method} on ${tabId}`));
      }, timeoutMs);
      this.on("event", onEv);
    });
  }

  close() {
    this.sock.end();
  }
}
