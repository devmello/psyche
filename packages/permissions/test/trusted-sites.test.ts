import { describe, expect, it } from "vitest";
import {
  compilePolicy,
  DEFAULT_SENSITIVE_ORIGINS,
  isSensitiveHost,
  normalizeTrustedSite,
  type PolicyCall,
  type PolicyContext,
  trustedSiteCovers,
} from "../src/index.ts";
import { CTX, call, DEVICE, type Harness, makeBroker, origin } from "./helpers.ts";

/**
 * Trusted sites (security §3.2): "Always for this site" on a first-read card. Two-way tables:
 * what must NOT ask for a trusted origin, and what must still ask, each with a positive control
 * (the same call is allowed on the exact trusted origin, so a broken feature cannot pass).
 */

const SITE = "https://docs.example.org";
const TASK2: PolicyContext = { ...CTX, taskId: "task_2", runId: "run_2" };

const nav = (url: string): PolicyCall =>
  call("browser.navigate", "read", origin(url), { kind: "new_origin", params: { url } });
const snapshot = (url: string) => call("browser.snapshot", "read", origin(url));
const readText = (url: string) => call("browser.read_text", "read", origin(url));
const fetchGet = (url: string, method?: string) =>
  call("web_fetch", "read", origin(url), {
    params: { url, ...(method === undefined ? {} : { method }) },
  });
const click = (url: string) => call("browser.click", "write", origin(url));

/** First read asked, the owner picks "Always for this site"; returns the answered approval. */
async function trust(
  h: Harness,
  url = SITE,
  choice: "origin" | "subdomains" = "origin",
  ctx: PolicyContext = CTX,
) {
  const c = nav(url);
  const d = await h.broker.decide(c, ctx);
  if (d.decision !== "ask" || d.approvalKind === undefined) throw new Error(`no ask: ${d.rule}`);
  const issued = await h.broker.requestApproval({
    kind: d.approvalKind,
    summary: "open site",
    details: {},
    bindingHash: d.bindingHash ?? "",
    grantKey: d.grantKey ?? "",
    requestedBy: { runId: ctx.runId, taskId: ctx.taskId ?? null, threadId: ctx.threadId },
    sideEffect: "read",
    target: origin(url),
    surfaces: ["desktop"],
    taint: ctx.taint,
  });
  h.clock.advance(500);
  const approval = await h.broker.answer({
    approvalId: issued.approval.id,
    answerToken: issued.answerTokens.desktop ?? "",
    decision: "approve",
    scope: "once",
    trustSite: choice,
    decidedBy: DEVICE,
  });
  return { issued, approval };
}

describe("normalizeTrustedSite: exact, canonical, never a shared suffix", () => {
  const OK: [string, string][] = [
    ["https://example.org", "https://example.org"],
    ["https://Example.ORG/some/path?q=1", "https://example.org"],
    ["https://example.org:8443/x", "https://example.org:8443"],
    ["http://example.org", "http://example.org"],
    ["https://example.org:443", "https://example.org"],
    ["https://example.org.", "https://example.org"],
    ["https://bücher.de", "https://xn--bcher-kva.de"],
  ];
  it.each(OK)("accepts %s as %s", (input, want) => {
    expect(normalizeTrustedSite(input).origin).toBe(want);
    expect(normalizeTrustedSite(input, true).origin).toBe(want);
  });

  const REFUSED = [
    "http://localhost:3000",
    "https://app.localhost",
    "http://127.0.0.1",
    "http://127.1",
    "http://2130706433",
    "http://[::1]",
    "https://10.0.0.5",
    "https://8.8.8.8",
    "https://intranet",
    "https://co.uk",
    "https://com.au",
    "https://github.io",
    "https://vercel.app",
    "ftp://example.org",
    "file:///etc/passwd",
    "not a url",
    "https://user:pw@example.org",
  ];
  it.each(REFUSED)("refuses %s", (input) => {
    expect(() => normalizeTrustedSite(input)).toThrow();
    expect(() => normalizeTrustedSite(input, true)).toThrow();
  });

  it("positive control: the same shape with a real name is accepted", () => {
    expect(() => normalizeTrustedSite("https://project.github.io")).not.toThrow();
    expect(() => normalizeTrustedSite("https://example.co.uk", true)).not.toThrow();
  });
});

