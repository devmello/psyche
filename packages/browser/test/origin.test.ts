import { describe, expect, it } from "vitest";
import {
  canonicalizeUrl,
  classifyHost,
  matchesPattern,
  parseOriginPattern,
  schemeOf,
  tryOrigin,
} from "../src/origin/canonical.ts";
import { OriginPolicy, type PolicyVerdict } from "../src/origin/policy.ts";
import {
  ChainedReputation,
  LocalBlocklist,
  type ReputationCheck,
  type ReputationVerdict,
} from "../src/origin/reputation.ts";

function reasonOf(raw: string): string | undefined {
  try {
    canonicalizeUrl(raw);
    return undefined;
  } catch (err) {
    return (err as { details?: { reason?: string } }).details?.reason;
  }
}

function denyReason(v: PolicyVerdict): string | undefined {
  return v.action === "deny" ? v.reason : undefined;
}

describe("canonicalizeUrl", () => {
  it("lowercases hosts and schemes", () => {
    const c = canonicalizeUrl("HTTPS://ExAmPlE.CoM/Path");
    expect(c.origin).toBe("https://example.com");
    expect(c.scheme).toBe("https");
    expect(c.host).toBe("example.com");
    expect(c.pathname).toBe("/Path");
  });

  it("IDNA-normalizes: bücher.de equals xn--bcher-kva.de", () => {
    expect(tryOrigin("https://bücher.de")).toBe("https://xn--bcher-kva.de");
    expect(tryOrigin("https://BÜCHER.DE.")).toBe("https://xn--bcher-kva.de");
    expect(tryOrigin("https://xn--bcher-kva.de")).toBe("https://xn--bcher-kva.de");
    expect(tryOrigin("https://XN--BCHER-KVA.de")).toBe("https://xn--bcher-kva.de");
  });

  it("folds fullwidth and ideographic-dot hosts like the browser does", () => {
    expect(tryOrigin("https://example。com")).toBe("https://example.com");
    expect(tryOrigin("https://ＬＯＣＡＬＨＯＳＴ")).toBe("https://localhost");
  });

  it("removes a single trailing dot", () => {
    expect(tryOrigin("https://example.com./")).toBe("https://example.com");
    expect(canonicalizeUrl("https://example.com.").host).toBe("example.com");
    expect(tryOrigin("http://127.0.0.1./")).toBe("http://127.0.0.1");
  });

  it("rejects double trailing dots and empty labels instead of keeping a dot", () => {
    expect(reasonOf("https://example.com../")).toBe("invalid_url");
    expect(reasonOf("http://localhost../")).toBe("invalid_url");
    expect(reasonOf("https://a..example.com/")).toBe("invalid_url");
  });

  it("strips default ports and keeps explicit ones", () => {
    expect(tryOrigin("https://a.com:443")).toBe("https://a.com");
    expect(tryOrigin("https://a.com:0443/")).toBe("https://a.com");
    expect(tryOrigin("http://a.com:80")).toBe("http://a.com");
    expect(tryOrigin("http://a.com:443")).toBe("http://a.com:443");
    expect(tryOrigin("https://a.com:80")).toBe("https://a.com:80");
    expect(tryOrigin("http://a.com:443")).not.toBe(tryOrigin("https://a.com"));
    expect(canonicalizeUrl("https://a.com").port).toBe(443);
    expect(canonicalizeUrl("http://a.com").port).toBe(80);
    expect(canonicalizeUrl("https://a.com:8443").port).toBe(8443);
  });

  it("rejects userinfo (CVE-2025-47241)", () => {
    expect(reasonOf("https://good.com@evil.com")).toBe("userinfo");
    expect(reasonOf("https://user:pass@good.com")).toBe("userinfo");
    expect(reasonOf("https://:pass@good.com")).toBe("userinfo");
    expect(reasonOf("https://good.com:443@evil.com")).toBe("userinfo");
    expect(reasonOf("https://good.com%40@evil.com")).toBe("userinfo");
    expect(reasonOf("https:good.com@evil.com")).toBe("userinfo");
    expect(reasonOf("https:/good.com@evil.com")).toBe("userinfo");
  });

  it("rejects percent-encoded @ in the host", () => {
    expect(tryOrigin("https://evil.com%40good.com")).toBeUndefined();
    expect(tryOrigin("https://good.com%2540evil.com")).toBeUndefined();
  });

  it("resolves backslash tricks to the host the browser would visit", () => {
    // `\` is `/` in special schemes: the host is good.com, `@evil.com` is the path.
    const a = canonicalizeUrl("https://good.com\\@evil.com");
    expect(a.host).toBe("good.com");
    expect(a.pathname).toBe("/@evil.com");
    expect(tryOrigin("https:\\\\evil.com")).toBe("https://evil.com");
    expect(tryOrigin("https:/\\evil.com/")).toBe("https://evil.com");
  });

  it("rejects whitespace and control characters anywhere", () => {
    for (const raw of [
      " https://a.com",
      "https://a.com ",
      "https://a .com",
      "https://a.com/\tx",
      "https://ev\til.com",
      "https://ev\nil.com",
      "https://ev\ril.com",
      "java\nscript:alert(1)",
      "https://a.com/\u0000",
      "https://a.com\u007f",
      "https://a.com/ ",
      "https://a.com/ ",
      "\u0001https://a.com",
    ]) {
      expect(reasonOf(raw), JSON.stringify(raw)).toBe("invalid_url");
    }
  });

  it("rejects empty, relative and oversize input", () => {
    expect(reasonOf("")).toBe("invalid_url");
    expect(reasonOf("//evil.com/")).toBe("invalid_url");
    expect(reasonOf("/path")).toBe("invalid_url");
    expect(reasonOf("evil.com")).toBe("invalid_url");
    expect(reasonOf(`https://a.com/${"x".repeat(9000)}`)).toBe("invalid_url");
    expect(reasonOf("https://")).toBe("invalid_url");
  });

  it("blocks non-http(s) schemes", () => {
    for (const raw of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html,<script>1</script>",
      "file:///etc/passwd",
      "about:blank",
      "chrome://settings",
      "chrome-extension://abc/x.html",
      "devtools://devtools/bundled/inspector.html",
      "view-source:https://a.com",
      "blob:https://a.com/uuid",
      "filesystem:https://a.com/temporary/x",
      "ws://a.com",
      "wss://a.com",
      "ftp://a.com",
      "mailto:a@b.com",
      "intent://x#Intent;end",
      "gopher://a.com",
    ]) {
      expect(reasonOf(raw), raw).toBe("blocked_scheme");
    }
  });

  it("schemeOf lowercases and handles absent schemes", () => {
    expect(schemeOf("HTTPS://a")).toBe("https:");
    expect(schemeOf("view-source:x")).toBe("view-source:");
    expect(schemeOf("a.com/x")).toBeUndefined();
  });

  it("folds numeric IPv4 forms", () => {
    for (const raw of [
      "http://0x7f.1",
      "http://2130706433",
      "http://017700000001",
      "http://0x7f000001",
      "http://127.1",
      "http://0177.0.0.1",
    ]) {
      const c = canonicalizeUrl(raw);
      expect(c.host, raw).toBe("127.0.0.1");
      expect(c.hostKind, raw).toBe("ipv4");
    }
  });

  it("normalizes IPv6 and drops brackets from host", () => {
    const c = canonicalizeUrl("http://[0:0:0:0:0:0:0:1]:8080/");
    expect(c.host).toBe("::1");
    expect(c.hostKind).toBe("ipv6");
    expect(c.origin).toBe("http://[::1]:8080");
    expect(canonicalizeUrl("http://[::ffff:127.0.0.1]").host).toBe("::ffff:7f00:1");
  });

  it("href carries the canonical host and keeps the fragment", () => {
    expect(canonicalizeUrl("https://Example.com.:443/a?b=1#c").href).toBe(
      "https://example.com/a?b=1#c",
    );
  });
});

