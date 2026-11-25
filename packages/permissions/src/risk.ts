import type { ApprovalKind, RiskClass, SideEffect } from "@psyche/protocol";
import { routineWritePath } from "@psyche/protocol/routine-path";
import { inferApprovalKind } from "./kinds.ts";
import type { PolicyCall, PolicyContext, PolicyDecision } from "./types.ts";

/**
 * The risk class of an approval card (the automation digest's "Approve all routine ones").
 *
 * `routine` is deliberately narrow and fails closed. A card is routine only when the broker's own
 * `decide` asked for it with the plain mode default for a local write (`mode:<mode>/write`), on
 * a file or git write the tool really is, for the owner, with nothing that made it ask harder,
 * and only for files on the document allowlist (`routineWritePath`). Any other rule
 * (`classifier:*`, `taint:*`, `prohibition:*`, `policy:ask:*`, an escalation, a floor, a hook),
 * no decision at all, a device-only card, a non-owner requester, a typed word, a payment, taint,
 * a destructive class or any path off the allowlist makes it `sensitive`, so the bulk button
 * never covers it. This only labels cards: it changes neither which actions ask nor what an
 * approval allows.
 */
export const ROUTINE_BULK_KINDS: ReadonlySet<ApprovalKind> = new Set<ApprovalKind>([
  "file_write",
  "git_write",
]);

/** The plain mode default for a write (engine step 6): nothing else asked. */
const MODE_DEFAULT_WRITE = /^mode:(?:manual|balanced|auto)\/write$/;

/** The document rule lives in `@psyche/protocol/routine-path`, shared with the file tools. */
export { routineWritePath };

/** Pathspec magic or a glob: the path is not one literal file. */
const PATHSPEC_MAGIC = /^:|[*?[]/;

const joinPath = (root: string, rel: string) =>
  rel.startsWith("/") ? rel : `${root.replace(/\/+$/, "")}/${rel}`;

/**
 * Every file the call writes, or undefined when that cannot be read (which is sensitive). The
 * file tools write their canonical target (`realPath`); a commit takes its explicit `paths`
 * (none means sensitive, never "everything"); a patch is not read, so it is sensitive.
 */
function writtenFiles(
  kind: ApprovalKind,
  call: PolicyCall | undefined,
  fields: unknown,
): string[] | undefined {
  const f = (fields ?? {}) as Record<string, unknown>;
  const targetPath =
    call?.target?.kind === "path" && typeof call.target.value === "string"
      ? call.target.value
      : undefined;
  if (kind === "git_write") {
    // `code.git`'s own arguments (the binding hash covers every one of them), with the repo as
    // the broker saw it (the canonical target). Creating a branch writes no file; switching
    // rewrites the tree from whatever is in the repo (sensitive); a commit takes exactly the
    // listed files, never "." or a folder (which would take the owner's unfinished work too).
    const params = (call?.params ?? {}) as Record<string, unknown>;
    if (targetPath === undefined) return undefined;
    if (params.op === "branch") return params.create === true ? [] : undefined;
    const paths = params.paths;
    if (params.op !== "commit" || !Array.isArray(paths) || paths.length === 0) return undefined;
    const out: string[] = [];
    // A folder has no document type, so the file rule refuses it too.
    for (const p of paths) {
      if (
        typeof p !== "string" ||
        p === "" ||
        p === "." ||
        p.endsWith("/") ||
        p.includes("..") ||
        PATHSPEC_MAGIC.test(p)
      )
        return undefined;
      out.push(joinPath(targetPath, p));
    }
    return out;
  }
  // A patch (`code.edit`) names its files inside the patch, which is not read here: sensitive.
  if (call?.tool === "code.edit" || Array.isArray(f.files)) return undefined;
  if (typeof f.realPath === "string") return [f.realPath];
  if (targetPath !== undefined) return [targetPath];
  return undefined;
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
  // A staged apply is never routine, whatever else is true: it is never part of "Approve all
  // routine" (night-shift-2026 §3.3).
  if (input.kind === "staged_apply") return "sensitive";
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
  const files = writtenFiles(input.kind, r.call, r.fields);
  if (files === undefined) return "sensitive";
  if (input.kind === "file_write" && files.length === 0) return "sensitive";
  if (!files.every(routineWritePath)) return "sensitive";
  return "routine";
}