describe("trustedSiteCovers", () => {
  const exact = normalizeTrustedSite("https://example.org");
  const wide = normalizeTrustedSite("https://example.org", true);
  const COVERED: [string, string, string][] = [
    ["exact", "https://example.org", "exact"],
    ["exact with a path", "https://example.org/a/b?x=1", "exact"],
    ["trailing dot", "https://example.org.", "exact"],
    ["subdomain when chosen", "https://a.example.org", "wide"],
    ["deep subdomain when chosen", "https://a.b.example.org", "wide"],
    ["apex when chosen", "https://example.org", "wide"],
  ];
  it.each(COVERED)("%s: %s is covered", (_n, url, which) => {
    expect(trustedSiteCovers(which === "exact" ? exact : wide, url)).toBe(true);
  });

  const NOT: [string, string, string][] = [
    ["subdomain, not chosen", "https://a.example.org", "exact"],
    ["other port", "https://example.org:8443", "exact"],
    ["other port, subdomains", "https://a.example.org:8443", "wide"],
    ["other scheme", "http://example.org", "exact"],
    ["other scheme, subdomains", "http://a.example.org", "wide"],
    ["suffix string, not a subdomain", "https://evilexample.org", "wide"],
    ["trusted name as a subdomain of another", "https://example.org.evil.example", "wide"],
    ["punycode look-alike", "https://xn--exmple-cua.org", "wide"],
    ["other TLD", "https://example.com", "wide"],
    ["loopback", "http://127.0.0.1", "wide"],
  ];
  it.each(NOT)("%s: %s is not covered", (_n, url, which) => {
    expect(trustedSiteCovers(which === "exact" ? exact : wide, url)).toBe(false);
  });
});

