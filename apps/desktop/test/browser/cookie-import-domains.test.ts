import { venueDomains } from "@psyche/protocol/financial-block";
import { describe, expect, it } from "vitest";
import {
  domainOfCookie,
  groupByDomain,
  sensitiveKind,
  siteSensitivity,
  sitesOf,
} from "../../src/main/browser/cookie-import/domains.ts";
import type { ImportCookie } from "../../src/main/browser/cookie-import/read.ts";

const cookie = (host: string, name = "s"): ImportCookie => ({
  host,
  name,
  value: "v",
  path: "/",
  secure: true,
  httpOnly: false,
  sameSite: "unspecified",
});

describe("grouping by registrable domain (public suffix list, ICANN and private)", () => {
  // Hosts that belong to the site.
  it.each([
    [".google.com", "google.com"],
    ["mail.google.com", "google.com"],
    ["accounts.google.com", "google.com"],
    [".www.bbc.co.uk", "bbc.co.uk"],
    ["canvas.ucsc.edu", "ucsc.edu"],
    ["GitHub.com", "github.com"],
    ["tenant-a.okta.com", "okta.com"],
  ])("%s is %s", (host, domain) => {
    expect(domainOfCookie(host)).toBe(domain);
  });

  // Public suffixes the old three-label table didn't know: each site is its own row.
  it.each([
    ["www.maybank2u.com.my", "maybank2u.com.my"],
    ["shopee.com.my", "shopee.com.my"],
    ["www.bca.co.id", "bca.co.id"],
    ["www.bancolombia.com.co", "bancolombia.com.co"],
    ["alice.github.io", "alice.github.io"],
    ["evil.github.io", "evil.github.io"],
    ["x.herokuapp.com", "x.herokuapp.com"],
    ["x.vercel.app", "x.vercel.app"],
    ["x.netlify.app", "x.netlify.app"],
    ["x.pages.dev", "x.pages.dev"],
    ["x.blogspot.com", "x.blogspot.com"],
    ["x.appspot.com", "x.appspot.com"],
    ["x.web.app", "x.web.app"],
    ["a.co.th", "a.co.th"],
    ["a.com.ph", "a.com.ph"],
    ["a.com.vn", "a.com.vn"],
    ["a.com.pk", "a.com.pk"],
    ["a.com.ng", "a.com.ng"],
    ["a.com.eg", "a.com.eg"],
    ["a.com.sa", "a.com.sa"],
    ["a.co.ke", "a.co.ke"],
    ["a.me.uk", "a.me.uk"],
    ["a.ltd.uk", "a.ltd.uk"],
  ])("%s is its own site %s", (host, domain) => {
    expect(domainOfCookie(host)).toBe(domain);
  });

  // Near misses: they share a word with google.com and must be their own sites.
  it.each([
    ["evil-google.com", "evil-google.com"],
    [".google.com.evil.io", "evil.io"],
    ["googlecom.net", "googlecom.net"],
    ["mygoogle.com", "mygoogle.com"],
    ["google.co.uk", "google.co.uk"],
  ])("%s is %s, not google.com", (host, domain) => {
    expect(domainOfCookie(host)).toBe(domain);
    expect(domainOfCookie(host)).not.toBe("google.com");
  });

  it.each([
    "",
    "evil host.com",
    "a/b.com",
    "a..b.com",
    "-x.com",
    "x_y.com",
    "über.de",
    // A bare public suffix is never a site; neither is an IP address.
    "com.my",
    ".co.uk",
    "github.io",
    "com",
    "127.0.0.1",
  ])("drops an unusable host %j", (host) => {
    expect(domainOfCookie(host)).toBeUndefined();
  });

  it("two banks and a shop under one public suffix are separate rows", () => {
    const sites = sitesOf(
      groupByDomain([
        cookie(".maybank2u.com.my"),
        cookie(".shopee.com.my"),
        cookie("alice.github.io"),
        cookie("evil.github.io"),
      ]),
    );
    expect(sites.map((s) => [s.domain, s.sensitive])).toEqual([
      ["alice.github.io", null],
      ["evil.github.io", null],
      ["maybank2u.com.my", "bank"],
      ["shopee.com.my", null],
    ]);
  });

  it("counts cookies per site, lists the hosts and judges each host", () => {
    const sites = sitesOf(
      groupByDomain([
        cookie(".mail.google.com"),
        cookie("accounts.google.com", "a"),
        cookie(".google.com", "b"),
        cookie(".evil-google.com"),
        cookie("bad host"),
      ]),
    );
    expect(sites).toEqual([
      { domain: "evil-google.com", hosts: ["evil-google.com"], cookies: 1, sensitive: null },
      {
        domain: "google.com",
        hosts: ["accounts.google.com", "google.com", "mail.google.com"],
        cookies: 3,
        sensitive: "email",
      },
    ]);
  });

  it("a row is sensitive when any one host in it is", () => {
    expect(siteSensitivity(["www.example.com", "bank.example.com"])).toBeNull();
    expect(siteSensitivity(["www.chase.com", "static.chase.com"])).toBe("bank");
    expect(siteSensitivity(["gist.github.com", "x.github.com"])).toBe("signin");
    // The strongest kind wins.
    expect(siteSensitivity(["accounts.google.com", "mail.google.com"])).toBe("email");
  });
});

