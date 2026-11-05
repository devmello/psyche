import spec from "./gateway-task.json" with { type: "json" };
import { currentUserSid } from "./private.ts";

/**
 * The Windows Gateway's scheduled task name (docs/guides/install.md "Windows"). Task Scheduler
 * names are machine-wide, so a fixed `\Psyche\Gateway` collides when two accounts on one PC install
 * Psyche: the second would replace (or fail to replace) the first one's task. The name carries the
 * account's SID instead, which survives a renamed account and needs no escaping:
 * `\Psyche\Gateway-S-1-5-21-…-1001`. gateway-task.json holds the parts (install-local.ps1 reads it
 * too); the desktop's supervisor, its uninstall hook and the CLI all name the task through here.
 */

/** `\Psyche\`, the Task Scheduler folder (Get-ScheduledTask's `-TaskPath`). */
export const GATEWAY_TASK_FOLDER: string = spec.folder;

/** The name every account shared before it was per user; migrated by `taskBelongsTo`. */
export const LEGACY_GATEWAY_TASK: string = `${spec.folder}${spec.legacyName}`;

const SID = /^S-1-\d+(-\d+)+$/;

/** The task's name inside the folder (Get-ScheduledTask's `-TaskName`) for the account `sid`. */
export function gatewayTaskLeaf(sid: string): string {
  if (!SID.test(sid)) throw new Error(`not a Windows SID: ${sid}`);
  return `${spec.prefix}${sid}`;
}

/** The full task path for the account `sid`: `\Psyche\Gateway-<sid>`. */
export function gatewayTaskName(sid: string): string {
  return `${spec.folder}${gatewayTaskLeaf(sid)}`;
}

/** This account's task path, or null when Windows would not say who we are. */
export function currentGatewayTaskName(): string | null {
  const sid = currentUserSid();
  return sid === null ? null : gatewayTaskName(sid);
}

function xmlUnescape(s: string): string {
  return s
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

/**
 * Whether a task definition (`schtasks /Query /XML`) runs as this account. Task Scheduler exports
 * the logon trigger's user as a SID and the principal as `DOMAIN\user` (as registered), so either
 * matching counts; case does not matter in either. A task that names no user is not ours.
 */
export function taskBelongsTo(xml: string, user: { sid: string; userId?: string }): boolean {
  const mine = new Set([user.sid.toLowerCase()]);
  if (user.userId) mine.add(user.userId.toLowerCase());
  for (const m of xml.matchAll(/<UserId>([^<]*)<\/UserId>/g)) {
    if (
      mine.has(
        xmlUnescape(m[1] ?? "")
          .trim()
          .toLowerCase(),
      )
    )
      return true;
  }
  return false;
}