describe("Balanced reads of a trusted site", () => {
  it("first read of an untrusted origin asks and offers Always for this site", async () => {
    const h = makeBroker();
    const d = await h.broker.decide(nav(SITE), CTX);
    expect(d).toMatchObject({ decision: "ask", rule: "mode:balanced/read:new_source" });
    const { issued } = await trust(makeBroker());
    expect((issued.approval.details as { trustSite?: unknown }).trustSite).toEqual({
      origin: SITE,
      subdomains: true,
    });
  });

  it("answering with Always for this site stores a grant and still allows this read once", async () => {
    const h = makeBroker();
    const { approval } = await trust(h);
    expect(approval.status).toBe("approved");
    expect(approval.scopeGranted).toBe("once");
    const grants = await h.broker.listGrants({});
    expect(grants).toHaveLength(1);
    expect(grants[0]?.subject).toMatchObject({ trustedSite: { origin: SITE, subdomains: false } });
  });

  // MUST NOT ASK -----------------------------------------------------------------------------
  const MUST_NOT_ASK: [string, (url: string) => PolicyCall, string][] = [
    ["navigate", nav, SITE],
    ["navigate with a path", () => nav(`${SITE}/guides/a?b=c`), SITE],
    ["snapshot", snapshot, SITE],
    ["read page text", readText, SITE],
    ["fetch GET", (u) => fetchGet(u), SITE],
    ["fetch with an explicit GET", (u) => fetchGet(u, "GET"), SITE],
  ];
  it.each(MUST_NOT_ASK)(
    "a second %s of a trusted origin in a new task does not ask",
    async (_n, make, url) => {
      const h = makeBroker();
      await trust(h);
      const d = await h.broker.decide(make(url), TASK2);
      expect(d).toMatchObject({ decision: "allow", rule: "mode:balanced/read:trusted_site" });
      expect(d.trace).not.toContain("step6:ask");
    },
  );

  it("subdomains are covered when the owner picked this site and its subdomains", async () => {
    const h = makeBroker();
    await trust(h, SITE, "subdomains");
    expect((await h.broker.decide(nav("https://a.docs.example.org"), TASK2)).decision).toBe(
      "allow",
    );
  });

  // MUST ASK (each with its positive control) -------------------------------------------------
  // A task of its own, so the control read does not mark the origin touched for the task under test.
  const control = async (h: Harness, ctx: PolicyContext = { ...CTX, taskId: "task_ctl" }) =>
    expect(await h.broker.decide(nav(SITE), ctx)).toMatchObject({
      decision: "allow",
      rule: "mode:balanced/read:trusted_site",
    });

  it("the first read of an untrusted origin asks (control: the trusted origin does not)", async () => {
    const h = makeBroker();
    await trust(h);
    await control(h);
    for (const u of ["https://other.example", "https://docs.example.net"]) {
      expect((await h.broker.decide(nav(u), TASK2)).decision, u).toBe("ask");
    }
  });

  it("a trusted origin that is on the sensitive list asks (control: before it was listed)", async () => {
    const h = makeBroker();
    await trust(h);
    await control(h);
    h.broker.setPolicy({ sensitiveOrigins: ["*.example.org"] });
    expect(await h.broker.decide(nav(SITE), TASK2)).toMatchObject({
      decision: "ask",
      rule: "mode:balanced/read:sensitive",
    });
    expect((await h.broker.decide(snapshot(SITE), TASK2)).decision).toBe("ask");
  });

  it("the card does not offer Always for this site on a sensitive host", async () => {
    const h = makeBroker();
    const c = nav("https://mail.google.com");
    const d = await h.broker.decide(c, CTX);
    const issued = await h.broker.requestApproval({
      kind: d.approvalKind ?? "new_origin",
      summary: "open",
      details: {},
      bindingHash: d.bindingHash ?? "",
      grantKey: d.grantKey ?? "",
      requestedBy: { runId: CTX.runId, taskId: "task_1", threadId: CTX.threadId },
      sideEffect: "read",
      target: origin("https://mail.google.com"),
      surfaces: ["desktop"],
      taint: false,
    });
    expect(issued.approval.details).not.toHaveProperty("trustSite");
    // Positive control: an ordinary host does get the offer.
    const ok = await trust(makeBroker());
    expect(ok.issued.approval.details).toHaveProperty("trustSite");
  });

  it("a read steered by tainted content asks (control: the same read untainted)", async () => {
    const h = makeBroker();
    await trust(h);
    await control(h);
    const tainted: PolicyContext = {
      ...TASK2,
      taint: true,
      taintSources: [{ sourceKind: "browser", origin: "https://other.example" }],
    };
    for (const make of [nav, snapshot, readText, (u: string) => fetchGet(u)]) {
      const d = await h.broker.decide(make(SITE), tainted);
      expect(d.decision).toBe("ask");
      expect(d.rule).not.toContain("trusted_site");
    }
    expect((await h.broker.decide(nav(SITE), { ...TASK2, initiator: "mcp_app" })).decision).toBe(
      "ask",
    );
  });

  it("a write or submit on a trusted origin asks as before (control: the read does not)", async () => {
    const h = makeBroker();
    await trust(h);
    await control(h);
    const submit = call("browser.submit", "destructive", origin(SITE), {
      binding: {
        pageUrl: `${SITE}/form`,
        action: `${SITE}/post`,
        method: "post",
        fields: { a: "1" },
      },
    });
    for (const c of [click(SITE), submit, fetchGet(SITE, "POST")]) {
      const d = await h.broker.decide(c, TASK2);
      expect(d.decision, c.tool).toBe("ask");
      expect(d.rule, c.tool).not.toContain("trusted_site");
    }
  });

  it("a download or a typed credential on a trusted origin is not a covered read", async () => {
    const h = makeBroker();
    await trust(h);
    for (const tool of ["browser.download", "browser.fill_credential", "browser.upload"]) {
      const d = await h.broker.decide(call(tool, "read", origin(SITE)), TASK2);
      expect(d.rule, tool).not.toContain("trusted_site");
    }
  });

  it("a brokerage, exchange or bank gets no trust offer (control: an ordinary host does)", async () => {
    const venue = "https://www.kraken.com";
    const h = makeBroker();
    await expect(trust(h, venue)).rejects.toThrow(/does not offer/);
    expect(await h.broker.listGrants({})).toHaveLength(0);
    await trust(h);
    expect(await h.broker.listGrants({})).toHaveLength(1);
  });

  const LOOKALIKES: [string, string][] = [
    ["a subdomain of the trusted origin", "https://a.docs.example.org"],
    ["the parent domain", "https://example.org"],
    ["a different port", "https://docs.example.org:8443"],
    ["a different scheme", "http://docs.example.org"],
    ["a punycode look-alike", "https://d\u043ecs.example.org"],
    ["the trusted name under another domain", "https://docs.example.org.evil.example"],
    ["a suffix-string neighbour", "https://mydocs.example.org"],
    ["a different TLD", "https://docs.example.com"],
  ];
  it.each(LOOKALIKES)("%s asks (control: the trusted origin does not)", async (_n, url) => {
    const h = makeBroker();
    await trust(h);
    await control(h);
    for (const make of [nav, snapshot, readText]) {
      expect((await h.broker.decide(make(url), TASK2)).decision, make(url).tool).toBe("ask");
    }
  });

  it("a trailing dot is the same origin, not a look-alike", async () => {
    const h = makeBroker();
    await trust(h);
    expect((await h.broker.decide(nav("https://docs.example.org."), TASK2)).decision).toBe("allow");
  });

  it("Manual mode still asks (control: Balanced does not)", async () => {
    const h = makeBroker();
    await trust(h);
    await control(h);
    const manual: PolicyContext = { ...TASK2, permissionMode: "manual" };
    expect(await h.broker.decide(nav(SITE), manual)).toMatchObject({
      decision: "ask",
      rule: "mode:manual/read:new_source",
    });
    expect((await h.broker.decide(snapshot(SITE), manual)).decision).toBe("ask");
  });

  it("a revoked trusted site asks again (control: before the revoke)", async () => {
    const h = makeBroker();
    const { approval } = await trust(h);
    await control(h);
    await h.broker.revokeGrant(approval.grantId ?? "");
    expect((await h.broker.decide(nav(SITE), TASK2)).decision).toBe("ask");
  });

  it("an expired trusted site asks again (control: before it expired)", async () => {
    const h = makeBroker({ policy: { grants: { alwaysExpiryDays: 1 } } });
    await trust(h);
    await control(h);
    h.clock.advance(2 * 24 * 60 * 60 * 1000);
    expect((await h.broker.decide(nav(SITE), TASK2)).decision).toBe("ask");
  });

  it.each(["designated", "allowed"] as const)(
    "a %s requester's reads do not use the owner's trusted sites (control: the owner)",
    async (role) => {
      const h = makeBroker();
      await trust(h);
      await control(h);
      const owner = await h.broker.decide(nav(SITE), { ...TASK2, requester: { role: "owner" } });
      expect(owner.rule).toBe("mode:balanced/read:trusted_site");
      const other = await h.broker.decide(nav(SITE), {
        ...TASK2,
        taskId: "task_3",
        requester: { role, identityId: "idn_1", senderId: "x", channel: "telegram" },
      });
      expect(other.rule).not.toContain("trusted_site");
    },
  );
});

