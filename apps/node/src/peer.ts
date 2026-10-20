import {
  errRes,
  type Frame,
  okRes,
  PsycheError,
  parseFrame,
  reqFrame,
  serializeFrame,
} from "@psyche/protocol";
import type { FrameChannel } from "./transports/channel.ts";

export type RequestHandler = (method: string, params: unknown) => Promise<unknown> | unknown;

interface Pending {
  resolve(payload: unknown): void;
  reject(err: PsycheError): void;
  timer: NodeJS.Timeout;
}

/**
 * Both directions of the wire protocol on one channel: our `req`s with `res` correlation, and
 * the Gateway's `req`s (`node.invoke`) answered through `handler`. Gateway `event` frames carry
 * nothing a node needs today and are dropped.
 */
export class FramePeer {
  readonly channel: FrameChannel;
  readonly #pending = new Map<string, Pending>();
  #handler: RequestHandler = (method) => {
    throw new PsycheError("unknown_method", `unknown method ${method}`);
  };
  #nextId = 0;
  #closed = false;

  constructor(channel: FrameChannel) {
    this.channel = channel;
    channel.onFrame((raw) => this.#onFrame(raw));
    channel.onClose((reason) => {
      this.#closed = true;
      for (const [id, p] of this.#pending) {
        clearTimeout(p.timer);
        this.#pending.delete(id);
        p.reject(new PsycheError("unavailable", `connection closed: ${reason}`));
      }
    });
  }

  get closed(): boolean {
    return this.#closed;
  }

  setHandler(handler: RequestHandler): void {
    this.#handler = handler;
  }

  request(method: string, params?: unknown, timeoutMs = 30_000): Promise<unknown> {
    if (this.#closed) {
      return Promise.reject(new PsycheError("unavailable", "connection closed"));
    }
    const id = `n${this.#nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new PsycheError("timeout", `${method} timed out`, { retryable: true }));
      }, timeoutMs);
      timer.unref();
      this.#pending.set(id, { resolve, reject, timer });
      this.channel.send(serializeFrame(reqFrame(id, method, params)));
    });
  }

  close(reason?: string): void {
    this.channel.close(reason);
  }

  #send(frame: Frame): void {
    this.channel.send(serializeFrame(frame));
  }

  #onFrame(raw: string): void {
    let frame: Frame;
    try {
      frame = parseFrame(raw);
    } catch (err) {
      const e = PsycheError.from(err);
      const id = (e.details as { id?: unknown } | undefined)?.id;
      if (typeof id === "string") this.#send(errRes(id, e));
      return;
    }
    if (frame.type === "res") {
      const p = this.#pending.get(frame.id);
      if (!p) return;
      this.#pending.delete(frame.id);
      clearTimeout(p.timer);
      if (frame.ok) p.resolve(frame.payload);
      else
        p.reject(
          new PsycheError(frame.error.code, frame.error.message, {
            ...(frame.error.details ? { details: frame.error.details } : {}),
            ...(frame.error.retryable !== undefined ? { retryable: frame.error.retryable } : {}),
          }),
        );
      return;
    }
    if (frame.type === "req") {
      const { id, method, params } = frame;
      Promise.resolve()
        .then(() => this.#handler(method, params))
        .then(
          (payload) => this.#send(okRes(id, payload)),
          (err) => this.#send(errRes(id, PsycheError.from(err))),
        );
    }
  }
}
