import type { IssuedApproval } from "@psyche/protocol";

/**
 * The away chat (decision D3): a card raised from the Mac or iPhone reaches the one chat the owner
 * picked only after no paired device has had owner activity for `awayAfterMs`. Delivery is held
 * back until then; while the card is still open it is checked again at each moment the window
 * could have elapsed, so a card raised during activity still reaches the chat once the owner has
 * been gone long enough, and a card answered in time sends nothing.
 */
export interface AwayRouterOptions {
  now: () => number;
  /** Epoch ms of the owner's latest activity on any paired device. */
  activityAt: () => number;
  awayAfterMs: () => number;
  /** False once the approval is answered, expired or cancelled. */
  isOpen: (approvalId: string) => Promise<boolean>;
  /** Sends the card to the away surfaces only. */
  deliver: (issued: IssuedApproval) => Promise<void>;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  onError?: (err: unknown) => void;
}

export class AwayRouter {
  readonly #o: AwayRouterOptions;
  readonly #timers = new Map<string, unknown>();

  constructor(options: AwayRouterOptions) {
    this.#o = options;
  }

  /** Holds `issued` (its tokens are the away surfaces' only) until the owner has been away. */
  hold(issued: IssuedApproval): void {
    const id = issued.approval.id;
    const check = async (): Promise<void> => {
      this.#timers.delete(id);
      try {
        if (!(await this.#o.isOpen(id))) return;
        const idle = this.#o.now() - this.#o.activityAt();
        const after = this.#o.awayAfterMs();
        if (idle >= after) {
          await this.#o.deliver(issued);
          return;
        }
        this.#arm(id, after - idle + 250, check);
      } catch (err) {
        this.#o.onError?.(err);
      }
    };
    this.#arm(id, 0, check);
  }

  #arm(id: string, ms: number, fn: () => Promise<void>): void {
    const set = this.#o.setTimer ?? ((f, t) => setTimeout(f, t).unref());
    this.#timers.set(
      id,
      set(() => void fn(), Math.max(0, ms)),
    );
  }

  stop(): void {
    const clear = this.#o.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
    for (const h of this.#timers.values()) clear(h);
    this.#timers.clear();
  }
}