describe("answering Always for this site is bounded", () => {
  const ask = async (h: Harness, ctx = CTX, url = SITE) => {
    const d = await h.broker.decide(nav(url), ctx);
    const issued = await h.broker.requestApproval({
      kind: d.approvalKind ?? "new_origin",
      summary: "open",
      details: {},
      bindingHash: d.bindingHash ?? "",
      grantKey: d.grantKey ?? "",
      requestedBy: { runId: ctx.runId, taskId: ctx.taskId ?? null, threadId: ctx.threadId },
      sideEffect: "read",
      target: origin(url),
      surfaces: ["desktop"],
      taint: ctx.taint,
    });
    h.clock.advance(500);
    return issued;
  };
  const answer = (h: Harness, i: Awaited<ReturnType<typeof ask>>, extra: object) =>
    h.broker.answer({
      approvalId: i.approval.id,
      answerToken: i.answerTokens.desktop ?? "",
      decision: "approve",
      scope: "once",
      decidedBy: DEVICE,
      ...extra,
    });

  it("a tainted card does not offer it, and a forced answer is refused", async () => {
    const h = makeBroker();
    const ctx: PolicyContext = { ...CTX, taint: true };
    const i = await ask(h, ctx);
    expect(i.approval.details).not.toHaveProperty("trustSite");
    await expect(answer(h, i, { trustSite: "origin" })).rejects.toThrow(/does not offer/);
    expect(await h.broker.listGrants({})).toHaveLength(0);
  });

  it("an agent-supplied details.trustSite is dropped, and answering it is refused", async () => {
    const h = makeBroker();
    const url = "https://mail.google.com";
    const d = await h.broker.decide(nav(url), CTX);
    const issued = await h.broker.requestApproval({
      kind: d.approvalKind ?? "new_origin",
      summary: "open",
      details: { trustSite: { origin: "https://evil.example", subdomains: true } },
      bindingHash: d.bindingHash ?? "",
      grantKey: d.grantKey ?? "",
      requestedBy: { runId: CTX.runId, taskId: "task_1", threadId: CTX.threadId },
      sideEffect: "read",
      target: origin(url),
      surfaces: ["desktop"],
      taint: false,
    });
    expect(issued.approval.details).not.toHaveProperty("trustSite");
    h.clock.advance(500);
    await expect(
      h.broker.answer({
        approvalId: issued.approval.id,
        answerToken: issued.answerTokens.desktop ?? "",
        decision: "approve",
        scope: "once",
        trustSite: "subdomains",
        decidedBy: DEVICE,
      }),
    ).rejects.toThrow(/does not offer/);
    expect(await h.broker.listGrants({})).toHaveLength(0);
  });

  it("a card for a write or an unrelated tool never offers it", async () => {
    const h = makeBroker();
    const c = click(SITE);
    const d = await h.broker.decide(c, CTX);
    const issued = await h.broker.requestApproval({
      kind: d.approvalKind ?? "connector_action",
      summary: "click",
      details: {},
      bindingHash: d.bindingHash ?? "",
      grantKey: d.grantKey ?? "",
      requestedBy: { runId: CTX.runId, taskId: "task_1", threadId: CTX.threadId },
      sideEffect: "write",
      target: origin(SITE),
      surfaces: ["desktop"],
      taint: false,
    });
    expect(issued.approval.details).not.toHaveProperty("trustSite");
  });

  it("subdomains is refused when the card did not offer it (a public-suffix-adjacent host)", async () => {
    const h = makeBroker();
    const i = await ask(h, CTX, "https://project.github.io");
    expect(i.approval.details).toMatchObject({
      trustSite: { origin: "https://project.github.io", subdomains: true },
    });
    const bare = await ask(h, { ...CTX, taskId: "t9", runId: "r9" }, "https://tiny.example.net");
    expect(
      (bare.approval.details as { trustSite?: { subdomains?: boolean } }).trustSite,
    ).toBeDefined();
  });

  it("denying with trustSite stores nothing", async () => {
    const h = makeBroker();
    const i = await ask(h);
    await h.broker.answer({
      approvalId: i.approval.id,
      answerToken: i.answerTokens.desktop ?? "",
      decision: "deny",
      scope: "once",
      trustSite: "origin",
      decidedBy: DEVICE,
    });
    expect(await h.broker.listGrants({})).toHaveLength(0);
    // Positive control: approving stores one.
    const h2 = makeBroker();
    await trust(h2);
    expect(await h2.broker.listGrants({})).toHaveLength(1);
  });

  it("a trusted-site grant never satisfies an ordinary grant lookup", async () => {
    const h = makeBroker();
    await trust(h);
    // The grant key differs from the navigate call's own key, so a tainted turn is not exempted.
    const tainted: PolicyContext = {
      ...TASK2,
      taint: true,
      taintSources: [{ sourceKind: "browser", origin: "https://other.example" }],
    };
    expect(await h.broker.decide(nav(SITE), tainted)).toMatchObject({
      decision: "ask",
      rule: "taint:new_origin",
    });
  });
});

