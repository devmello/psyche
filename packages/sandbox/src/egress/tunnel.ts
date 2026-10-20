import type { Readable, Writable } from "node:stream";
import { Duplex } from "node:stream";

/**
 * Host side of the egress shim's stdio multiplexer (`EGRESS_SHIM`). Every connection the shim
 * accepts inside the container becomes a `Duplex` handed to `onConnection` (the egress proxy).
 */
export const FRAME = { OPEN: 1, DATA: 2, EOF: 3, CLOSE: 4, READY: 5 } as const;
const HEADER = 9;
const MAX_PAYLOAD = 64 * 1024;
/** A frame larger than this means the stream is corrupt. */
const MAX_FRAME = 1 << 20;

export function encodeFrame(
  type: number,
  id: number,
  payload: Uint8Array = Buffer.alloc(0),
): Buffer {
  const head = Buffer.alloc(HEADER);
  head.writeUInt8(type, 0);
  head.writeUInt32BE(id, 1);
  head.writeUInt32BE(payload.length, 5);
  return Buffer.concat([head, payload]);
}

class TunnelConnection extends Duplex {
  readonly #id: number;
  readonly #send: (frame: Buffer, cb?: (err?: Error | null) => void) => void;
  #closed = false;

  constructor(id: number, send: (frame: Buffer, cb?: (err?: Error | null) => void) => void) {
    super({ allowHalfOpen: true });
    this.#id = id;
    this.#send = send;
  }

  override _read(): void {}

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    if (this.#closed) {
      cb(new Error("connection closed"));
      return;
    }
    let offset = 0;
    const next = (err?: Error | null): void => {
      if (err) {
        cb(err);
        return;
      }
      if (offset >= chunk.length) {
        cb();
        return;
      }
      const part = chunk.subarray(offset, offset + MAX_PAYLOAD);
      offset += part.length;
      this.#send(encodeFrame(FRAME.DATA, this.#id, part), next);
    };
    next();
  }

  override _final(cb: (err?: Error | null) => void): void {
    if (this.#closed) {
      cb();
      return;
    }
    this.#send(encodeFrame(FRAME.EOF, this.#id), cb);
  }

  override _destroy(err: Error | null, cb: (err?: Error | null) => void): void {
    if (!this.#closed) {
      this.#closed = true;
      this.#send(encodeFrame(FRAME.CLOSE, this.#id));
    }
    cb(err);
  }

  /** From the shim. */
  deliver(type: number, payload: Buffer): void {
    if (type === FRAME.DATA) this.push(payload);
    else if (type === FRAME.EOF) this.push(null);
    else if (type === FRAME.CLOSE) {
      this.#closed = true;
      this.push(null);
      this.destroy();
    }
  }
}

export interface EgressTunnel {
  /** Resolves with the port the shim listens on once it is ready. */
  readonly ready: Promise<number>;
  /** Live connections. */
  readonly connections: number;
  close(): void;
}

/**
 * Demultiplexes a shim's stdout and writes frames to its stdin. `ready` rejects when the shim
 * exits or sends something malformed before it is ready.
 */
export function attachTunnel(
  io: { stdin: Writable; stdout: Readable },
  onConnection: (conn: Duplex) => void,
): EgressTunnel {
  const conns = new Map<number, TunnelConnection>();
  let buf: Buffer = Buffer.alloc(0);
  let closed = false;
  let resolveReady: (port: number) => void = () => undefined;
  let rejectReady: (err: Error) => void = () => undefined;
  const ready = new Promise<number>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  ready.catch(() => undefined);
  const send = (frame: Buffer, cb?: (err?: Error | null) => void) => {
    if (closed || io.stdin.destroyed) {
      cb?.(new Error("tunnel closed"));
      return;
    }
    io.stdin.write(frame, cb);
  };
  const close = () => {
    if (closed) return;
    closed = true;
    rejectReady(new Error("egress shim exited"));
    for (const c of conns.values()) c.destroy();
    conns.clear();
    io.stdout.off("data", onData);
    io.stdin.end();
  };
  const onData = (chunk: Buffer) => {
    buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
    while (buf.length >= HEADER) {
      const type = buf.readUInt8(0);
      const id = buf.readUInt32BE(1);
      const len = buf.readUInt32BE(5);
      if (len > MAX_FRAME) {
        close();
        return;
      }
      if (buf.length < HEADER + len) break;
      const payload = Buffer.from(buf.subarray(HEADER, HEADER + len));
      buf = buf.subarray(HEADER + len);
      if (type === FRAME.READY) {
        const port = Number(payload.toString("ascii"));
        if (Number.isInteger(port) && port > 0) resolveReady(port);
        continue;
      }
      if (type === FRAME.OPEN) {
        if (conns.has(id)) continue;
        const conn = new TunnelConnection(id, send);
        conns.set(id, conn);
        conn.on("close", () => conns.delete(id));
        onConnection(conn);
        continue;
      }
      conns.get(id)?.deliver(type, payload);
    }
  };
  io.stdout.on("data", onData);
  io.stdout.on("end", close);
  io.stdout.on("close", close);
  io.stdout.on("error", close);
  return {
    ready,
    get connections() {
      return conns.size;
    },
    close,
  };
}
