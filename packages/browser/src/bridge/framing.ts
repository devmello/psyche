import type { Duplex } from "node:stream";
import {
  createValidator,
  type ErrorCode,
  errRes,
  eventFrame,
  Frame,
  okRes,
  PsycheError,
  reqFrame,
} from "@psyche/protocol";

/**
 * NDJSON frame connection (wire spec v1 frames: `req` / `res` / `event`), symmetric so both the
 * Gateway side and the mock desktop use it. The browser bridge carries raw AX trees, so its cap
 * is 16 MiB rather than the node socket's 1 MiB (spike 01, amendment 2).
 */
export const BRIDGE_MAX_FRAME_BYTES = 16 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

const frameValidator = createValidator(Frame);

export interface FrameConnectionOptions {
  maxFrameBytes?: number;
  requestTimeoutMs?: number;
  onRequest?: (method: string, params: unknown) => Promise<unknown>;
  onEvent?: (event: string, payload: unknown, seq: number) => void;
  onClose?: (reason: string) => void;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class FrameConnection {
  #stream: Duplex;
  #o: FrameConnectionOptions;
  #max: number;
  #buf = "";
  #bufBytes = 0;
  #nextId = 1;
  #seq = 0;
  #pending = new Map<string, Pending>();
  #closed = false;

  constructor(stream: Duplex, options: FrameConnectionOptions = {}) {
    this.#stream = stream;
    this.#o = options;
    this.#max = options.maxFrameBytes ?? BRIDGE_MAX_FRAME_BYTES;
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => this.#onData(chunk));
    stream.on("close", () => this.#close("stream closed"));
    stream.on("error", (err) => this.#close(`stream error: ${err.message}`));
  }

  get closed(): boolean {
    return this.#closed;
  }

  setHandlers(handlers: Pick<FrameConnectionOptions, "onRequest" | "onEvent" | "onClose">): void {
    Object.assign(this.#o, handlers);
  }

  #onData(chunk: string): void {
    this.#buf += chunk;
    this.#bufBytes += Buffer.byteLength(chunk);
    let nl = this.#buf.indexOf("\n");
    while (nl !== -1) {
      const line = this.#buf.slice(0, nl).replace(/\r$/, "");
      this.#buf = this.#buf.slice(nl + 1);
      if (line.length > 0) this.#onLine(line);
      nl = this.#buf.indexOf("\n");
    }
    this.#bufBytes = this.#buf.length === 0 ? 0 : Buffer.byteLength(this.#buf);
    if (this.#bufBytes > this.#max) {
      this.destroy(`frame exceeds ${this.#max} bytes`);
    }
  }

  #onLine(line: string): void {
    if (Buffer.byteLength(line) > this.#max) {
      this.destroy(`frame exceeds ${this.#max} bytes`);
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.destroy("frame is not valid JSON");
      return;
    }
    if (!frameValidator.check(value)) {
      const id = (value as { id?: unknown }).id;
      if (typeof id === "string" && id.length > 0 && id.length <= 128) {
        this.#write(
          errRes(id, { code: "invalid_frame", message: "frame does not match the wire spec" }),
        );
      }
      return;
    }
    const f = value;
    if (f.type === "req") void this.#onReq(f.id, f.method, f.params);
    else if (f.type === "res") {
      const p = this.#pending.get(f.id);
      if (p === undefined) return;
      this.#pending.delete(f.id);
      clearTimeout(p.timer);
      if (f.ok) p.resolve(f.payload);
      else {
        const opts: { details?: unknown; retryable?: boolean } = {};
        if (f.error.details !== undefined) opts.details = f.error.details;
        if (f.error.retryable === true) opts.retryable = true;
        p.reject(new PsycheError(f.error.code as ErrorCode, f.error.message, opts));
      }
    } else this.#o.onEvent?.(f.event, f.payload, f.seq);
  }

  async #onReq(id: string, method: string, params: unknown): Promise<void> {
    const handler = this.#o.onRequest;
    if (handler === undefined) {
      this.#write(errRes(id, { code: "unknown_method", message: `no handler for ${method}` }));
      return;
    }
    try {
      this.#write(okRes(id, await handler(method, params)));
    } catch (err) {
      this.#write(errRes(id, PsycheError.from(err)));
    }
  }

  #write(frame: unknown): void {
    if (this.#closed) return;
    const line = JSON.stringify(frame);
    if (Buffer.byteLength(line) > this.#max) {
      throw new PsycheError("invalid_frame", `outgoing frame exceeds ${this.#max} bytes`);
    }
    this.#stream.write(`${line}\n`);
  }

  request(
    method: string,
    params?: unknown,
    options: { timeoutMs?: number } = {},
  ): Promise<unknown> {
    if (this.#closed) {
      return Promise.reject(
        new PsycheError("unavailable", "bridge is not connected", { retryable: true }),
      );
    }
    const id = `g${this.#nextId++}`;
    const timeoutMs = options.timeoutMs ?? this.#o.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new PsycheError("timeout", `${method} timed out after ${timeoutMs} ms`, {
            retryable: true,
          }),
        );
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#write(reqFrame(id, method, params));
      } catch (err) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(err);
      }
    });
  }

  event(event: string, payload: unknown): void {
    this.#write(eventFrame(event, payload, this.#seq++, 0));
  }

  #close(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const p of this.#pending.values()) {
      clearTimeout(p.timer);
      p.reject(new PsycheError("unavailable", `bridge closed: ${reason}`, { retryable: true }));
    }
    this.#pending.clear();
    this.#o.onClose?.(reason);
  }

  destroy(reason = "closed"): void {
    this.#close(reason);
    this.#stream.destroy();
  }
}