describe("optional sensitive categories (on by default, the owner may turn them off)", () => {
  const host = (p: ReturnType<typeof compilePolicy>, h: string) => isSensitiveHost(p, h);
  const GOV_ICLOUD = ["irs.gov", "www.usa.gov", "service.gov.uk", "icloud.com", "www.icloud.com"];

  it("banks, health, email, password managers, sign-in, gov and iCloud are on by default", () => {
    const p = compilePolicy({});
    for (const h of [
      "chase.com",
      "www.paypal.com",
      "foo.mychart.com",
      "my.1password.com",
      "mail.google.com",
      "outlook.office.com",
      "accounts.google.com",
      "appleid.apple.com",
      ...GOV_ICLOUD,
    ]) {
      expect(host(p, h), h).toBe(true);
    }
    expect(DEFAULT_SENSITIVE_ORIGINS).toContain("*.gov");
    expect(DEFAULT_SENSITIVE_ORIGINS).toContain("*.icloud.com");
  });

  it.each(GOV_ICLOUD)("%s stops being sensitive only when both categories are off", (h) => {
    expect(
      host(compilePolicy({ sensitiveCategories: { government: true, icloud: true } }), h),
    ).toBe(true);
    expect(
      host(compilePolicy({ sensitiveCategories: { government: false, icloud: false } }), h),
    ).toBe(false);
  });

  it("each category switches only its own hosts off", () => {
    const noGov = compilePolicy({ sensitiveCategories: { government: false } });
    expect(host(noGov, "irs.gov")).toBe(false);
    expect(host(noGov, "icloud.com")).toBe(true);
    expect(host(noGov, "chase.com")).toBe(true);
    const noIcloud = compilePolicy({ sensitiveCategories: { icloud: false } });
    expect(host(noIcloud, "icloud.com")).toBe(false);
    expect(host(noIcloud, "irs.gov")).toBe(true);
    expect(host(noIcloud, "mail.google.com")).toBe(true);
  });

  it("with the category on a gov read asks as sensitive; off, as an ordinary new source", async () => {
    const h = makeBroker();
    expect((await h.broker.decide(nav("https://www.irs.gov"), CTX)).rule).toBe(
      "mode:balanced/read:sensitive",
    );
    h.broker.setPolicy({ sensitiveCategories: { government: false } });
    expect((await h.broker.decide(nav("https://www.irs.gov"), CTX)).rule).toBe(
      "mode:balanced/read:new_source",
    );
  });

  it("the card never offers Always for this site on a sensitive host, gov or iCloud included", async () => {
    for (const url of ["https://www.irs.gov", "https://www.icloud.com"]) {
      const h = makeBroker();
      await expect(trust(h, url), url).rejects.toThrow(/does not offer/);
      // Positive control: turn its category off and the offer appears.
      h.broker.setPolicy({ sensitiveCategories: { government: false, icloud: false } });
      await trust(h, url, "origin", { ...CTX, taskId: "t_off", runId: "r_off" });
      expect(await h.broker.listGrants({}), url).toHaveLength(1);
    }
  });
});

