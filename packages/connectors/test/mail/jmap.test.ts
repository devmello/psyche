import {
  assertNoSecrets,
  FakeClock,
  FakeCredentialBroker,
  FakeJmapServer,
  FakeMailStore,
  seedMailStore,
} from "@psyche/testing";
import { describe, expect, it } from "vitest";
import { toolCallBindingHash } from "../../src/framework/binding.ts";
import { ConnectorRegistry } from "../../src/framework/registry.ts";
import type { ConnectorEvent } from "../../src/framework/types.ts";
import { sendBinding } from "../../src/mail/binding.ts";
import { MAIL_ACTIONS } from "../../src/mail/connector.ts";
import { parseJmapConfig } from "../../src/mail/jmap/client.ts";
import { jmapFactory } from "../../src/mail/presets.ts";
import { MapRegistry, MemoryLibrary, MemoryVault, run, stubBroker } from "./helpers.ts";

const TOKEN = "fmu1-fake-token-0123456789abcdef";
const OWNER = "owner@example.com";

async function connected(
  opts: {
    scopeMode?: "read" | "read_act";
    approved?: Record<string, string>;
    extraHosts?: string[];
    standing?: boolean;
  } = {},
) {
  const store = seedMailStore(new FakeMailStore({ address: OWNER, secret: TOKEN }));
  const server = new FakeJmapServer(store);
  const clock = new FakeClock();
  const credentials = new FakeCredentialBroker({ clock });
  credentials.add({
    slug: "fastmail-token",
    kind: "api_key",
    bindings: [{ connector: "jmap-1" }],
    secret: TOKEN,
  });
  credentials.approve("cfa_mail", { slug: "fastmail-token", origin: "jmap-1", scope: "site" });
  const events: ConnectorEvent[] = [];
  const tools = new MapRegistry();
  const library = new MemoryLibrary();
  const { broker, receipts, approved } = stubBroker(opts.approved);
  const registry = new ConnectorRegistry({
    factories: [
      jmapFactory(opts.standing === false ? {} : { approveCredential: async () => "cfa_mail" }),
    ],
    context: { clock, fetch: server.fetch, tokens: new MemoryVault(), credentials, library },
    tools,
    broker,
    approvalFor: (callId) => (callId === "call-approved" ? "apr_1" : undefined),
    onEvent: (e) => events.push(e),
    newId: () => "jmap-1",
  });
  const record = await registry.connect({
    catalogueId: "jmap",
    scopeMode: opts.scopeMode ?? "read_act",
    config: {
      token: "{{cred:fastmail-token}}",
      account: OWNER,
      sessionUrl: server.sessionUrl,
      extraHosts: opts.extraHosts ?? [new URL(server.downloadOrigin).host],
    },
  });
  return {
    store,
    server,
    registry,
    record,
    events,
    tools,
    library,
    receipts,
    approved,
    credentials,
  };
}

