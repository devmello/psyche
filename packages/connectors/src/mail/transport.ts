import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { PsycheError } from "@psyche/protocol";

/**
 * Byte transport for the IMAP and SMTP clients. `TLS` is implicit TLS (IMAPS 993, SMTPS 465).
 * `STARTTLS` (IMAP 143, SMTP 587) starts in plaintext and the client upgrades with
 * `upgradeTls` before it sends anything secret. Both verify certificates and use TLS 1.2 or
 * newer. There is no plaintext-only mode. Tests supply in-memory sockets from the fake servers.
 */
export type MailSecurity = "TLS" | "STARTTLS";

export interface MailSocket {
  readonly readable: AsyncIterable<Uint8Array>;
  write(data: Uint8Array | string): Promise<void>;
  end(): void;
  destroy(): void;
  /** STARTTLS sockets only: resolves to the TLS socket that replaces this plaintext one. */
  upgradeTls?(servername: string): Promise<MailSocket>;
  /** Bytes already received and not yet read; a STARTTLS upgrade refuses when any are pending. */
  pendingBytes?(): number;
}

export type MailDialer = (
  host: string,
  port: number,
  signal?: AbortSignal,
  security?: MailSecurity,
) => Promise<MailSocket>;

export const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

const TLS_OPTIONS = { minVersion: "TLSv1.2" as const, rejectUnauthorized: true };

export function tlsDialer(options: { timeoutMs?: number } = {}): MailDialer {
  return (host, port, signal) =>
    new Promise<MailSocket>((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(new PsycheError("cancelled", "connect aborted"));
        return;
      }
      const socket = tlsConnect({
        host,
        port,
        servername: host,
        ...TLS_OPTIONS,
      });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(
          new PsycheError("unavailable", `connecting to ${host}:${port} timed out`, {
            retryable: true,
          }),
        );
      }, options.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
      const onAbort = () => {
        socket.destroy();
        reject(new PsycheError("cancelled", "connect aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      socket.once("error", (err) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(
          new PsycheError(
            "unavailable",
            `TLS connection to ${host}:${port} failed: ${err.message}`,
            { retryable: true },
          ),
        );
      });
      socket.once("secureConnect", () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(wrapSocket(socket));
      });
    });
}

/**
 * Plaintext dialer for STARTTLS. Nothing secret is written on this socket: the protocol client
 * sends STARTTLS first and then calls `upgradeTls`, which wraps the same connection in TLS with
 * certificate verification on.
 */
export function starttlsDialer(options: { timeoutMs?: number } = {}): MailDialer {
  return (host, port, signal) =>
    new Promise<MailSocket>((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(new PsycheError("cancelled", "connect aborted"));
        return;
      }
      const timeoutMs = options.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
      const socket = netConnect({ host, port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(
          new PsycheError("unavailable", `connecting to ${host}:${port} timed out`, {
            retryable: true,
          }),
        );
      }, timeoutMs);
      const onAbort = () => {
        socket.destroy();
        reject(new PsycheError("cancelled", "connect aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      socket.once("error", (err) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(
          new PsycheError("unavailable", `connection to ${host}:${port} failed: ${err.message}`, {
            retryable: true,
          }),
        );
      });
      socket.once("connect", () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(wrapSocket(socket, (servername) => upgradeToTls(socket, servername, timeoutMs)));
      });
    });
}

/** Production dialer: `TLS` dials implicit TLS, `STARTTLS` dials plaintext to upgrade. */
export function mailDialer(options: { timeoutMs?: number } = {}): MailDialer {
  const implicit = tlsDialer(options);
  const plain = starttlsDialer(options);
  return (host, port, signal, security = "TLS") =>
    security === "STARTTLS" ? plain(host, port, signal) : implicit(host, port, signal);
}

function upgradeToTls(raw: Socket, servername: string, timeoutMs: number): Promise<MailSocket> {
  return new Promise<MailSocket>((resolve, reject) => {
    const secure = tlsConnect({ socket: raw, servername, ...TLS_OPTIONS });
    const timer = setTimeout(() => {
      secure.destroy();
      reject(
        new PsycheError("unavailable", `TLS upgrade with ${servername} timed out`, {
          retryable: true,
        }),
      );
    }, timeoutMs);
    secure.on("error", (err) => {
      clearTimeout(timer);
      reject(
        new PsycheError("unavailable", `TLS upgrade with ${servername} failed: ${err.message}`, {
          retryable: true,
        }),
      );
    });
    secure.once("secureConnect", () => {
      clearTimeout(timer);
      resolve(wrapSocket(secure));
    });
  });
}

function wrapSocket(
  socket: Socket,
  upgrade?: (servername: string) => Promise<MailSocket>,
): MailSocket {
  return {
    readable: socket as unknown as AsyncIterable<Uint8Array>,
    write: (data) =>
      new Promise<void>((ok, fail) => socket.write(data, (err) => (err ? fail(err) : ok()))),
    end: () => socket.end(),
    destroy: () => socket.destroy(),
    pendingBytes: () => socket.readableLength,
    ...(upgrade === undefined ? {} : { upgradeTls: upgrade }),
  };
}

/** Line and literal reader over a `MailSocket`. */
export class LineReader {
  readonly #iter: AsyncIterator<Uint8Array>;
  #buf: Buffer = Buffer.alloc(0);
  #closed = false;

  constructor(socket: MailSocket) {
    this.#iter = socket.readable[Symbol.asyncIterator]();
  }

  async #fill(): Promise<boolean> {
    if (this.#closed) return false;
    const r = await this.#iter.next();
    if (r.done === true) {
      this.#closed = true;
      return false;
    }
    this.#buf = Buffer.concat([this.#buf, Buffer.from(r.value)]);
    return true;
  }

  /** Bytes read from the socket but not yet consumed by a line or literal read. */
  buffered(): number {
    return this.#buf.length;
  }

  /** One line without its CRLF; `undefined` when the peer closed. */
  async readLine(): Promise<string | undefined> {
    for (;;) {
      const i = this.#buf.indexOf("\n");
      if (i >= 0) {
        const line = this.#buf.subarray(0, i).toString("latin1").replace(/\r$/, "");
        this.#buf = this.#buf.subarray(i + 1);
        return line;
      }
      if (!(await this.#fill())) {
        if (this.#buf.length === 0) return undefined;
        const line = this.#buf.toString("latin1");
        this.#buf = Buffer.alloc(0);
        return line;
      }
    }
  }

  async readBytes(n: number): Promise<Uint8Array> {
    while (this.#buf.length < n) {
      if (!(await this.#fill()))
        throw new PsycheError("unavailable", "connection closed mid-literal");
    }
    const out = new Uint8Array(this.#buf.subarray(0, n));
    this.#buf = this.#buf.subarray(n);
    return out;
  }
}
