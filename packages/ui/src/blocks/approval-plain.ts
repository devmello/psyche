import type { ApprovalRequest } from "@psyche/protocol";
import { t } from "../i18n/core.ts";
import { pathBasename, pathDirname } from "../lib/paths.ts";

/** Kinds whose writes change files, the folder or the repository. */
const FILE_KINDS: readonly string[] = [
  "file_write",
  "exec",
  "exec_host",
  "folder_access",
  "git_write",
  "git_push",
  "memory_protected_write",
  "staged_apply",
  "skill_install",
];
const SEND_KINDS: readonly string[] = ["send_email", "message_send"];

/**
 * The card's one plain line about what it does ("Changes files", "Sends to someone", "Can't be
 * undone", "Moves money"), instead of the raw side-effect word. Null when the request says
 * nothing about it.
 */
export function plainEffect(
  a: Pick<ApprovalRequest, "kind" | "sideEffect"> & { details?: ApprovalRequest["details"] },
): string {
  if (a.kind === "purchase" || a.sideEffect === "financial") return t("approvals.effect.money");
  if (SEND_KINDS.includes(a.kind)) return t("approvals.effect.sends");
  // A command on this computer is the stronger line: it can reach the internet, or at least run
  // outside the sandbox.
  if (a.kind === "exec_host" && reachesNetwork(a.details)) return t("approvals.effect.network");
  if (a.sideEffect === "destructive") return t("approvals.effect.irreversible");
  if (a.kind === "exec_host") return t("approvals.effect.hostRun");
  if (a.kind === "git_push") return t("approvals.effect.publishes");
  if (a.sideEffect === "write") {
    return FILE_KINDS.includes(a.kind) ? t("approvals.effect.files") : t("approvals.effect.write");
  }
  if (a.sideEffect === "read") return t("approvals.effect.read");
  if (a.sideEffect === "none") return t("approvals.effect.none");
  // Nothing said about it: a neutral line, never an empty one.
  return t("approvals.effect.unknown");
}

/** An exec_host card that allows network: allowed domains, or a `network` other than none. */
function reachesNetwork(details: ApprovalRequest["details"] | undefined): boolean {
  const d = (details ?? {}) as Record<string, unknown>;
  if (Array.isArray(d.allowedDomains) && d.allowedDomains.length > 0) return true;
  const n = d.network;
  return n === true || (typeof n === "string" && n !== "" && n !== "none");
}

/**
 * The line under the card's title: what the action does in plain words ("Changes files · Psyche
 * read something from outside first"). The kind's own title ("Run command in sandbox") is the
 * Gateway's template wording, shared with the channels, and stays off the desktop card: the
 * heading already says what Psyche wants to do.
 */
export function plainHeader(
  a: Pick<ApprovalRequest, "kind" | "sideEffect" | "taint"> & {
    details?: ApprovalRequest["details"];
  },
): string {
  return [plainEffect(a), a.taint ? t("approvals.effect.untrusted") : null]
    .filter((x): x is string => x !== null && x !== "")
    .join(" · ");
}

/** The longest command the heading quotes in full; a longer one stays whole in Details. */
const MAX_COMMAND_CHARS = 120;

const quoteArg = (a: string): string => (/[\s"'\\]/.test(a) || a === "" ? JSON.stringify(a) : a);

/** The command of an `exec` / `exec_host` card as one line, or null when there is none. */
export function commandLine(details: ApprovalRequest["details"] | undefined): string | null {
  const d = (details ?? {}) as Record<string, unknown>;
  if (Array.isArray(d.argv) && d.argv.length > 0) {
    return d.argv.map((x) => quoteArg(String(x))).join(" ");
  }
  return typeof d.command === "string" && d.command.trim() !== "" ? d.command : null;
}

/** A folder as a person names it: its last part, or nothing for "~", "." and a bare root. */
function folderName(path: unknown): string | null {
  if (typeof path !== "string" || path.trim() === "") return null;
  const name = pathBasename(path.replace(/[\\/]+$/, ""));
  return name === "" || name === "~" || name === "." || name === "/" ? null : name;
}

/**
 * One plain sentence for the heading: "Wren wants to run `npm install` in psyche." Only for the
 * cards whose facts are all in `details` (a command in the sandbox or on this computer, a file
 * save); null for every other kind and for a command too long to quote whole, which keep the
 * Gateway's summary.
 */
export function plainTitle(
  a: Pick<ApprovalRequest, "kind" | "details">,
  persona: string,
): string | null {
  const d = (a.details ?? {}) as Record<string, unknown>;
  if (a.kind === "exec" || a.kind === "exec_host") {
    if (d.onMachine === true) return null;
    const command = commandLine(a.details);
    if (command === null || command.length > MAX_COMMAND_CHARS) return null;
    const folder = folderName(d.cwd);
    return t("approvals.plain.run", {
      who: persona,
      command,
      hasFolder: folder !== null,
      folder: folder ?? "",
    });
  }
  if (a.kind === "file_write" && typeof d.path === "string") {
    const file = pathBasename(d.path);
    if (file === "") return null;
    const folder = folderName(pathDirname(d.path));
    return t("approvals.plain.save", {
      who: persona,
      file,
      mode: d.mode === "create" ? "create" : "change",
      hasFolder: folder !== null,
      folder: folder ?? "",
    });
  }
  return null;
}

const REASONS: readonly (readonly [string | RegExp, string])[] = [
  [/^exec always asks\b/, "approvals.plainWhy.commands"],
  ["read-only commands ask in this mode or with the setting off", "approvals.plainWhy.commands"],
  ["user ask rule", "approvals.plainWhy.yourRule"],
  ["write outside the workspace", "approvals.plainWhy.outsideWorkspace"],
  ["srt is not set up", "approvals.plainWhy.noSandbox"],
  ["protected memory files always ask", "approvals.plainWhy.protectedFiles"],
  ["pushes always ask", "approvals.plainWhy.push"],
  ["file changes on a machine ask every time", "approvals.plainWhy.machineFiles"],
  ["tools of unknown MCP servers ask", "approvals.plainWhy.unknownTool"],
  ["connector matrix asks", "approvals.plainWhy.connector"],
  ["untrusted content was read and the target is new", "approvals.plainWhy.outsideNew"],
  ["exec with network or outside writes in a tainted turn", "approvals.plainWhy.outsideCommand"],
  [/^a command on .* in a tainted turn$/, "approvals.plainWhy.outsideCommand"],
];

/**
 * The engine's reason for asking, as a person would give it ("You asked to approve commands
 * before they run"). The engine's words stay in `packages/permissions`; they are mapped here.
 * A reason with no mapping (a hook's own text, an address it names) returns null and the card
 * shows it as sent.
 */
export function plainReason(reason: string): string | null {
  const text = reason.trim().replace(/^[A-Za-z]+ mode; /, "");
  const hit = REASONS.find(([match]) =>
    typeof match === "string" ? match === text : match.test(text),
  );
  return hit ? t(hit[1] as never) : null;
}

/** Why a card was closed without an answer, in a sentence (never the raw code). */
export function voidedText(reason: string | undefined): string {
  switch (reason) {
    case undefined:
    case "":
    case "binding_mismatch":
      return t("approvals.void.changed");
    case "run_cancelled":
      return t("approvals.void.runCancelled");
    case "gateway_restart":
      return t("approvals.void.restart");
    default:
      return t("approvals.void.other");
  }
}
