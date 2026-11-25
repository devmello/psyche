import type { Message, PlanFork, PlanForkBranch, StagedAction } from "@psyche/protocol";
import { createContext, useContext, useEffect, useState, useSyncExternalStore } from "react";
import { type useCall, useGatewayQuery, useStore } from "../data/index.ts";
import { type ApprovalMismatch, checkApproval, type TakeSelection } from "./model.ts";

type Call = ReturnType<typeof useCall>;

/** One fork with its branches, and the live step of each running branch (`planFork.updated`). */
export function usePlanFork(forkId: string): {
  loading: boolean;
  error: boolean;
  fork: PlanFork | null;
  branches: PlanForkBranch[];
  steps: Record<string, string>;
  reload: () => void;
} {
  const store = useStore();
  const q = useGatewayQuery("planForks.get", { forkId });
  const [steps, setSteps] = useState<Record<string, string>>({});
  useEffect(
    () =>
      store.client.subscribe((e) => {
        if (e.event !== "planFork.updated" || e.payload.forkId !== forkId) return;
        setSteps(
          Object.fromEntries(
            e.payload.branches.flatMap((b) => (b.step === undefined ? [] : [[b.id, b.step]])),
          ),
        );
      }),
    [store, forkId],
  );
  return {
    loading: q.loading && q.data === undefined,
    error: q.error != null && q.data === undefined,
    fork: q.data?.fork ?? null,
    branches: q.data?.branches ?? [],
    steps,
    reload: q.reload,
  };
}

/** The prepared items of one branch, for the Take sheet. */
export function useForkStaged(
  forkId: string,
  branchId: string,
  enabled: boolean,
): { loading: boolean; error: boolean; items: StagedAction[] } {
  const q = useGatewayQuery("planForks.staged", { forkId, branchId }, { enabled });
  return {
    loading: q.loading && q.data === undefined,
    error: q.error != null && q.data === undefined,
    items: q.data?.items ?? [],
  };
}

export type TakeOutcome =
  /** Nothing was ticked: the plan was taken at once. */
  | { kind: "taken" }
  /** The owner's tap was sent and the Gateway approved it. */
  | { kind: "applied" }
  /** The Gateway refused some items; the rest may still have been applied. */
  | { kind: "refused"; items: { itemId: string; reason: string }[]; applied: boolean }
  /** The card did not match what was ticked: nothing was answered. */
  | { kind: "mismatch"; reason: ApprovalMismatch }
  | { kind: "declined" };

/**
 * `planForks.take` then, only if the card's item set equals the selection, `approvals.answer`
 * (docs/design/fork-a-plan-2026.md §3.4 step 3). A mismatch answers nothing.
 */
export async function takePlan(
  call: Call,
  args: { forkId: string; branchId: string; selection: TakeSelection; continue: boolean },
): Promise<TakeOutcome> {
  const res = await call("planForks.take", {
    forkId: args.forkId,
    branchId: args.branchId,
    items: [...args.selection.items],
    sends: [...args.selection.sends],
    continue: args.continue,
  });
  const refused = res.refused;
  if (res.approval === undefined) {
    return refused.length > 0
      ? { kind: "refused", items: refused, applied: false }
      : { kind: "taken" };
  }
  const checked = checkApproval(res.approval, args.selection);
  if (!checked.ok) return { kind: "mismatch", reason: checked.reason };
  if (res.answerToken === undefined) return { kind: "declined" };
  const answer = await call("approvals.answer", {
    approvalId: res.approval.id,
    answerToken: res.answerToken,
    decision: "approve",
    scope: "once",
  });
  if (answer.approval.status !== "approved") return { kind: "declined" };
  return refused.length > 0
    ? { kind: "refused", items: refused, applied: true }
    : { kind: "applied" };
}

/** Which chat the palette's "Fork a plan from this chat" acts on: the one most recently shown. */
export interface ForkChatTarget {
  threadId: string;
  start: () => void;
}

let activeChat: ForkChatTarget | null = null;
const chatListeners = new Set<() => void>();

export function registerForkChat(target: ForkChatTarget): () => void {
  activeChat = target;
  for (const l of chatListeners) l();
  return () => {
    if (activeChat === target) activeChat = null;
    for (const l of chatListeners) l();
  };
}

export function useForkChatTarget(): ForkChatTarget | null {
  return useSyncExternalStore(
    (l) => {
      chatListeners.add(l);
      return () => chatListeners.delete(l);
    },
    () => activeChat,
    () => null,
  );
}

/** What the chat column offers its transcript: start a fork at a message, open a fork's view. */
export interface PlanForkNav {
  start: (message: Message, labels?: string[]) => void;
  openPlans: (forkId: string) => void;
}

export const PlanForkNavContext = createContext<PlanForkNav | null>(null);

export function usePlanForkNav(): PlanForkNav | null {
  return useContext(PlanForkNavContext);
}

/** `?fork=<id>` of a chat route (`/chat/<threadId>?fork=<forkId>`), or null. */
export function forkFromRoute(route: string): string | null {
  const [path = "", rest = ""] = route.split("#")[0]?.split("?") ?? [];
  if (!/^\/chat\/[^/]+$/.test(path)) return null;
  return new URLSearchParams(rest).get("fork");
}
