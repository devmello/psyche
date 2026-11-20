import { registrableDomain } from "@psyche/protocol";
import type { ImportCookie } from "./read.ts";

/**
 * Sites in the import list, one per registrable domain (`mail.google.com` and
 * `accounts.google.com` are `google.com`; `evil-google.com` is its own site). Sensitive sites are
 * flagged so the list shows a warning and "Select all" leaves them out: a stolen session there
 * moves money, opens every other account (email resets) or unlocks the owner's passwords.
 */

export type SensitiveKind = "bank" | "payment" | "passwords" | "email";

const LISTS: Record<SensitiveKind, readonly string[]> = {
  email: [
    "google.com",
    "gmail.com",
    "outlook.com",
    "live.com",
    "hotmail.com",
    "office.com",
    "microsoftonline.com",
    "yahoo.com",
    "aol.com",
    "icloud.com",
    "me.com",
    "apple.com",
    "proton.me",
    "protonmail.com",
    "fastmail.com",
    "zoho.com",
    "gmx.com",
    "gmx.de",
    "gmx.net",
    "web.de",
    "mail.ru",
    "yandex.ru",
    "yandex.com",
    "tuta.com",
    "tutanota.com",
    "hey.com",
    "naver.com",
    "qq.com",
    "163.com",
  ],
  passwords: [
    "1password.com",
    "1password.eu",
    "1password.ca",
    "bitwarden.com",
    "bitwarden.eu",
    "lastpass.com",
    "dashlane.com",
    "keepersecurity.com",
    "nordpass.com",
    "roboform.com",
    "enpass.io",
    "keeper.io",
  ],
  payment: [
    "paypal.com",
    "stripe.com",
    "venmo.com",
    "cash.app",
    "squareup.com",
    "wise.com",
    "revolut.com",
    "klarna.com",
    "affirm.com",
    "afterpay.com",
    "zelle.com",
    "coinbase.com",
    "kraken.com",
    "binance.com",
    "robinhood.com",
    "paytm.com",
    "alipay.com",
    "payoneer.com",
    "skrill.com",
  ],
  bank: [
    "chase.com",
    "bankofamerica.com",
    "wellsfargo.com",
    "citi.com",
    "citibank.com",
    "capitalone.com",
    "usbank.com",
    "americanexpress.com",
    "discover.com",
    "schwab.com",
    "fidelity.com",
    "vanguard.com",
    "ally.com",
    "pnc.com",
    "td.com",
    "tdbank.com",
    "truist.com",
    "sofi.com",
    "chime.com",
    "hsbc.com",
    "hsbc.co.uk",
    "barclays.co.uk",
    "lloydsbank.com",
    "natwest.com",
    "santander.com",
    "santander.co.uk",
    "monzo.com",
    "starlingbank.com",
    "n26.com",
    "ing.com",
    "bnpparibas.com",
    "deutsche-bank.de",
    "commerzbank.de",
    "sparkasse.de",
    "rbc.com",
    "scotiabank.com",
    "bmo.com",
    "cibc.com",
    "commbank.com.au",
    "westpac.com.au",
    "nab.com.au",
    "anz.com",
    "hdfcbank.com",
    "icicibank.com",
    "sbi.co.in",
    "mufg.jp",
    "itau.com.br",
    "nubank.com.br",
  ],
};

const BY_DOMAIN = new Map<string, SensitiveKind>(
  (Object.entries(LISTS) as [SensitiveKind, readonly string[]][]).flatMap(([kind, list]) =>
    list.map((d) => [d, kind] as const),
  ),
);

/**
 * The sensitive kind of a registrable domain, or null. A listed domain matches exactly; the
 * `.bank` TLD and a first label that is "bank" as a word (`bank-x.de`, `x-bank.com`) count as
 * banks. Lookalikes such as `paypal-login.com` or `evil-google.com` are other sites, not these.
 */
export function sensitiveKind(domain: string): SensitiveKind | null {
  const d = domain.toLowerCase();
  const listed = BY_DOMAIN.get(d);
  if (listed !== undefined) return listed;
  if (d.endsWith(".bank")) return "bank";
  const first = d.split(".")[0] ?? "";
  if (first.split("-").includes("bank")) return "bank";
  return null;
}

/** A host name a cookie can be set for: letters, digits, dots and dashes. */
const HOST = /^\.?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

export function domainOfCookie(host: string): string | undefined {
  const h = host.toLowerCase();
  if (!HOST.test(h)) return undefined;
  return registrableDomain(h);
}

export interface ImportSite {
  domain: string;
  /** Cookie hosts under the domain, without the leading dot. */
  hosts: string[];
  cookies: number;
  sensitive: SensitiveKind | null;
}

/** Groups cookies by registrable domain; cookies on an unusable host are dropped. */
export function groupByDomain(cookies: readonly ImportCookie[]): Map<string, ImportCookie[]> {
  const by = new Map<string, ImportCookie[]>();
  for (const c of cookies) {
    const d = domainOfCookie(c.host);
    if (d === undefined || d === "") continue;
    const list = by.get(d) ?? [];
    list.push(c);
    by.set(d, list);
  }
  return by;
}

export function sitesOf(groups: ReadonlyMap<string, readonly ImportCookie[]>): ImportSite[] {
  return [...groups.entries()]
    .map(([domain, list]) => ({
      domain,
      hosts: [...new Set(list.map((c) => c.host.replace(/^\./, "")))].sort(),
      cookies: list.length,
      sensitive: sensitiveKind(domain),
    }))
    .sort((a, b) => a.domain.localeCompare(b.domain));
}
