import type { Block, Message } from "@psyche/protocol";
import { createContext, type ReactElement, type ReactNode, useContext } from "react";
import type { ToolCallBlock } from "./types.ts";

/**
 * Where each tool call and approval of a thread is shown (#569). A turn that pauses for an
 * approval is recorded across several messages: the call's block stays `pending` in the message
 * before the pause, the resumed call lands in a later message under the same `toolCallId`, and
 * the approval can be recorded more than once. Each call is shown once, at its first position,
 * with its latest state (pending → ok); each approval once, where it first appears.
 */
export interface ThreadBlockIndex {
  /** toolCallId → the first message that shows it. */
  toolHome: ReadonlyMap<string, string>;
  /** toolCallId → its latest block in the thread. */
  toolLatest: ReadonlyMap<string, ToolCallBlock>;
  /** approvalId → the first message that shows it. */
  approvalHome: ReadonlyMap<string, string>;
  /**
   * The run in progress (#623): its tool calls and approvals show in the run's step log under
   * the last message, so the transcript leaves them out until the run ends.
   */
  activeRunId?: string | null;
  /**
   * Runs with a step trace (run-trace T2): their tool calls and approvals show in the run's steps
   * above the reply, so the transcript leaves them out.
   */
  tracedRuns?: ReadonlySet<string>;
}

/** Indexes a thread's messages, in transcript order. */
export function indexThreadBlocks(messages: readonly Message[]): ThreadBlockIndex {
  const toolHome = new Map<string, string>();
  const toolLatest = new Map<string, ToolCallBlock>();
  const approvalHome = new Map<string, string>();
  for (const m of messages) {
    for (const b of m.blocks) {
      if (b.type === "tool_call") {
        if (!toolHome.has(b.toolCallId)) toolHome.set(b.toolCallId, m.id);
        toolLatest.set(b.toolCallId, b);
      } else if (b.type === "approval" && !approvalHome.has(b.approvalId)) {
        approvalHome.set(b.approvalId, m.id);
      }
    }
  }
  return { toolHome, toolLatest, approvalHome };
}

/**
 * The blocks one message shows: without tool calls and approvals that belong to an earlier
 * message, with each call at its latest state, and one block per approval within the message.
 * With no index (a message rendered on its own) only the in-message rules apply.
 */
export function blocksToShow(
  message: { id: string; blocks: readonly Block[]; runId?: string | null },
  index: ThreadBlockIndex | null,
): readonly Block[] {
  const seenApprovals = new Set<string>();
  let changed = false;
  const out: Block[] = [];
  const live =
    message.runId != null &&
    ((index?.activeRunId != null && message.runId === index.activeRunId) ||
      index?.tracedRuns?.has(message.runId) === true);
  for (const b of message.blocks) {
    if (live && (b.type === "tool_call" || b.type === "approval")) {
      changed = true;
      continue;
    }
    if (b.type === "approval") {
      const elsewhere =
        index !== null && (index.approvalHome.get(b.approvalId) ?? message.id) !== message.id;
      if (elsewhere || seenApprovals.has(b.approvalId)) {
        changed = true;
        continue;
      }
      seenApprovals.add(b.approvalId);
      out.push(b);
      continue;
    }
    if (b.type === "tool_call" && index !== null) {
      if ((index.toolHome.get(b.toolCallId) ?? message.id) !== message.id) {
        changed = true;
        continue;
      }
      const latest = index.toolLatest.get(b.toolCallId) ?? b;
      if (latest !== b) changed = true;
      out.push(latest);
      continue;
    }
    out.push(b);
  }
  return changed ? out : message.blocks;
}

const Ctx = createContext<ThreadBlockIndex | null>(null);

/** Provided by the chat thread around its messages. */
export function ThreadBlocksProvider({
  index,
  children,
}: {
  index: ThreadBlockIndex;
  children?: ReactNode;
}): ReactElement {
  return <Ctx.Provider value={index}>{children}</Ctx.Provider>;
}

export function useThreadBlocks(): ThreadBlockIndex | null {
  return useContext(Ctx);
}
