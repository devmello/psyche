import type { ChecklistItem, CompactionSummary, ModelMessage, TaintSource } from "@psyche/protocol";

/** What the loop keeps per thread between turns. The Gateway (S01) supplies a durable store. */
export interface ThreadState {
  /** Transcript after the last compaction; provider-native parts are kept verbatim. */
  messages: ModelMessage[];
  /** Summary of compacted turns; `untrusted` when it summarized untrusted content. */
  summary?: {
    text: string;
    untrusted: boolean;
    /** The structured form the text renders (owner-set limits); absent for older summaries. */
    structured?: CompactionSummary;
  };
  /** Compactions of this thread so far (the context meter). */
  compactions?: number;
  /** The `update_plan` checklist pinned under the latest message (C5). */
  checklist: ChecklistItem[];
  /**
   * Taint sources of the last turn, kept while untrusted content stays in `messages` or the
   * summary (security §3.6: taint survives compaction, and here a kill/restart): the next turn
   * starts tainted with these sources, so its approval cards still name the original origins.
   */
  taint?: { sources: TaintSource[] };
  /**
   * Deferred tools this thread loaded (`load_tools`, an approved install), in load order. Append
   * only: a loaded tool stays for the thread, so the tool list only ever grows at its end.
   */
  loadedTools?: string[];
}

export interface ThreadStateStore {
  load(threadId: string): Promise<ThreadState | undefined>;
  save(threadId: string, state: ThreadState): Promise<void>;
}

export function emptyThreadState(): ThreadState {
  return { messages: [], checklist: [] };
}

export class InMemoryThreadStateStore implements ThreadStateStore {
  #threads = new Map<string, ThreadState>();

  async load(threadId: string): Promise<ThreadState | undefined> {
    const state = this.#threads.get(threadId);
    return state === undefined ? undefined : structuredClone(state);
  }

  async save(threadId: string, state: ThreadState): Promise<void> {
    this.#threads.set(threadId, structuredClone(state));
  }
}
