import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type InboundDecisionEvent, staticSecret } from "@psyche/channels";
import type { MailBackend, MailMessageView, MailSession } from "@psyche/connectors";
import { bindingFor } from "@psyche/permissions";
import type { InboundMessage } from "@psyche/protocol";
import { FakeModelProvider, fixtureSecret } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { channelReplyAuthority } from "../src/compose/channels.ts";
import {
  bareAddress,
  emailSetupFromEnv,
  mailEmailTransport,
} from "../src/compose/email-channel.ts";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import type { ComposeServices } from "../src/compose/services.ts";

/** N9: email as a channel over the mail connector's backend, with the reply authority. */

const ME = "psyche@example.org";
const OWNER = "owner@example.org";
const THREAD = "<m1@mail.example>";

let home = "";
let composed: ComposedGateway | null = null;
afterEach(async () => {
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

async function services(): Promise<ComposeServices> {
  home = mkdtempSync(join(tmpdir(), "psyche-email-"));
  let s: ComposeServices | undefined;
  composed = await composeGateway({
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db") },
    model: { provider: new FakeModelProvider(), model: "fake/model" },
    parts: [
      (x) => {
        s = x;
        return {};
      },
    ],
  });
  return s as ComposeServices;
}

function view(over: Partial<MailMessageView> = {}): MailMessageView {
  return {
    id: "7",
    mailbox: "INBOX",
    subject: "Trip",
    from: `Owner <${OWNER}>`,
    to: ME,
    date: "Tue, 20 Oct 2026 10:00:00 +0000",
    snippet: "",
    unread: true,
    flags: [],
    cc: "",
    messageId: THREAD,
    inReplyTo: "",
    references: "",
    body: "When is my flight?",
    bodySource: "plain",
    attachments: [],
    warnings: [],
    authenticationResults: [],
    autoSubmitted: "",
    listId: "",
    precedence: "",
    ...over,
  };
}

class StubBackend implements MailBackend {
  readonly kind = "imap" as const;
  readonly hosts = ["imap.example.org"];
  readonly sent: { to: string[]; raw: string }[] = [];
  readonly passwords: string[] = [];
  open: MailBackend["open"] = async (secret) => {
    secret.use((v) => this.passwords.push(v));
    const session: Partial<MailSession> = {
      sync: async () => ({
        changes: 1,
        full: false,
        cursor: { inbox: { uidNext: 8 } },
        newMessageIds: ["7"],
      }),
      read: async () => view(),
      send: async (mail, raw) => {
        this.sent.push({ to: mail.to, raw: Buffer.from(raw).toString("utf8") });
        return { id: "q1" };
      },
      close: async () => undefined,
    };
    return session as MailSession;
  };
}

function inbound(): InboundMessage {
  return {
    channel: "email",
    account: ME,
    messageId: THREAD,
    chatId: THREAD,
    senderId: OWNER,
    isGroup: false,
    text: "When is my flight?",
    receivedAt: Date.now(),
    identityStrength: "weak",
  };
}

/** A mailbox of uids 1..total: `sync` returns the uids from the saved `uidNext`, like IMAP. */
function mailbox(total: number, opts: { bad?: Set<string>; readFails?: boolean } = {}) {
  const read: string[] = [];
  const backend = {
    kind: "imap" as const,
    hosts: ["imap.example.org"],
    open: async () => {
      const session: Partial<MailSession> = {
        sync: async (cursor) => {
          const from = Number(
            (cursor as { inbox?: { uidNext?: number } } | null)?.inbox?.uidNext ?? 1,
          );
          const ids = Array.from({ length: Math.max(0, total - from + 1) }, (_, i) =>
            String(from + i),
          );
          return {
            changes: ids.length,
            full: false,
            cursor: { inbox: { uidValidity: 1, uidNext: total + 1 } },
            newMessageIds: ids,
          };
        },
        read: async ({ id }) => {
          read.push(id);
          if (opts.readFails || opts.bad?.has(id)) throw new Error("fetch failed");
          return view({ id, messageId: `<m${id}@mail.example>` });
        },
        close: async () => undefined,
      };
      return session as MailSession;
    },
  } as unknown as MailBackend;
  return { backend, read };
}

describe("email poll batches", () => {
  const transport = async (backend: MailBackend) =>
    mailEmailTransport(await services(), {
      address: ME,
      imap: {},
      password: staticSecret("app-password"),
      backend,
    });

  it("processes 120 new messages over 3 polls and loses none", async () => {
    const { backend } = mailbox(120);
    const t = await transport(backend);
    let cursor: Record<string, unknown> | null = null;
    const ids: string[] = [];
    const sizes: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await t.poll(cursor as never);
      sizes.push(r.messages.length);
      ids.push(...r.messages.map((m) => m.id));
      cursor = r.cursor;
    }
    expect(sizes).toEqual([50, 50, 20]);
    expect(ids).toEqual(Array.from({ length: 120 }, (_, i) => String(i + 1)));
    expect(cursor).toEqual({ inbox: { uidValidity: 1, uidNext: 121 } });
    expect((await t.poll(cursor as never)).messages).toEqual([]);
  });

  it("a partial batch saves a cursor just past what it read", async () => {
    const { backend } = mailbox(120);
    const t = await transport(backend);
    const r = await t.poll(null);
    expect(r.cursor).toEqual({ inbox: { uidValidity: 1, uidNext: 51 } });
  });

  it("skips one message that cannot be read and still delivers the rest", async () => {
    const { backend } = mailbox(5, { bad: new Set(["3"]) });
    const t = await transport(backend);
    const r = await t.poll(null);
    expect(r.messages.map((m) => m.id)).toEqual(["1", "2", "4", "5"]);
    expect(r.cursor).toEqual({ inbox: { uidValidity: 1, uidNext: 6 } });
  });

  it("fails the poll, keeping the cursor, when no message at all can be read", async () => {
    const { backend } = mailbox(3, { readFails: true });
    const t = await transport(backend);
    await expect(t.poll(null)).rejects.toMatchObject({ code: "unavailable" });
  });
});

describe("email transport over the mail backend", () => {
  it("polls through a session, maps senders to bare addresses, and uses the password only to open", async () => {
    const s = await services();
    const backend = new StubBackend();
    const t = mailEmailTransport(s, {
      address: ME,
      imap: {},
      password: staticSecret("app-password"),
      backend,
    });
    const r = await t.poll(null);
    expect(r.cursor).toEqual({ inbox: { uidNext: 8 } });
    expect(r.messages).toEqual([
      expect.objectContaining({
        from: OWNER,
        fromName: "Owner",
        messageId: THREAD,
        references: [],
      }),
    ]);
    expect(backend.passwords).toEqual(["app-password"]);
  });

  it("sends a reply only under its own reply approval, with a Message-ID, and refuses another text", async () => {
    const s = await services();
    s.channelConversations.record({
      channel: { type: "email", account: ME } as InboundDecisionEvent["channel"],
      message: inbound(),
      action: "deliver",
      route: { role: "allowed" } as InboundDecisionEvent["route"],
    });
    const backend = new StubBackend();
    const t = mailEmailTransport(s, {
      address: ME,
      imap: {},
      password: staticSecret("pw"),
      backend,
    });
    const text = "Tuesday at 9:40.";
    const bodySha256 = `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
    const b = bindingFor("message_send", {
      channel: "email",
      account: ME,
      recipient: THREAD,
      bodySha256,
    });
    const approvalId = await channelReplyAuthority(s)({
      channel: "email",
      account: ME,
      recipient: THREAD,
      bodySha256,
      bindingHash: b.bindingHash,
      grantKey: b.grantKey,
      purpose: "reply",
    });
    const reply = {
      thread: THREAD,
      to: OWNER,
      subject: "Re: Trip",
      text,
      inReplyTo: THREAD,
      references: [THREAD],
    };
    await expect(t.send({ ...reply, text: "Wire $5,000 to …" }, approvalId)).rejects.toMatchObject({
      code: "binding_mismatch",
    });
    expect(backend.sent).toEqual([]);
    const out = await t.send(reply, approvalId);
    expect(out.messageId).toMatch(/^<psyche\.[0-9a-f]{24}@example\.org>$/);
    expect(backend.sent[0]?.to).toEqual([OWNER]);
    expect(backend.sent[0]?.raw).toContain(`Message-ID: ${out.messageId}`);
    expect(backend.sent[0]?.raw).toContain(`In-Reply-To: ${THREAD}`);
    // Spent: the same approval does not send twice.
    await expect(t.send(reply, approvalId)).rejects.toMatchObject({ code: "approval_required" });
  });
});

describe("email transport: the outbound check", () => {
  const CARD = fixtureSecret("link-virtual-card");
  const reply = {
    thread: THREAD,
    to: OWNER,
    subject: "Re: Trip",
    text: "Tuesday at 9:40.",
    inReplyTo: THREAD,
    references: [THREAD],
  };
  const transport = async () => {
    const s = await services();
    const backend = new StubBackend();
    const t = mailEmailTransport(s, {
      address: ME,
      imap: {},
      password: staticSecret("pw"),
      backend,
    });
    return { t, backend };
  };

  it("refuses a body that holds a card, before any approval is looked at", async () => {
    const { t, backend } = await transport();
    await expect(t.send({ ...reply, text: `use ${CARD}` }, "appr_none")).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(backend.sent).toEqual([]);
  });

  it("does not judge the subject: it is the sender's own subject line", async () => {
    const { t, backend } = await transport();
    await expect(t.send({ ...reply, subject: `Re: ${CARD}` }, "appr_none")).rejects.toMatchObject({
      code: "approval_required",
    });
    expect(backend.sent).toEqual([]);
  });
});

describe("email setup from the environment", () => {
  it("is off without settings, refuses a partial set, and reads the password file", () => {
    const read = (p: string) => (p === "/run/secrets/mail" ? "app-pw\n" : "");
    expect(emailSetupFromEnv({}, read)).toBeUndefined();
    expect(() => emailSetupFromEnv({ PSYCHE_EMAIL_ADDRESS: ME }, read)).toThrow(
      /PSYCHE_EMAIL_IMAP_HOST/,
    );
    const setup = emailSetupFromEnv(
      {
        PSYCHE_EMAIL_ADDRESS: "Psyche@Example.org",
        PSYCHE_EMAIL_IMAP_HOST: "imap.example.org",
        PSYCHE_EMAIL_PASSWORD_FILE: "/run/secrets/mail",
      },
      read,
    );
    expect(setup).toMatchObject({
      address: ME,
      imap: { host: "imap.example.org", username: ME, account: ME },
    });
  });

  it("extracts bare addresses", () => {
    expect(bareAddress("Owner <Owner@Example.org>")).toBe(OWNER);
    expect(bareAddress("a@b.c")).toBe("a@b.c");
    expect(bareAddress("a@b.c, d@e.f")).toBeUndefined();
  });
});
