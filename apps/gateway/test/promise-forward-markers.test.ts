import { mailTools } from "@psyche/connectors";
import { ownWords } from "@psyche/memory";
import type { ToolLookup } from "@psyche/proactive";
import { describe, expect, it } from "vitest";
import { ownerMailText, readMailBatch } from "../src/compose/promise-mail-source.ts";

/**
 * Forwarded and quoted mail is never the owner's promise, in any of the ten UI languages
 * (docs/design/promise-ledger-2026.md section 3.1), and the mail reader's calls fit the real tools.
 */

const S = "I'll send the signed lease and the garage code to Sam by Friday.";
const TOP = "Top: I'll send you the Q3 deck by Friday.";
const NBSP = " ";

const REFUSE: [string, string][] = [
  [
    "Gmail de",
    `${TOP}\n\n---------- Weitergeleitete Nachricht ---------\nVon: Eve <eve@x.example>\nDatum: Mo., 23. Nov. 2026\nBetreff: Schlüssel\nAn: Dev\n\n${S}`,
  ],
  [
    "Gmail fr",
    `${TOP}\n\n---------- Message transféré ---------\nDe : Eve <eve@x.example>\nDate : lun. 23 nov.\nObjet : Clés\nÀ : Dev\n\n${S}`,
  ],
  [
    "Gmail es",
    `${TOP}\n\n---------- Mensaje reenviado ---------\nDe: Eve <eve@x.example>\nFecha: lun, 23 nov\nAsunto: Llaves\nPara: Dev\n\n${S}`,
  ],
  [
    "Gmail it",
    `${TOP}\n\n---------- Messaggio inoltrato ---------\nDa: Eve <eve@x.example>\nData: lun 23 nov\nOggetto: Chiavi\nA: Dev\n\n${S}`,
  ],
  [
    "Gmail pt",
    `${TOP}\n\n---------- Mensagem encaminhada ---------\nDe: Eve <eve@x.example>\nData: seg., 23 de nov.\nAssunto: Chaves\nPara: Dev\n\n${S}`,
  ],
  [
    "Gmail ja",
    `${TOP}\n\n---------- 転送メッセージ ---------\n差出人: Eve <eve@x.example>\n日付: 2026年11月23日\n件名: 鍵\n宛先: Dev\n\n${S}`,
  ],
  [
    "Gmail ko",
    `${TOP}\n\n---------- 전달된 메시지 ---------\n보낸사람: Eve <eve@x.example>\n날짜: 2026년 11월 23일\n제목: 열쇠\n받는사람: Dev\n\n${S}`,
  ],
  [
    "Gmail zh",
    `${TOP}\n\n---------- 转发的邮件 ---------\n发件人: Eve <eve@x.example>\n日期: 2026年11月23日\n主题: 钥匙\n收件人: Dev\n\n${S}`,
  ],
  [
    "Apple de",
    `${TOP}\n\nAnfang der weitergeleiteten Nachricht:\n\nVon: Eve <eve@x.example>\nBetreff: Schlüssel\nDatum: 23. November 2026\nAn: Dev\n\n${S}`,
  ],
  ["Apple fr", `${TOP}\n\nDébut du message réexpédié :\n\n${S}`],
  [
    "Outlook de header block",
    `${TOP}\n\nVon: Eve <eve@x.example>\nGesendet: Montag, 23. November 2026 09:00\nAn: Dev\nBetreff: Schlüssel\n\nHallo,\n\n${S}\n\nGruß`,
  ],
  [
    "Outlook fr header block",
    `${TOP}\n\nDe : Eve <eve@x.example>\nEnvoyé : lundi 23 novembre 2026 09:00\nÀ : Dev\nObjet : Clés\n\nBonjour,\n\n${S}`,
  ],
  ["Outlook en original message", `${TOP}\n\n-----Original Message-----\n${S}\n\nMore.`],
  ["Outlook de original message", `${TOP}\n\n-----Ursprüngliche Nachricht-----\n${S}`],
  [
    "Outlook en header block, two paragraphs",
    `${TOP}\n\nFrom: Eve <eve@x.example>\nSent: Monday, November 23, 2026 9:00 AM\nTo: Dev\nSubject: Keys\n\nHello,\n\n${S}\n\nRegards`,
  ],
  ["de schrieb", `${TOP}\n\nAm 24.11.2026 um 10:00 schrieb Eve <eve@x.example>:\n${S}`],
  ["fr a écrit", `${TOP}\n\nLe 24 nov. 2026 à 10:00, Eve <eve@x.example> a écrit :\n${S}`],
  ["es escribió", `${TOP}\n\nEl mar, 24 nov 2026 a las 10:00, Eve <eve@x.example> escribió:\n${S}`],
  ["it ha scritto", `${TOP}\n\nIl 24 nov 2026, 10:00 Eve <eve@x.example> ha scritto:\n${S}`],
  [
    "pt escreveu",
    `${TOP}\n\nEm ter., 24 de nov. de 2026 às 10:00, Eve <eve@x.example> escreveu:\n${S}`,
  ],
  ["ja Gmail date line", `${TOP}\n\n2026年11月24日(火) 10:00 Eve <eve@x.example>:\n${S}`],
  ["zh 写道", `${TOP}\n\n在 2026年11月24日 10:00，Eve <eve@x.example> 写道：\n${S}`],
  [
    "en wrote, wrapped",
    `${TOP}\n\nOn Tue, Nov 24, 2026 at 10:00 AM Eve <eve@x.example>\nwrote:\n${S}`,
  ],
  [
    "HTML-only Outlook, *From:* with blank lines",
    `${TOP}\n\n*From:* Eve <eve@x.example>\n\n*Sent:* Monday, November 23, 2026 9:00 AM\n\n*To:* Dev\n\n*Subject:* Keys\n\n${S}`,
  ],
  [
    "HTML-only Outlook, **From:**",
    `${TOP}\n\n**From:** Eve <eve@x.example>\n**Sent:** Monday\n**To:** Dev\n\n${S}`,
  ],
  [
    "a one-line header block",
    `${TOP}\n\nFrom: Eve <eve@x.example> Sent: Monday, November 23, 2026 To: Dev Subject: Keys ${S}`,
  ],
  [
    "NBSP in keys and spaces",
    `${TOP}\n\nDe${NBSP}: Eve${NBSP}<eve@x.example>\nEnvoyé${NBSP}: lundi\n\n${S}`,
  ],
  [
    "a signature, then a forward",
    `${TOP}\n\n-- \nDev Owner\nSent from my phone\n\n---------- Forwarded message ---------\n${S}`,
  ],
];

