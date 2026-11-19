import type { PsychePermissionBroker } from "@psyche/permissions";
import type { ApprovalRequest, Notification, Notifier } from "@psyche/protocol";

/**
 * The automation digest (Deferred). An unattended run that asks for an action parks its approval
 * with nobody there to answer. Instead of one notice per card, ONE notice stays open for all of
 * them: raised when the first one waits, its count updated in place while it is open, raised
 * again when a card arrives that the owner has not been told about (after they dismissed it, say),
 * and resolved when none are left. It changes no approval: which actions ask, their expiry and
 * their answer path are the broker's, and a card past its expiry is never counted.
 */
export const DIGEST_DEDUPE_KEY = "approvals:deferred-digest";
export const DIGEST_ROUTE = "/agent/approvals";
export const DIGEST_TITLE_KEY = "notice.approvals.digest.title";
export const DIGEST_BODY_KEY = "notice.approvals.digest.body";
/** English fallback; clients word it from `message` (packages/ui notices.ts). */
export const DIGEST_BODY = "Open Approvals to approve or decline them";
/** After this long, a dismissed digest comes back even with no new card ("a few hours"). */
export const DIGEST_WINDOW_MS = 4 * 60 * 60 * 1000;

export interface DeferredDigestOptions {
  broker: Pick<PsychePermissionBroker, "list">;
  notifier: Pick<Notifier, "notify" | "resolve" | "list">;
  /** True for a card an unattended run is waiting on (the same test the broker uses). */
  isDeferred: (approval: ApprovalRequest) => boolean | Promise<boolean>;
  clock: { now(): number };
  windowMs?: number;
}

/** English fallback of the title (the same text as `notice.approvals.digest.title`). */
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
  /** Cards the owner has been told about by a raised (delivered) digest. */
  #announced = new Set<string>();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: DeferredDigestOptions) {
    this.#o = options;
    this.#windowMs = options.windowMs ?? DIGEST_WINDOW_MS;
  }

  /**
   * Brings the digest in line with the waiting actions. Safe to call on every approval event:
   * runs are serialised, an open digest is updated in place (no second alert), and a new alert
   * goes out only when no digest is open and a card is new to the owner or the window has passed.
   */
  refresh(): Promise<number> {
    const run = this.#queue.then(() => this.#refresh());
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #refresh(): Promise<number> {
    const now = this.#o.clock.now();
    const pending = (await this.#o.broker.list({ status: "pending" })).filter(
      (a) => a.status === "pending" && now < Date.parse(a.expiresAt),
    );
    const waiting: string[] = [];
    for (const a of pending) if (await this.#o.isDeferred(a)) waiting.push(a.id);
    if (waiting.length === 0) {
      await this.#resolveOpen();
      this.#announced.clear();
      return 0;
    }
    // Gone from the set: answered or expired cards are no longer "announced".
    for (const id of [...this.#announced]) if (!waiting.includes(id)) this.#announced.delete(id);
    const open = this.#openId !== undefined && (await this.#isOpen(this.#openId));
    if (!open) {
      this.#openId = undefined;
      const fresh = waiting.some((id) => !this.#announced.has(id));
      const windowPassed = this.#raisedAt === undefined || now - this.#raisedAt >= this.#windowMs;
      // Dismissed with nothing new in it: the cards stay in Approvals, without a repeat alert.
      if (!fresh && !windowPassed) return waiting.length;
    }
    // With one open, the same dedupe key updates that notice in place (its count) and does not
    // alert again; with none open, this raises (delivers) a new one.
    const n: Notification = await this.#o.notifier.notify({
      kind: "approval",
      title: digestTitle(waiting.length),
      body: DIGEST_BODY,
      message: {
        titleKey: DIGEST_TITLE_KEY,
        bodyKey: DIGEST_BODY_KEY,
        params: { count: waiting.length },
      },
      route: DIGEST_ROUTE,
      dedupeKey: DIGEST_DEDUPE_KEY,
    });
    if (!open) this.#raisedAt = now;
    this.#openId = n.id;
    for (const id of waiting) this.#announced.add(id);
    return waiting.length;
  }

  async #isOpen(id: string): Promise<boolean> {
    const open = await this.#o.notifier.list({ unresolvedOnly: true, kind: "approval" });
    return open.some((n) => n.id === id && n.resolvedAt == null);
  }

  /** Closes the open digest. After a restart it is found by its route and message instead. */
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
      if (
        n.route === DIGEST_ROUTE &&
        n.approvalId == null &&
        (n.message?.titleKey === DIGEST_TITLE_KEY || n.body === DIGEST_BODY)
      ) {
        await this.#o.notifier.resolve(n.id).catch(() => undefined);
      }
    }
  }
}
