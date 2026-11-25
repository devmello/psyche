/**
 * Which owner chats get an approval card (owner decision D3, 2026-11-25).
 *
 * - A run that came from a chat asks in that chat (plus the paired devices, which are not chat
 *   surfaces and are added elsewhere).
 * - A run from the Mac or the iPhone asks on the devices, plus the ONE away chat the owner picked
 *   (Settings → Notifications), and only when no paired device has been seen for `awayAfterMs`.
 * - With no away chat set, a run from the Mac or iPhone reaches no chat at all.
 */

/** Minutes without a paired device before the away chat is used (`notifications.approvals.awayAfterMinutes`). */
export const DEFAULT_AWAY_AFTER_MINUTES = 10;

export interface ApprovalRouteInput {
  /** The chat the run came from (`<channel>:<ownerId>`), when it was started in a chat. */
  originSurface?: string | undefined;
  /** Every owner chat surface that can carry a card now. */
  ownerSurfaces: readonly string[];
  /** The owner chat the owner picked as the away chat (`notifications.approvals.awayChannel`). */
  awaySurfaces?: readonly string[] | undefined;
  /** When a paired device was last seen (epoch ms); `null` when never, or none paired. */
  deviceLastSeenAt: number | null;
  /** True while a paired device holds a live connection. */
  deviceConnected: boolean;
  now: number;
  awayAfterMs: number;
}

/** The chat surfaces an approval card goes to. Never a surface that is not an owner chat. */
export function approvalChatSurfaces(input: ApprovalRouteInput): string[] {
  const owner = new Set(input.ownerSurfaces);
  if (input.originSurface !== undefined) {
    return owner.has(input.originSurface) ? [input.originSurface] : [];
  }
  const away = (input.awaySurfaces ?? []).filter((s) => owner.has(s));
  if (away.length === 0) return [];
  if (input.deviceConnected) return [];
  const seen = input.deviceLastSeenAt;
  const absent = seen === null || input.now - seen >= input.awayAfterMs;
  return absent ? away : [];
}
