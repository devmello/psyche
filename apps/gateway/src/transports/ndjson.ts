import { MAX_FRAME_BYTES } from "@psyche/protocol";

/**
 * Newline-delimited JSON framing for Unix-socket nodes (wire spec v1): one UTF-8 JSON frame per
 * line, at most MAX_FRAME_BYTES per frame. Returns complete lines; keeps the remainder buffered.
 */
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
