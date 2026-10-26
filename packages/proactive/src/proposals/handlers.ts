import type { MethodParams, MethodResult, Surface } from "@psyche/protocol";
import type { ProposalService } from "./service.ts";

type ProposalMethod =
  | "proposals.list"
  | "proposals.get"
  | "proposals.approve"
  | "proposals.dismiss"
  | "proposals.undo";

/** The calling device's approval surface (`desktop`, `web`, …): tokens go to that surface only. */
export interface ProposalCaller {
  surface: Surface;
}

export type ProposalHandlers = {
  [M in ProposalMethod]: (
    params: MethodParams<M>,
    caller: ProposalCaller,
  ) => Promise<MethodResult<M>>;
};

const strip = <T extends Record<string, unknown>>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/** `proposals.*` handlers (params validated and scopes checked by the Gateway router). */
export function createProposalHandlers(proposals: ProposalService): ProposalHandlers {
  return {
    "proposals.list": async (p) => proposals.list(strip(p)),
    "proposals.get": async (p) => ({ proposal: proposals.get(p.proposalId) }),
    "proposals.approve": async (p, caller) => {
      const { proposal, issued } = await proposals.approve(p.proposalId);
      const answerToken = issued.answerTokens[caller.surface];
      return {
        proposal,
        approval: issued.approval,
        ...(answerToken === undefined ? {} : { answerToken }),
      };
    },
    "proposals.dismiss": async (p) => ({ proposal: proposals.dismiss(p.proposalId) }),
    "proposals.undo": async (p) => ({ proposal: proposals.undo(p.proposalId) }),
  };
}
