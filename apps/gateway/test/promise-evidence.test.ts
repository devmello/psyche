import { evaluateDone } from "@psyche/memory";
import type { ToolLookup } from "@psyche/proactive";
import { FakeClock } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import {
  addressOf,
  displayName,
  isAutomatedSender,
  mailEvidence,
  normalizeSubject,
  parseMailMeta,
} from "../src/compose/mail-threads.ts";
import {
  calendarEvidence,
  collectDoneEvidence,
  type EvidenceDeps,
  messagesEvidence,
} from "../src/compose/promise-evidence.ts";

const DAY = 86_400_000;
const MON = Date.parse("2026-11-23T09:00:00Z");
const SAM = "ent_sam";
const SAM_ADDR = "sam@example.com";
const OWNER = "me@example.com";

const resolve = (c: string): string | null =>
  c.toLowerCase() === SAM_ADDR || c === "+15551230000" ? SAM : null;

describe("mail-threads helpers (moved out of mail-followups)", () => {
  it("parses headers and subjects as before", () => {
    expect(addressOf("Sam Lee <Sam@Example.com>")).toBe(SAM_ADDR);
    expect(displayName('"Sam Lee" <sam@example.com>')).toBe("Sam Lee");
    expect(normalizeSubject("Re: Fwd: Lunch?")).toBe("lunch?");
    expect(isAutomatedSender("no-reply@x.com")).toBe(true);
    expect(isAutomatedSender("sam@example.com")).toBe(false);
  });
});

describe("mail evidence", () => {
  it("reads attachments off a Gmail message and tells the owner's mail apart", () => {
    const m = parseMailMeta(
      {
        id: "g1",
        threadId: "t1",
        from: "Me <me@example.com>",
        to: "Sam <sam@example.com>",
        date: new Date(MON + DAY).toISOString(),
        labelIds: ["SENT"],
        attachments: [{ filename: "deck.pdf" }, { filename: "logo.png", inline: true }],
      },
      {},
    );
    expect(m).toMatchObject({ fromOwner: true, attachments: ["deck.pdf"], threadKey: "t1" });
    const ev = mailEvidence(m ? [m] : [], resolve);
    expect(ev.sent[0]).toMatchObject({ toEntityIds: [SAM], attachments: ["deck.pdf"] });
    expect(ev.replies[0]).toMatchObject({ fromOwner: true });
  });

  it("drops malformed rows", () => {
    expect(parseMailMeta({ id: "x" })).toBeUndefined();
    expect(parseMailMeta("nope")).toBeUndefined();
  });
});

describe("the owner is whoever the mailbox says, never the From header", () => {
  const row = (o: Record<string, unknown>) => ({
    id: "g9",
    threadId: "thread-1",
    from: OWNER,
    to: SAM_ADDR,
    date: new Date(MON + DAY).toISOString(),
    attachments: [{ filename: "budget-deck.pdf", mimeType: "application/pdf" }],
    ...o,
  });

  it("a spoofed From: me@ in the INBOX is nobody's send", () => {
    const m = parseMailMeta(row({ labelIds: ["INBOX", "UNREAD"] }));
    expect(m?.fromOwner).toBe(false);
    const ev = mailEvidence(m ? [m] : [], resolve);
    expect(ev.sent[0]).toMatchObject({ fromOwner: false, toEntityIds: [] });
    const loop = {
      direction: "i_owe" as const,
      whatAction: "send" as const,
      text: "send Sam the budget deck",
      counterpartId: SAM,
      threadKey: "thread-1",
    };
    expect(
      evaluateDone(
        loop,
        { ...ev, events: [] },
        { afterMs: MON, askSuppressed: false, askOpen: false },
      ).kind,
    ).toBe("none");
    // Positive control: the same row labelled SENT is the owner's, and closes it.
    const own = parseMailMeta(row({ labelIds: ["SENT"] }));
    const ev2 = mailEvidence(own ? [own] : [], resolve);
    expect(
      evaluateDone(
        loop,
        { ...ev2, events: [] },
        { afterMs: MON, askSuppressed: false, askOpen: false },
      ).kind,
    ).toBe("auto");
    // Sent to oneself (SENT and INBOX) is not a send to Sam either.
    expect(parseMailMeta(row({ labelIds: ["SENT", "INBOX"] }))?.fromOwner).toBe(false);
  });

  it("a stranger's mail to Sam that copies the owner records no recipients", () => {
    const m = parseMailMeta(
      row({ from: "eve@evil.test", to: `${SAM_ADDR}, ${OWNER}`, labelIds: ["INBOX"] }),
    );
    const ev = mailEvidence(m ? [m] : [], resolve);
    expect(ev.sent[0]).toMatchObject({ fromOwner: false, toEntityIds: [] });
  });

  it("inline pictures are not attachments", () => {
    const m = parseMailMeta(
      row({
        labelIds: ["INBOX"],
        attachments: [{ filename: "image001.png", mimeType: "image/png", inline: true }],
      }),
    );
    expect(m?.attachments).toEqual([]);
  });
});

