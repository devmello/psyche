import { describe, expect, it } from "vitest";
import {
  domainOfCookie,
  groupByDomain,
  sensitiveKind,
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

describe("grouping by registrable domain", () => {
  // Hosts that belong to the site.
  it.each([
    [".google.com", "google.com"],
    ["mail.google.com", "google.com"],
    ["accounts.google.com", "google.com"],
    [".www.bbc.co.uk", "bbc.co.uk"],
    ["canvas.ucsc.edu", "ucsc.edu"],
    ["GitHub.com", "github.com"],
  ])("%s is %s", (host, domain) => {
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

  it.each(["", "evil host.com", "a/b.com", "a..b.com", "-x.com", "x_y.com", "über.de"])(
    "drops an unusable host %j",
    (host) => {
      expect(domainOfCookie(host)).toBeUndefined();
    },
  );

  it("counts cookies per site and lists the hosts", () => {
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
});

describe("sensitive sites", () => {
  it.each([
    ["chase.com", "bank"],
    ["bankofamerica.com", "bank"],
    ["hsbc.co.uk", "bank"],
    ["example.bank", "bank"],
    ["first-bank.com", "bank"],
    ["bank-austria.at", "bank"],
    ["paypal.com", "payment"],
    ["stripe.com", "payment"],
    ["coinbase.com", "payment"],
    ["1password.com", "passwords"],
    ["bitwarden.com", "passwords"],
    ["lastpass.com", "passwords"],
    ["google.com", "email"],
    ["outlook.com", "email"],
    ["proton.me", "email"],
    ["icloud.com", "email"],
  ])("%s is %s", (domain, kind) => {
    expect(sensitiveKind(domain)).toBe(kind);
  });

  // Near misses: a shared word, but not the sensitive site itself.
  it.each([
    "evil-google.com",
    "paypal-login.com",
    "chase-tickets.com",
    "bankrate.com",
    "databank.io",
    "embankment.co.uk",
    "1password.community.example",
    "gmail.example.com",
    "github.com",
    "stripes.com",
    "outlooks.com",
  ])("%s is not flagged", (domain) => {
    expect(sensitiveKind(domain)).toBeNull();
  });
});