describe("JMAP connector: connect and config", () => {
  it("connects with a vault token, reports the account and never exposes the token", async () => {
    const { record, server, events } = await connected();
    expect(record).toMatchObject({ status: "connected", account: OWNER, type: "jmap" });
    expect(server.requests.every((r) => r.authorized)).toBe(true);
    assertNoSecrets({ record, events });
    expect(JSON.stringify(record)).not.toContain(TOKEN);
  });

  it("refuses a raw token, an http session URL and a missing account", async () => {
    expect(() =>
      parseJmapConfig({ sessionUrl: "http://api.fastmail.example/jmap/session" }),
    ).toThrow(/https/);
    const { registry } = await connected();
    await expect(
      registry.connect({
        catalogueId: "jmap",
        scopeMode: "read_act",
        config: { token: TOKEN, account: OWNER },
      }),
    ).rejects.toThrow(/placeholder/);
    await expect(
      registry.connect({
        catalogueId: "jmap",
        scopeMode: "read_act",
        config: { token: "{{cred:fastmail-token}}" },
      }),
    ).rejects.toThrow(/account/);
  });

  it("has Gmail's action matrix: send is destructive, labels ask, read allows", async () => {
    const byId = Object.fromEntries(MAIL_ACTIONS.map((a) => [a.id, a]));
    expect(byId["mail.send"]).toMatchObject({
      sideEffect: "destructive",
      approvalKind: "send_email",
      defaultRule: "ask",
    });
    expect(byId["mail.labels"]).toMatchObject({ sideEffect: "write", defaultRule: "ask" });
    expect(byId["mail.read"]).toMatchObject({ sideEffect: "read", defaultRule: "allow" });
    const { registry } = await connected();
    await expect(registry.setMatrix("jmap-1", { "mail.send": "allow" })).rejects.toThrow(
      /destructive/,
    );
  });

  it("read-only scope registers no write tools", async () => {
    const { tools } = await connected({ scopeMode: "read" });
    const names = tools.list().map((t) => t.name);
    expect(names).toContain("mcp__jmap-1__mail_search_messages");
    expect(names).not.toContain("mcp__jmap-1__mail_send");
    expect(names).not.toContain("mcp__jmap-1__mail_modify_flags");
  });
});

describe("JMAP connector: reading", () => {
  it("searches the inbox newest first, filters unread and pages", async () => {
    const { tools } = await connected();
    const all = (await run(tools, "mcp__jmap-1__mail_search_messages", {})) as {
      output: {
        messages: { id: string; subject: string; unread: boolean }[];
        nextPageToken: string | null;
      };
      provenance: string;
    };
    expect(all.provenance).toBe("untrusted");
    expect(all.output.messages.map((m) => m.id)).toEqual([
      "msg_0001",
      "msg_0002",
      "msg_0003",
      "msg_0004",
      "msg_0005",
    ]);
    expect(all.output.messages[0]?.subject).toBe("Q4 roadmap: confirm launch date by Tuesday");
    const unread = (await run(tools, "mcp__jmap-1__mail_search_messages", {
      unread: true,
      maxResults: 2,
    })) as {
      output: { messages: { id: string }[]; nextPageToken: string | null };
    };
    expect(unread.output.messages.map((m) => m.id)).toEqual(["msg_0001", "msg_0003"]);
    expect(unread.output.nextPageToken).toBe("2");
    const page2 = (await run(tools, "mcp__jmap-1__mail_search_messages", {
      unread: true,
      maxResults: 2,
      pageToken: "2",
    })) as {
      output: { messages: { id: string }[]; nextPageToken: string | null };
    };
    expect(page2.output.messages.map((m) => m.id)).toEqual(["msg_0004"]);
    const byText = (await run(tools, "mcp__jmap-1__mail_search_messages", {
      query: "invoice",
    })) as {
      output: { messages: { id: string }[] };
    };
    expect(byText.output.messages.map((m) => m.id)).toEqual(["msg_0003"]);
  });

  it("reads a message with hidden HTML stripped and quoted-printable decoded, as untrusted data", async () => {
    const { tools } = await connected();
    const html = (await run(tools, "mcp__jmap-1__mail_read_message", { id: "msg_0002" })) as {
      output: { body: string; subject: string; unread: boolean; flags: string[] };
      provenance: string;
    };
    expect(html.provenance).toBe("untrusted");
    expect(html.output.body).toContain("retention loops");
    expect(html.output.body).not.toContain("attacker@evil.example");
    expect(html.output.unread).toBe(false);
    const qp = (await run(tools, "mcp__jmap-1__mail_read_message", { id: "msg_0004" })) as {
      output: { body: string; subject: string; cc: string; flags: string[] };
    };
    expect(qp.output.subject).toBe("Café menu — Übersicht");
    expect(qp.output.body).toContain("Grüße aus Zürich");
    expect(qp.output.cc).toBe("team@example.org");
    expect(qp.output.flags).toEqual(["flagged"]);
    await expect(run(tools, "mcp__jmap-1__mail_read_message", { id: "nope" })).rejects.toThrow(
      /not found/,
    );
  });

  it("lists mailboxes with roles and saves an attachment to the Library", async () => {
    const { tools, library } = await connected();
    const boxes = (await run(tools, "mcp__jmap-1__mail_list_mailboxes", {})) as {
      output: { id: string; role?: string; unread?: number }[];
    };
    expect(boxes.output.find((b) => b.role === "inbox")).toMatchObject({
      id: "mbx_inbox",
      unread: 3,
    });
    const read = (await run(tools, "mcp__jmap-1__mail_read_message", { id: "msg_0003" })) as {
      output: { attachments: { partId: string; filename: string }[] };
    };
    expect(read.output.attachments[0]).toMatchObject({ filename: "invoice-4471.pdf", partId: "2" });
    const saved = (await run(tools, "mcp__jmap-1__mail_save_attachment", {
      id: "msg_0003",
      partId: "2",
    })) as {
      output: { libraryItemId: string; filename: string; mimeType: string };
    };
    expect(saved.output).toMatchObject({
      libraryItemId: "lib_1",
      filename: "invoice-4471.pdf",
      mimeType: "application/pdf",
    });
    expect(library.items[0]?.provenance).toBe("untrusted");
    expect(Buffer.from(library.items[0]?.bytes ?? []).toString("latin1")).toContain("%PDF-1.4");
  });
});

