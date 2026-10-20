import type { Duplex, Readable, Writable } from "node:stream";
import { MAX_FRAME_BYTES } from "@psyche/protocol";
import { ChannelEvents, type FrameChannel } from "./channel.ts";

/** Splits a UTF-8 byte stream into lines; refuses a line longer than `MAX_FRAME_BYTES`. */
export class NdjsonDecoder {
  #buffer = "";

  push(chunk: string): string[] {
    this.#buffer += chunk;
    const lines: string[] = [];
    let index = this.#buffer.indexOf("\n");
    while (index !== -1) {
      const line = this.#buffer.slice(0, index).replace(/\r$/, "");
      this.#buffer = this.#buffer.slice(index + 1);
      if (line.length > 0) lines.push(line);
      index = this.#buffer.indexOf("\n");
    }
    if (Buffer.byteLength(this.#buffer) > MAX_FRAME_BYTES) {
      this.#buffer = "";
      throw new Error("frame exceeds MAX_FRAME_BYTES");
    }
    return lines;
  }
}

/**
 * NDJSON over a readable/writable pair: a Unix or TCP socket (one duplex) or a bridge process's
 * stdout/stdin. `onEnd` lets the owner add cleanup (killing a bridge process).
 */
export class NdjsonChannel implements FrameChannel {
  readonly describe: string;
  readonly #events = new ChannelEvents();
  readonly #out: Writable;
  readonly #teardown: () => void;

  constructor(
    describe: string,
    input: Readable,
    output: Writable,
    teardown: () => void = () => {},
  ) {
    this.describe = describe;
    this.#out = output;
    this.#teardown = teardown;
    const decoder = new NdjsonDecoder();
    input.setEncoding("utf8");
    input.on("data", (chunk: string) => {
      let lines: string[];
      try {
        lines = decoder.push(chunk);
      } catch (err) {
        this.close((err as Error).message);
        return;
      }
      for (const line of lines) this.#events.emitFrame(line);
    });
    input.on("end", () => this.close("peer closed the stream"));
    input.on("error", (err) => this.close(err.message));
    output.on("error", (err) => this.close(err.message));
  }

  static fromDuplex(describe: string, stream: Duplex): NdjsonChannel {
    return new NdjsonChannel(describe, stream, stream, () => stream.destroy());
  }

  send(frame: string): void {
    if (this.#events.closed) return;
    this.#out.write(`${frame}\n`);
  }

  onFrame(listener: (frame: string) => void): void {
    this.#events.onFrame(listener);
  }

  onClose(listener: (reason: string) => void): void {
    this.#events.onClose(listener);
  }

  close(reason = "closed"): void {
    if (this.#events.closed) return;
    this.#events.emitClose(reason);
    this.#teardown();
  }
}
