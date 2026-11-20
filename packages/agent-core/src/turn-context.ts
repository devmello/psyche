import type { Block, ModelMessage, PermissionMode, RunMode, TaintSource } from "@psyche/protocol";

/**
 * Turn context providers (feature E12 "From your other chats", and anything like it): code the
 * Gateway trusts that adds context drawn from the owner's own data to a turn. A provider runs
 * once per owner turn, with the owner's words, never for a subagent or a non-owner requester.
 * Its sections go into the owner's user message (after their words, kept in the transcript so
 * every later request replays the same bytes), never into `system`. They are fenced as untrusted
 * (they quote other content) and taint the run with the provider's source; its block, if any, is added to the reply so the owner sees what the
 * turn drew on. A provider that fails or misses its deadline adds nothing.
 */

/** Characters one trusted section may place in the prompt (three 300-character recall lines). */
export const TRUSTED_CONTEXT_CAP = 1_200;

/** Characters one untrusted section may place in the owner's user message. */
export const UNTRUSTED_CONTEXT_CAP = 8_000;

export interface TurnContextInput {
  threadId: string;
  runId: string;
  taskId?: string;
  /** The owner's own words this turn. */
  text: string;
  mode: RunMode;
  permissionMode: PermissionMode;
  /** The run's Space, fixed at run start (spaces-2026 §5.1); absent outside a Space. */
  spaceId?: string;
}

export interface TurnContext {
  sections: { title: string; text: string }[];
  /** Shown in the reply, e.g. `related_threads`. */
  block?: Block;
  /** Recorded as the run's taint source when sections are added (ignored when `trusted`). */
  source: TaintSource;
  /** The sections hold owner/system data only: no untrusted fence, no taint (owner turns only). */
  trusted?: true;
}

export interface TurnContextProvider {
  name: string;
  provide(input: TurnContextInput): Promise<TurnContext | undefined>;
}

/** What replaces an earlier run's turn context in the thread: fixed, unflagged, carries nothing. */
export const TURN_CONTEXT_STUB = "[context recalled for an earlier turn was removed]";

/**
 * Turn context lives for its own run. This replaces every part marked `turnContext` with the
 * stub, in place, and says whether it changed anything. Run at the start of each run (before
 * the taint check, so the removed text no longer taints) and by the Gateway when a Forget must
 * not leave recalled text in a saved thread. One stub per message, however many parts it held.
 */
export function stubTurnContext(messages: ModelMessage[]): boolean {
  let changed = false;
  for (const m of messages) {
    if (!m.parts.some((p) => p.type === "text" && p.turnContext === true)) continue;
    const kept = m.parts.filter((p) => !(p.type === "text" && p.turnContext === true));
    m.parts = [{ type: "text", text: TURN_CONTEXT_STUB }, ...kept];
    changed = true;
  }
  return changed;
}