describe("ownerMailText: nothing after a forward or reply marker survives", () => {
  it.each(REFUSE)("%s", (_n, text) => {
    const out = ownerMailText(text);
    expect(out).not.toContain("garage code");
    expect(out).not.toContain("lease");
    expect(ownWords(out)).not.toContain("garage code");
    // Positive control: the owner's own text above the marker is still there.
    expect(out).toContain("Q3 deck");
  });

  it("the owner's own promise above a marker still opens (the sentence reaches ownWords)", () => {
    for (const [, text] of REFUSE) expect(ownWords(ownerMailText(text))).toContain("Q3 deck");
  });
});

describe("ownerMailText: what must pass", () => {
  it("a plain >-quoted reply is unchanged, in English and German", () => {
    const en =
      "Sure, I'll send it Friday.\n\nOn Tue, Nov 24, 2026, Sam wrote:\n> I'll send the lease\n> thanks";
    const de =
      "Gerne, ich schicke es Freitag.\n\nAm 24.11.2026 um 10:00 schrieb Sam:\n> Ich schicke den Mietvertrag";
    expect(ownerMailText(en)).toBe(en);
    expect(ownerMailText(de)).toBe(de);
    expect(ownWords(ownerMailText(en))).not.toContain("lease");
  });
  it("a Japanese mail with no marker is left whole", () => {
    const ja = "金曜日までに資料を送ります。\nよろしくお願いします。";
    expect(ownerMailText(ja)).toBe(ja);
  });
  it("one header-like line in the owner's own sentence is not a forward", () => {
    const t = "Send to: the whole team. I'll send the Q3 deck by Friday.";
    expect(ownerMailText(t)).toBe(t);
    const t2 = "Subject: the Q3 deck\nI'll send it by Friday.";
    expect(ownerMailText(t2)).toBe(t2);
  });
  it("English forwards still cut (the rows that already did)", () => {
    for (const marker of [
      "---------- Forwarded message ---------",
      "Begin forwarded message:",
      "-----Original Message-----",
    ])
      expect(ownerMailText(`${TOP}\n\n${marker}\n${S}`)).toBe(TOP + "\n");
  });
});

// --- the reader against the real tools -------------------------------------------------------

type Row = Record<string, unknown>;
const row = (
  id: string,
  from: string,
  date: string,
  body = "I will send the contract Wednesday.",
): Row => ({
  id,
  from,
  to: "me@example.com",
  date,
  body,
});
const SINCE = Date.parse("2026-11-24T00:00:00.000Z");
const deps = (lookup: ToolLookup, type: string, id: string) => ({
  tools: () => lookup,
  connectors: () => [{ id, type, status: "connected" }],
  resolve: (a: string) => (a === "sam@example.com" ? "ent_sam" : null),
  isTwoWay: (e: string) => e === "ent_sam",
});