describe("classifyHost", () => {
  const cls = (raw: string) => {
    const c = canonicalizeUrl(raw);
    return classifyHost(c.host, c.hostKind);
  };

  it("loopback names and addresses", () => {
    for (const raw of [
      "http://localhost",
      "http://LOCALHOST.",
      "http://app.localhost:3000",
      "http://127.0.0.1",
      "http://127.255.1.2",
      "http://0x7f.1",
      "http://[::1]",
      "http://[::ffff:127.0.0.1]",
      "http://[::ffff:0:127.0.0.1]",
      "http://[::127.0.0.1]",
      "http://0.0.0.0",
      "http://0",
      "http://[::]",
    ]) {
      expect(cls(raw), raw).toEqual({ loopback: true, private: true });
    }
  });

  it("private ranges", () => {
    for (const raw of [
      "http://10.0.0.1",
      "http://10.255.255.255",
      "http://172.16.0.1",
      "http://172.31.255.255",
      "http://192.168.1.1",
      "http://169.254.169.254",
      "http://100.64.0.1",
      "http://100.127.255.255",
      "http://224.0.0.1",
      "http://255.255.255.255",
      "http://[fc00::1]",
      "http://[fd12:3456::1]",
      "http://[fe80::1]",
      "http://[febf::1]",
      "http://[ff02::1]",
      "http://[::ffff:10.0.0.1]",
      "http://[::ffff:169.254.169.254]",
      "http://[::ffff:192.168.0.1]",
      "http://printer.local",
      "http://db.internal",
      "http://nas.lan",
      "http://router.home.arpa",
      "http://intranet",
      "http://wiki.corp",
    ]) {
      const n = cls(raw);
      expect(n.private, raw).toBe(true);
      expect(n.loopback, raw).toBe(false);
    }
  });

  it("public neighbours of private ranges", () => {
    for (const raw of [
      "http://172.15.255.255",
      "http://172.32.0.1",
      "http://100.63.255.255",
      "http://100.128.0.1",
      "http://11.0.0.1",
      "http://192.169.0.1",
      "http://169.255.0.1",
      "http://8.8.8.8",
      "http://[2001:4860:4860::8888]",
      "http://[::ffff:8.8.8.8]",
      "https://example.com",
      "https://localhost.example.com",
      "https://local.example.com",
      "https://example.localdomain.com",
    ]) {
      expect(cls(raw), raw).toEqual({ loopback: false, private: false });
    }
  });
});

