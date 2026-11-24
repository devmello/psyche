import { type ViewPane, ViewPane as ViewPaneSchema } from "@psyche/protocol";

/**
 * Hands a `view.open` from the Gateway to a main window that did not exist when it was sent.
 *
 * A Settings window can ask for a pane (Watch) while the owner's main window is closed or its view
 * is released. Main raises a fresh window, but the Gateway's `view.command` event has already gone
 * by, so main keeps the open here and sends it to the new window once it has loaded. Pure: no
 * Electron, so the queue rules are unit-tested directly.
 *
 * Only `open` is kept. A close or focus with no main window has nothing to act on. Entries expire
 * quickly: an open the owner did not see at once must not surprise them when they open the app later.
 */

/** How long a queued open stays valid before the window it was meant for is gone for good. */
export const VIEW_OPEN_HANDOFF_TTL_MS = 10_000;
/** A few opens at most; a flood from a broken caller must not grow the queue without limit. */
export const VIEW_OPEN_HANDOFF_MAX = 4;
/** A `target` (machine id, thread id) is a short, printable string. */
const TARGET_MAX_LENGTH = 200;

export interface ViewOpenRequest {
  pane: ViewPane;
  target?: string;
}

export interface QueuedViewOpen {
  request: ViewOpenRequest;
  queuedAt: number;
}

/** C0 controls and DEL: a target never carries them. */
function isControl(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
}

/** The protocol's pane kinds (`ViewPane`), read from the shared schema, never hand-copied. */
function paneKinds(): readonly string[] {
  return (ViewPaneSchema as unknown as { enum?: readonly string[] }).enum ?? [];
}

/** Validates a `view.command` payload as an open request, or null when it is not one. */
export function viewOpenFromCommand(payload: unknown): ViewOpenRequest | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { command, args } = payload as { command?: unknown; args?: unknown };
  if (command !== "open") return null;
  if (typeof args !== "object" || args === null) return null;
  const { pane, target } = args as { pane?: unknown; target?: unknown };
  if (typeof pane !== "string" || !paneKinds().includes(pane)) return null;
  // The pane is in the protocol's list (checked above), so this narrowing is the list's own type.
  const kind = pane as ViewPane;
  if (target === undefined) return { pane: kind };
  if (typeof target !== "string" || target.length === 0 || target.length > TARGET_MAX_LENGTH) {
    return null;
  }
  // No control characters: the target is shown and matched, never run.
  if ([...target].some((ch) => isControl(ch))) return null;
  return { pane: kind, target };
}

/** The queue with `request` added: expired entries dropped, the newest few kept. */
export function queueViewOpen(
  queue: readonly QueuedViewOpen[],
  request: ViewOpenRequest,
  now: number,
): QueuedViewOpen[] {
  const fresh = queue.filter((q) => now - q.queuedAt <= VIEW_OPEN_HANDOFF_TTL_MS);
  return [...fresh, { request, queuedAt: now }].slice(-VIEW_OPEN_HANDOFF_MAX);
}

/** The opens still valid at `now`, oldest first. The caller clears its queue after sending them. */
export function takeViewOpens(queue: readonly QueuedViewOpen[], now: number): ViewOpenRequest[] {
  return queue.filter((q) => now - q.queuedAt <= VIEW_OPEN_HANDOFF_TTL_MS).map((q) => q.request);
}
