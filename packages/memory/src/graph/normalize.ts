import { createHash } from "node:crypto";
import type { GraphIdentifierKind } from "@psyche/protocol";

/**
 * Identifier normalisation and the "never a person" rules (docs/memory/people-and-projects-2026.md
 * §4.2). The normalised form is the merge key; the display form is what the owner sees.
 */

const GMAIL = new Set(["gmail.com", "googlemail.com"]);

/** Lower-cases an address; for Gmail folds dots and `+tags` in the local part. */
export function normalizeEmail(raw: string): string | undefined {
  const m = /^\s*<?([^<>\s@]+)@([^<>\s@]+\.[^<>\s@]+)>?\s*$/.exec(raw);
  if (m === null) return undefined;
  let local = (m[1] ?? "").toLowerCase();
  let domain = (m[2] ?? "").toLowerCase().replace(/\.$/, "");
  if (GMAIL.has(domain)) {
    local = local.replace(/\+.*$/, "").replace(/\./g, "");
    domain = "gmail.com";
  }
  return local.length === 0 ? undefined : `${local}@${domain}`;
}

/**
 * E.164 without a phone library: keeps `+` and digits; a 10-digit national number gets the
 * owner's default country code (default `1`), an 11-digit number starting with it gets `+`.
 * Short codes (< 7 digits) are not phone identifiers.
 */
export function normalizePhone(raw: string, defaultCountry = "1"): string | undefined {
  const plus = raw.trim().startsWith("+");
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return undefined;
  if (plus) return `+${digits}`;
  if (digits.startsWith("00")) return `+${digits.slice(2)}`;
  if (digits.length === 10) return `+${defaultCountry}${digits}`;
  if (digits.length === 11 && digits.startsWith(defaultCountry)) return `+${digits}`;
  return `+${digits}`;
}

export function normalizeIdentifier(
  kind: GraphIdentifierKind,
  raw: string,
  defaultCountry?: string,
): string | undefined {
  const v = raw.trim();
  if (v.length === 0 || v.length > 512) return undefined;
  switch (kind) {
    case "email":
      return normalizeEmail(v);
    case "phone":
      return normalizePhone(v, defaultCountry);
    case "domain":
      return v
        .toLowerCase()
        .replace(/^www\./, "")
        .replace(/\.$/, "");
    case "channel":
      return v.toLowerCase();
    default:
      return v;
  }
}

/** Case- and accent-insensitive form of a name or alias. */
export function normalizeName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** File-safe slug for card paths: `Sam Lee` → `sam-lee`. */
export function slugify(name: string): string {
  const s = normalizeName(name).replace(/\s+/g, "-").slice(0, 60).replace(/-+$/, "");
  return s.length > 0 ? s : "untitled";
}

const MACHINE_LOCAL =
  /^(no-?reply|do-?not-?reply|donotreply|notifications?|notify|mailer-daemon|postmaster|bounces?|alerts?|automated|system|daemon|calendar-notification)([+._-].*)?$/;
const ROLE_LOCAL =
  /^(info|support|help|hello|hi|team|sales|billing|accounts?|admin|contact|office|marketing|news|newsletter|press|jobs|careers|hr|privacy|legal|security|abuse|feedback|service|orders?|receipts?|invoices?)([+._-].*)?$/;

/** No-reply and machine senders, and role inboxes (§4.2): never people, never person keys. */
export function isMachineOrRoleAddress(email: string): boolean {
  const local = email.split("@")[0] ?? "";
  return MACHINE_LOCAL.test(local) || ROLE_LOCAL.test(local);
}

/** Header names are matched case-insensitively. */
export interface MailHeaders {
  [name: string]: string | undefined;
}

/** Mailing-list and automated mail (RFC 2369, 2919, 3834; `Precedence: bulk/list/junk`). */
export function isBulkMail(headers: MailHeaders): boolean {
  const get = (name: string) => {
    const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
    return key === undefined ? undefined : headers[key];
  };
  if (get("list-id") !== undefined || get("list-unsubscribe") !== undefined) return true;
  const precedence = get("precedence")?.trim().toLowerCase();
  if (precedence === "bulk" || precedence === "list" || precedence === "junk") return true;
  const auto = get("auto-submitted")?.trim().toLowerCase();
  return auto !== undefined && auto !== "no";
}

/** Free-mail domains never become organisations. */
export const FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "ymail.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "gmx.com",
  "gmx.de",
  "web.de",
  "fastmail.com",
  "hey.com",
  "zoho.com",
  "mail.com",
  "yandex.com",
  "qq.com",
  "163.com",
]);

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Hash of an identifier for the forget blocklist (never stores the value). */
export function blockHash(kind: string, valueNorm: string): string {
  return sha256(`${kind}\n${valueNorm}`);
}