describe("subdomain trust refuses public and private suffixes (PSL)", () => {
  const REFUSE = [
    "https://s3.amazonaws.com",
    "https://s3.us-east-1.amazonaws.com",
    "https://storage.googleapis.com",
    "https://blob.core.windows.net",
    "https://run.app",
    "https://r2.dev",
    "https://cloudfunctions.net",
    "https://readthedocs.io",
    "https://uk.com",
    "https://me.uk",
    "https://kyoto.jp",
    "https://vercel.app",
    "https://herokuapp.com",
    "https://github.io",
    "https://raw.githubusercontent.com",
    "https://gist.githubusercontent.com",
  ];
  it.each(REFUSE)("%s cannot be trusted, with or without subdomains", (u) => {
    expect(() => normalizeTrustedSite(u, true)).toThrow();
    expect(() => normalizeTrustedSite(u, false)).toThrow();
  });
  it.each([
    "https://example.com",
    "https://bbc.co.uk",
    "https://docs.python.org",
    "https://tenant.github.io",
  ])("control: %s can be trusted with subdomains", (u) => {
    expect(() => normalizeTrustedSite(u, true)).not.toThrow();
  });

  it("a tenant bucket stays asking after a trust attempt on the suffix", async () => {
    const h = makeBroker();
    await expect(trust(h, "https://s3.amazonaws.com", "subdomains")).rejects.toThrow();
    const fetchTenant = fetchGet("https://attacker-bucket.s3.amazonaws.com/?d=SECRET");
    expect((await h.broker.decide(fetchTenant, TASK2)).decision).toBe("ask");
    // Positive control: the same shape on a trusted ordinary host is quiet.
    await trust(h, "https://example.com", "subdomains");
    expect(
      (await h.broker.decide(fetchGet("https://a.example.com/?d=x"), { ...TASK2, taskId: "t7" }))
        .decision,
    ).toBe("allow");
  });
});

