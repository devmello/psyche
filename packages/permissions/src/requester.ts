import type { ApprovalKind, SideEffect } from "@psyche/protocol";
import { BROWSER_WRITE_TOOLS, SEVERITY } from "./kinds.ts";
import { globToRegExp, type Rule, ruleMatches } from "./policy.ts";
import type { PolicyCall, PolicyContext, Requester } from "./types.ts";

/**
 * Who asked for a call (security §9 "Channels and people"; S10 `RouteContext.role`). The owner's
 * standing authority never covers anyone else:
 *
 * - `owner` (or no requester): the normal policy.
 * - `designated`: a designated person with a delegated persona. Persona limits are fixed (no
 *   exec, vault, browser writes, computer-use writes, protected memory or money); the identity's
 *   `toolAllow` globs and the owner's per-identity matrix (`policy.designated[identityId]`) apply;
 *   standing grants are per identity, so the owner's grants never cover them and theirs never
 *   cover the owner; every approval goes to the owner's devices, never back to their chat.
 * - `allowed`: an allowlisted sender who is neither. Evidence, never permission (§1.1 goal 2):
 *   no writes, and no reads of the owner's sources (#293): whatever the turn reads can leave
 *   through the reply into the sender's own conversation. Only public, cookie-less web reads
 *   (`PUBLIC_READ_TOOLS`) and calls without side effects remain.
 */

/** Reads of the public web without the owner's identity: what an allowlisted sender may use. */
const PUBLIC_READ_TOOLS: ReadonlySet<string> = new Set(["web_search", "web_fetch"]);

export interface DesignatedMatrix {
  allow: Rule[];
  ask: Rule[];
  deny: Rule[];
}

/** Grant-ledger key of the requester: `null` for the owner. */
export function requesterKey(requester: Requester | undefined): string | null {
  if (requester === undefined || requester.role === "owner") return null;
  if (requester.role === "designated") return `identity:${requester.identityId ?? "?"}`;
  return `sender:${requester.channel ?? "?"}:${requester.senderId ?? "?"}`;
}

/** Surfaces that reach the requester themselves (their own chats): never approval surfaces. */
export function requesterSurfaces(requester: Requester | undefined): string[] {
  if (requester === undefined || requester.role === "owner") return [];
  const own = [...(requester.links ?? [])];
  if (requester.channel !== undefined && requester.senderId !== undefined) {
    own.push(`${requester.channel}:${requester.senderId}`);
  }
  if (requester.channel !== undefined && requester.chatId !== undefined) {
    own.push(`${requester.channel}:${requester.chatId}`);
  }
  return own;
}

/** Kinds and tools a delegated persona never gets (security §9). */
const PERSONA_DENIED_KINDS: readonly ApprovalKind[] = [
  "exec",
  "exec_host",
  "credential_fill",
  "purchase",
  "browser_submit",
  "memory_protected_write",
  "skill_install",
  "pairing",
  "policy_change",
];
const PERSONA_DENIED_TOOLS =
  /^(exec|exec_host|sandbox\.|credentials\.|vault\.|memory$|skills\.install)/;

export type RequesterVerdict =
  | { effect: "deny"; rule: string; reason: string }
  | { effect: "ask"; rule: string; reason: string }
  | { effect: "allow"; rule: string }
  | undefined;

/** Step 2 check for non-owner requesters; `undefined` for the owner. */
export function checkRequester(
  call: PolicyCall,
  ctx: PolicyContext,
  kind: ApprovalKind,
  se: SideEffect,
  matrices: ReadonlyMap<string, DesignatedMatrix>,
): RequesterVerdict[] {
  const r = ctx.requester;
  if (r === undefined || r.role === "owner") return [];
  if (r.role === "allowed") {
    if (SEVERITY[se] >= SEVERITY.write) {
      return [
        {
          effect: "deny",
          rule: "requester:not_owner",
          reason: "only the owner or a designated person can request changes",
        },
      ];
    }
    if (se === "read" && !PUBLIC_READ_TOOLS.has(call.tool)) {
      return [
        {
          effect: "deny",
          rule: "requester:not_owner",
          reason:
            "an allowlisted sender cannot have the owner's messages, mail, files or memory read",
        },
      ];
    }
    // The route's tool list narrows further: channels route allowlisted senders chat-only
    // (`toolAllow: []`, #321), so not even the public web is used for them.
    if (
      r.toolAllow !== undefined &&
      !r.toolAllow.some((g) => globToRegExp(g, "plain").test(call.tool))
    ) {
      return [
        {
          effect: "deny",
          rule: "requester:not_owner",
          reason: `${call.tool} is not available in this sender's chat`,
        },
      ];
    }
    return [];
  }
  // designated
  const out: RequesterVerdict[] = [];
  const writePlus = SEVERITY[se] >= SEVERITY.write;
  if (
    se === "financial" ||
    PERSONA_DENIED_KINDS.includes(kind) ||
    PERSONA_DENIED_TOOLS.test(call.tool)
  ) {
    return [
      {
        effect: "deny",
        rule: "designated:persona_limit",
        reason: `a delegated persona cannot use ${call.tool}`,
      },
    ];
  }
  if (writePlus && (BROWSER_WRITE_TOOLS.test(call.tool) || kind === "computer_action")) {
    return [
      {
        effect: "deny",
        rule: "designated:persona_limit",
        reason: "a delegated persona cannot act in the browser or on apps",
      },
    ];
  }
  if (
    r.toolAllow !== undefined &&
    !r.toolAllow.some((g) => globToRegExp(g, "plain").test(call.tool))
  ) {
    return [
      {
        effect: "deny",
        rule: "designated:not_in_tool_allow",
        reason: `${call.tool} is not in this person's tool list`,
      },
    ];
  }
  const m = r.identityId === undefined ? undefined : matrices.get(r.identityId);
  if (m !== undefined) {
    const d = m.deny.find((x) => ruleMatches(x, call.tool, call.target));
    if (d !== undefined)
      return [
        {
          effect: "deny",
          rule: `designated:deny:${d.raw}`,
          reason: "the owner denies this for this person",
        },
      ];
    const a = m.ask.find((x) => ruleMatches(x, call.tool, call.target));
    if (a !== undefined)
      out.push({
        effect: "ask",
        rule: `designated:ask:${a.raw}`,
        reason: "the owner asks to approve this for this person",
      });
    const al = m.allow.find((x) => ruleMatches(x, call.tool, call.target));
    if (al !== undefined && SEVERITY[se] <= SEVERITY.write)
      out.push({ effect: "allow", rule: `designated:allow:${al.raw}` });
  }
  // Every destructive action a designated person triggers goes to the owner (§9).
  if (se === "destructive")
    out.push({
      effect: "ask",
      rule: "designated:owner_approves",
      reason: "destructive actions for a designated person need the owner",
    });
  return out;
}
