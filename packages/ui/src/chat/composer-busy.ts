import { useAuiState } from "@assistant-ui/react";
import { useEffect } from "react";

/**
 * Threads whose composer holds something the owner has not sent: typed text or an attached file.
 * Leaving an empty chat deletes it, unless it is in here. Drafts are not saved anywhere, so this
 * is the only record of one.
 */
const busy = new Set<string>();

export function isComposerBusy(threadId: string): boolean {
  return busy.has(threadId);
}

export function setComposerBusy(threadId: string, on: boolean): void {
  if (on) busy.add(threadId);
  else busy.delete(threadId);
}

/** Test teardown. */
export function clearComposerBusy(): void {
  busy.clear();
}

/** Mounted inside the composer's runtime: records whether it has text or `attachments` chips. */
export function ComposerBusyWatch({
  threadId,
  attachments,
}: {
  threadId: string;
  attachments: number;
}): null {
  const text = useAuiState((s) => (s.composer.isEditing ? s.composer.text : ""));
  const has = text.trim() !== "" || attachments > 0;
  // Not cleared on unmount: the shell reads it as the owner leaves, after the composer is gone.
  // The next mount of this thread's composer sets it again from what it actually holds.
  useEffect(() => {
    setComposerBusy(threadId, has);
  }, [threadId, has]);
  return null;
}
