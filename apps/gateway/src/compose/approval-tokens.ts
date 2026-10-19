import type { PsychePermissionBroker } from "@psyche/permissions";
import type { IssuedApproval, Surface } from "@psyche/protocol";

/**
 * Delivery of single-use answer tokens (security §3.7). The broker stores only token hashes, so
 * the plaintext exists once, in the `IssuedApproval` that `requestApproval` / `reissue` return to
 * the agent loop or the worker pool. The composition root keeps them here, in memory only, until
 * the approval is decided, expires or is invalidated, and hands a device the token of its own
 * surface through `approvals.get` / `approvals.list` (never another surface's).
 */
export class ApprovalTokens {
  readonly #tokens = new Map<string, Record<Surface, string>>();
  #reissued: IssuedApproval[] = [];

  remember(issued: IssuedApproval): void {
    this.#tokens.set(issued.approval.id, { ...issued.answerTokens });
  }

  forget(approvalId: string): void {
    this.#tokens.delete(approvalId);
  }

  tokenFor(approvalId: string, surface: Surface): string | undefined {
    return this.#tokens.get(approvalId)?.[surface];
  }

  /** The approvals re-issued at boot (the worker pool needs them, docs/status/s04.md). */
  get reissued(): IssuedApproval[] {
    return this.#reissued;
  }

  /**
   * A view of the broker that records every issued token. Every consumer (loop, worker pool,
   * scheduler, Gateway) gets this view, so no token is issued past it.
   */
  wrap(broker: PsychePermissionBroker): PsychePermissionBroker {
    return new Proxy(broker, {
      get: (target, key) => {
        if (key === "requestApproval") {
          return async (...args: Parameters<PsychePermissionBroker["requestApproval"]>) => {
            const issued = await target.requestApproval(...args);
            this.remember(issued);
            return issued;
          };
        }
        if (key === "reissue") {
          return async () => {
            const issued = await target.reissue();
            for (const i of issued) this.remember(i);
            this.#reissued = issued;
            return issued;
          };
        }
        const v = Reflect.get(target, key, target) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
  }
}
