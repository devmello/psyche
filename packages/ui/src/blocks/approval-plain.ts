import type { ApprovalRequest } from "@psyche/protocol";
import { t } from "../i18n/core.ts";

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
export function plainEffect(a: Pick<ApprovalRequest, "kind" | "sideEffect">): string | null {
  if (a.kind === "purchase" || a.sideEffect === "financial") return t("approvals.effect.money");
  if (SEND_KINDS.includes(a.kind)) return t("approvals.effect.sends");
  if (a.sideEffect === "destructive") return t("approvals.effect.irreversible");
  if (a.sideEffect === "write") {
    return FILE_KINDS.includes(a.kind) ? t("approvals.effect.files") : t("approvals.effect.write");
  }
  if (a.sideEffect === "read") return t("approvals.effect.read");
  if (a.sideEffect === "none") return t("approvals.effect.none");
  return null;
}

/**
 * The first line of the Gateway's template ("Title · write · after reading untrusted content")
 * with the side-effect word and the untrusted-content note in plain words. The title stays as the
 * Gateway wrote it (`cardHeader` is shared with the channels).
 */
export function plainHeader(
  a: Pick<ApprovalRequest, "kind" | "sideEffect" | "taint">,
  templateLine: string,
): string {
  const title = templateLine.split(" · ")[0] ?? templateLine;
  return [title, plainEffect(a), a.taint ? t("approvals.effect.untrusted") : null]
    .filter((x): x is string => x !== null && x !== "")
    .join(" · ");
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
