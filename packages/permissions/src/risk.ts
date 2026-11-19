import type { ApprovalKind, RiskClass, SideEffect } from "@psyche/protocol";
import { inferApprovalKind } from "./kinds.ts";
import type { PolicyCall, PolicyContext, PolicyDecision } from "./types.ts";

/**
 * The risk class of an approval card (the automation digest's "Approve all routine ones").
 *
 * `routine` is deliberately narrow and fails closed. A card is routine only when the broker's own
 * `decide` asked for it with the plain mode default for a local write (`mode:<mode>/write`), on
 * a file or git write the tool really is, for the owner, with nothing that made it ask harder.
 * Any other rule (`classifier:*`, `taint:*`, `prohibition:*`, `policy:ask:*`, an escalation, a
 * floor, a hook), no decision at all, a device-only card, a non-owner requester, a typed word, a
 * payment, taint, a destructive class or a path that carries execution makes it `sensitive`, so
 * the bulk button never covers it. This only labels cards: it changes neither which actions ask
 * nor what an approval allows.
 */
export const ROUTINE_BULK_KINDS: ReadonlySet<ApprovalKind> = new Set<ApprovalKind>([
  "file_write",
  "git_write",
]);

/** The plain mode default for a write (engine step 6): nothing else asked. */
const MODE_DEFAULT_WRITE = /^mode:(?:manual|balanced|auto)\/write$/;

/**
 * Files whose content runs later without another ask: a shell rc, a task runner, a package's
 * scripts, an editor's tasks, a login agent. A write to one of these is never bulk-approved.
 */
const EXECUTING_NAMES: ReadonlySet<string> = new Set([
  ".envrc",
  ".env",
  "makefile",
  "gnumakefile",
  "justfile",
  "rakefile",
  "taskfile.yml",
  "taskfile.yaml",
  "package.json",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "build.gradle",
  "build.gradle.kts",
  "cargo.toml",
  "build.rs",
  "procfile",
  ".pre-commit-config.yaml",
  ".gitattributes",
  ".gitconfig",
  ".bashrc",
  ".bash_profile",
  ".bash_login",
  ".bash_logout",
  ".profile",
  ".zshrc",
  ".zshenv",
  ".zprofile",
  ".zlogin",
  ".zlogout",
  ".inputrc",
  "config.fish",
  "crontab",
]);

/** Folders whose files run or configure what runs (editor tasks, CI, hooks, login items). */
const EXECUTING_SEGMENTS: readonly (readonly string[])[] = [
  [".vscode"],
  [".idea"],
  [".github", "workflows"],
  [".husky"],
  [".git"],
  [".direnv"],
  ["launchagents"],
  ["launchdaemons"],
  [".config", "autostart"],
  [".config", "fish"],
  [".config", "systemd"],
];

const EXECUTING_SUFFIXES = [".mk", ".command", ".plist", ".service", ".desktop"];

/** True when a write to `path` can carry execution (see `EXECUTING_NAMES`). */
export function pathCarriesExecution(path: string): boolean {
  const parts = path
    .toLowerCase()
    .split(/[\\/]+/)
    .filter((p) => p !== "" && p !== ".");
  const name = parts.at(-1);
  if (name === undefined) return true;
  if (EXECUTING_NAMES.has(name)) return true;
  if (EXECUTING_SUFFIXES.some((s) => name.endsWith(s))) return true;
  for (const seg of EXECUTING_SEGMENTS) {
    for (let i = 0; i + seg.length <= parts.length - 1; i++) {
      if (seg.every((s, j) => parts[i + j] === s)) return true;
    }
  }
  return false;
}

/** Every path the call writes, from its target and its binding fields. Empty means unknown. */
function writtenPaths(call: PolicyCall | undefined, fields: unknown): string[] {
  const out: string[] = [];
  if (call?.target?.kind === "path" && typeof call.target.value === "string")
    out.push(call.target.value);
  const f = (fields ?? {}) as Record<string, unknown>;
  for (const key of ["path", "realPath"]) {
    const v = f[key];
    if (typeof v === "string") out.push(v);
  }
  const files = f.files;
  if (Array.isArray(files)) {
    for (const v of files) {
      if (typeof v === "string") out.push(v);
      else if (typeof v === "object" && v !== null) {
        const p = (v as { path?: unknown }).path;
        if (typeof p === "string") out.push(p);
      }
    }
  }
  return out;
}

export interface RiskInput {
  kind: ApprovalKind;
  sideEffect?: SideEffect | undefined;
  requiresAuthentication: boolean;
  taint: boolean;
  deviceOnly: boolean;
  typedConfirmation: boolean;
  /** The broker's own `decide` that asked for this card; absent means sensitive. */
  recent?:
    | {
        call: PolicyCall;
        ctx: PolicyContext;
        decision: PolicyDecision;
        fields: unknown;
      }
    | undefined;
}

export function riskClassFor(input: RiskInput): RiskClass {
  const r = input.recent;
  if (r === undefined) return "sensitive";
  if (input.requiresAuthentication || input.taint || input.deviceOnly || input.typedConfirmation)
    return "sensitive";
  if (r.ctx.taint === true || r.decision.deviceOnly === true) return "sensitive";
  if (r.ctx.requester !== undefined && r.ctx.requester.role !== "owner") return "sensitive";
  if (r.decision.decision !== "ask" || !MODE_DEFAULT_WRITE.test(r.decision.rule))
    return "sensitive";
  if (input.sideEffect !== "write" || r.decision.sideEffect !== "write") return "sensitive";
  if (!ROUTINE_BULK_KINDS.has(input.kind) || r.decision.approvalKind !== input.kind)
    return "sensitive";
  // The kind must be the tool's own: a relabelled call (`call.kind`) never reads as routine.
  const tool = r.call.tool;
  if (input.kind === "file_write" && inferApprovalKind(tool) !== "file_write") return "sensitive";
  if (input.kind === "git_write" && tool !== "code.git") return "sensitive";
  if (input.kind === "file_write") {
    const paths = writtenPaths(r.call, r.fields);
    if (paths.length === 0 || paths.some(pathCarriesExecution)) return "sensitive";
  }
  return "routine";
}