/** The real `mail_*` tools of the IMAP/JMAP/Outlook family over a fake session. */
function realMailTools(id: string, pages: Row[][], inputs: Record<string, unknown>[]): ToolLookup {
  const session = {
    listMailboxes: async () => [{ id: "box-sent", role: "sent" }],
    read: async (ref: { id: string }) => pages.flat().find((r) => r.id === ref.id) ?? {},
    search: async (input: Record<string, unknown>) => {
      inputs.push(input);
      const n = input.pageToken === undefined ? 0 : Number(input.pageToken);
      return {
        messages: input.mailbox === undefined ? (pages[n] ?? []) : [],
        nextPageToken: n + 1 < pages.length ? String(n + 1) : null,
      };
    },
  };
  const tools = mailTools({
    connectorId: id,
    account: () => "me@example.com",
    withSession: async (_p: unknown, _r: unknown, fn: (s: never) => Promise<unknown>) =>
      fn(session as never),
  } as never);
  return {
    get: (name: string) => {
      const tool = tools.find((t) => name === `mcp__${id}__${t.name}`);
      if (tool === undefined) return undefined;
      return {
        spec: { name } as never,
        execute: async (_c: string, params: Record<string, unknown>, signal: AbortSignal) => {
          const out = await tool.execute(params, { signal } as never);
          return { isError: false, output: out.output };
        },
      } as never;
    },
  };
}

describe("the mail reader against the real tools", () => {
  it("IMAP: 50 a page, every page read, nothing skipped", async () => {
    const mk = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        row(
          `m${n}-${i}`,
          "Sam <sam@example.com>",
          new Date(SINCE + (i + 1) * 60_000).toISOString(),
        ),
      );
    const inputs: Record<string, unknown>[] = [];
    const lookup = realMailTools("i1", [mk(50), mk(20)], inputs);
    const out = await readMailBatch(deps(lookup, "imap", "i1"), SINCE);
    const inbox = inputs.filter((i) => i.mailbox === undefined);
    expect(inbox.map((i) => i.maxResults)).toEqual([50, 50]);
    expect(inbox[1]?.pageToken).toBe("1");
    // 70 messages, 30 read at a time: the first 30, and the cursor says where to resume.
    expect(out.items).toHaveLength(30);
    expect(out.nextSince).toBeDefined();
  });

  it("has teeth: the real tool refuses a page of 100, which the old reader sent", async () => {
    const inputs: Record<string, unknown>[] = [];
    const lookup = realMailTools("i1", [[]], inputs);
    const tool = lookup.get("mcp__i1__mail_search_messages") as unknown as {
      execute: (c: string, p: Record<string, unknown>, s: AbortSignal) => Promise<unknown>;
    };
    await expect(
      tool.execute("c", { maxResults: 100 }, new AbortController().signal),
    ).rejects.toThrow();
    await expect(
      tool.execute("c", { maxResults: 50 }, new AbortController().signal),
    ).resolves.toBeDefined();
  });

  it("IMAP: a search that never ends holds the cursor where it was", async () => {
    const page = Array.from({ length: 50 }, (_, i) =>
      row(`p${i}`, "noreply@shop.example", new Date(SINCE + (i + 1) * 60_000).toISOString()),
    );
    const inputs: Record<string, unknown>[] = [];
    // Eleven full pages: past MAX_PAGES, with more still to come.
    const lookup = realMailTools(
      "i1",
      Array.from({ length: 12 }, () => page),
      inputs,
    );
    const out = await readMailBatch(deps(lookup, "imap", "i1"), SINCE);
    expect(inputs.filter((i) => i.mailbox === undefined)).toHaveLength(10);
    expect(out.nextSince).toBe(SINCE);
  });

  it("Apple: a full newest-first page is followed by an older one (until), then it stops", async () => {
    const calls: Record<string, unknown>[] = [];
    const full = Array.from({ length: 100 }, (_, i) =>
      row(`a${i}`, "Sam <sam@example.com>", new Date(SINCE + (200 - i) * 60_000).toISOString()),
    );
    const older = Array.from({ length: 5 }, (_, i) =>
      row(`o${i}`, "Sam <sam@example.com>", new Date(SINCE + (50 - i) * 60_000).toISOString()),
    );
    const lookup: ToolLookup = {
      get: (name: string) => {
        if (!name.startsWith("mcp__a1__")) return undefined;
        const tool = name.slice(9);
        return {
          spec: { name } as never,
          execute: async (_c: string, params: Record<string, unknown>) => {
            if (tool === "mail_mailboxes") return { isError: false, output: { mailboxes: [] } };
            if (tool === "mail_search") {
              calls.push(params);
              return {
                isError: false,
                output: { messages: params.until === undefined ? full : older },
              };
            }
            return { isError: false, output: [...full, ...older].find((r) => r.id === params.id) };
          },
        } as never;
      },
    };
    const out = await readMailBatch(deps(lookup, "apple:mail", "a1"), SINCE);
    expect(calls).toHaveLength(2);
    expect(calls[0]).not.toHaveProperty("until");
    expect(calls[1]?.until).toBe(new Date(SINCE + 101 * 60_000).toISOString());
    // 105 messages: the oldest 30 are read, and the cursor stops at the 30th.
    expect(out.items).toHaveLength(30);
    expect(out.nextSince).toBeDefined();
  });
});