describe("JMAP connector: writes", () => {
  it("fails closed on writes without an approval, then flags and moves with a receipt", async () => {
    const { tools, store, receipts, approved } = await connected();
    await expect(
      run(tools, "mcp__jmap-1__mail_modify_flags", { id: "msg_0001", addFlags: ["seen"] }),
    ).rejects.toMatchObject({ code: "approval_required" });
    const params = { id: "msg_0001", addFlags: ["Seen", "$flagged"], moveTo: "Archive" };
    // The hash the loop approves is the one describeCall produces for these exact arguments.
    const reg = tools.get("mcp__jmap-1__mail_modify_flags");
    const desc = reg?.describeCall?.(params);
    approved.apr_1 = toolCallBindingHash("mcp__jmap-1__mail_modify_flags", params, desc);
    const out = (await run(tools, "mcp__jmap-1__mail_modify_flags", params, "call-approved")) as {
      output: { id: string; mailbox: string };
      receiptId?: string;
    };
    expect(out.output).toEqual({ id: "msg_0001", mailbox: "mbx_archive" });
    expect(out.receiptId).toBe("rcpt_1");
    const msg = store.get("msg_0001");
    expect(msg?.mailbox).toBe("mbx_archive");
    expect([...(msg?.flags ?? [])].sort()).toEqual(["Flagged", "Seen"]);
    expect(receipts[0]).toMatchObject({ kind: "mail.labels", outcome: "ok", approvalId: "apr_1" });
  });

  it("creates a draft in the Drafts mailbox (allow by default) with a receipt", async () => {
    const { tools, store, receipts } = await connected();
    const out = (await run(tools, "mcp__jmap-1__mail_create_draft", {
      to: ["Maya Okafor <maya@example.com>"],
      subject: "Re: Q4 roadmap",
      body: "Still on for Nov 12.",
    })) as { output: { draftId: string }; receiptId?: string };
    expect(out.output.draftId).toBe("msg_0008");
    const draft = store.get("msg_0008");
    expect(draft?.mailbox).toBe("mbx_drafts");
    expect(draft?.flags.has("Draft")).toBe(true);
    expect(store.header(draft as never, "From")).toBe(OWNER);
    expect(receipts[0]).toMatchObject({ kind: "mail.draft", outcome: "ok" });
  });

  it("sends only with an approval bound to the exact recipients, subject and body", async () => {
    const { tools, store, server, receipts, approved } = await connected();
    const params = { to: ["dana@example.com"], subject: "Thursday works", body: "See you at 2pm." };
    await expect(run(tools, "mcp__jmap-1__mail_send", params)).rejects.toMatchObject({
      code: "approval_required",
    });
    approved.apr_1 = toolCallBindingHash(
      "mcp__jmap-1__mail_send",
      params,
      sendBinding(OWNER, params),
    );
    await expect(
      run(tools, "mcp__jmap-1__mail_send", { ...params, body: "See you at 3pm." }, "call-approved"),
    ).rejects.toMatchObject({ code: "binding_mismatch" });
    expect(server.submissions).toHaveLength(0);
    const out = (await run(tools, "mcp__jmap-1__mail_send", params, "call-approved")) as {
      output: { messageId: string };
      receiptId?: string;
    };
    expect(server.submissions).toEqual([
      { id: "sub_0001", emailId: out.output.messageId, identityId: "ident_1" },
    ]);
    const sent = store.get(out.output.messageId);
    expect(sent?.mailbox).toBe("mbx_sent");
    expect(sent?.flags.has("Draft")).toBe(false);
    expect(store.header(sent as never, "To")).toBe("dana@example.com");
    expect(receipts.at(-1)).toMatchObject({
      kind: "mail.send",
      outcome: "ok",
      approvalId: "apr_1",
    });
    expect(receipts.at(-1)?.summary).toContain("dana@example.com");
    assertNoSecrets({ receipts, out });
  });
});

