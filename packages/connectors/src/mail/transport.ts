import { connect as tlsConnect } from "node:tls";
import { PsycheError } from "@psyche/protocol";

/**
 * Byte transport for the IMAP and SMTP clients. Production dials implicit TLS only (IMAPS 993,
 * SMTPS 465): no STARTTLS, no plaintext, certificate verification on, TLS 1.2 or newer. Tests
 * supply in-memory sockets from the fake servers.
 */
export interface MailSocket {
  readonly readable: AsyncIterable<Uint8Array>;
  write(data: Uint8Array | string): Promise<void>;
  end(): void;
  destroy(): void;
}

export type MailDialer = (host: string, port: number, signal?: AbortSignal) => Promise<MailSocket>;

export const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

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
        minVersion: "TLSv1.2",
        rejectUnauthorized: true,
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
        resolve({
          readable: socket as unknown as AsyncIterable<Uint8Array>,
          write: (data) =>
            new Promise<void>((ok, fail) => socket.write(data, (err) => (err ? fail(err) : ok()))),
          end: () => socket.end(),
          destroy: () => socket.destroy(),
        });
      });
    });
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
