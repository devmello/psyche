import type { PsychePermissionBroker } from "@psyche/permissions";
import type { ApprovalRequest, Notification, Notifier } from "@psyche/protocol";

/**
 * The automation digest (Deferred). An unattended run that asks for an action parks its approval
 * with nobody there to answer. Each such card used to announce itself, so a busy automation
 * raised many cards and a quiet one raised none. This keeps ONE notice open for all of them:
 * raised when the first one waits, refreshed at most once per window, and resolved when none are
 * left. It changes no approval: which actions ask, their expiry and their answer path are the
 * broker's, and a card past its expiry is never counted (so it cannot be answered late either).
 */
export const DIGEST_DEDUPE_KEY = "approvals:deferred-digest";
export const DIGEST_ROUTE = "/agent/approvals";
export const DIGEST_BODY = "Open Approvals to approve or decline them";
/** How often the digest may be re-raised while actions keep waiting ("a few hours"). */
export const DIGEST_WINDOW_MS = 4 * 60 * 60 * 1000;

export interface DeferredDigestOptions {
  broker: Pick<PsychePermissionBroker, "list">;
  notifier: Pick<Notifier, "notify" | "resolve" | "list">;
  /** True for a card an unattended run is waiting on (the same test the broker uses). */
  isDeferred: (approval: ApprovalRequest) => boolean | Promise<boolean>;
  clock: { now(): number };
  windowMs?: number;
}

export function digestTitle(count: number): string {
  return count === 1
    ? "1 action is waiting from your automations"
    : `${count} actions are waiting from your automations`;
}

export class DeferredDigest {
  readonly #o: DeferredDigestOptions;
  readonly #windowMs: number;
  #openId: string | undefined;
  #raisedAt: number | undefined;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: DeferredDigestOptions) {
    this.#o = options;
    this.#windowMs = options.windowMs ?? DIGEST_WINDOW_MS;
  }

  /**
   * Brings the digest in line with the waiting actions. Safe to call on every approval event and
   * when the owner returns: runs are serialised, and a notice is only sent when none is open or
   * the window has passed.
   */
  refresh(): Promise<number> {
    const run = this.#queue.then(() => this.#refresh());
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #refresh(): Promise<number> {
    const now = this.#o.clock.now();
    const pending = (await this.#o.broker.list()).filter(
      (a) => a.status === "pending" && now < Date.parse(a.expiresAt),
    );
    let waiting = 0;
    for (const a of pending) if (await this.#o.isDeferred(a)) waiting += 1;
    if (waiting === 0) {
      await this.#resolveOpen();
      return 0;
    }
    if (this.#openId !== undefined && this.#raisedAt !== undefined) {
      if (now - this.#raisedAt < this.#windowMs) return waiting;
    }
    const n: Notification = await this.#o.notifier.notify({
      kind: "approval",
      title: digestTitle(waiting),
      body: DIGEST_BODY,
      route: DIGEST_ROUTE,
      dedupeKey: DIGEST_DEDUPE_KEY,
    });
    this.#openId = n.id;
    this.#raisedAt = now;
    return waiting;
  }

  /** Closes the open digest. After a restart it is found by its route and body instead. */
  async #resolveOpen(): Promise<void> {
    if (this.#openId !== undefined) {
      const id = this.#openId;
      this.#openId = undefined;
      this.#raisedAt = undefined;
      await this.#o.notifier.resolve(id).catch(() => undefined);
      return;
    }
    const open = await this.#o.notifier.list({ unresolvedOnly: true, kind: "approval" });
    for (const n of open) {
      if (n.route === DIGEST_ROUTE && n.body === DIGEST_BODY && n.approvalId == null) {
        await this.#o.notifier.resolve(n.id).catch(() => undefined);
      }
    }
  }
}