describe("origin patterns", () => {
  const m = (url: string, pattern: string) =>
    matchesPattern(canonicalizeUrl(url), parseOriginPattern(pattern));

  it("bare host patterns default to https and the default port", () => {
    const p = parseOriginPattern("Example.COM.");
    expect(p).toMatchObject({ scheme: "https", host: "example.com", port: 443, subdomains: false });
    expect(p.text).toBe("https://example.com");
    expect(m("https://example.com/x", "example.com")).toBe(true);
    expect(m("http://example.com/x", "example.com")).toBe(false);
  });

  it("wildcards cover strict subdomains only", () => {
    expect(m("https://example.com", "*.example.com")).toBe(false);
    expect(m("https://a.example.com", "*.example.com")).toBe(true);
    expect(m("https://a.b.example.com", "https://*.example.com")).toBe(true);
    expect(m("https://A.EXAMPLE.COM.", "*.example.com")).toBe(true);
    expect(parseOriginPattern("HTTPS://*.Example.com").text).toBe("https://*.example.com");
  });

  it("subdomains are separate without a wildcard", () => {
    expect(m("https://www.example.com", "example.com")).toBe(false);
    expect(m("https://example.com", "www.example.com")).toBe(false);
  });

  it("lookalike suffixes and prefixes never match", () => {
    for (const pattern of ["example.com", "*.example.com"]) {
      expect(m("https://evilexample.com", pattern)).toBe(false);
      expect(m("https://example.com.evil.com", pattern)).toBe(false);
      expect(m("https://a.example.com.evil.com", pattern)).toBe(false);
      expect(m("https://example.co", pattern)).toBe(false);
      expect(m("https://xexample.com", pattern)).toBe(false);
    }
  });

  it("scheme and port must match", () => {
    expect(m("http://a.com", "https://a.com")).toBe(false);
    expect(m("https://a.com:8443", "https://a.com")).toBe(false);
    expect(m("https://a.com:443", "https://a.com")).toBe(true);
    expect(m("https://a.com", "https://a.com:443")).toBe(true);
    expect(m("http://a.com:443", "https://a.com")).toBe(false);
    expect(m("http://localhost:5173", "http://localhost:5173")).toBe(true);
    expect(m("http://localhost:5174", "http://localhost:5173")).toBe(false);
  });

  it("IDN patterns match punycode URLs and vice versa", () => {
    expect(m("https://xn--bcher-kva.de", "bücher.de")).toBe(true);
    expect(m("https://bücher.de", "xn--bcher-kva.de")).toBe(true);
    expect(m("https://shop.xn--bcher-kva.de", "*.bücher.de")).toBe(true);
  });

  it("wildcards never match IP addresses", () => {
    expect(() => parseOriginPattern("https://*.127.0.0.1")).toThrow();
    expect(() => parseOriginPattern("http://*.[::1]")).toThrow();
    expect(() => parseOriginPattern("https://*.2.3.4")).toThrow();
    expect(m("https://1.2.3.4", "https://2.3.4")).toBe(false);
  });

  it("rejects bad patterns", () => {
    expect(() => parseOriginPattern("https://a.com/path")).toThrow();
    expect(() => parseOriginPattern("https://user@a.com")).toThrow();
    expect(() => parseOriginPattern("javascript:alert(1)")).toThrow();
    expect(() => parseOriginPattern("file:///etc")).toThrow();
    expect(() => parseOriginPattern("ws://a.com")).toThrow();
    expect(() => parseOriginPattern("")).toThrow();
  });

  it("a lone or malformed star is a literal host, never a match-all", () => {
    for (const raw of ["https://*", "https://*.", "*"]) {
      const p = parseOriginPattern(raw);
      expect(p.subdomains, raw).toBe(false);
      expect(matchesPattern(canonicalizeUrl("https://example.com"), p), raw).toBe(false);
    }
  });
});

