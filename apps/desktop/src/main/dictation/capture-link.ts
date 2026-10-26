import type { DictationCapture } from "./controller.ts";

/**
 * Main's half of the HUD microphone (issue #611). Every command carries an id and the HUD
 * answers it with `{id, ok, open}`, where `open` says whether any microphone track is still live
 * afterwards. macOS keeps the orange indicator on while one is, so main never trusts silence:
 *
 * - a `stop` the HUD does not confirm within `stopTimeoutMs` (2 s), or confirms with
 *   `open: true`, force-releases (the HUD window is destroyed, which ends its renderer and every
 *   stream it held; the next session makes a fresh one);
 * - a `start` that times out or fails with a stream still open force-releases too;
 * - a `stop` sent while a `start` is still waiting for `getUserMedia` makes that start fail
 *   (the HUD drops the stream it gets), so an early release can never leave a stream behind.
 */

export interface CaptureCommand {
  command: "start" | "stop";
  id: number;
}

export interface CaptureAck {
  id: number;
  ok: boolean;
  open: boolean;
}

export interface CaptureLinkOptions {
  /** Sends a command to the HUD; false when there is no HUD to send to. */
  send: (command: CaptureCommand) => boolean;
  /** Ends every stream the HUD may hold (destroys its window). */
  forceRelease: (reason: string) => void;
  warn?: (message: string) => void;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
  setTimer?: (fn: () => void, ms: number) => () => void;
}

export function parseCaptureAck(v: unknown): CaptureAck | null {
  const r = v as { id?: unknown; ok?: unknown; open?: unknown } | null;
  if (typeof r?.id !== "number" || !Number.isInteger(r.id)) return null;
  return { id: r.id, ok: r.ok === true, open: r.open === true };
}

export class CaptureLink implements DictationCapture {
  readonly #o: Required<Pick<CaptureLinkOptions, "startTimeoutMs" | "stopTimeoutMs" | "setTimer">> &
    CaptureLinkOptions;
  #next = 0;
  readonly #pending = new Map<number, (ack: CaptureAck | null) => void>();
  /** A start was sent and not yet followed by a confirmed stop. */
  #capturing = false;

  constructor(opts: CaptureLinkOptions) {
    this.#o = {
      startTimeoutMs: 3_000,
      stopTimeoutMs: 2_000,
      setTimer: (fn, ms) => {
        const t = setTimeout(fn, ms);
        return () => clearTimeout(t);
      },
      ...opts,
    };
  }

  /** True between a start and its confirmed stop (or a force release). */
  get capturing(): boolean {
    return this.#capturing;
  }

  /** An `{id, ok, open}` from the HUD. */
  onAck(ack: CaptureAck): void {
    const resolve = this.#pending.get(ack.id);
    if (!resolve) return;
    this.#pending.delete(ack.id);
    resolve(ack);
  }

  async start(): Promise<void> {
    this.#capturing = true;
    const ack = await this.#request("start", this.#o.startTimeoutMs);
    if (ack?.ok) return;
    if (ack === null) this.#force("the HUD did not confirm the microphone in time");
    else if (ack.open) this.#force("a failed start left a microphone stream open");
    else this.#capturing = false;
    throw new Error("microphone unavailable");
  }

  async stop(): Promise<void> {
    if (!this.#capturing) return;
    const ack = await this.#request("stop", this.#o.stopTimeoutMs);
    if (ack === null) this.#force("the HUD did not confirm the microphone was released");
    else if (ack.open) this.#force("the HUD still holds a microphone stream after stop");
    else this.#capturing = false;
  }

  /** The HUD went away (closed, crashed, destroyed): nothing can still be capturing. */
  reset(): void {
    this.#capturing = false;
    for (const resolve of this.#pending.values()) resolve(null);
    this.#pending.clear();
  }

  #request(command: CaptureCommand["command"], timeoutMs: number): Promise<CaptureAck | null> {
    const id = ++this.#next;
    return new Promise((resolve) => {
      let cancel = () => {};
      const done = (ack: CaptureAck | null) => {
        cancel();
        this.#pending.delete(id);
        resolve(ack);
      };
      this.#pending.set(id, done);
      if (!this.#o.send({ command, id })) return done(null);
      cancel = this.#o.setTimer(() => done(null), timeoutMs);
    });
  }

  #force(reason: string): void {
    this.#o.warn?.(`releasing the microphone: ${reason}`);
    this.#o.forceRelease(reason);
    this.reset();
  }
}
