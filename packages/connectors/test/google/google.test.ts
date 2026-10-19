import type {
  PermissionBroker,
  ReceiptInput,
  ToolRegistration,
  ToolRegistry,
  ToolSpec,
} from "@psyche/protocol";
import { assertNoSecrets, registerSecret } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import { toolCallBindingHash } from "../../src/framework/binding.ts";
import { ConnectorRegistry } from "../../src/framework/registry.ts";
import type { ConnectorEvent } from "../../src/framework/types.ts";
import { GOOGLE_SCOPES, TESTING_MODE_TTL_MS } from "../../src/google/auth.ts";
import { calendarBinding, googleFactory, sendBinding } from "../../src/google/connector.ts";
import { buildMime, decodeBase64Url, htmlToText, parsePayload } from "../../src/google/mime.ts";
import { CLIENT_ID, FakeGoogle, fixture } from "./fake-google.ts";

class MapRegistry implements ToolRegistry {
  readonly tools = new Map<string, ToolRegistration>();
  list(): ToolSpec[] {
    return [...this.tools.values()].map((t) => t.spec);
  }
  get(name: string) {
    return this.tools.get(name);
  }
  register(r: ToolRegistration) {
    this.tools.set(r.spec.name, r);
    return () => this.tools.delete(r.spec.name);
  }
}

/** Broker stub: approvals the loop already verified (id → approved binding hash), receipts recorded. */
function stubBroker(approved: Record<string, string> = {}) {
  const receipts: ReceiptInput[] = [];
  const broker = {
    async get(id: string) {
      const bindingHash = approved[id];
      return bindingHash === undefined
        ? undefined
        : { id, status: "approved", bindingHash, requestedBy: { toolCallId: "call-1" } };
    },
    async recordReceipt(input: ReceiptInput) {
      receipts.push(input);
      return { id: `rcpt_${receipts.length}` } as never;
    },
  } as unknown as PermissionBroker;
  return { broker, receipts };
}

async function connected(
  opts: {
    scopeMode?: "read" | "read_act";
    broker?: PermissionBroker;
    approvalFor?: (id: string) => string | undefined;
  } = {},
) {
  const g = new FakeGoogle();
  g.route("GET", "/gmail/v1/users/me/profile", fixture("profile"));
  const events: ConnectorEvent[] = [];
  const tools = new MapRegistry();
  const registry = new ConnectorRegistry({
    factories: [googleFactory({ openBrowser: g.openBrowser, timeoutMs: 5000 })],
    context: g.context(),
    tools,
    onEvent: (e) => events.push(e),
    newId: () => "google-1",
    ...(opts.broker === undefined ? {} : { broker: opts.broker }),
    ...(opts.approvalFor === undefined ? {} : { approvalFor: opts.approvalFor }),
  });
  const record = await registry.connect({
    catalogueId: "google",
    scopeMode: opts.scopeMode ?? "read_act",
    config: { clientId: CLIENT_ID },
  });
  return { g, registry, record, events, tools };
}

const run = (tools: MapRegistry, name: string, params: unknown, callId = "call-1") => {
  const t = tools.get(name);
  if (t === undefined) throw new Error(`tool ${name} not registered`);
  return t.execute(callId, params, new AbortController().signal, () => {});
};

