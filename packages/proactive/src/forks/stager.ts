import type { StagedCall as LoopStagedCall, StagingSink } from "@psyche/protocol";
import { createStager, type StagerDeps } from "../night-shift/stager.ts";

/**
 * `ForkStagingSink` (docs/design/fork-a-plan-2026.md §3.1). It is the Night shift stager with the
 * rows' origin set to one branch (`staged_actions.fork_branch_id`): the same adapters, the same
 * `capture`, `check`, `preview` and `inverse`, the same one-live-item-per-target rule. There is no
 * second allowlist, no second adapter set and no second apply path. Two branches may stage the
 * same target: the rule is per branch because each stager lists only its own branch's rows.
 *
 * On top of the shared pipeline it refuses a call that is not this fork's and this branch's, and
 * every call once the branch is no longer live (cancelled, ended): a cancelled branch's late call
 * records nothing.
 */

export interface ForkStagerDeps extends Omit<StagerDeps, "nightId" | "forkBranchId"> {
  forkId: string;
  branchId: string;
  /** False once the branch has ended or been cancelled: authority is revoked. */
  live: () => boolean;
}

export function createForkStager(deps: ForkStagerDeps): StagingSink {
  const { forkId, branchId, live, ...rest } = deps;
  // `live` is asked again right before the rows are written, after the capture's awaits.
  const inner = createStager({ ...rest, forkBranchId: branchId, beforeWrite: live });
  return {
    async stage(call: LoopStagedCall) {
      if (call.staging.kind !== "fork" || call.staging.forkId !== forkId) {
        deps.onRefused?.({ tool: call.tool, reason: "wrong_fork" });
        return { staged: false };
      }
      if (call.staging.branchId !== branchId) {
        deps.onRefused?.({ tool: call.tool, reason: "wrong_branch" });
        return { staged: false };
      }
      if (!live()) {
        deps.onRefused?.({ tool: call.tool, reason: "branch_not_live" });
        return { staged: false };
      }
      return inner.stage(call);
    },
  };
}
