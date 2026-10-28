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
  /** inputRequestId → the first message that shows its question card. */
  questionHome?: ReadonlyMap<string, string>;
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
  /**
   * Answered questions: inputRequestId → the answer values. An answered question card leaves the
   * transcript; the host fills this from the store, and `blocksToShow` drops the card when a later
   * user message already says the answer (otherwise the card shows as one compact answer line).
   */
  answeredQuestions?: ReadonlyMap<string, readonly string[]>;
  /** User messages in transcript order, for finding an answer a user message already shows. */
  userTexts?: readonly { pos: number; text: string }[];
  /** Position of each message in transcript order, to tell "after" for `userTexts`. */
  messagePos?: ReadonlyMap<string, number>;
}

/** Display values of a stored question answer, in question order. */
export function answerValues(
  answer: Readonly<Record<string, string | readonly string[]>> | null | undefined,
): string[] {
  return Object.values(answer ?? {})
    .flatMap((v) => (typeof v === "string" ? [v] : [...v]))
    .map((v) => v.trim())
    .filter((v) => v !== "");
}

/** True when a user message after `messageId` already contains every answer value. */
export function answerShownByUser(
  index: ThreadBlockIndex | null,
  messageId: string,
  values: readonly string[],
): boolean {
  const texts = index?.userTexts;
  if (texts === undefined || values.length === 0) return false;
  const from = index?.messagePos?.get(messageId) ?? -1;
  return texts.some((u) => {
    if (u.pos <= from) return false;
    const text = u.text.toLowerCase();
    return values.every((v) => text.includes(v.toLowerCase()));
  });
}

/** Indexes a thread's messages, in transcript order. */
export function indexThreadBlocks(messages: readonly Message[]): ThreadBlockIndex {
  const toolHome = new Map<string, string>();
  const toolLatest = new Map<string, ToolCallBlock>();
  const approvalHome = new Map<string, string>();
  const questionHome = new Map<string, string>();
  const userTexts: { pos: number; text: string }[] = [];
  const messagePos = new Map<string, number>();
  for (const m of messages) {
    messagePos.set(m.id, messagePos.size);
    if (m.role === "user") {
      const text = m.blocks.flatMap((b) => (b.type === "text" ? [b.md] : [])).join("\n");
      if (text !== "") userTexts.push({ pos: messagePos.size - 1, text });
    }
    for (const b of m.blocks) {
      if (b.type === "tool_call") {
        if (!toolHome.has(b.toolCallId)) toolHome.set(b.toolCallId, m.id);
        toolLatest.set(b.toolCallId, b);
      } else if (b.type === "approval" && !approvalHome.has(b.approvalId)) {
        approvalHome.set(b.approvalId, m.id);
      } else if (b.type === "question" && !questionHome.has(b.inputRequestId)) {
        questionHome.set(b.inputRequestId, m.id);
      }
    }
  }
  return { toolHome, toolLatest, approvalHome, questionHome, userTexts, messagePos };
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
  const seenQuestions = new Set<string>();
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
    if (b.type === "question") {
      // The same question was recorded twice in stored transcripts: one card per question.
      const elsewhere = (index?.questionHome?.get(b.inputRequestId) ?? message.id) !== message.id;
      if (elsewhere || seenQuestions.has(b.inputRequestId)) {
        changed = true;
        continue;
      }
      seenQuestions.add(b.inputRequestId);
      // Answered, the card is gone: the answer is already a user message, or shows as one line.
      const answered = index?.answeredQuestions?.get(b.inputRequestId);
      if (answered !== undefined && answerShownByUser(index, message.id, answered)) {
        changed = true;
        continue;
      }
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
