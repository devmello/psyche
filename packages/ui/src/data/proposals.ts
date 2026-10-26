import type { ActionProposal } from "@psyche/protocol";
import { useCallback } from "react";
import { type LoadState, useLoader } from "./hooks.ts";
import { useStore, useStoreState } from "./provider.tsx";
import { put } from "./state.ts";

/**
 * Batch proposals' data layer (docs/workflows/mail-and-meetings-2026.md §8.1, §7.2): one proposal
 * from `proposals.get`, kept live by `proposal.updated`, with approve (which issues the one
 * `batch` approval and keeps its answer token), dismiss and undo (which returns the inverse
 * proposal, pending its own approval).
 */
export function useProposal(proposalId: string | null): LoadState & {
  proposal: ActionProposal | null;
  approve: () => Promise<ActionProposal>;
  dismiss: () => Promise<void>;
  undo: () => Promise<ActionProposal>;
} {
  const store = useStore();
  const proposal = useStoreState((s) =>
    proposalId === null ? undefined : s.proposals[proposalId],
  );
  const load = useLoader(proposalId === null ? null : `proposal:${proposalId}`, async (st) => {
    if (proposalId === null) return;
    const version = st.version();
    const res = await st.call("proposals.get", { proposalId });
    st.update((s) =>
      (s.touched[`proposals:${proposalId}`] ?? -1) > version
        ? s
        : { ...s, proposals: { ...s.proposals, [proposalId]: res.proposal } },
    );
  });

  const keep = useCallback(
    (p: ActionProposal) =>
      store.update((s) => ({ ...s, proposals: { ...s.proposals, [p.id]: p } })),
    [store],
  );

  const approve = useCallback(async () => {
    if (proposalId === null) throw new Error("no proposal");
    const res = await store.call("proposals.approve", { proposalId });
    store.update((s) => ({
      ...put(s, "approvals", res.approval),
      answerTokens:
        res.answerToken === undefined
          ? s.answerTokens
          : { ...s.answerTokens, [res.approval.id]: res.answerToken },
      proposals: { ...s.proposals, [res.proposal.id]: res.proposal },
    }));
    return res.proposal;
  }, [store, proposalId]);

  const dismiss = useCallback(async () => {
    if (proposalId === null) return;
    keep((await store.call("proposals.dismiss", { proposalId })).proposal);
  }, [store, proposalId, keep]);

  const undo = useCallback(async () => {
    if (proposalId === null) throw new Error("no proposal");
    const { proposal: inverse } = await store.call("proposals.undo", { proposalId });
    keep(inverse);
    return inverse;
  }, [store, proposalId, keep]);

  return { ...load, proposal: proposal ?? null, approve, dismiss, undo };
}