describe("OriginPolicy", () => {
  const set = {
    readOnly: ["docs.example.com", "*.wiki.org"],
    readWritable: ["https://app.example.com"],
  };

  it("allows set members with their access and approves everything else", () => {
    const p = new OriginPolicy(set);
    expect(p.evaluateSync("https://docs.example.com/x")).toMatchObject({
      action: "allow",
      access: "read",
    });
    expect(p.evaluateSync("https://en.wiki.org/")).toMatchObject({
      action: "allow",
      access: "read",
    });
    expect(p.evaluateSync("https://app.example.com:443/")).toMatchObject({
      action: "allow",
      access: "write",
    });
    for (const raw of [
      "https://wiki.org/",
      "https://example.com/",
      "https://evilexample.com/",
      "https://docs.example.com.evil.com/",
      "http://docs.example.com/",
      "https://docs.example.com:8443/",
      "https://good.com\\@evil.com",
    ]) {
      expect(p.evaluateSync(raw), raw).toMatchObject({ action: "approve", reason: "new_origin" });
    }
  });

  it("an empty policy never allows", () => {
    const v = new OriginPolicy().evaluateSync("https://example.com");
    expect(v.action).toBe("approve");
  });

  it("denies userinfo even when the visible host is in the set", () => {
    const p = new OriginPolicy({ readWritable: ["good.com", "evil.com"] });
    expect(denyReason(p.evaluateSync("https://good.com@evil.com"))).toBe("userinfo");
    expect(denyReason(p.evaluateSync("https://evil.com%40good.com"))).toBe("invalid_url");
  });

  it("denies blocked schemes and malformed input with a reason", () => {
    const p = new OriginPolicy(set);
    for (const raw of ["javascript:alert(1)", "about:blank", "chrome://settings", "data:,x"]) {
      expect(denyReason(p.evaluateSync(raw)), raw).toBe("blocked_scheme");
    }
    expect(denyReason(p.evaluateSync("https://docs.example.com\n.evil.com"))).toBe("invalid_url");
    expect(denyReason(p.evaluateSync("not a url"))).toBe("invalid_url");
  });

  it("denies loopback unless devPreview, even when granted", () => {
    const loopbacks = [
      "http://localhost:5173",
      "http://LOCALHOST.:5173",
      "http://app.localhost",
      "http://127.0.0.1:8080",
      "http://127.0.0.2",
      "http://0x7f.1",
      "http://2130706433",
      "http://017700000001",
      "http://[::1]:3000",
      "http://[::ffff:127.0.0.1]",
      "http://[::127.0.0.1]",
      "http://0.0.0.0:5173",
      "http://localhost../",
    ];
    const p = new OriginPolicy({
      readWritable: ["http://localhost:5173", "http://127.0.0.1:8080"],
      allowPrivateNetwork: true,
    });
    for (const raw of loopbacks) {
      expect(p.evaluateSync(raw).action, raw).toBe("deny");
    }
    expect(denyReason(p.evaluateSync("http://localhost:5173"))).toBe("loopback");
    expect(denyReason(p.evaluateSync("http://0.0.0.0:5173"))).toBe("loopback");
  });

  it("devPreview allows loopback as read-writable", () => {
    const p = new OriginPolicy({ devPreview: true });
    expect(p.devPreview).toBe(true);
    for (const raw of [
      "http://localhost:5173",
      "http://127.0.0.1:8080",
      "http://[::1]:3000",
      "http://0.0.0.0:3000",
    ]) {
      expect(p.evaluateSync(raw), raw).toMatchObject({ action: "allow", access: "write" });
    }
    // Named *.localhost hosts are allowed but need a set entry.
    expect(p.evaluateSync("http://app.localhost").action).toBe("approve");
    // devPreview is not a private-network grant.
    expect(denyReason(p.evaluateSync("http://192.168.1.10:3000"))).toBe("private_network");
    expect(p.evaluateSync("https://example.com").action).toBe("approve");
  });

  it("blocks private networks by default, even when granted", () => {
    const privates = [
      "http://10.0.0.1",
      "http://172.16.5.4",
      "http://192.168.0.1",
      "http://169.254.169.254/latest/meta-data/",
      "http://100.64.0.1",
      "http://[fc00::1]",
      "http://[fe80::1]",
      "http://[::ffff:169.254.169.254]",
      "http://[::ffff:0:a00:1]",
      "http://printer.local",
      "http://intranet",
      "https://db.internal",
    ];
    const p = new OriginPolicy({ readWritable: ["http://10.0.0.1", "printer.local"] });
    for (const raw of privates) {
      expect(denyReason(p.evaluateSync(raw)), raw).toBe("private_network");
    }
    const lan = new OriginPolicy({ readWritable: ["http://10.0.0.1"], allowPrivateNetwork: true });
    expect(lan.evaluateSync("http://10.0.0.1")).toMatchObject({ action: "allow" });
    expect(lan.evaluateSync("http://192.168.0.1").action).toBe("approve");
    expect(denyReason(lan.evaluateSync("http://127.0.0.1"))).toBe("loopback");
  });

  it("deny rules beat grants and devPreview", () => {
    const p = new OriginPolicy({
      readWritable: ["https://app.example.com", "*.example.com", "http://localhost:5173"],
      deny: ["app.example.com", "http://localhost:5173"],
      devPreview: true,
    });
    expect(denyReason(p.evaluateSync("https://app.example.com/"))).toBe("deny_rule");
    expect(denyReason(p.evaluateSync("https://APP.example.com./"))).toBe("deny_rule");
    expect(denyReason(p.evaluateSync("http://localhost:5173"))).toBe("deny_rule");
    expect(p.evaluateSync("https://other.example.com")).toMatchObject({ action: "allow" });
    const wild = new OriginPolicy({ readWritable: ["example.com"], deny: ["*.example.com"] });
    expect(denyReason(wild.evaluateSync("https://a.b.example.com"))).toBe("deny_rule");
    expect(wild.evaluateSync("https://example.com").action).toBe("allow");
  });

  it("grant upgrades read to write but never downgrades", () => {
    const p = new OriginPolicy({ readOnly: ["example.com"] });
    expect(p.evaluateSync("https://example.com")).toMatchObject({ access: "read" });
    p.grant("https://EXAMPLE.com:443", "write");
    expect(p.evaluateSync("https://example.com")).toMatchObject({ access: "write" });
    p.grant("example.com", "read");
    expect(p.evaluateSync("https://example.com")).toMatchObject({ access: "write" });
    expect(p.describe()).toEqual({ readOnly: [], readWritable: ["https://example.com"] });
  });

  it("the most permissive matching entry wins", () => {
    const p = new OriginPolicy({ readOnly: ["a.example.com"], readWritable: ["*.example.com"] });
    expect(p.evaluateSync("https://a.example.com")).toMatchObject({ access: "write" });
  });

  it("describe lists normalized pattern texts", () => {
    const p = new OriginPolicy({
      readOnly: ["Docs.Example.com.", "*.bücher.de"],
      readWritable: ["http://localhost:5173"],
    });
    expect(p.describe()).toEqual({
      readOnly: ["https://docs.example.com", "https://*.xn--bcher-kva.de"],
      readWritable: ["http://localhost:5173"],
    });
  });

  it("evaluate applies reputation after hard rules", async () => {
    const reputation = new LocalBlocklist(["evil.com"]);
    const p = new OriginPolicy({ readWritable: ["sub.evil.com"], reputation });
    const v = await p.evaluate("https://sub.evil.com/x", "redirect");
    expect(denyReason(v)).toBe("reputation");
    expect(await p.evaluate("https://ok.com")).toMatchObject({ action: "approve" });
    expect(denyReason(await p.evaluate("javascript:1"))).toBe("blocked_scheme");
  });

  it("evaluate without reputation equals evaluateSync", async () => {
    const p = new OriginPolicy(set);
    expect(await p.evaluate("https://docs.example.com")).toEqual(
      p.evaluateSync("https://docs.example.com"),
    );
  });
});

