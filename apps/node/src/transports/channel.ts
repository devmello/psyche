/**
 * One bidirectional frame stream to the Gateway: a WebSocket (one frame per text message) or a
 * byte stream framed as NDJSON (the Gateway's node socket, a vsock bridge). Frames are opaque
 * strings here; `FramePeer` parses and validates them.
 */
export interface FrameChannel {
  /** Human-readable endpoint for logs (never contains secrets). */
  readonly describe: string;
  send(frame: string): void;
  onFrame(listener: (frame: string) => void): void;
  /** Fires exactly once, after which `send` is a no-op. */
  onClose(listener: (reason: string) => void): void;
  close(reason?: string): void;
}

/** Opens a channel; rejects when the endpoint is unreachable. */
export type ChannelFactory = () => Promise<FrameChannel>;

/** Small helper so channel implementations share close-once semantics. */
export class ChannelEvents {
  #frame: ((frame: string) => void)[] = [];
  #close: ((reason: string) => void)[] = [];
  #closed = false;

  get closed(): boolean {
    return this.#closed;
  }

  onFrame(listener: (frame: string) => void): void {
    this.#frame.push(listener);
  }

  onClose(listener: (reason: string) => void): void {
    this.#close.push(listener);
  }

  emitFrame(frame: string): void {
    if (this.#closed) return;
    for (const l of this.#frame) l(frame);
  }

  emitClose(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const l of this.#close) l(reason);
  }
}
