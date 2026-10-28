import type { ApprovalRequest } from "@psyche/protocol";
import { t } from "../i18n/core.ts";

/**
 * The plain-language reason a card is limited to Allow once (security §3.6): what the turn read
 * or used earlier, by friendly name. The raw ids stay under the card's Details.
 */

interface Source {
  kind: string;
  origin?: string;
}

function sourcesOf(approval: ApprovalRequest): Source[] {
  if (approval.taintSources !== undefined && approval.taintSources.length > 0) {
    return approval.taintSources.map((s) => ({
      kind: s.sourceKind,
      ...(s.origin !== undefined ? { origin: s.origin } : s.sender ? { origin: s.sender } : {}),
    }));
  }
  // Older cards only carry the sanitized "<kind>:<origin>" strings in `details`.
  const raw = (approval.details as Record<string, unknown>).taintSources;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is string => typeof r === "string")
    .map((r) => {
      const at = r.indexOf(":");
      const origin = at === -1 ? "" : r.slice(at + 1);
      return {
        kind: at === -1 ? r : r.slice(0, at),
        ...(origin && origin !== "?" ? { origin } : {}),
      };
    });
}

function domainOf(origin: string | undefined): string | null {
  if (origin === undefined) return null;
  try {
    return new URL(origin).hostname.replace(/^www\./, "") || null;
  } catch {
    return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(origin) ? origin.replace(/^www\./, "") : null;
  }
}

/** `apple-reminders-mvp8e06m2` → "Reminders"; `google-calendar` → "Google Calendar". */
function connectorName(id: string): string {
  const base = id
    .replace(/-[a-z0-9]{6,10}$/i, (m) => (/\d/.test(m) ? "" : m))
    .replace(/^apple[-.]/, "");
  return base
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function join(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  const head = parts.slice(0, -1).join(", ");
  return t("blocks.approval.taintAnd", { head, last: parts[parts.length - 1] ?? "" });
}

/** One sentence, or null when the card is not tainted. */
export function taintSentence(
  approval: ApprovalRequest,
  persona: string,
  onlyOnce: boolean,
): string | null {
  if (!approval.taint) return null;
  const reads: string[] = [];
  const uses: string[] = [];
  let other = false;
  const add = (list: string[], v: string) => {
    if (!list.includes(v)) list.push(v);
  };
  for (const s of sourcesOf(approval)) {
    const mcp = /^mcp__([^_].*?)__/.exec(s.kind);
    if (mcp?.[1] !== undefined) add(uses, connectorName(s.origin ?? mcp[1]));
    else if (s.kind === "transcript") add(reads, t("blocks.approval.taintTranscript"));
    else {
      const domain = domainOf(s.origin);
      if (domain !== null) add(reads, domain);
      else other = true;
    }
  }
  const parts: string[] = [];
  if (reads.length > 0) parts.push(t("blocks.approval.taintRead", { list: join(reads) }));
  if (uses.length > 0) parts.push(t("blocks.approval.taintUsed", { list: join(uses) }));
  if (parts.length === 0 || other)
    parts.push(t("blocks.approval.taintOther", { first: parts.length === 0 }));
  return t("blocks.approval.taintSentence", { persona, what: join(parts), onlyOnce });
}