describe("LocalBlocklist", () => {
  it("blocks the host and every subdomain, not lookalikes", async () => {
    const b = new LocalBlocklist(["Evil.Example.", " bad.org "]);
    expect(b.has("evil.example")).toBe(true);
    expect(b.has("a.b.evil.example")).toBe(true);
    expect(b.has("EVIL.EXAMPLE")).toBe(true);
    expect(b.has("notevil.example")).toBe(false);
    expect(b.has("example")).toBe(false);
    expect(b.has("evil.example.com")).toBe(false);
    expect(b.has("bad.org")).toBe(true);
    expect(await b.check("https://x.bad.org:8443/path")).toBe("block");
    expect(await b.check("https://good.org")).toBe("ok");
  });

  it("IDNA-normalizes entries and lookups", async () => {
    const b = new LocalBlocklist(["bücher.de"]);
    expect(b.has("xn--bcher-kva.de")).toBe(true);
    expect(await b.check("https://shop.xn--bcher-kva.de")).toBe("block");
    const c = new LocalBlocklist(["xn--bcher-kva.de"]);
    expect(c.has("bücher.de")).toBe(true);
    expect(await c.check("https://BÜCHER.de")).toBe("block");
  });

  it("add extends the list and ignores empty entries", () => {
    const b = new LocalBlocklist();
    b.add("  ");
    b.add(".");
    expect(b.has("com")).toBe(false);
    b.add("evil.com");
    expect(b.has("www.evil.com")).toBe(true);
  });
});