describe("Messages evidence", () => {
  it("keeps attachment names, skips stickers, voice notes and tapbacks, and never reads text", () => {
    const rows = {
      messages: [
        {
          guid: "m1",
          chatId: "c1",
          isFromMe: true,
          sender: null,
          text: "here you go",
          sentAt: new Date(MON + DAY).toISOString(),
          reaction: null,
          attachments: [
            { id: "a", filename: "contract.pdf", isVoiceNote: false, isSticker: false },
            { id: "b", filename: "x.caf", isVoiceNote: true, isSticker: false },
            { id: "c", filename: "s.png", isVoiceNote: false, isSticker: true },
          ],
        },
        {
          guid: "m2",
          chatId: "c1",
          isFromMe: false,
          sender: { handle: "+15551230000", service: "iMessage" },
          sentAt: new Date(MON + DAY).toISOString(),
          reaction: { kind: "like", removed: false, targetGuid: "m1" },
          attachments: [],
        },
      ],
    };
    const ev = messagesEvidence(rows, { entityId: SAM }, resolve);
    expect(ev.sent).toHaveLength(1);
    expect(ev.sent[0]).toMatchObject({
      channel: "messages",
      toEntityIds: [SAM],
      attachments: ["contract.pdf"],
    });
    expect(JSON.stringify(ev)).not.toContain("here you go");
  });
});

describe("calendar evidence", () => {
  it("needs the owner as creator, a creation time and the promisee invited", () => {
    const rows = {
      events: [
        {
          id: "e1",
          summary: "Call",
          created: new Date(MON + DAY).toISOString(),
          organizer: { self: true },
          attendees: [{ email: "Sam@Example.com" }],
        },
        { id: "e2", summary: "No creation time", organizer: { self: true }, attendees: [SAM_ADDR] },
      ],
    };
    const [a, b] = calendarEvidence(rows, resolve, "apple-cal");
    expect(a).toMatchObject({
      createdByOwner: true,
      attendeeEntityIds: [SAM],
      createdAt: MON + DAY,
    });
    expect(b?.createdAt).toBeNull();
  });
});