describe("a trusted read does not make the origin touched (read-then-exfil)", () => {
  const tainted = (c: PolicyContext): PolicyContext => ({
    ...c,
    taint: true,
    taintSources: [{ sourceKind: "browser", origin: SITE }],
  });
  const exfil = [
    ["web.fetch", () => fetchGet(`${SITE}/search?q=PRIVATE`)],
    [
      "browser.open_tab",
      () =>
        call("browser.open_tab", "read", origin(SITE), { params: { url: `${SITE}/?q=PRIVATE` } }),
    ],
  ] as const;

  it.each(exfil)("%s asks in the same task after taint arrives", async (_n, make) => {
    const h = makeBroker();
    await trust(h);
    const ctx: PolicyContext = { ...CTX, taskId: "task_x", runId: "run_x" };
    // Positive control: the untainted trusted read is quiet.
    expect((await h.broker.decide(nav(SITE), ctx)).rule).toBe("mode:balanced/read:trusted_site");
    expect((await h.broker.decide(make(), tainted(ctx))).decision).toBe("ask");
  });

  it.each(exfil)(
    "%s asks in a thread-keyed context (no task), and on the next tainted turn",
    async (_n, make) => {
      const h = makeBroker();
      await trust(h);
      const ctx: PolicyContext = {
        threadId: "thr_chat",
        runId: "run_a",
        permissionMode: "balanced",
        taint: false,
      };
      expect((await h.broker.decide(snapshot(SITE), ctx)).rule).toBe(
        "mode:balanced/read:trusted_site",
      );
      expect((await h.broker.decide(make(), tainted(ctx))).decision).toBe("ask");
      expect((await h.broker.decide(make(), tainted({ ...ctx, runId: "run_b" }))).decision).toBe(
        "ask",
      );
    },
  );
});

describe("subdomain trust checks the host being read (R2)", () => {
  const wide = (u: string) => normalizeTrustedSite(u, true);
  const NOT_COVERED: [string, string][] = [
    ["https://google.com", "https://docs.google.com"],
    ["https://google.com", "https://drive.google.com"],
    ["https://google.com", "https://sites.google.com"],
    ["https://google.com", "https://script.google.com/macros/s/ATTACKER/exec?d=SECRET"],
    ["https://google.com", "https://pay.google.com"],
    ["https://googleusercontent.com", "https://x.googleusercontent.com"],
    ["https://amazonaws.com", "https://attacker-bucket.s3.amazonaws.com"],
    ["https://windows.net", "https://evil.blob.core.windows.net"],
    ["https://example.org", "https://www.kraken.com"],
  ];
  it.each(NOT_COVERED)("%s with subdomains does not cover %s", (trusted, read) => {
    let site: ReturnType<typeof wide> | undefined;
    try {
      site = wide(trusted);
    } catch {
      return; // refusing the entry outright is also closed
    }
    expect(trustedSiteCovers(site, read)).toBe(false);
  });

  it("control: ordinary subdomains are covered", () => {
    expect(trustedSiteCovers(wide("https://google.com"), "https://news.google.com")).toBe(true);
    expect(trustedSiteCovers(wide("https://example.com"), "https://a.b.example.com")).toBe(true);
  });

  const UNKNOWN = [
    "https://router.local",
    "https://nas.lan",
    "https://app.internal",
    "https://x.corp",
    "https://home.arpa",
    "https://printer.home.arpa",
  ];
  it.each(UNKNOWN)("%s is not a public name and cannot be trusted", (u) => {
    expect(() => normalizeTrustedSite(u)).toThrow();
    expect(() => normalizeTrustedSite(u, true)).toThrow();
  });

  const COLLECTORS = [
    "https://webhook.site",
    "https://abc.webhook.site",
    "https://requestbin.com",
    "https://eo123.m.pipedream.net",
    "https://abc.ngrok.io",
    "https://abc.ngrok-free.app",
    "https://pastebin.com",
    "https://ipfs.io",
  ];
  it.each(COLLECTORS)("collector %s cannot be trusted", (u) => {
    expect(() => normalizeTrustedSite(u)).toThrow();
  });
  it("control: github.com and ordinary sites stay trustable", () => {
    expect(() => normalizeTrustedSite("https://github.com")).not.toThrow();
    expect(() => normalizeTrustedSite("https://example.net")).not.toThrow();
  });

  it("a trade click stays denied or asked on and around a subdomain-trusted site", async () => {
    const h = makeBroker();
    await trust(h, "https://example.com", "subdomains");
    const buy = (u: string) =>
      call("browser.click", "financial", origin(u), {
        meta: { action: "click", control: { labels: ["Buy"], role: "button" } },
      });
    const covered = await h.broker.decide(buy("https://a.example.com"), TASK2);
    expect(covered.decision).toBe("ask");
    expect(covered.rule).not.toContain("trusted_site");
    expect((await h.broker.decide(buy("https://www.kraken.com"), TASK2)).decision).toBe("deny");
    // Positive control: the read of the covered subdomain is quiet.
    expect((await h.broker.decide(nav("https://a.example.com"), TASK2)).decision).toBe("allow");
  });
});

