import { type VenueKind, venueOfHost } from "@psyche/protocol/financial-block";
import { parse } from "tldts";
import type { ImportCookie } from "./read.ts";

/**
 * Sites in the import list, one per registrable domain under the public suffix list (ICANN and
 * private sections): `mail.google.com` and `accounts.google.com` are `google.com`, `a.github.io`
 * and `b.github.io` are two sites, `maybank2u.com.my` and `shopee.com.my` are two sites, and a
 * bare public suffix is never a site. Sensitivity is judged per cookie host, and a row is
 * sensitive when any host in it is: a stolen session there moves money, opens every other
 * account (email resets, single sign-on) or unlocks the owner's passwords.
 */

export type SensitiveKind = "bank" | "payment" | "passwords" | "email" | "signin";

/** Strongest first: the kind a row shows when its hosts differ. */
const SEVERITY: readonly SensitiveKind[] = ["bank", "payment", "passwords", "email", "signin"];

/**
 * Hand-kept domains, matched on a label boundary (the domain or any subdomain). Banks, brokerages,
 * exchanges and money transfer services the financial hard block knows are added on top through
 * `venueOfHost`, so the two lists cannot drift apart (a test checks every venue domain).
 */
const LISTS: Record<SensitiveKind, readonly string[]> = {
  // Sign-in providers: one session opens every account that signs in through them.
  signin: [
    "okta.com",
    "oktapreview.com",
    "okta-emea.com",
    "github.com",
    "accounts.google.com",
    "login.microsoftonline.com",
    "login.live.com",
    "login.microsoft.com",
    "auth0.com",
    "onelogin.com",
    "id.atlassian.com",
    "appleid.apple.com",
    "idmsa.apple.com",
  ],
  email: [
    "google.com",
    "gmail.com",
    "googlemail.com",
    "outlook.com",
    "live.com",
    "hotmail.com",
    "office.com",
    "office365.com",
    "microsoft.com",
    "microsoftonline.com",
    "yahoo.com",
    "yahoo.co.jp",
    "aol.com",
    "icloud.com",
    "me.com",
    "apple.com",
    "proton.me",
    "protonmail.com",
    "fastmail.com",
    "zoho.com",
    "zoho.eu",
    "zoho.in",
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
    "lastpass.eu",
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
    // Stored cards and one-click buying.
    "amazon.com",
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
    "lloydsbank.co.uk",
    "halifax-online.co.uk",
    "halifax.co.uk",
    "nationwide.co.uk",
    "nwolb.com",
    "keybank.com",
    "synchrony.com",
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
    "dkb.de",
    "comdirect.de",
    "postbank.de",
    "sparkasse.de",
    "bank-austria.at",
    "bankaustria.at",
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
    "onlinesbi.sbi",
    "mufg.jp",
    "itau.com.br",
    "nubank.com.br",
    "maybank2u.com.my",
    "maybank.com",
    "bca.co.id",
    "klikbca.com",
    "bancolombia.com.co",
    "bbva.mx",
    "bbva.com",
  ],
};

const VENUE_KIND: Record<VenueKind, SensitiveKind> = {
  bank: "bank",
  brokerage: "bank",
  exchange: "payment",
  p2p: "payment",
  p2p_mixed: "payment",
};

/** A host name a cookie can be set for: letters, digits, dots and dashes. */
const HOST = /^\.?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

function inList(host: string, domains: readonly string[]): boolean {
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

/**
 * The sensitive kind of one host (or domain), or null. A host matches a listed domain or any
 * subdomain of it, never a lookalike (`paypal-login.com`, `evil-google.com`,
 * `chase.com.evil.net`). The financial hard block's venue table counts too. The `.bank` and
 * `.sbi` TLDs and real Sparkassen (`sparkasse-koelnbonn.de`) are banks. A word like "bank" in a
 * name alone is not enough (`food-bank.org`, `bankrate.com`).
 */
export function sensitiveKind(input: string): SensitiveKind | null {
  const host = input.toLowerCase().replace(/^\./, "").replace(/\.$/, "");
  if (host === "") return null;
  const venue = venueOfHost(host);
  if (venue !== undefined) return VENUE_KIND[venue];
  if (host.endsWith(".bank") || host.endsWith(".sbi")) return "bank";
  const registrable = parse(host, { allowPrivateDomains: true }).domain ?? host;
  if (registrable.startsWith("sparkasse-") && registrable.endsWith(".de")) return "bank";
  // Specific sign-in hosts (`accounts.google.com`) are checked before their provider's mail.
  for (const kind of ["bank", "payment", "passwords", "signin", "email"] as const) {
    if (inList(host, LISTS[kind])) return kind;
  }
  return null;
}

/** The strongest kind among several hosts. */
export function strongest(kinds: readonly (SensitiveKind | null)[]): SensitiveKind | null {
  for (const k of SEVERITY) if (kinds.includes(k)) return k;
  return null;
}

/** The kind of a row: sensitive when any of its hosts is. */
export function siteSensitivity(hosts: readonly string[]): SensitiveKind | null {
  return strongest(hosts.map(sensitiveKind));
}

/**
 * The registrable domain of a cookie host under the full public suffix list (private section
 * included), or undefined for an unusable host, an IP address or a bare public suffix.
 */
export function domainOfCookie(host: string): string | undefined {
  const h = host.toLowerCase();
  if (!HOST.test(h)) return undefined;
  const r = parse(h.replace(/^\./, ""), { allowPrivateDomains: true });
  if (r.isIp === true || r.domain === null || r.domain === "") return undefined;
  return r.domain;
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
    if (d === undefined) continue;
    const list = by.get(d) ?? [];
    list.push(c);
    by.set(d, list);
  }
  return by;
}

export function hostsOf(list: readonly ImportCookie[]): string[] {
  return [...new Set(list.map((c) => c.host.replace(/^\./, "")))].sort();
}

export function sitesOf(groups: ReadonlyMap<string, readonly ImportCookie[]>): ImportSite[] {
  return [...groups.entries()]
    .map(([domain, list]) => {
      const hosts = hostsOf(list);
      return { domain, hosts, cookies: list.length, sensitive: siteSensitivity(hosts) };
    })
    .sort((a, b) => a.domain.localeCompare(b.domain));
}