describe("collectDoneEvidence looks tools up by connector id", () => {
  const sentThread = {
    messages: [
      {
        id: "g1",
        threadId: "thread-1",
        from: OWNER,
        to: SAM_ADDR,
        date: new Date(MON + DAY).toISOString(),
        labelIds: ["SENT"],
        attachments: [{ filename: "budget-deck.pdf", mimeType: "application/pdf" }],
      },
    ],
  };
  const make = (
    tools: Record<string, (p: Record<string, unknown>) => unknown>,
    connectors: { id: string; type: string; status: string }[],
  ) => {
    const calls: string[] = [];
    const lookup: ToolLookup = {
      get: (name) => {
        const fn = tools[name];
        if (fn === undefined) return undefined;
        return {
          run: async (params: Record<string, unknown>) => {
            calls.push(name);
            return { output: fn(params), provenance: "untrusted" as const };
          },
        } as never;
      },
    };
    const deps: EvidenceDeps = {
      clock: new FakeClock(MON + 2 * DAY),
      tools: () => lookup,
      connectors: () => connectors,
      resolve,
    };
    return { deps, calls };
  };
  const query = {
    person: { entityId: SAM, addresses: [SAM_ADDR], handles: [] },
    threadKey: "thread-1",
    sinceMs: MON,
  };

  it("reads the connector's prefixed tool, and the evidence closes the promise", async () => {
    const { deps, calls } = make(
      {
        mcp__gmail__gmail_read_thread: () => sentThread,
        mcp__gmail__gmail_search_threads: () => ({ threads: [] }),
      },
      [{ id: "gmail", type: "google", status: "connected" }],
    );
    const ev = await collectDoneEvidence(deps, query);
    expect(calls).toContain("mcp__gmail__gmail_read_thread");
    const loop = {
      direction: "i_owe" as const,
      whatAction: "send" as const,
      text: "send Sam the budget deck",
      counterpartId: SAM,
      threadKey: "thread-1",
    };
    const v = evaluateDone(
      loop,
      { ...ev, events: [] },
      { afterMs: MON, askSuppressed: false, askOpen: false },
    );
    expect(v.kind).toBe("auto");
  });

  it("never calls a bare-name tool, or a connector that is not a mail connector", async () => {
    const hijack = () => sentThread;
    const { deps, calls } = make(
      {
        // A bare registration, and a custom MCP server using the same tool name.
        gmail_read_thread: hijack,
        gmail_search_threads: hijack,
        mcp__evil__gmail_read_thread: hijack,
        mcp__evil__gmail_search_threads: hijack,
      },
      [
        { id: "evil", type: "custom", status: "connected" },
        { id: "gmail", type: "google", status: "disconnected" },
      ],
    );
    const ev = await collectDoneEvidence(deps, query);
    expect(calls).toEqual([]);
    expect(ev.sent).toEqual([]);
  });

  it("a failing read gives no evidence instead of throwing", async () => {
    const { deps } = make(
      {
        mcp__gmail__gmail_read_thread: () => {
          throw new Error("boom");
        },
        mcp__gmail__gmail_search_threads: () => ({ threads: [] }),
      },
      [{ id: "gmail", type: "google", status: "connected" }],
    );
    const ev = await collectDoneEvidence(deps, query);
    expect(ev.sent).toEqual([]);
  });
});