describe("ChainedReputation", () => {
  class FakeRemote implements ReputationCheck {
    calls: string[] = [];
    readonly #result: ReputationVerdict | Error;
    constructor(result: ReputationVerdict | Error) {
      this.#result = result;
    }
    async check(origin: string): Promise<ReputationVerdict> {
      this.calls.push(origin);
      if (this.#result instanceof Error) throw this.#result;
      return this.#result;
    }
  }

  it("local block short-circuits the remote", async () => {
    const remote = new FakeRemote("ok");
    const r = new ChainedReputation({
      local: new LocalBlocklist(["evil.com"]),
      remote,
      remoteEnabled: true,
    });
    expect(await r.check("https://evil.com")).toBe("block");
    expect(remote.calls).toEqual([]);
  });

  it("never calls the remote unless enabled", async () => {
    const remote = new FakeRemote("block");
    const off = new ChainedReputation({ local: new LocalBlocklist(), remote });
    expect(await off.check("https://a.com")).toBe("ok");
    const disabled = new ChainedReputation({
      local: new LocalBlocklist(),
      remote,
      remoteEnabled: false,
    });
    expect(await disabled.check("https://a.com")).toBe("ok");
    expect(remote.calls).toEqual([]);
    const noRemote = new ChainedReputation({ local: new LocalBlocklist(), remoteEnabled: true });
    expect(await noRemote.check("https://a.com")).toBe("ok");
  });

  it("passes only the origin to the remote and caches answers", async () => {
    const remote = new FakeRemote("block");
    const r = new ChainedReputation({ local: new LocalBlocklist(), remote, remoteEnabled: true });
    const p = new OriginPolicy({ reputation: r });
    expect(denyReason(await p.evaluate("https://a.com/secret?q=1#f"))).toBe("reputation");
    expect(await r.check("https://a.com")).toBe("block");
    expect(remote.calls).toEqual(["https://a.com"]);
  });

  it("fails open by default and closed when asked", async () => {
    const open = new ChainedReputation({
      local: new LocalBlocklist(),
      remote: new FakeRemote(new Error("timeout")),
      remoteEnabled: true,
    });
    expect(await open.check("https://a.com")).toBe("unknown");
    const p = new OriginPolicy({ readOnly: ["a.com"], reputation: open });
    expect(await p.evaluate("https://a.com")).toMatchObject({ action: "allow" });

    const closed = new ChainedReputation({
      local: new LocalBlocklist(),
      remote: new FakeRemote(new Error("timeout")),
      remoteEnabled: true,
      failClosed: true,
    });
    expect(await closed.check("https://a.com")).toBe("block");
  });

  it("does not cache remote failures", async () => {
    let fail = true;
    const remote: ReputationCheck = {
      async check() {
        if (fail) throw new Error("transient");
        return "block";
      },
    };
    const r = new ChainedReputation({ local: new LocalBlocklist(), remote, remoteEnabled: true });
    expect(await r.check("https://a.com")).toBe("unknown");
    fail = false;
    expect(await r.check("https://a.com")).toBe("block");
  });
});

describe("deny rules ignore scheme and port", () => {
  it("denies http and non-default ports of a denied host", async () => {
    const { OriginPolicy } = await import("../src/origin/policy.ts");
    const p = new OriginPolicy({
      readWritable: ["http://example.com:8443"],
      deny: ["example.com"],
    });
    expect(p.evaluateSync("http://example.com:8443/").action).toBe("deny");
    expect(p.evaluateSync("http://example.com/").action).toBe("deny");
  });
});
