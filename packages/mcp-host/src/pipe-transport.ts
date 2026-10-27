import type { Readable, Writable } from "node:stream";
import type { JSONRPCMessage, ReadBuffer, Transport } from "@modelcontextprotocol/client";
import { loadMcpSdk } from "./sdk.ts";

/**
 * MCP over a pair of byte pipes (newline-delimited JSON-RPC, as stdio), for servers whose
 * process the host does not spawn itself: a stdio server inside the sandbox container, reached
 * through the runner's `openStdio`. Closing the transport ends stdin and kills the process.
 */
export interface PipeProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly exited: Promise<unknown>;
  kill(signal?: "TERM" | "KILL"): Promise<void>;
}

/** Messages larger than this close the connection (a server cannot exhaust host memory). */
export const PIPE_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

export class PipeTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  readonly #io: PipeProcess;
  #buffer: ReadBuffer | undefined;
  #started = false;
  #closed = false;

  constructor(io: PipeProcess) {
    this.#io = io;
  }

  async start(): Promise<void> {
    if (this.#started) throw new Error("PipeTransport already started");
    this.#started = true;
    const { ReadBuffer } = await loadMcpSdk();
    const buffer = new ReadBuffer({ maxBufferSize: PIPE_MAX_MESSAGE_BYTES });
    this.#buffer = buffer;
    this.#io.stdout.on("data", (chunk: Buffer) => {
      try {
        buffer.append(chunk);
      } catch (err) {
        this.onerror?.(err instanceof Error ? err : new Error(String(err)));
        void this.close();
        return;
      }
      for (;;) {
        let message: JSONRPCMessage | null;
        try {
          message = buffer.readMessage();
        } catch (err) {
          // A malformed line: report it and keep reading the next one.
          this.onerror?.(err instanceof Error ? err : new Error(String(err)));
          continue;
        }
        if (message === null) break;
        this.onmessage?.(message);
      }
    });
    this.#io.stdout.on("error", (err: Error) => this.onerror?.(err));
    this.#io.stdin.on("error", (err: Error) => this.onerror?.(err));
    void this.#io.exited.then(
      () => this.#finish(),
      () => this.#finish(),
    );
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.#closed) throw new Error("PipeTransport is closed");
    const { serializeMessage } = await loadMcpSdk();
    const data = serializeMessage(message);
    await new Promise<void>((resolve, reject) => {
      this.#io.stdin.write(data, (err) => (err ? reject(err) : resolve()));
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#io.stdin.end();
    await this.#io.kill("TERM").catch(() => undefined);
    this.#finish();
  }

  #finish(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#buffer?.clear();
    this.onclose?.();
  }
}
