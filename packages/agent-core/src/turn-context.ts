import type { Block, PermissionMode, RunMode, TaintSource } from "@psyche/protocol";

/**
 * Turn context providers (feature E12 "From your other chats", and anything like it): code the
 * Gateway trusts that adds context drawn from the owner's own data to a turn. A provider runs
 * once per owner turn, with the owner's words, never for a subagent or a non-owner requester.
 * Its sections are always fenced as untrusted (they quote other content) and taint the run with
 * the provider's source; its block, if any, is added to the reply so the owner sees what the
 * turn drew on. A provider that fails or misses its deadline adds nothing.
 */

/** Characters one trusted section may place in the prompt (three 300-character recall lines). */
export const TRUSTED_CONTEXT_CAP = 1_200;

export interface TurnContextInput {
  threadId: string;
  runId: string;
  taskId?: string;
  /** The owner's own words this turn. */
  text: string;
  mode: RunMode;
  permissionMode: PermissionMode;
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