describe("JMAP connector: credential handling", () => {
  it("a rejected token moves the connector to needs_auth and invalidates pending work", async () => {
    const { tools, store, events, registry } = await connected();
    store.account.secret = "rotated-elsewhere-xyz";
    await expect(run(tools, "mcp__jmap-1__mail_list_mailboxes", {})).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(events.some((e) => e.type === "status" && e.status === "needs_auth")).toBe(true);
    expect(events.some((e) => e.type === "invalidated" && e.reason === "token_revoked")).toBe(true);
    expect((await registry.get("jmap-1")).status).toBe("needs_auth");
  });

  it("never sends the token to a host outside the session allowlist", async () => {
    const { tools, server } = await connected({ extraHosts: [] });
    await expect(
      run(tools, "mcp__jmap-1__mail_read_message", { id: "msg_0001" }),
    ).rejects.toMatchObject({
      code: "policy_denied",
    });
    expect(server.requests.some((r) => r.url.startsWith(server.downloadOrigin))).toBe(false);
  });

  it("without a standing approval, tools need the call's own approval and connect does no network", async () => {
    const { tools, server, credentials } = await connected({ standing: false });
    expect(server.requests).toHaveLength(0);
    await expect(run(tools, "mcp__jmap-1__mail_list_mailboxes", {})).rejects.toMatchObject({
      code: "approval_required",
    });
    credentials.approve("apr_1", { slug: "fastmail-token", origin: "jmap-1" });
    const out = (await run(tools, "mcp__jmap-1__mail_list_mailboxes", {}, "call-approved")) as {
      output: unknown[];
    };
    expect(out.output).toHaveLength(6);
  });

  it("syncs with Email/changes and falls back to a full sync when the state is gone", async () => {
    const { registry, store, server } = await connected();
    const first = await registry.sync("jmap-1");
    expect(first.full).toBe(true);
    store.add("INBOX", store.get("msg_0001")?.raw ?? new Uint8Array());
    const second = await registry.sync("jmap-1");
    expect(second).toMatchObject({ changes: 1, full: false });
    expect((second.cursor as { newMessageIds: string[] }).newMessageIds).toEqual(["msg_0008"]);
    server.cannotCalculateChanges = true;
    const third = await registry.sync("jmap-1");
    expect(third.full).toBe(true);
  });

  it("health reports connected, and the token appears in no request record or event", async () => {
    const { registry, server, events } = await connected();
    expect((await registry.status("jmap-1")).ok).toBe(true);
    assertNoSecrets({ requests: server.requests, events });
  });
});
