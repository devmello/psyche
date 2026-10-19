import type { CliStream } from "./cli.ts";
import { KILL_GRACE_MS, PTY_TRANSCRIPT_BYTES } from "./limits.ts";
import { AsyncQueue } from "./sync.ts";

/** Options for `ContainerSandboxRunner.openPty`. */
export interface PtyOptions {
  /** Default `["bash", "-l"]`. */
  argv?: string[];
  /** Default `/workspace`. */
  cwd?: string;
  cols?: number;
  rows?: number;
  /** Merged over `TERM=xterm-256color`; sent over stdin, never in host argv. */
  env?: Record<string, string>;
}

/**
 * An interactive terminal inside the sandbox (architecture §9, security §5.4). The PTY is
 * allocated in the container by a relay, so output is the raw terminal byte stream.
 */
export interface SandboxPty {
  readonly id: string;
  readonly sandboxId: string;
  /** Raw terminal output; ends when the process exits. Single consumer. */
  readonly output: AsyncIterable<Uint8Array>;
  /** Resolves once the relay has exited. `exitCode` is `null` when it was killed. */
  readonly exit: Promise<{ exitCode: number | null }>;
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  /** Hangs up (SIGHUP), then kills the process group after the grace period. */
  close(): Promise<void>;
  /** The last 128 KB of output, kept for the receipt (security §5.4). */
  transcript(): string;
}

export const FRAME_DATA = 0;
export const FRAME_RESIZE = 1;
export const FRAME_ENV = 2;

/** `[type u8][length u32 BE][payload]`, the relay's stdin framing (scripts.ts PTY_RELAY). */
export function encodeFrame(type: number, payload: Uint8Array): Buffer {
  const header = Buffer.alloc(5);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

export function resizePayload(cols: number, rows: number): Buffer {
  const p = Buffer.alloc(4);
  p.writeUInt16BE(clampDim(cols), 0);
  p.writeUInt16BE(clampDim(rows), 2);
  return p;
}

export function clampDim(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.min(Math.max(Math.trunc(n), 1), 1000);
}

/** Keeps the newest `max` bytes. */
export class TailBuffer {
  #chunks: Buffer[] = [];
  #size = 0;
  readonly #max: number;

  constructor(max = PTY_TRANSCRIPT_BYTES) {
    this.#max = max;
  }

  push(chunk: Buffer): void {
    this.#chunks.push(chunk);
    this.#size += chunk.length;
    while (this.#size > this.#max && this.#chunks.length > 0) {
      const head = this.#chunks[0] as Buffer;
      const excess = this.#size - this.#max;
      if (head.length <= excess) {
        this.#chunks.shift();
        this.#size -= head.length;
      } else {
        this.#chunks[0] = head.subarray(excess);
        this.#size -= excess;
      }
    }
  }

  toString(): string {
    return Buffer.concat(this.#chunks, this.#size).toString("utf8");
  }
}

function settledWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    p.then(
      () => {
        clearTimeout(t);
        resolve(true);
      },
      () => {
        clearTimeout(t);
        resolve(true);
      },
    );
  });
}

export function createPtySession(params: {
  id: string;
  sandboxId: string;
  stream: CliStream;
  envPairs: string[];
  killGroup: (signal: "TERM" | "KILL") => Promise<void>;
  onExit: () => void;
}): SandboxPty {
  const { stream } = params;
  const tail = new TailBuffer();
  const queue = new AsyncQueue<Uint8Array>({
    onPressure: (paused) => (paused ? stream.stdout.pause() : stream.stdout.resume()),
  });
  stream.stdout.on("data", (chunk: Buffer) => {
    tail.push(chunk);
    queue.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.length));
  });
  // Relay diagnostics (exec failures) are terminal output for the user too.
  stream.stderr.on("data", (chunk: Buffer) => {
    tail.push(chunk);
    queue.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.length));
  });
  const exit = stream.exited.then(({ exitCode }) => {
    queue.end();
    params.onExit();
    return { exitCode };
  });
  const envPayload = Buffer.from(params.envPairs.map((p) => `${p}\0`).join(""), "utf8");
  stream.stdin.write(encodeFrame(FRAME_ENV, envPayload));
  let closing: Promise<void> | undefined;

  return {
    id: params.id,
    sandboxId: params.sandboxId,
    output: queue,
    exit,
    write(data) {
      if (closing !== undefined) return;
      const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
      stream.stdin.write(encodeFrame(FRAME_DATA, bytes));
    },
    resize(cols, rows) {
      if (closing !== undefined) return;
      stream.stdin.write(encodeFrame(FRAME_RESIZE, resizePayload(cols, rows)));
    },
    close() {
      closing ??= (async () => {
        stream.stdin.end();
        if (await settledWithin(exit, KILL_GRACE_MS)) return;
        await params.killGroup("KILL");
        if (await settledWithin(exit, 1_000)) return;
        stream.kill("SIGKILL");
        await exit;
      })();
      return closing;
    },
    transcript: () => tail.toString(),
  };
}