describe("follow-up: multi-tenant apexes, more collectors, exact matches", () => {
  const APEXES = [
    "wordpress.com",
    "tumblr.com",
    "substack.com",
    "medium.com",
    "sharepoint.com",
    "zendesk.com",
    "atlassian.net",
    "itch.io",
    "blogger.com",
    "notion.site",
    "webflow.io",
    "wixsite.com",
    "squarespace.com",
    "myshopify.com",
    "glitch.me",
    "replit.app",
    "repl.co",
  ];
  // Already public or private suffixes on the list: refused outright, which is stricter still.
  const SUFFIXES = [
    "notion.site",
    "webflow.io",
    "wixsite.com",
    "myshopify.com",
    "replit.app",
    "repl.co",
  ];
  const APEX_ONLY = APEXES.filter((h) => !SUFFIXES.includes(h));
  it.each(APEX_ONLY)("%s: the exact origin is trustable, its subdomains are not", (h) => {
    expect(() => normalizeTrustedSite(`https://${h}`)).not.toThrow();
    expect(() => normalizeTrustedSite(`https://${h}`, true)).toThrow();
    const exact = { origin: `https://${h}`, subdomains: false };
    expect(trustedSiteCovers(exact, `https://${h}`)).toBe(true);
    // Even an entry already stored with subdomains does not cover a tenant.
    const stored = { origin: `https://${h}`, subdomains: true };
    expect(trustedSiteCovers(stored, `https://evil.${h}`)).toBe(false);
    expect(trustedSiteCovers(stored, `https://${h}`)).toBe(true);
  });
  it.each(SUFFIXES)("%s is a suffix on the list: refused with or without subdomains", (h) => {
    expect(() => normalizeTrustedSite(`https://${h}`)).toThrow();
    expect(() => normalizeTrustedSite(`https://${h}`, true)).toThrow();
    expect(
      trustedSiteCovers({ origin: `https://${h}`, subdomains: true }, `https://evil.${h}`),
    ).toBe(false);
  });

  it("control: a tenant's own subdomains stay coverable", () => {
    const site = normalizeTrustedSite("https://blog.wordpress.com", true);
    expect(trustedSiteCovers(site, "https://a.blog.wordpress.com")).toBe(true);
  });

  const COLLECTORS = [
    "interact.sh",
    "oast.pro",
    "oast.live",
    "oast.site",
    "oast.online",
    "oast.fun",
    "oast.me",
    "burpcollaborator.net",
    "canarytokens.com",
    "requestcatcher.com",
    "beeceptor.com",
    "requestrepo.com",
    "postb.in",
    "transfer.sh",
    "paste.ee",
    "hastebin.com",
  ];
  it.each(COLLECTORS)("collector %s and its subdomains cannot be trusted or covered", (h) => {
    expect(() => normalizeTrustedSite(`https://${h}`)).toThrow();
    expect(() => normalizeTrustedSite(`https://abc.${h}`)).toThrow();
    expect(trustedSiteCovers({ origin: `https://${h}`, subdomains: false }, `https://${h}`)).toBe(
      false,
    );
  });

  // Entries made before a list update (or by an older build) must stop working.
  const STALE = [
    "https://webhook.site",
    "https://abc.ngrok.io",
    "https://www.kraken.com",
    "https://storage.googleapis.com",
    "https://docs.google.com",
    "https://s3.amazonaws.com",
    "https://co.uk",
    "https://router.local",
  ];
  it.each(STALE)("a stored exact entry for %s gets no quiet read", async (u) => {
    expect(trustedSiteCovers({ origin: u, subdomains: false }, u)).toBe(false);
    expect(trustedSiteCovers({ origin: u, subdomains: true }, u)).toBe(false);
  });
  it("control: a stored exact entry for an ordinary host still covers itself", () => {
    expect(
      trustedSiteCovers(
        { origin: "https://example.com", subdomains: false },
        "https://example.com",
      ),
    ).toBe(true);
  });
});
