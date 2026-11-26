import type { PermissionMode } from "./common.ts";

/**
 * Full access (owner, 2026-11-25): "allows full web browsing, files, everything but payment".
 * One mode value (`full`) on a chat thread. Who may set it and which runs it reaches are decided
 * here, in one place, for the Gateway (setting it), the broker (deciding with it) and the file
 * executors (which folders a run may reach).
 *
 * - Only the owner's own chats can be in Full access: never a channel thread (third parties talk
 *   there), an automation or Night shift thread, a specialist's job thread or an imported chat.
 * - It reaches only the owner's attended chat turns, and the in-process subagents they spawn.
 *   An unattended run (automation, heartbeat, Night shift), a channel turn, a designated person's
 *   turn, an MCP App's page and instructions found in content never run in it, whatever the
 *   thread says.
 */
export const FULL_ACCESS_MODE = "full" satisfies PermissionMode;

/** Thread kinds the owner may turn Full access on in: their own chats. */
export const FULL_ACCESS_THREAD_KINDS: readonly string[] = ["main", "side", "incognito"];

export type FullAccessThreadRefusal = "thread_kind" | "imported" | "channel_session";

/**
 * Why `full` can't be set on this thread, or `undefined` when it can. The app's own chats have
 * session keys `owner:…` or `main…`; any other key (an old chat channel's `<channel>:peer:…`,
 * `import:…`, `specialist:…`, an automation run's) names a channel, import or job session.
 */
export function fullAccessThreadRefusal(thread: {
  kind: string;
  imported?: unknown;
  sessionKey?: unknown;
}): FullAccessThreadRefusal | undefined {
  if (!FULL_ACCESS_THREAD_KINDS.includes(thread.kind)) return "thread_kind";
  if (thread.imported !== undefined && thread.imported !== null) return "imported";
  if (typeof thread.sessionKey === "string" && !/^(owner|main)(:|$)/.test(thread.sessionKey)) {
    return "channel_session";
  }
  return undefined;
}

export type FullAccessIgnored = "unattended" | "requester" | "channel" | "initiator";

/** The facts of a run that decide whether its thread's Full access reaches it. */
export interface FullAccessRunFacts {
  permissionMode: PermissionMode;
  /** An automation, heartbeat or Night shift run (`RunMode` `unattended`). */
  unattended?: boolean;
  initiator?: string;
  requester?: { role: string; channel?: string };
}

/** Initiators of an owner's chat turn: the owner, the agent working on it, its subagents. */
const OWNER_TURN_INITIATORS: readonly (string | undefined)[] = [
  undefined,
  "owner",
  "agent",
  "subagent",
];

/**
 * Why a run in a `full` thread does not get Full access (it is decided as Balanced), or
 * `undefined` when it does. Only meaningful when `permissionMode` is `full`.
 */
export function fullAccessIgnored(f: FullAccessRunFacts): FullAccessIgnored | undefined {
  if (f.unattended === true) return "unattended";
  if (f.requester !== undefined) {
    if (f.requester.role !== "owner") return "requester";
    // The owner's own message through an old chat channel: the chat is the channel's.
    if (f.requester.channel !== undefined) return "channel";
  }
  if (!OWNER_TURN_INITIATORS.includes(f.initiator)) return "initiator";
  return undefined;
}

/** Whether this run runs in Full access: a `full` thread and an owner's attended chat turn. */
export function fullAccessApplies(f: FullAccessRunFacts): boolean {
  return f.permissionMode === FULL_ACCESS_MODE && fullAccessIgnored(f) === undefined;
}
