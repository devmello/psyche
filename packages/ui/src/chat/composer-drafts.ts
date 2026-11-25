import { useAui, useAuiState } from "@assistant-ui/react";
import { type MutableRefObject, useEffect, useRef } from "react";

/**
 * Drafts per thread, in memory: the chat remounts when the owner switches threads, and what was
 * typed (and the message being replied to) must be there when they come back. Attachment chips
 * are kept the same way by `useAttachments`. Nothing is written to disk.
 */
interface Draft {
  text: string;
  quoteId: string | null;
}

const drafts = new Map<string, Draft>();

export function getDraft(threadId: string): Draft {
  return drafts.get(threadId) ?? { text: "", quoteId: null };
}

function putDraft(threadId: string, patch: Partial<Draft>): void {
  const next = { ...getDraft(threadId), ...patch };
  if (next.text === "" && next.quoteId === null) drafts.delete(threadId);
  else drafts.set(threadId, next);
}

/** The message the next send replies to, remembered for a thread switch. */
export function setDraftQuote(threadId: string, quoteId: string | null): void {
  putDraft(threadId, { quoteId });
}

/** After a send: forget the draft. */
export function clearDraft(threadId: string): void {
  drafts.delete(threadId);
}

/** Test teardown. */
export function clearAllDrafts(): void {
  drafts.clear();
}

/**
 * Mounted inside the composer's runtime: puts the thread's saved text back into the composer and
 * keeps the saved copy in step with what is typed (an emptied composer, a send included, clears
 * it). `setText` hands the Thread a way to put text back after a refused command.
 */
export function ComposerDraft({
  threadId,
  setText,
}: {
  threadId: string;
  setText?: MutableRefObject<((text: string) => void) | null>;
}): null {
  const aui = useAui();
  const text = useAuiState((s) => (s.composer.isEditing ? s.composer.text : ""));
  // The text the restore put in: the render before it shows the empty composer, which is not a
  // reason to forget the draft.
  const waiting = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per thread, on mount
  useEffect(() => {
    const saved = getDraft(threadId).text;
    waiting.current = saved === "" ? null : saved;
    if (saved !== "") aui.composer.setText(saved);
  }, [threadId]);
  useEffect(() => {
    if (setText) setText.current = (v) => aui.composer.setText(v);
    return () => {
      if (setText) setText.current = null;
    };
  }, [aui, setText]);
  useEffect(() => {
    if (waiting.current !== null) {
      if (text === "") return;
      waiting.current = null;
    }
    putDraft(threadId, { text });
  }, [threadId, text]);
  return null;
}
