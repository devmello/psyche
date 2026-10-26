/**
 * Approvals by voice (docs/voice/voice-mode-2026.md §4.6). The tiers are chat's (security §3.7,
 * §9):
 * - voice may answer `write` approvals, and `destructive` ones when the owner allows it;
 * - `deviceOnly` kinds (purchases, credential fills, host shell, policy and pairing changes) never;
 * - nothing that needs Touch ID;
 * - in a turn tainted by untrusted content, voice may only deny.
 *
 * Psyche reads the request back from the broker's own summary, never from model text, then
 * listens for a fixed phrase. Only an exact phrase counts; anything else leaves the card on
 * screen.
 */

export type VoiceApprovalTier = "off" | "write" | "write_destructive";

/** What the conversation needs to know about a pending approval (from the ApprovalRequest). */
export interface VoiceApprovalInfo {
  id: string;
  /** The broker's summary with the full arguments, as on the card. */
  summary: string;
  sideEffect?: string;
  deviceOnly: boolean;
  requiresAuthentication: boolean;
  /** The turn read untrusted content (security §3.6). */
  taint: boolean;
  scopesOffered: readonly string[];
}

/**
 * - `answer`: voice may approve or deny.
 * - `deny_only`: voice may deny, but approving needs the card.
 * - `card`: voice can't answer; Psyche says why.
 */
export type VoiceApprovalMode = "answer" | "deny_only" | "card";

export interface VoiceApprovalPlan {
  mode: VoiceApprovalMode;
  /** What Psyche says: the readback with the expected phrases, or why the card is needed. */
  speech: string;
}

export interface ApprovalPhrases {
  approve: readonly string[];
  deny: readonly string[];
  /** Said after a deny, after an approve, and when nothing matched. */
  denied: string;
  approved: string;
  leftOnScreen: string;
}

/** English phrases; other locales come from the UI catalogues (V-U). */
export const DEFAULT_APPROVAL_PHRASES: ApprovalPhrases = {
  approve: [
    "yes",
    "yes please",
    "yes send it",
    "yes do it",
    "send it",
    "do it",
    "go ahead",
    "approve",
    "approve it",
  ],
  deny: [
    "no",
    "no thanks",
    "cancel",
    "cancel it",
    "don't",
    "don't send it",
    "do not",
    "stop",
    "deny",
  ],
  denied: "Cancelled.",
  approved: "Okay.",
  leftOnScreen: "I'll leave it on screen.",
};

/** How long Psyche listens for the answer after the readback has played. */
export const APPROVAL_WINDOW_MS = 10_000;

/** Decides what voice may do with an approval, and what Psyche says about it. */
export function planVoiceApproval(
  info: VoiceApprovalInfo,
  tier: VoiceApprovalTier,
): VoiceApprovalPlan {
  if (info.deviceOnly || info.requiresAuthentication) {
    return { mode: "card", speech: "That needs your Touch ID on screen." };
  }
  if (!info.scopesOffered.includes("once")) {
    return { mode: "card", speech: "I need your approval on screen." };
  }
  const allowed =
    tier === "write_destructive"
      ? info.sideEffect === "write" || info.sideEffect === "destructive"
      : tier === "write"
        ? info.sideEffect === "write"
        : false;
  if (!allowed) return { mode: "card", speech: "I need your approval on screen." };
  const summary = cleanSummary(info.summary);
  if (info.taint) {
    return {
      mode: "deny_only",
      speech: `${summary}. This came from something I read, so approve it on screen. Say "no" to cancel.`,
    };
  }
  return { mode: "answer", speech: `${summary}. Say "yes" to approve, or "no" to cancel.` };
}

/**
 * The spoken answer, or undefined. The normalised words must equal one phrase exactly (with an
 * optional trailing "please" or "thanks"). Anything mixed ("no, send it") or longer counts as no
 * answer, so a sentence that merely contains "yes" never approves.
 */
export function matchApprovalPhrase(
  text: string,
  phrases: Pick<ApprovalPhrases, "approve" | "deny"> = DEFAULT_APPROVAL_PHRASES,
): "approve" | "deny" | undefined {
  const words = normalise(text).replace(/\s+(please|thanks|thank you)$/, "");
  if (words === "") return undefined;
  const approve = phrases.approve.some((p) => normalise(p) === words);
  const deny = phrases.deny.some((p) => normalise(p) === words);
  if (approve === deny) return undefined;
  return approve ? "approve" : "deny";
}

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The summary as speech: no markup, no trailing punctuation, at most 400 characters. */
function cleanSummary(summary: string): string {
  const s = summary
    .replace(/[<>{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?]+$/, "");
  return s.length > 400 ? `${s.slice(0, 399).trimEnd()}…` : s;
}
