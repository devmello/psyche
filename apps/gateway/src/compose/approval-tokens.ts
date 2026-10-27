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
  /** Approvals settled before `requestApproval` returned (bounded), so no token outlives them. */
  readonly #settled = new Set<string>();
  #reissued: IssuedApproval[] = [];

  remember(issued: IssuedApproval): void {
    if (this.#settled.delete(issued.approval.id)) return;
    this.#tokens.set(issued.approval.id, { ...issued.answerTokens });
  }

  forget(approvalId: string): void {
    if (!this.#tokens.delete(approvalId)) {
      this.#settled.add(approvalId);
      if (this.#settled.size > 1000) {
        const oldest = this.#settled.values().next().value;
        if (oldest !== undefined) this.#settled.delete(oldest);
      }
    }
  }

  tokenFor(approvalId: string, surface: Surface): string | undefined {
    return this.#tokens.get(approvalId)?.[surface];
  }

  /** The approvals re-issued at boot, handed once to the worker pool (docs/archive/status/s04.md). */
  takeReissued(): IssuedApproval[] {
    const out = this.#reissued;
    this.#reissued = [];
    return out;
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
        if (key === "requestBatch") {
          return async (...args: Parameters<PsychePermissionBroker["requestBatch"]>) => {
            const issued = await target.requestBatch(...args);
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