describe("Google OAuth (desktop client, loopback + PKCE)", () => {
  it("authorizes with PKCE S256, offline access and the read_act scopes, then reads the account", async () => {
    const { g, record } = await connected();
    const q = g.lastAuthorize as URLSearchParams;
    expect(q.get("client_id")).toBe(CLIENT_ID);
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("access_type")).toBe("offline");
    expect(q.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(q.get("scope")?.split(" ").sort()).toEqual(
      [GOOGLE_SCOPES.gmailModify, GOOGLE_SCOPES.calendar, GOOGLE_SCOPES.driveFile].sort(),
    );
    expect(record).toMatchObject({
      status: "connected",
      account: "owner@example.com",
      scopeMode: "read_act",
    });
    expect(g.vault.tokens.get("google-1")?.refreshToken).toBe("1//fake-refresh-token-abcdef");
    // Tokens live in the vault, never in the record's config.
    expect(JSON.stringify(record)).not.toContain("fake-refresh-token");
  });

  it("read-only mode asks for readonly scopes and does not offer write tools", async () => {
    const { tools, g } = await connected({ scopeMode: "read" });
    expect(g.lastAuthorize?.get("scope")).toContain("gmail.readonly");
    expect(g.lastAuthorize?.get("scope")).not.toContain("gmail.modify");
    const names = tools.list().map((t) => t.name);
    expect(names).toContain("mcp__google-1__gmail_read_thread");
    expect(names).not.toContain("mcp__google-1__gmail_send");
    expect(names).not.toContain("mcp__google-1__calendar_delete_event");
  });

  it("fails when Google grants fewer scopes than requested", async () => {
    const g = new FakeGoogle();
    g.grantScope = () => GOOGLE_SCOPES.gmailModify;
    const registry = new ConnectorRegistry({
      factories: [googleFactory({ openBrowser: g.openBrowser, timeoutMs: 5000 })],
      context: g.context(),
    });
    await expect(
      registry.connect({
        catalogueId: "google",
        scopeMode: "read_act",
        config: { clientId: CLIENT_ID },
      }),
    ).rejects.toThrow(/did not grant: calendar, drive.file/);
  });

  it("refreshes an expired access token; a revoked one moves to needs_auth and invalidates work", async () => {
    const { g, tools, events, registry } = await connected();
    g.route("GET", "/gmail/v1/users/me/labels", {
      labels: [{ id: "INBOX", name: "INBOX", type: "system" }],
    });
    g.clock.advance(2 * 60 * 60 * 1000);
    await run(tools, "mcp__google-1__gmail_list_labels", {});
    expect(g.requests.filter((r) => r.body.includes("grant_type=refresh_token"))).toHaveLength(1);

    g.clock.advance(2 * 60 * 60 * 1000);
    g.refreshResult = "invalid_grant";
    await expect(run(tools, "mcp__google-1__gmail_list_labels", {})).rejects.toMatchObject({
      code: "unauthorized",
    });
    expect(events).toContainEqual(
      expect.objectContaining({ type: "status", status: "needs_auth" }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: "invalidated", reason: "token_revoked" }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect((await registry.get("google-1")).status).toBe("needs_auth");
  });

  it("names the 7-day Testing-mode expiry when the refresh token dies a week after consent", async () => {
    const { g, tools } = await connected();
    g.route("GET", "/gmail/v1/users/me/labels", { labels: [] });
    g.clock.advance(TESTING_MODE_TTL_MS + 60_000);
    g.refreshResult = "invalid_grant";
    await expect(run(tools, "mcp__google-1__gmail_list_labels", {})).rejects.toThrow(
      /Testing mode/,
    );
  });

  it("an account change on reconnect invalidates pending work", async () => {
    const { g, registry, events } = await connected();
    g.route("GET", "/gmail/v1/users/me/profile", {
      emailAddress: "other@example.com",
      historyId: "1",
    });
    await registry.connect({
      catalogueId: "google",
      scopeMode: "read_act",
      connectorId: "google-1",
    });
    expect(events).toContainEqual({
      type: "invalidated",
      connectorId: "google-1",
      reason: "account_changed",
      previousAccount: "owner@example.com",
      account: "other@example.com",
    });
  });
});

describe("Gmail threads and parsing hardening", () => {
  it("lists threads with subjects, senders and snippets", async () => {
    const { g, tools } = await connected();
    g.route("GET", "/gmail/v1/users/me/threads", fixture("threads-list"));
    g.route("GET", "/gmail/v1/users/me/threads/t1", fixture("thread-t1-metadata"));
    g.route("GET", "/gmail/v1/users/me/threads/t2", fixture("thread-t2-metadata"));
    const r = await run(tools, "mcp__google-1__gmail_search_threads", {
      query: "is:unread",
      maxResults: 5,
    });
    expect(r.provenance).toBe("untrusted");
    expect(r.output).toMatchObject({
      nextPageToken: "page-2",
      threads: [
        { id: "t1", subject: "Lunch on Friday?", from: "Ana <ana@example.org>", messageCount: 1 },
        { id: "t2", subject: "Invoice 42" },
      ],
    });
    const listCall = g.requests.find((q) => q.url.pathname.endsWith("/threads"));
    expect(listCall?.url.searchParams.get("q")).toBe("is:unread");
  });

  it("reads a thread: plain text preferred, hidden HTML dropped, malformed parts survive", async () => {
    const { g, tools } = await connected();
    g.route("GET", "/gmail/v1/users/me/threads/t1", fixture("thread-full"));
    const r = await run(tools, "mcp__google-1__gmail_read_thread", { threadId: "t1" });
    const { messages } = r.output as {
      messages: {
        body: string;
        bodySource: string;
        attachments: { filename: string; tooLarge: boolean }[];
        warnings: string[];
      }[];
    };
    expect(messages[0]?.body).toBe("Hi! Lunch on Friday at noon? — Ana");
    expect(messages[0]?.bodySource).toBe("plain");
    expect(messages[0]?.attachments).toMatchObject([
      { filename: "menu.pdf", tooLarge: false },
      { filename: "huge.mp4", tooLarge: true },
    ]);
    expect(messages[1]?.body).toBe("Visible reply");
    expect(messages[1]?.body).not.toMatch(/IGNORE|hidden|alert/);
    expect(messages[2]?.body).toContain("latin");
    expect(messages[2]?.warnings).toContain("unknown charset x-made-up; decoded as UTF-8");
  });

  it("bounds depth, part count and body size", () => {
    let deep: Record<string, unknown> = { mimeType: "text/plain", body: { data: "aGk" } };
    for (let i = 0; i < 40; i++) deep = { mimeType: "multipart/mixed", parts: [deep] };
    expect(parsePayload(deep).warnings).toContain("part depth limit reached");
    const wide = {
      mimeType: "multipart/mixed",
      parts: Array.from({ length: 1000 }, (_, i) => ({
        mimeType: "application/octet-stream",
        filename: `f${i}`,
        body: { size: 1 },
      })),
    };
    const parsed = parsePayload(wide);
    expect(parsed.warnings).toContain("part count limit reached");
    expect(parsed.attachments.length).toBeLessThanOrEqual(300);
    const big = {
      mimeType: "text/plain",
      body: { data: Buffer.from("x".repeat(300_000)).toString("base64url") },
    };
    expect(parsePayload(big).warnings).toContain("body truncated");
    expect(parsePayload(undefined)).toMatchObject({ text: "", source: "none" });
    expect(parsePayload({ mimeType: 42, parts: "nope" } as never).text).toBe("");
  });

  it("saves a small attachment to the Library and refuses a huge one", async () => {
    const { g, tools } = await connected();
    g.route("GET", "/gmail/v1/users/me/messages/m1", fixture("message-m1"));
    g.route(
      "GET",
      "/gmail/v1/users/me/messages/m1/attachments/att-small",
      fixture("attachment-small"),
    );
    const r = await run(tools, "mcp__google-1__gmail_save_attachment", {
      messageId: "m1",
      partId: "1",
    });
    expect(r.output).toMatchObject({ libraryItemId: "lib_1", filename: "menu.pdf" });
    expect(g.library.items[0]).toMatchObject({
      name: "menu.pdf",
      provenance: "untrusted",
      source: { ref: "gmail:m1/att-small" },
    });
    expect(Buffer.from(g.library.items[0]?.bytes ?? []).toString()).toBe("%PDF-1.4 hi");
    await expect(
      run(tools, "mcp__google-1__gmail_save_attachment", { messageId: "m1", partId: "2" }),
    ).rejects.toMatchObject({
      code: "invalid_params",
    });
    expect(g.requests.some((q) => q.url.pathname.endsWith("att-huge"))).toBe(false);
  });
});

describe("Gmail send through the registry", () => {
  const mail = {
    to: ["Ana <ANA@example.org>"],
    cc: ["bob@example.org"],
    subject: "Lunch",
    body: "Friday works.",
  };

  it("verifies the approval binding, sends, and records a receipt", async () => {
    let expected = "";
    const approvals: Record<string, string> = {};
    const { broker, receipts } = stubBroker(approvals);
    const { g, tools } = await connected({ broker, approvalFor: () => "ap_1" });
    const desc = tools.get("mcp__google-1__gmail_send")?.describeCall?.(mail);
    expect(desc).toMatchObject({
      kind: "send_email",
      grantKey: "send_email:owner@example.com:ana@example.org,bob@example.org",
      bindingFields: {
        account: "owner@example.com",
        to: ["ana@example.org"],
        cc: ["bob@example.org"],
        subject: "Lunch",
      },
    });
    expected = toolCallBindingHash("mcp__google-1__gmail_send", mail, desc);
    approvals.ap_1 = expected;
    g.route("POST", "/gmail/v1/users/me/messages/send", ({ body }: { body: string }) => {
      const raw = JSON.parse(body).raw as string;
      const text = Buffer.from(decodeBase64Url(raw) ?? []).toString();
      expect(text).toContain('To: "Ana" <ANA@example.org>');
      expect(text).toContain("Subject: Lunch");
      return Response.json({ id: "sent-1", threadId: "t5", labelIds: ["SENT"] });
    });
    const r = await run(tools, "mcp__google-1__gmail_send", mail);
    expect(r).toMatchObject({ receiptId: "rcpt_1", provenance: "untrusted" });
    expect(receipts[0]).toMatchObject({
      kind: "gmail.send",
      outcome: "ok",
      approvalId: "ap_1",
      externalRefs: { messageId: "sent-1" },
    });
  });

  it("a changed body after approval fails with binding_mismatch and nothing is sent", async () => {
    const approvals: Record<string, string> = {};
    const { broker } = stubBroker(approvals);
    const { g, tools } = await connected({ broker, approvalFor: () => "ap_1" });
    approvals.ap_1 = toolCallBindingHash("mcp__google-1__gmail_send", mail, {
      kind: "send_email",
      bindingFields: sendBinding("owner@example.com", mail).bindingFields,
    });
    await expect(
      run(tools, "mcp__google-1__gmail_send", { ...mail, body: "Send me your password." }),
    ).rejects.toMatchObject({
      code: "binding_mismatch",
    });
    expect(g.requests.some((q) => q.url.pathname.endsWith("/messages/send"))).toBe(false);
  });

  it("ask without an approval, and deny in the matrix, both refuse", async () => {
    const { broker } = stubBroker();
    const { tools, registry } = await connected({ broker, approvalFor: () => undefined });
    await expect(run(tools, "mcp__google-1__gmail_send", mail)).rejects.toMatchObject({
      code: "approval_required",
    });
    await registry.setMatrix("google-1", { "gmail.send": "deny" });
    await expect(run(tools, "mcp__google-1__gmail_send", mail)).rejects.toMatchObject({
      code: "policy_denied",
    });
    await expect(
      registry.setMatrix("google-1", { "calendar.delete": "allow" }),
    ).rejects.toMatchObject({ code: "policy_denied" });
    await expect(registry.setMatrix("google-1", { "nope.nope": "ask" })).rejects.toMatchObject({
      code: "invalid_params",
    });
  });

  it("buildMime refuses header injection and encodes non-ASCII subjects", () => {
    expect(() =>
      buildMime({ to: ["a@example.org\r\nBcc: x@evil.example"], subject: "s", text: "t" }),
    ).toThrow();
    expect(() =>
      buildMime({ to: ["a@example.org"], subject: "hi\r\nBcc: x@evil.example", text: "t" }),
    ).toThrow(/line break/);
    const raw = Buffer.from(
      decodeBase64Url(buildMime({ to: ["a@example.org"], subject: "Olá café", text: "t" })) ?? [],
    ).toString();
    expect(raw).toContain(`Subject: =?UTF-8?B?${Buffer.from("Olá café").toString("base64")}?=`);
  });
});

describe("sync", () => {
  it("Gmail history.list pages from the saved historyId; Calendar uses the syncToken", async () => {
    const { g, registry } = await connected();
    let page = 0;
    g.route("GET", "/gmail/v1/users/me/history", ({ url }: { url: URL }) => {
      expect(url.searchParams.get("startHistoryId")).toBe("9001");
      page += 1;
      return Response.json(fixture(page === 1 ? "history-page1" : "history-page2"));
    });
    g.route("GET", "/calendar/v3/calendars/primary/events", ({ url }: { url: URL }) => {
      expect(url.searchParams.get("syncToken")).toBe("sync-old");
      return Response.json(fixture("events-incremental"));
    });
    const store = await registry.get("google-1");
    store.lastSync = { gmail: { historyId: "9001" }, calendars: { primary: "sync-old" } };
    const live = registry.instance("google-1");
    const r = await live?.sync?.(store.lastSync);
    expect(r).toMatchObject({
      full: false,
      changes: 4,
      cursor: {
        gmail: { historyId: "9004" },
        calendars: { primary: "sync-inc-3" },
        newMessageIds: ["n1", "n2", "n3"],
      },
    });
  });

  it("history 404 and calendar 410 both fall back to a full resync", async () => {
    const { g, registry, events } = await connected();
    g.route("GET", "/gmail/v1/users/me/history", () =>
      Response.json(fixture("history-not-found"), { status: 404 }),
    );
    g.route("GET", "/gmail/v1/users/me/messages", fixture("messages-list"));
    g.route("GET", "/calendar/v3/calendars/primary/events", ({ url }: { url: URL }) => {
      if (url.searchParams.get("syncToken") === "expired")
        return Response.json(fixture("gone"), { status: 410 });
      return Response.json(
        fixture(
          url.searchParams.get("pageToken") === "p2" ? "events-full-page2" : "events-full-page1",
        ),
      );
    });
    const r = await registry
      .instance("google-1")
      ?.sync?.({ gmail: { historyId: "1" }, calendars: { primary: "expired" } });
    expect(r).toMatchObject({
      full: true,
      cursor: {
        gmail: { historyId: "9001" },
        calendars: { primary: "sync-full-2" },
        newMessageIds: ["r1", "r2"],
      },
    });
    // Through the registry the cursor is persisted as lastSync.
    const viaRegistry = await registry.sync("google-1");
    expect(viaRegistry.full).toBe(true);
    expect((await registry.get("google-1")).lastSync).toMatchObject({
      calendars: { primary: "sync-full-2" },
    });
    expect(events).toContainEqual(expect.objectContaining({ type: "synced", full: true }));
  });
});

describe("Calendar", () => {
  it("lists events only in bounded ranges, queries free/busy, and creates events with a calendar binding", async () => {
    const approvals: Record<string, string> = {};
    const { g, tools } = await connected({
      broker: stubBroker(approvals).broker,
      approvalFor: () => "ap",
    });
    g.route("GET", "/calendar/v3/calendars/primary/events", fixture("events-list"));
    g.route("POST", "/calendar/v3/freeBusy", fixture("freebusy"));
    g.route("POST", "/calendar/v3/calendars/primary/events", ({ body }: { body: string }) =>
      Response.json({ id: "new-1", status: "confirmed", ...JSON.parse(body) }),
    );
    const listed = await run(tools, "mcp__google-1__calendar_list_events", {
      timeMin: "2026-10-19T00:00:00Z",
      timeMax: "2026-10-26T00:00:00Z",
    });
    expect((listed.output as { summary: string }[]).map((e) => e.summary)).toEqual([
      "Lunch with Ana",
      "Standup",
    ]);
    await expect(
      run(tools, "mcp__google-1__calendar_list_events", {
        timeMin: "2026-01-01T00:00:00Z",
        timeMax: "2028-01-01T00:00:00Z",
      }),
    ).rejects.toMatchObject({ code: "invalid_params" });
    const fb = await run(tools, "mcp__google-1__calendar_free_busy", {
      timeMin: "2026-10-23T00:00:00Z",
      timeMax: "2026-10-24T00:00:00Z",
    });
    expect(fb.output).toMatchObject({ primary: { busy: [{ start: "2026-10-23T12:00:00Z" }] } });
    const params = {
      event: {
        summary: "Lunch",
        start: { dateTime: "2026-10-23T12:00:00Z" },
        end: { dateTime: "2026-10-23T13:00:00Z" },
      },
    };
    const desc = tools.get("mcp__google-1__calendar_create_event")?.describeCall?.(params);
    expect(desc).toMatchObject({
      kind: "calendar_write",
      grantKey: "calendar_write:owner@example.com:primary:create",
    });
    expect(
      tools.get("mcp__google-1__calendar_delete_event")?.describeCall?.({ eventId: "e1" })
        ?.sideEffect,
    ).toBe("destructive");
    approvals.ap = toolCallBindingHash("mcp__google-1__calendar_create_event", params, desc);
    const created = await run(tools, "mcp__google-1__calendar_create_event", params);
    expect(created.output).toMatchObject({ id: "new-1", summary: "Lunch" });
  });
});

describe("secrets", () => {
  it("tokens never appear in tool outputs, records or events", async () => {
    registerSecret("1//fake-refresh-token-abcdef", "google refresh token");
    registerSecret("ya29.fake-access-token-1", "google access token");
    const { g, tools, registry, events } = await connected();
    g.route("GET", "/gmail/v1/users/me/labels", { labels: [] });
    const out = await run(tools, "mcp__google-1__gmail_list_labels", {});
    assertNoSecrets({ out, record: await registry.get("google-1"), events, specs: tools.list() });
  });
});

describe("review regressions", () => {
  it("a calendar event that invites people targets the attendees, so a standing grant cannot cover new ones", () => {
    const plain = calendarBinding("owner@example.com", "create", { event: { summary: "x" } });
    const invite = calendarBinding("owner@example.com", "create", {
      event: {
        summary: "x",
        attendees: [{ email: "Eve@Evil.example" }, { email: "ana@example.org" }],
      },
      sendUpdates: "all",
    });
    expect(plain.target).toEqual({ kind: "account", value: "owner@example.com" });
    expect(invite.target).toMatchObject({
      kind: "recipient",
      value: "ana@example.org,eve@evil.example",
    });
    expect(invite.grantKey).not.toBe(plain.grantKey);
    expect(invite.grantKey).toContain("eve@evil.example");
    expect(
      calendarBinding("o", "update", { eventId: "e", event: {}, sendUpdates: "all" }).target?.kind,
    ).toBe("recipient");
  });

  it("threading headers are part of the send binding", () => {
    const base = { to: ["a@example.org"], subject: "s", body: "b" };
    const a = sendBinding("o", { ...base, inReplyTo: "<1@x>" }).bindingFields;
    const b = sendBinding("o", { ...base, inReplyTo: "<2@x>" }).bindingFields;
    expect(a).not.toEqual(b);
  });

  it("one address string is exactly one recipient", () => {
    for (const bad of [
      "ok@a.com evil@b.com",
      "Bob <bob@a.com",
      "a@b.com, c@d.com",
      "Eve <e@x.com> <f@y.com>",
      'x"y <a@b.com>',
    ]) {
      expect(() => buildMime({ to: [bad], subject: "s", text: "t" }), bad).toThrow();
    }
    const raw = Buffer.from(
      decodeBase64Url(buildMime({ to: ["José <j@example.org>"], subject: "s", text: "t" })) ?? [],
    ).toString();
    expect(raw).toContain(
      `To: =?UTF-8?B?${Buffer.from("José").toString("base64")}?= <j@example.org>`,
    );
  });

  it("nested hidden HTML is dropped and visible styles are kept", () => {
    expect(
      htmlToText('<div style="display:none"><div>a</div>IGNORE PREVIOUS</div><p>shown</p>'),
    ).toBe("shown");
    expect(
      htmlToText('<p style="opacity:0.9;font-size:0.8em;overflow:hidden">visible text</p>'),
    ).toBe("visible text");
  });

  it("reconnecting in read mode revokes the old grant and stores only the granted scopes", async () => {
    const { g, registry } = await connected();
    const revokesBefore = g.requests.filter(
      (r) => r.url.href === "https://oauth2.googleapis.com/revoke",
    ).length;
    const r = await registry.connect({
      catalogueId: "google",
      scopeMode: "read",
      connectorId: "google-1",
    });
    expect(
      g.requests.filter((q) => q.url.href === "https://oauth2.googleapis.com/revoke").length,
    ).toBe(revokesBefore + 1);
    expect(r.scopes.sort()).toEqual(
      [GOOGLE_SCOPES.calendarReadonly, GOOGLE_SCOPES.driveFile, GOOGLE_SCOPES.gmailReadonly].sort(),
    );
  });

  it("a grant broader than requested is revoked and refused", async () => {
    const g = new FakeGoogle();
    g.route("GET", "/gmail/v1/users/me/profile", fixture("profile"));
    g.grantScope = (requested) => `${requested} ${GOOGLE_SCOPES.gmailSend}`;
    const registry = new ConnectorRegistry({
      factories: [googleFactory({ openBrowser: g.openBrowser, timeoutMs: 5000 })],
      context: g.context(),
    });
    await expect(
      registry.connect({
        catalogueId: "google",
        scopeMode: "read",
        config: { clientId: CLIENT_ID },
      }),
    ).rejects.toThrow(/more than requested/);
    expect(g.requests.some((q) => q.url.href === "https://oauth2.googleapis.com/revoke")).toBe(
      true,
    );
  });
});