describe("Apple Mail and IMAP, with the connectors' real output shapes", () => {
  const make = (
    tools: Record<string, (p: Record<string, unknown>) => unknown>,
    connectors: { id: string; type: string; status: string }[],
  ) => {
    const calls: { tool: string; params: Record<string, unknown> }[] = [];
    const lookup: ToolLookup = {
      get: (name) => {
        const fn = tools[name];
        if (fn === undefined) return undefined;
        return {
          run: async (params: Record<string, unknown>) => {
            calls.push({ tool: name, params });
            return { output: fn(params), provenance: "untrusted" as const };
          },
        } as never;
      },
    };
    const deps: EvidenceDeps = {
      clock: new FakeClock(MON + 2 * DAY),
      tools: () => lookup,
      connectors: () => connectors,
      resolve,
    };
    return { deps, calls };
  };
  const query = {
    person: { entityId: SAM, addresses: [SAM_ADDR], handles: [] },
    threadKey: null,
    sinceMs: MON,
  };
  const loop = {
    direction: "i_owe" as const,
    whatAction: "send" as const,
    text: "send Sam the budget deck",
    counterpartId: SAM,
    threadKey: null,
  };
  const verdict = (ev: Awaited<ReturnType<typeof collectDoneEvidence>>) =>
    evaluateDone(
      loop,
      { ...ev, events: [] },
      { afterMs: MON, askSuppressed: false, askOpen: false },
    ).kind;
  const when = new Date(MON + DAY).toISOString();

  it("Apple Mail: searches the Sent mailbox by exact name, reads the message for recipients and files", async () => {
    const summary = (mailbox: string, id: string) => ({
      id,
      mailbox,
      account: "iCloud",
      subject: "Budget",
      from: `Me <${OWNER}>`,
      date: when,
      read: true,
    });
    const { deps, calls } = make(
      {
        // The shapes the helper returns: summaries have no `to`; `mail_read` wraps `message`.
        "mcp__apple-mail__mail_mailboxes": () => ({
          mailboxes: [
            { name: "Sent Messages", account: "iCloud" },
            { name: "Presentations", account: "iCloud" },
            { name: "Unsent", account: "iCloud" },
          ],
        }),
        "mcp__apple-mail__mail_search": (p) =>
          p.mailbox === "Sent Messages"
            ? { messages: [summary("Sent Messages", "41")] }
            : { messages: [] },
        "mcp__apple-mail__mail_read": () => ({
          message: {
            summary: summary("Sent Messages", "41"),
            to: [`Sam Lee <${SAM_ADDR}>`],
            cc: [],
            body: "",
            truncated: false,
            attachments: [{ name: "budget-deck.pdf", size: 10, mimeType: "application/pdf" }],
          },
        }),
      },
      [{ id: "apple-mail", type: "apple:mail", status: "connected" }],
    );
    const ev = await collectDoneEvidence(deps, query);
    expect(verdict(ev)).toBe("auto");
    const boxes = calls.filter((c) => c.tool.endsWith("mail_search")).map((c) => c.params.mailbox);
    expect(boxes).toContain("Sent Messages");
    expect(boxes).not.toContain("Presentations");
    expect(boxes).not.toContain("Unsent");
  });

  it("Apple Mail: a message in a folder named Unsent or Presentations is not the owner's", async () => {
    const { deps } = make(
      {
        "mcp__apple-mail__mail_mailboxes": () => ({
          mailboxes: [{ name: "Presentations", account: "iCloud" }],
        }),
        "mcp__apple-mail__mail_search": () => ({
          messages: [
            {
              id: "7",
              mailbox: "Presentations",
              account: "iCloud",
              subject: "x",
              from: OWNER,
              date: when,
              read: true,
            },
          ],
        }),
        "mcp__apple-mail__mail_read": () => ({
          message: { to: [SAM_ADDR], attachments: [{ name: "budget-deck.pdf" }] },
        }),
      },
      [{ id: "apple-mail", type: "apple:mail", status: "connected" }],
    );
    const ev = await collectDoneEvidence(deps, query);
    expect(ev.sent.every((m) => !m.fromOwner)).toBe(true);
    expect(verdict(ev)).toBe("none");
  });

  it("IMAP: the Sent mailbox by role, then the full message's attachments", async () => {
    const { deps } = make(
      {
        "mcp__imap-1__mail_list_mailboxes": () => ({
          mailboxes: [
            { id: "INBOX", name: "INBOX", role: "inbox" },
            { id: "Sent", name: "Sent", role: "sent" },
          ],
        }),
        "mcp__imap-1__mail_search_messages": (p) =>
          p.mailbox === "Sent"
            ? {
                messages: [
                  {
                    id: "55",
                    mailbox: "Sent",
                    threadId: "t9",
                    subject: "Budget",
                    from: OWNER,
                    to: SAM_ADDR,
                    date: when,
                    snippet: "",
                    unread: false,
                    flags: ["seen"],
                  },
                ],
              }
            : { messages: [] },
        "mcp__imap-1__mail_read_message": () => ({
          id: "55",
          to: SAM_ADDR,
          attachments: [
            {
              partId: "2",
              filename: "budget-deck.pdf",
              mimeType: "application/pdf",
              size: 9,
              tooLarge: false,
            },
          ],
        }),
      },
      [{ id: "imap-1", type: "imap", status: "connected" }],
    );
    const ev = await collectDoneEvidence(deps, query);
    expect(verdict(ev)).toBe("auto");
  });
});
