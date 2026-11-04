import { createHash, X509Certificate } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { type TLSSocket, connect as tlsConnect } from "node:tls";
import type { WebSocketLike } from "@psyche/web/client";
import WebSocket from "ws";

/**
 * TLS for a Gateway on the local network (remote-gateway design §3.1, "LAN"). The Gateway's
 * certificate is self-signed: there is no public CA for `<host>.local`, so the system's trust
 * store is never asked and never trusted here. A LAN Gateway is reached only through a
 * `PinnedChannel`, which accepts a connection only when the SHA-256 of the certificate's SPKI is
 * the pinned one, and (until a pin is stored) leaves the first certificate to the handshake's
 * binding check: the Gateway's identity key signs the SPKI it served into the challenge, and the
 * verifier refuses unless that is the certificate the connection actually presented
 * (`createGatewayVerifier`'s `lan` option).
 *
 * The one place chain validation is switched off is the single socket made in `connect`, with
 * `rejectUnauthorized: false` set on that socket only (never a process or session setting), and
 * the pin check runs on that same socket before the socket is handed to anyone, so no byte is
 * written to a peer whose certificate was not accepted. (Node's `checkServerIdentity` is not
 * called after a chain failure, so the pin is the check; it replaces the chain, it does not add
 * to it.) The renderer never dials a Gateway, so Electron's session certificate callbacks are not
 * involved.
 */

/** SHA-256 of a certificate's SubjectPublicKeyInfo, base64url: the cert pin. */
export function spkiPinOfCert(der: Buffer): string {
  const spki = new X509Certificate(der).publicKey.export({ type: "spki", format: "der" });
  return createHash("sha256").update(spki).digest("base64url");
}

export const CERT_PIN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Raised when a LAN connection is refused; `code` is a fatal splash code. */
export class PinRefusal extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "PinRefusal";
    this.code = code;
  }
}

export interface PinnedChannelOptions {
  host: string;
  port: number;
  /** The pinned SPKI (base64url), read per attempt; `undefined` until the first pairing. */
  pinned: () => string | undefined;
  handshakeTimeoutMs?: number;
}

export class PinnedChannel {
  readonly #o: PinnedChannelOptions;
  #wsSpki: string | undefined;

  constructor(opts: PinnedChannelOptions) {
    this.#o = opts;
  }

  /** The SPKI the most recent WebSocket connection presented (after it passed the pin check). */
  observedSpki(): string | undefined {
    return this.#wsSpki;
  }

  pinnedSpki(): string | undefined {
    return this.#o.pinned();
  }

  /**
   * A TLS connection to the Gateway whose certificate matched the pin (or any certificate while
   * no pin is stored: the handshake's binding check decides before anything is signed).
   * `kind: "ws"` records the certificate for that check.
   */
  connect(kind: "ws" | "health"): Promise<TLSSocket> {
    const { host, port } = this.#o;
    return new Promise((resolve, reject) => {
      let pinned: string | undefined;
      try {
        pinned = this.#o.pinned();
      } catch {
        reject(new PinRefusal("gateway_pins_unreadable"));
        return;
      }
      const socket = tlsConnect({
        host,
        port,
        ...(isIP(host) === 0 ? { servername: host } : {}),
        minVersion: "TLSv1.3",
        ALPNProtocols: ["http/1.1"],
        // This socket only, and replaced by the pin check just below (see the file comment).
        rejectUnauthorized: false,
      });
      const timer = setTimeout(
        () => socket.destroy(new Error("handshake timed out")),
        this.#o.handshakeTimeoutMs ?? 10_000,
      );
      socket.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      socket.once("secureConnect", () => {
        clearTimeout(timer);
        let seen: string;
        try {
          const raw = socket.getPeerCertificate(true).raw;
          if (!raw || raw.length === 0) throw new Error("no certificate");
          seen = spkiPinOfCert(raw);
        } catch {
          socket.destroy();
          reject(new PinRefusal("gateway_cert_invalid"));
          return;
        }
        if (pinned !== undefined && seen !== pinned) {
          socket.destroy();
          reject(new PinRefusal("gateway_cert_changed"));
          return;
        }
        if (kind === "ws") this.#wsSpki = seen;
        socket.removeAllListeners("error");
        resolve(socket);
      });
    });
  }
}

type Listener = (ev: { data?: unknown; refusal?: string }) => void;

/**
 * A WebSocket over a pin-checked TLS socket, for `GatewayConnection`'s `createWebSocket`. A
 * refused certificate surfaces as an `error` event carrying `refusal` (a fatal code), then
 * `close`, so the connection stops with a reason instead of retrying a Gateway that failed.
 */
export function createPinnedWebSocket(channel: PinnedChannel, url: string): WebSocketLike {
  const listeners: Record<"open" | "close" | "error" | "message", Listener[]> = {
    open: [],
    close: [],
    error: [],
    message: [],
  };
  let ws: WebSocket | undefined;
  let closed = false;
  const emit = (type: keyof typeof listeners, ev: Parameters<Listener>[0] = {}) => {
    for (const l of listeners[type]) l(ev);
  };
  const finish = (refusal?: string) => {
    if (closed) return;
    closed = true;
    if (refusal !== undefined) emit("error", { refusal });
    emit("close");
  };
  void channel.connect("ws").then(
    (socket) => {
      if (closed) {
        socket.destroy();
        return;
      }
      ws = new WebSocket(url, { createConnection: () => socket, handshakeTimeout: 10_000 });
      ws.on("open", () => emit("open"));
      ws.on("message", (data, isBinary) => {
        const buf = Buffer.isBuffer(data) ? data : Buffer.concat(data as Buffer[]);
        emit("message", { data: isBinary ? buf : buf.toString("utf8") });
      });
      ws.on("error", () => emit("error"));
      ws.on("close", () => finish());
    },
    (err: unknown) => finish(err instanceof PinRefusal ? err.code : undefined),
  );
  return {
    get readyState() {
      return closed ? 3 : (ws?.readyState ?? 0);
    },
    send: (data) => ws?.send(data),
    close: (code, reason) => {
      if (ws) ws.close(code, reason);
      else finish();
    },
    addEventListener: (type, cb) => {
      listeners[type].push(cb);
    },
  };
}

/** `fetch` for the health check, over a pin-checked socket; only what `GatewayConnection` uses. */
export function createPinnedFetch(channel: PinnedChannel): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const socket = await channel.connect("health");
    return await new Promise<Response>((resolve, reject) => {
      const req = httpsRequest(
        {
          createConnection: () => socket,
          host: url.hostname,
          port: url.port,
          path: `${url.pathname}${url.search}`,
          method: "GET",
          headers: { host: url.host, connection: "close" },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () =>
            resolve(
              new Response(Buffer.concat(chunks), {
                status: res.statusCode ?? 502,
                headers: { "content-type": String(res.headers["content-type"] ?? "text/plain") },
              }),
            ),
          );
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      init?.signal?.addEventListener("abort", () => req.destroy(new Error("aborted")));
      req.end();
    });
  }) as typeof fetch;
}