describe("sensitive sites", () => {
  // Must warn: [host, kind]. The reviewer's table for PR #1508 and the original lists.
  it.each([
    ["chase.com", "bank"],
    ["www.chase.com", "bank"],
    ["bankofamerica.com", "bank"],
    ["hsbc.co.uk", "bank"],
    ["example.bank", "bank"],
    ["www.usaa.com", "bank"],
    ["www.navyfederal.org", "bank"],
    ["www.citizensbank.com", "bank"],
    ["www.keybank.com", "bank"],
    ["www.regions.com", "bank"],
    ["www.53.com", "bank"],
    ["www.synchrony.com", "bank"],
    ["www.nwolb.com", "bank"],
    ["online.lloydsbank.co.uk", "bank"],
    ["www.halifax-online.co.uk", "bank"],
    ["www.nationwide.co.uk", "bank"],
    ["banking.ing.de", "bank"],
    ["www.dkb.de", "bank"],
    ["www.comdirect.de", "bank"],
    ["www.postbank.de", "bank"],
    ["www.sparkasse-koelnbonn.de", "bank"],
    ["retail.onlinesbi.sbi", "bank"],
    ["www.maybank2u.com.my", "bank"],
    ["www.bca.co.id", "bank"],
    ["www.bancolombia.com.co", "bank"],
    ["ibank.klikbca.com", "bank"],
    ["www.bbva.mx", "bank"],
    ["www.etrade.com", "bank"],
    ["crypto.com", "payment"],
    ["www.gemini.com", "payment"],
    ["www.amazon.com", "payment"],
    ["paypal.com", "payment"],
    ["stripe.com", "payment"],
    ["coinbase.com", "payment"],
    ["vault.bitwarden.com", "passwords"],
    ["1password.com", "passwords"],
    ["lastpass.com", "passwords"],
    ["lastpass.eu", "passwords"],
    ["google.com", "email"],
    ["pay.google.com", "email"],
    ["outlook.office365.com", "email"],
    ["account.microsoft.com", "email"],
    ["mail.yahoo.co.jp", "email"],
    ["mail.zoho.eu", "email"],
    ["outlook.com", "email"],
    ["proton.me", "email"],
    ["icloud.com", "email"],
    ["acme.okta.com", "signin"],
    ["github.com", "signin"],
    ["gist.github.com", "signin"],
    ["accounts.google.com", "signin"],
    ["login.microsoftonline.com", "signin"],
  ])("%s is %s", (host, kind) => {
    expect(sensitiveKind(host)).toBe(kind);
  });

  // Must NOT warn: a shared word, a lookalike or a longer name, but not the sensitive site.
  it.each([
    "food-bank.org",
    "bank-holidays.co.uk",
    "piggy-bank.toys",
    "paypal-login.com",
    "evil-google.com",
    "chase.com.evil.net",
    "bankrate.com",
    "news.ycombinator.com",
    "xn--pypal-4ve.com",
    "chase-tickets.com",
    "databank.io",
    "embankment.co.uk",
    "1password.community.example",
    "gmail.example.com",
    "stripes.com",
    "outlooks.com",
    "alice.github.io",
    "github.com.evil.io",
    "shopee.com.my",
  ])("%s is not flagged", (host) => {
    expect(sensitiveKind(host)).toBeNull();
  });

  it("flags every domain the financial hard block knows as a venue, with www and a subdomain", () => {
    const missed = venueDomains().filter(
      (d) =>
        sensitiveKind(d) === null ||
        sensitiveKind(`www.${d}`) === null ||
        sensitiveKind(`secure.login.${d}`) === null,
    );
    expect(missed).toEqual([]);
    expect(venueDomains().length).toBeGreaterThan(150);
  });
});
