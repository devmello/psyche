import {
  assertNoSecrets,
  FakeClock,
  FakeCredentialBroker,
  FakeImapServer,
  type FakeImapServerOptions,
  FakeMailStore,
  FakeSmtpServer,
  seedMailStore,
} from "@psyche/testing";
import { describe, expect, it } from "vitest";
import { toolCallBindingHash } from "../../src/framework/binding.ts";
import { ConnectorRegistry } from "../../src/framework/registry.ts";
import type { ConnectorEvent } from "../../src/framework/types.ts";
import { sendBinding } from "../../src/mail/binding.ts";
import { parseImapConfig } from "../../src/mail/imap/backend.ts";
import {
  fetchItems,
  internalDateToIso,
  isoToImapDate,
  tokenize,
} from "../../src/mail/imap/parser.ts";
import { imapFactory } from "../../src/mail/presets.ts";
import type { MailDialer } from "../../src/mail/transport.ts";
import { MapRegistry, MemoryLibrary, MemoryVault, run, stubBroker } from "./helpers.ts";

const PASSWORD = "fx-app-pw-7Qx9mZ2pLw";
const OWNER = "owner@example.com";

async function connected(
  opts: {
    scopeMode?: "read" | "read_act";
    server?: FakeImapServerOptions;
    password?: string;
    standing?: boolean;
  } = {},
) {
  const password = opts.password ?? PASSWORD;
  const store = seedMailStore(new FakeMailStore({ address: OWNER, secret: password }));
  const imap = new FakeImapServer(store, opts.server ?? {});
  const smtp = new FakeSmtpServer(store);
  const dials: { host: string; port: number }[] = [];
  const dial: MailDialer = async (host, port) => {
    dials.push({ host, port });
    if (port === 993) return imap.connect();
    if (port === 465) return smtp.connect();
    throw new Error(`unexpected dial ${host}:${port}`);
  };
  const clock = new FakeClock();
  const credentials = new FakeCredentialBroker({ clock });
  credentials.add({
    slug: "mail-app-password",
    kind: "login",
    bindings: [{ connector: "imap-1" }],
    secret: password,
    username: OWNER,
  });
  credentials.approve("cfa_mail", { slug: "mail-app-password", origin: "imap-1", scope: "site" });
  const events: ConnectorEvent[] = [];
  const tools = new MapRegistry();
  const library = new MemoryLibrary();
  const { broker, receipts, approved } = stubBroker();
  const registry = new ConnectorRegistry({
    factories: [
      imapFactory({
        dial,
        ...(opts.standing === false ? {} : { approveCredential: async () => "cfa_mail" }),
      }),
    ],
    context: {
      clock,
      fetch: () => Promise.reject(new Error("no http")),
      tokens: new MemoryVault(),
      credentials,
      library,
    },
    tools,
    broker,
    approvalFor: (callId) => (callId === "call-approved" ? "apr_1" : undefined),
    onEvent: (e) => events.push(e),
    newId: () => "imap-1",
  });
  const record = await registry.connect({
    catalogueId: "imap",
    scopeMode: opts.scopeMode ?? "read_act",
    config: {
      host: "imap.example.net",
      username: OWNER,
      password: "{{cred:mail-app-password.password}}",
      smtpHost: "smtp.example.net",
      account: OWNER,
    },
  });
  return {
    store,
    imap,
    smtp,
    dials,
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

describe("IMAP response parsing", () => {
  it("tokenizes atoms, quoted strings, lists, NIL, literals and BODY[] sections", () => {
    const lit = Buffer.from("From: a@example.com\r\n\r\n");
    const t = tokenize(
      `* 3 FETCH (UID 12 FLAGS (\\Seen \\Flagged) INTERNALDATE "19-Oct-2026 08:00:00 -0700" BODY[HEADER.FIELDS (FROM TO)] \u00000\u0000 RFC822.SIZE 345 X NIL)`,
      [lit],
    );
    expect(t[0]).toBe("*");
    expect(t[2]).toBe("FETCH");
    const items = fetchItems(t[3] as never);
    expect(items.get("UID")).toBe("12");
    expect(items.get("FLAGS")).toEqual(["\\Seen", "\\Flagged"]);
    expect(items.get("INTERNALDATE")).toBe("19-Oct-2026 08:00:00 -0700");
    expect(items.get("BODY[HEADER.FIELDS (FROM TO)]")).toBe(lit);
    expect(items.get("RFC822.SIZE")).toBe("345");
    expect(items.get("X")).toBeNull();
    expect(tokenize('* LIST (\\HasNoChildren \\Drafts) "/" "Dra\\"fts"', [])).toEqual([
      "*",
      "LIST",
      ["\\HasNoChildren", "\\Drafts"],
      "/",
      'Dra"fts',
    ]);
    expect(tokenize("garbage ) ( ((", [])).toBeTruthy();
  });

  it("converts INTERNALDATE and ISO dates", () => {
    expect(internalDateToIso("19-Oct-2026 08:00:00 -0700")).toBe("2026-10-19T15:00:00.000Z");
    expect(internalDateToIso("nonsense")).toBe("nonsense");
    expect(isoToImapDate("2026-10-19T15:30:00Z")).toBe("19-Oct-2026");
    expect(isoToImapDate("not a date")).toBeUndefined();
  });

  it("config requires a host, a username, implicit TLS and a password placeholder", () => {
    expect(() => parseImapConfig({ host: "bad host", username: "u" })).toThrow(/host/);
    expect(() => parseImapConfig({ host: "imap.example.net" })).toThrow(/username/);
    expect(() => parseImapConfig({ host: "imap.example.net", username: "u", tls: false })).toThrow(
      /TLS/,
    );
    expect(() => parseImapConfig({ host: "imap.example.net", username: "u", port: 70000 })).toThrow(
      /port/,
    );
    expect(parseImapConfig({ host: "IMAP.Example.net", username: "u" })).toMatchObject({
      host: "imap.example.net",
      port: 993,
      smtpHost: "imap.example.net",
      smtpPort: 465,
      smtpUsername: "u",
    });
  });
});

describe("IMAP connector: connect", () => {
  it("logs in over the dialer with the vault password; the password reaches no log, record or event", async () => {
    const { record, imap, dials, events } = await connected();
    expect(record).toMatchObject({ status: "connected", account: OWNER, type: "imap" });
    expect(dials[0]).toEqual({ host: "imap.example.net", port: 993 });
    expect(imap.commands[0]).toBe(`LOGIN ${OWNER} ***`);
    expect(imap.connections[0]?.loggedIn).toBe(true);
    expect(imap.connections[0]?.closed).toBe(true);
    assertNoSecrets({ record, events, commands: imap.commands });
  });

  it("sends a non-ASCII password as a literal and refuses a raw password in config", async () => {
    const { imap, record } = await connected({ password: "pässwörd-with-ümlauts-42" });
    expect(record.status).toBe("connected");
    expect(imap.connections[0]?.loggedIn).toBe(true);
    const { registry } = await connected();
    await expect(
      registry.connect({
        catalogueId: "imap",
        scopeMode: "read_act",
        config: { host: "imap.example.net", username: OWNER, password: PASSWORD, account: OWNER },
      }),
    ).rejects.toThrow(/placeholder/);
  });

  it("a refused login moves the connector to needs_auth and invalidates pending work", async () => {
    const { tools, store, events, registry } = await connected();
    store.account.secret = "changed-by-the-owner-99";
    await expect(run(tools, "mcp__imap-1__mail_list_mailboxes", {})).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(events.some((e) => e.type === "status" && e.status === "needs_auth")).toBe(true);
    expect(events.some((e) => e.type === "invalidated" && e.reason === "token_revoked")).toBe(true);
    expect((await registry.get("imap-1")).status).toBe("needs_auth");
  });

  it("read-only scope registers no write tools", async () => {
    const { tools } = await connected({ scopeMode: "read" });
    const names = tools.list().map((t) => t.name);
    expect(names).toContain("mcp__imap-1__mail_read_message");
    expect(names).not.toContain("mcp__imap-1__mail_send");
  });
});

describe("IMAP connector: reading", () => {
  it("lists mailboxes with roles from SPECIAL-USE, or from names when the server lacks it", async () => {
    const { tools } = await connected();
    const boxes = (await run(tools, "mcp__imap-1__mail_list_mailboxes", {})) as {
      output: { id: string; role?: string }[];
    };
    expect(boxes.output.map((b) => [b.id, b.role])).toEqual([
      ["INBOX", "inbox"],
      ["Drafts", "drafts"],
      ["Sent", "sent"],
      ["Trash", "trash"],
      ["Junk", "junk"],
      ["Archive", "archive"],
    ]);
    const plain = await connected({ server: { capabilities: ["IMAP4rev1"] } });
    const b2 = (await run(plain.tools, "mcp__imap-1__mail_list_mailboxes", {})) as {
      output: { id: string; role?: string }[];
    };
    expect(b2.output.find((b) => b.id === "Junk")?.role).toBe("junk");
    expect(b2.output.find((b) => b.id === "Archive")?.role).toBe("archive");
  });

  it("searches newest UID first, filters unread, pages, and searches text with UTF-8", async () => {
    const { tools, imap } = await connected();
    const all = (await run(tools, "mcp__imap-1__mail_search_messages", {})) as {
      output: {
        messages: { id: string; mailbox: string; subject: string; date: string; unread: boolean }[];
        nextPageToken: string | null;
      };
      provenance: string;
    };
    expect(all.provenance).toBe("untrusted");
    expect(all.output.messages.map((m) => m.id)).toEqual(["5", "4", "3", "2", "1"]);
    expect(all.output.messages[0]).toMatchObject({
      mailbox: "INBOX",
      subject: "Q4 roadmap: confirm launch date by Tuesday",
      date: "2026-10-19T14:52:00.000Z",
      unread: true,
    });
    const unread = (await run(tools, "mcp__imap-1__mail_search_messages", {
      unread: true,
      maxResults: 2,
    })) as {
      output: { messages: { id: string }[]; nextPageToken: string | null };
    };
    expect(unread.output.messages.map((m) => m.id)).toEqual(["5", "3"]);
    expect(unread.output.nextPageToken).toBe("2");
    const page2 = (await run(tools, "mcp__imap-1__mail_search_messages", {
      unread: true,
      maxResults: 2,
      pageToken: "2",
    })) as {
      output: { messages: { id: string }[]; nextPageToken: string | null };
    };
    expect(page2.output.messages.map((m) => m.id)).toEqual(["2"]);
    expect(page2.output.nextPageToken).toBeNull();
    const text = (await run(tools, "mcp__imap-1__mail_search_messages", {
      query: "Zürich",
      since: "2026-10-15T00:00:00Z",
    })) as {
      output: { messages: { id: string }[] };
    };
    expect(text.output.messages.map((m) => m.id)).toEqual(["2"]);
    expect(imap.commands.some((c) => c.startsWith("UID SEARCH CHARSET UTF-8"))).toBe(true);
    const ascii = await connected({ server: { asciiSearchOnly: true } });
    await expect(
      run(ascii.tools, "mcp__imap-1__mail_search_messages", { query: "Zürich" }),
    ).rejects.toMatchObject({ code: "invalid_params" });
    const other = (await run(tools, "mcp__imap-1__mail_search_messages", { mailbox: "Sent" })) as {
      output: { messages: { id: string; mailbox: string }[] };
    };
    expect(other.output.messages).toEqual([expect.objectContaining({ id: "1", mailbox: "Sent" })]);
  });

  it("reads a message (hidden HTML dropped, quoted-printable decoded) and saves an attachment", async () => {
    const { tools, library } = await connected();
    const html = (await run(tools, "mcp__imap-1__mail_read_message", { id: "4" })) as {
      output: { body: string; unread: boolean; flags: string[]; messageId: string } & Record<
        string,
        unknown
      >;
      provenance: string;
    };
    expect(html.provenance).toBe("untrusted");
    expect(html.output.body).toContain("retention loops");
    expect(html.output.body).not.toContain("attacker@evil.example");
    expect(html.output.unread).toBe(false);
    expect(html.output.messageId).toBe("<msg_002.fixture@growthhub.example>");
    expect(html.output).toMatchObject({ authenticationResults: [], autoSubmitted: "", listId: "" });
    const qp = (await run(tools, "mcp__imap-1__mail_read_message", {
      id: "2",
      mailbox: "INBOX",
    })) as {
      output: { body: string; subject: string; flags: string[] };
    };
    expect(qp.output.subject).toBe("Café menu — Übersicht");
    expect(qp.output.body).toContain("Grüße aus Zürich");
    expect(qp.output.flags).toEqual(["flagged"]);
    const saved = (await run(tools, "mcp__imap-1__mail_save_attachment", {
      id: "3",
      partId: "2",
    })) as {
      output: { libraryItemId: string; filename: string };
    };
    expect(saved.output).toMatchObject({ libraryItemId: "lib_1", filename: "invoice-4471.pdf" });
    expect(Buffer.from(library.items[0]?.bytes ?? []).toString("latin1")).toContain("%PDF-1.4");
    await expect(run(tools, "mcp__imap-1__mail_read_message", { id: "99" })).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      run(tools, "mcp__imap-1__mail_read_message", { id: "msg_0001" }),
    ).rejects.toMatchObject({ code: "invalid_params" });
  });
});

describe("IMAP connector: writes", () => {
  it("fails closed without an approval; with one it stores flags and MOVEs, returning the new UID", async () => {
    const { tools, store, receipts, approved } = await connected();
    await expect(
      run(tools, "mcp__imap-1__mail_modify_flags", { id: "5", addFlags: ["seen"] }),
    ).rejects.toMatchObject({ code: "approval_required" });
    const params = {
      id: "5",
      addFlags: ["seen", "flagged"],
      removeFlags: ["answered"],
      moveTo: "archive",
    };
    approved.apr_1 = toolCallBindingHash(
      "mcp__imap-1__mail_modify_flags",
      params,
      tools.get("mcp__imap-1__mail_modify_flags")?.describeCall?.(params),
    );
    const out = (await run(tools, "mcp__imap-1__mail_modify_flags", params, "call-approved")) as {
      output: { id: string; mailbox: string };
      receiptId?: string;
    };
    const msg = store.get("msg_0005");
    expect(msg?.mailbox).toBe("mbx_archive");
    expect(out.output).toEqual({ id: String(msg?.uid), mailbox: "Archive" });
    expect([...(msg?.flags ?? [])].sort()).toEqual(["Flagged", "Seen"]);
    expect(receipts[0]).toMatchObject({ kind: "mail.labels", outcome: "ok", approvalId: "apr_1" });
  });

  it("falls back to COPY + \\Deleted + UID EXPUNGE when the server has no MOVE", async () => {
    const { tools, store, imap, approved } = await connected({
      server: { capabilities: ["IMAP4rev1", "UIDPLUS"] },
    });
    const params = { id: "3", moveTo: "Trash" };
    approved.apr_1 = toolCallBindingHash(
      "mcp__imap-1__mail_modify_flags",
      params,
      tools.get("mcp__imap-1__mail_modify_flags")?.describeCall?.(params),
    );
    const out = (await run(tools, "mcp__imap-1__mail_modify_flags", params, "call-approved")) as {
      output: { id: string; mailbox: string };
    };
    expect(out.output.mailbox).toBe("Trash");
    expect(store.inMailbox("Trash")).toHaveLength(1);
    expect(store.inMailbox("INBOX").map((m) => m.id)).not.toContain("msg_0003");
    expect(
      imap.commands
        .filter((c) => /^UID (COPY|STORE|EXPUNGE)/.test(c))
        .map((c) => c.split(" ").slice(0, 2).join(" ")),
    ).toEqual(["UID COPY", "UID STORE", "UID EXPUNGE"]);
  });

  it("creates a draft with APPEND (allow by default) and returns the APPENDUID", async () => {
    const { tools, store, receipts } = await connected();
    const out = (await run(tools, "mcp__imap-1__mail_create_draft", {
      to: ["maya@example.com"],
      subject: "Re: Q4 roadmap",
      body: "Still on for Nov 12.",
    })) as {
      output: { draftId: string };
    };
    const drafts = store.inMailbox("Drafts");
    expect(drafts).toHaveLength(2);
    expect(out.output.draftId).toBe(String(drafts[1]?.uid));
    expect(drafts[1]?.flags.has("Draft")).toBe(true);
    expect(store.header(drafts[1] as never, "From")).toBe(OWNER);
    expect(receipts[0]).toMatchObject({ kind: "mail.draft", outcome: "ok" });
  });

  it("sends through SMTP only with an approval bound to the exact message, then files a copy in Sent", async () => {
    const { tools, store, smtp, dials, receipts, approved } = await connected();
    const params = {
      to: ["Dana Park <dana@example.com>"],
      cc: ["team@example.org"],
      subject: "Thursday works",
      body: "See you at 2pm.",
    };
    await expect(run(tools, "mcp__imap-1__mail_send", params)).rejects.toMatchObject({
      code: "approval_required",
    });
    approved.apr_1 = toolCallBindingHash(
      "mcp__imap-1__mail_send",
      params,
      sendBinding(OWNER, params),
    );
    await expect(
      run(tools, "mcp__imap-1__mail_send", { ...params, subject: "Friday works" }, "call-approved"),
    ).rejects.toMatchObject({ code: "binding_mismatch" });
    expect(smtp.sent).toHaveLength(0);
    const out = (await run(tools, "mcp__imap-1__mail_send", params, "call-approved")) as {
      output: { messageId: string };
      receiptId?: string;
    };
    expect(out.output.messageId).toBe("fakeq-0001");
    expect(dials.at(-1)).toEqual({ host: "smtp.example.net", port: 465 });
    expect(smtp.sent[0]).toMatchObject({
      from: OWNER,
      recipients: ["dana@example.com", "team@example.org"],
    });
    expect(Buffer.from(smtp.sent[0]?.raw ?? []).toString("latin1")).toContain(
      "Subject: Thursday works",
    );
    expect(smtp.commands).toContain("AUTH PLAIN ***");
    expect(store.inMailbox("Sent")).toHaveLength(2);
    expect(receipts.at(-1)).toMatchObject({
      kind: "mail.send",
      outcome: "ok",
      approvalId: "apr_1",
      externalRefs: { messageId: "fakeq-0001" },
    });
    assertNoSecrets({ receipts, out, smtpCommands: smtp.commands });
  });

  it("a refused recipient fails the send and records an uncertain receipt", async () => {
    const { tools, smtp, store, receipts, approved } = await connected();
    smtp.rejectRecipients.add("nobody@example.com");
    const params = { to: ["nobody@example.com"], subject: "x", body: "y" };
    approved.apr_1 = toolCallBindingHash(
      "mcp__imap-1__mail_send",
      params,
      sendBinding(OWNER, params),
    );
    await expect(run(tools, "mcp__imap-1__mail_send", params, "call-approved")).rejects.toThrow(
      /550/,
    );
    expect(smtp.sent).toHaveLength(0);
    expect(store.inMailbox("Sent")).toHaveLength(1);
    expect(receipts.at(-1)).toMatchObject({ kind: "mail.send", outcome: "uncertain" });
  });
});

describe("IMAP connector: sync and credentials", () => {
  it("syncs by UIDVALIDITY / UIDNEXT: full first, then only new UIDs", async () => {
    const { registry, store } = await connected();
    const first = await registry.sync("imap-1");
    expect(first).toMatchObject({ full: true, changes: 0 });
    expect(first.cursor).toMatchObject({ inbox: { uidValidity: 1000, uidNext: 6 } });
    const none = await registry.sync("imap-1");
    expect(none).toMatchObject({ full: false, changes: 0 });
    store.add("INBOX", store.get("msg_0005")?.raw ?? new Uint8Array());
    store.add("INBOX", store.get("msg_0004")?.raw ?? new Uint8Array());
    const next = await registry.sync("imap-1");
    expect(next).toMatchObject({ full: false, changes: 2 });
    expect((next.cursor as { newMessageIds: string[] }).newMessageIds).toEqual(["6", "7"]);
    (store.mailbox("INBOX") as { uidValidity: number }).uidValidity = 2000;
    expect((await registry.sync("imap-1")).full).toBe(true);
  });

  it("without a standing approval, connect makes no connection and tools need the call's approval", async () => {
    const { tools, imap, credentials } = await connected({ standing: false });
    expect(imap.connections).toHaveLength(0);
    await expect(run(tools, "mcp__imap-1__mail_list_mailboxes", {})).rejects.toMatchObject({
      code: "approval_required",
    });
    credentials.approve("apr_1", { slug: "mail-app-password", origin: "imap-1" });
    const out = (await run(tools, "mcp__imap-1__mail_list_mailboxes", {}, "call-approved")) as {
      output: unknown[];
    };
    expect(out.output).toHaveLength(6);
  });
});
