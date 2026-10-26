import type { DigestCategory } from "@psyche/protocol";
import { addressOf, domainOf, ruleFor, type SenderRule } from "./rules.ts";

/**
 * The digest's pre-sort (spec §4.1 step 2): everything decidable without a model. Order:
 * the owner's rules first, then lookalike senders, then bulk and automated mail. What is left
 * goes to the classifier.
 */

export interface MailItem {
  account: string;
  id: string;
  threadId: string;
  from: string;
  subject: string;
  at: string;
  link?: string;
  /** The first characters of the body (or Gmail's snippet), untrusted. */
  preview: string;
  /** Tool family, for the batch actions: `apple` (mail_* tools) or `gmail`. */
  via: "apple" | "gmail";
}

export interface PresortResult {
  category?: DigestCategory;
  because?: string;
}

const BULK_LOCAL =
  /^(news(letter)?s?|digest|weekly|daily|updates?|marketing|promo(tions)?|offers?|hello|hi|team)([.+_-].*)?$/;
const AUTOMATED_LOCAL =
  /^(no-?reply|do-?not-?reply|notifications?|alerts?|receipts?|orders?|accounts?|security|bounce|mailer-daemon|postmaster|calendar(-notification)?)([.+_-].*)?$/;
const RECEIPT_SUBJECT =
  /\b(receipt|order (confirmation|#)|your order|shipped|delivered|payment received|sign-?in|verification code|security alert)\b/i;
const UNSUBSCRIBE =
  /\b(unsubscribe|manage (your )?(email )?preferences|view (this|it) in (your|a) browser)\b/i;

/** Lookalike digits and letters attackers swap (`rn`→`m`, `0`→`o`, `1`→`l`). */
function skeleton(domain: string): string {
  return domain.replace(/rn/g, "m").replace(/0/g, "o").replace(/[1|]/g, "l").replace(/vv/g, "w");
}

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let diag = prev[0] as number;
    prev[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = prev[j] as number;
      prev[j] = Math.min(
        (prev[j] as number) + 1,
        (prev[j - 1] as number) + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diag = tmp;
    }
  }
  return prev[b.length] as number;
}

/** A sender domain that imitates a known one (mail [55]: never "needs you"). */
export function lookalikeOf(domain: string, known: readonly string[]): string | undefined {
  if (domain === "") return undefined;
  for (const k of known) {
    if (k === domain) return undefined;
  }
  for (const k of known) {
    if (skeleton(k) === skeleton(domain) || editDistance(k, domain) <= 2) return k;
  }
  return undefined;
}

export function presort(
  m: MailItem,
  ctx: {
    rules: readonly SenderRule[];
    today: string;
    knownDomains: readonly string[];
    isFirstTime: boolean;
    isKnownPerson: boolean;
  },
): PresortResult {
  const address = addressOf(m.from);
  const rule = ruleFor(ctx.rules, m.from, ctx.today);
  if (rule?.decision === "always_archive")
    return { category: "notifications", because: "your rule: always archive" };
  if (rule?.decision === "not_now")
    return { category: "fyi", because: `your rule: not now until ${rule.until}` };
  if (rule?.decision === "category" && rule.category !== undefined) {
    return { category: rule.category as DigestCategory, because: "your rule" };
  }
  const domain = domainOf(address);
  const imitates = lookalikeOf(domain, ctx.knownDomains);
  if (imitates !== undefined) return { category: "unverified", because: `looks like ${imitates}` };
  if (rule?.decision === "allow" || ctx.isKnownPerson) return {};
  const local = address.split("@")[0] ?? "";
  if (AUTOMATED_LOCAL.test(local) || RECEIPT_SUBJECT.test(m.subject)) {
    return {
      category: "notifications",
      because: AUTOMATED_LOCAL.test(local)
        ? `automated sender ${address}`
        : "receipt or account notice",
    };
  }
  if (BULK_LOCAL.test(local) || UNSUBSCRIBE.test(m.preview)) {
    return {
      category: "newsletters",
      because: UNSUBSCRIBE.test(m.preview) ? "has an unsubscribe link" : `bulk sender ${address}`,
    };
  }
  if (ctx.isFirstTime) return { category: "screen", because: "first mail from this sender" };
  return {};
}
