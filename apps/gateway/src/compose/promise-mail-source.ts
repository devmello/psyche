import type { LaneItem } from "@psyche/memory";
import { MAIL_HEADER, MAIL_HEADER_EXTRA, ownWords } from "@psyche/memory";
import type { ToolLookup } from "@psyche/proactive";
import {
  addressOf,
  type ConnectorRef,
  connectorsOf,
  displayName,
  GMAIL_ID,
  isAutomatedSender,
  MAIL_CONNECTOR_TYPES,
  ms,
  output,
  readConnectorTool,
  str,
} from "./mail-threads.ts";

/**
 * The mail the promise scan reads (design 3.1): the owner's own new text in sent mail, and new
 * text from a person the owner is in two-way touch with. Automated senders and bulk lists are
 * skipped. Bodies are cut to the author's own words before anything else sees them, and are never
 * stored: they live only in the returned items.
 *
 * Mail connectors are read by connector id (`mcp__<id>__<tool>`), never by a bare tool name. A
 * failed read yields nothing for that connector. A read that stopped at its cap says where the
 * next one may start (`nextSince`), so the scan's cursor never moves past mail that was not read.
 */

export interface MailSourceDeps {
  tools: () => ToolLookup | undefined;
  connectors: () => readonly ConnectorRef[] | Promise<readonly ConnectorRef[]>;
  /** An address to the person's entity id, or null for nobody the owner knows. */
  resolve: (address: string) => string | null;
  /** Whether the owner is in two-way touch with this person. */
  isTwoWay: (entityId: string) => boolean;
  logger?: { log(level: "warn", msg: string, fields?: Record<string, unknown>): void };
}

const MAX_MESSAGES = 30;
/** `mail_search_messages` takes 1 to 50; Apple's `mail_search` up to 500. */
const PAGE_IMAP = 50;
const PAGE_APPLE = 100;
const MAX_PAGES = 10;
const MAX_THREADS = 15;
const MAX_RECIPIENTS = 8;
const MAX_HALVINGS = 6;
const epoch = (t: number): number => Math.floor(t / 1000);

// --- forwarded and quoted text ------------------------------------------------------------------

/** Spaces of every kind (NBSP, thin, ideographic) become one space; markdown bold marks go. */
const plain = (line: string): string =>
  line
    .replace(/[\u00a0\u1680\u2000-\u200b\u202f\u205f\u3000]/g, " ")
    .replace(/\*+|_{2,}/g, "")
    .trim();

/** The words a client puts on the line that opens a forwarded message or the original message. */
const FORWARD_PHRASES: readonly string[] = [
  "forwarded message",
  "begin forwarded message",
  "original message",
  "weitergeleitete nachricht",
  "anfang der weitergeleiteten nachricht",
  "urspr[uü]ngliche nachricht",
  "message transf[eé]r[eé]",
  "d[eé]but du message r[eé]exp[eé]di[eé]",
  "message d'origine",
  "message original",
  "mensaje reenviado",
  "inicio del mensaje reenviado",
  "mensaje original",
  "mensagem encaminhada",
  "in[ií]cio da mensagem encaminhada",
  "mensagem original",
  "messaggio inoltrato",
  "inizio del messaggio inoltrato",
  "messaggio originale",
  "転送メッセージ",
  "転送されたメッセージ",
  "元のメッセージ",
  "전달된 메시지",
  "전달된 메일",
  "원본 메시지",
  "转发的邮件",
  "轉寄的郵件",
  "转发邮件",
  "原始邮件",
  "原始郵件",
  "رسالة معاد توجيهها",
  "الرسالة الأصلية",
  "अग्रेषित संदेश",
  "मूल संदेश",
];
const FORWARD_LINE = new RegExp(
  `^[\\-_=\\s>]*(?:${FORWARD_PHRASES.join("|")})[\\-_=\\s:：]*$`,
  "iu",
);

/** "wrote:" in every UI language; Japanese and Korean put the verb after the name, Gmail ja ends in `>:`. */
const WROTE_WORDS =
  "wrote|schrieb|a [eé]crit|escribi[oó]|ha scritto|escreveu|写道|寫道|が書きました|님이 작성|كتب|ने लिखा";
// German puts the sender after the verb ("schrieb Eve <e@x>:"), so the colon may come later.
const WROTE_END = new RegExp(`(?:${WROTE_WORDS}).{0,250}?[:：]$`, "iu");
const WROTE_ALONE = new RegExp(`^(?:${WROTE_WORDS})\\s*[:：]$`, "iu");
const JA_DATE_LINE = /^\d{4}年.{3,200}[>＞)）]\s*[:：]$/u;
/** A header line of a forwarded or original message, in any language. */
const isHeaderLine = (raw: string): boolean => {
  const c = plain(raw);
  return !c.startsWith(">") && (MAIL_HEADER.test(c) || MAIL_HEADER_EXTRA.test(c));
};
const FROM_KEY = "from|von|de|da|差出人|发件人|寄件者|보낸 ?사람|من|प्रेषक";
const OTHER_KEY =
  "sent|date|to|subject|cc|gesendet|datum|an|betreff|envoy[eé]|[àa]|objet|enviado|fecha|para|asunto|assunto|data|inviato|oggetto|送信日時|宛先|件名|发送时间|收件人|主题|寄件日期|收件者|主旨|받는 ?사람|제목|إلى|الموضوع|प्रति|विषय";
const ONE_LINE_HEADERS = new RegExp(
  `(?:^|[\\s|;,(])(?:${FROM_KEY})\\s*[:：].*?(?:^|[\\s|;,(])(?:${OTHER_KEY})\\s*[:：]`,
  "iu",
);

/**
 * What the sender wrote above any forward or reply marker. A forwarded message is somebody else's
 * words, and so is any unquoted text under an "X wrote:" line. The cut fails closed, in all ten UI
 * languages: from the first of these to the end of the text, nothing survives (design 3.1):
 * - a forward or original-message line (Gmail, Apple, Outlook);
 * - two header lines in a row (`From:`/`Sent:`, `Von:`/`Betreff:`, `De :`/`Objet :` ...), with
 *   optional `*`/`**` around the keys, as Outlook's HTML comes through `htmlToMarkdown`;
 * - one line that holds a from-header and another header (`From: x Sent: y To: z`);
 * - an "X wrote:" line (`schrieb`, `a écrit`, `escribió` ...), unless what follows is `>`-quoted,
 *   which is a top-posted reply and is left to `ownWords`.
 */
export function ownerMailText(text: string): string {
  const lines = text.split(/\r?\n/);
  const nextText = (from: number): { line: string; at: number } | undefined => {
    for (let j = from; j < lines.length; j++) {
      const l = lines[j] as string;
      if (plain(l) !== "") return { line: l, at: j };
    }
    return undefined;
  };
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] as string;
    const c = plain(raw);
    if (c === "" || c.startsWith(">")) continue;
    if (FORWARD_LINE.test(c)) {
      end = i;
      break;
    }
    if (isHeaderLine(raw)) {
      // Two header lines in a row (blank lines between them are fine for Outlook's markdown).
      const next = nextText(i + 1);
      if (next !== undefined && isHeaderLine(next.line)) {
        end = i;
        break;
      }
    }
    if (c.length <= 600 && ONE_LINE_HEADERS.test(c)) {
      end = i;
      break;
    }
    const wrapped =
      WROTE_ALONE.test(plain(lines[i + 1] ?? "")) && c.length <= 300 && !WROTE_END.test(c);
    if ((c.length <= 300 && (WROTE_END.test(c) || JA_DATE_LINE.test(c))) || wrapped) {
      const after = nextText(i + (wrapped ? 2 : 1));
      if (after !== undefined && !plain(after.line).startsWith(">")) {
        end = i;
        break;
      }
    }
  }
  return lines.slice(0, end).join("\n");
}

// --- raw messages -----------------------------------------------------------------------------

const bodyOf = (raw: Record<string, unknown>): string => {
  const inner = (raw.message ?? raw) as Record<string, unknown>;
  return (
    str(inner.body) ||
    str(inner.text) ||
    str(inner.textBody) ||
    str(inner.snippet) ||
    str(inner.preview)
  );
};

const addrList = (v: unknown): string[] =>
  (Array.isArray(v) ? v.map((x) => str(x)) : str(v).split(","))
    .map((x) => addressOf(x))
    .filter((x) => x !== "");

interface RawMail {
  id: string;
  threadKey: string | null;
  from: string;
  fromLabel: string;
  to: string[];
  at: number;
  fromOwner: boolean;
  text: string;
}

function toItem(m: RawMail, deps: MailSourceDeps): LaneItem | undefined {
  if (m.text.trim() === "" || isAutomatedSender(m.from)) return undefined;
  const people = new Set([m.from, ...m.to]);
  if (people.size > MAX_RECIPIENTS + 1) return undefined;
  const own = ownWords(ownerMailText(m.text));
  if (own.trim() === "") return undefined;
  if (m.fromOwner) {
    const known = m.to.map((a) => deps.resolve(a)).filter((x): x is string => x !== null);
    const only = known.length === 1 && m.to.length === 1 ? known[0] : undefined;
    return {
      source: "mail",
      sourceRef: `mail:${m.id}`,
      threadId: m.threadKey,
      author: "owner",
      counterpartId: only ?? null,
      counterpartLabel: only === undefined ? null : (m.to[0] ?? null),
      sentAt: new Date(m.at).toISOString(),
      text: own,
      groupSize: m.to.length + 1,
    };
  }
  const who = deps.resolve(m.from);
  if (who === null || !deps.isTwoWay(who)) return undefined;
  return {
    source: "mail",
    sourceRef: `mail:${m.id}`,
    threadId: m.threadKey,
    author: "counterpart",
    counterpartId: who,
    counterpartLabel: m.fromLabel.slice(0, 80),
    sentAt: new Date(m.at).toISOString(),
    text: own,
    groupSize: m.to.length + 1,
  };
}

// --- connectors ---------------------------------------------------------------------------------

/** How one family of boxed mail connectors lists Sent, searches and reads a message. */
interface BoxedFlavor {
  listBoxes: string;
  sentBoxes(list: unknown): Record<string, unknown>[];
  search: string;
  boxParams(box: Record<string, unknown>): Record<string, unknown>;
  limitKey: string;
  read: string;
  readParams(raw: Record<string, unknown>): Record<string, unknown>;
}
const APPLE_SENT = /^sent( (messages|mail|items))?$/i;
const APPLE: BoxedFlavor = {
  listBoxes: "mail_mailboxes",
  sentBoxes: (list) =>
    output<Record<string, unknown>>(list, "mailboxes").filter(
      (b) => b.special === "sent" || (b.special == null && APPLE_SENT.test(str(b.name).trim())),
    ),
  search: "mail_search",
  boxParams: (b) => ({
    mailbox: str(b.name),
    ...(str(b.account) === "" ? {} : { account: str(b.account) }),
  }),
  limitKey: "limit",
  read: "mail_read",
  readParams: (raw) => ({
    id: str(raw.id),
    maxLength: 4000,
    ...(str(raw.mailbox) === "" ? {} : { mailbox: str(raw.mailbox) }),
    ...(str(raw.account) === "" ? {} : { account: str(raw.account) }),
  }),
};
const IMAP: BoxedFlavor = {
  listBoxes: "mail_list_mailboxes",
  sentBoxes: (list) =>
    output<Record<string, unknown>>(list, "mailboxes").filter((b) => b.role === "sent"),
  search: "mail_search_messages",
  boxParams: (b) => ({ mailbox: str(b.id) }),
  limitKey: "maxResults",
  read: "mail_read_message",
  readParams: (raw) => ({
    id: str(raw.id),
    ...(str(raw.mailbox) === "" ? {} : { mailbox: str(raw.mailbox) }),
  }),
};

export interface MailBatch {
  items: LaneItem[];
  /** Where the next read may start when this one stopped at a cap; undefined: it read everything. */
  nextSince?: number;
}

/** Mail since `sinceMs`, as lane items. */
export async function readMailBatch(deps: MailSourceDeps, sinceMs: number): Promise<MailBatch> {
  const tools = deps.tools();
  if (tools === undefined) return { items: [] };
  const raws: RawMail[] = [];
  let resume: number | undefined;
  const clip = (t: number): void => {
    resume = resume === undefined ? t : Math.min(resume, t);
  };
  const safe = async <T>(label: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (err) {
      deps.logger?.log("warn", "promise mail read failed", {
        source: label,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  };
  const since = new Date(sinceMs).toISOString();
  for (const c of connectorsOf(await deps.connectors(), MAIL_CONNECTOR_TYPES)) {
    if (c.type === "google") {
      // Gmail takes epoch seconds: a calendar day would be the UTC day, and lose an evening's
      // mail for an owner west of UTC. A full page narrows the window (oldest half first) so
      // nothing in it is skipped; the cursor then moves only to the end of what was read.
      let until = Date.now();
      let threads: { id?: unknown }[] = [];
      for (let i = 0; i <= MAX_HALVINGS; i++) {
        const query = `after:${epoch(sinceMs)} before:${epoch(until) + 1}`;
        const found = await safe("gmail_search_threads", () =>
          readConnectorTool(tools, c.id, "gmail_search_threads", {
            query,
            maxResults: MAX_THREADS,
          }),
        );
        threads = output<{ id?: unknown }>(found, "threads");
        if (threads.length < MAX_THREADS || until - sinceMs < 2000) break;
        until = sinceMs + Math.floor((until - sinceMs) / 2);
      }
      if (until < Date.now() - 1000) clip(until);
      for (const t of threads.slice(0, MAX_THREADS)) {
        const threadId = str(t.id);
        if (!GMAIL_ID.test(threadId)) continue;
        const th = await safe("gmail_read_thread", () =>
          readConnectorTool(tools, c.id, "gmail_read_thread", { threadId }),
        );
        for (const raw of output<Record<string, unknown>>(th, "messages")) {
          const at = ms(raw.date);
          const labels = Array.isArray(raw.labelIds) ? (raw.labelIds as unknown[]) : [];
          if (
            Number.isNaN(at) ||
            at <= sinceMs ||
            at > until ||
            labels.includes("SPAM") ||
            labels.includes("TRASH")
          )
            continue;
          raws.push({
            id: str(raw.id),
            threadKey: threadId,
            from: addressOf(str(raw.from)),
            fromLabel: displayName(str(raw.from)),
            to: addrList(raw.to),
            at,
            // The label, never the From header, says it is the owner's.
            fromOwner: labels.includes("SENT") && !labels.includes("INBOX"),
            text: bodyOf(raw),
          });
        }
      }
      continue;
    }
    // Apple Mail, IMAP, JMAP and Outlook: the owner's mail is what sits in the Sent mailbox, which
    // is searched by name; the inbox (the default) holds everyone else's.
    const f = c.type === "apple:mail" ? APPLE : IMAP;
    const boxes = await safe(f.listBoxes, () => readConnectorTool(tools, c.id, f.listBoxes, {}));
    const searches: { params: Record<string, unknown>; sentBox: boolean }[] = [
      ...f
        .sentBoxes(boxes)
        .slice(0, 3)
        .map((b) => ({ params: f.boxParams(b), sentBox: true })),
      { params: {}, sentBox: false },
    ];
    for (const { params, sentBox } of searches) {
      // Read every page of the window. IMAP, JMAP and Outlook page with `pageToken`; Apple's
      // `mail_search` is newest first and pages with `until`. A search that still has more after
      // MAX_PAGES holds the cursor where it was: nothing in the window is skipped for good.
      const all = new Map<string, Record<string, unknown>>();
      let token: string | undefined;
      let until: string | undefined;
      let more = false;
      for (let page = 0; page < MAX_PAGES; page++) {
        const found = await safe(f.search, () =>
          readConnectorTool(tools, c.id, f.search, {
            ...params,
            since,
            [f.limitKey]: f === APPLE ? PAGE_APPLE : PAGE_IMAP,
            ...(token === undefined ? {} : { pageToken: token }),
            ...(until === undefined ? {} : { until }),
          }),
        );
        const got = output<Record<string, unknown>>(found, "messages");
        for (const raw of got) all.set(str(raw.id), raw);
        more = false;
        if (f === APPLE) {
          if (got.length < PAGE_APPLE) break;
          const oldest = Math.min(...got.map((r) => ms(r.date)).filter((t) => !Number.isNaN(t)));
          if (!Number.isFinite(oldest) || oldest <= sinceMs) break;
          until = new Date(oldest).toISOString();
          more = true;
        } else {
          const next = str((found as { nextPageToken?: unknown } | undefined)?.nextPageToken);
          if (next === "") break;
          token = next;
          more = true;
        }
      }
      if (more) clip(sinceMs);
      const rows = [...all.values()]
        .map((raw) => ({ raw, at: ms(raw.date), from: addressOf(str(raw.from)) }))
        .filter((r) => !Number.isNaN(r.at) && r.at > sinceMs)
        // Automated senders go before the cap, so they cannot crowd out real mail.
        .filter((r) => sentBox || !isAutomatedSender(r.from))
        .sort((a, b) => a.at - b.at);
      for (const r of rows.slice(0, MAX_MESSAGES)) {
        const full = await safe(f.read, () =>
          readConnectorTool(tools, c.id, f.read, f.readParams(r.raw)),
        );
        const wrapped = (full as Record<string, unknown> | undefined)?.message;
        const detail = (wrapped !== null && typeof wrapped === "object" ? wrapped : full) as
          | Record<string, unknown>
          | undefined;
        raws.push({
          id: str(r.raw.id),
          threadKey: str(r.raw.threadId) || null,
          from: r.from,
          fromLabel: displayName(str(r.raw.from)),
          to: addrList(detail?.to ?? r.raw.to),
          at: r.at,
          // Only a row out of the account's own Sent mailbox is the owner's.
          fromOwner: sentBox,
          text: detail === undefined ? bodyOf(r.raw) : bodyOf(detail) || bodyOf(r.raw),
        });
      }
      // Cut short: the next read starts at the last message this one read.
      if (rows.length > MAX_MESSAGES) clip((rows[MAX_MESSAGES - 1] as { at: number }).at);
    }
  }
  const seen = new Set<string>();
  const items: LaneItem[] = [];
  for (const m of raws.sort((a, b) => a.at - b.at)) {
    if (m.id === "" || seen.has(m.id)) continue;
    seen.add(m.id);
    const item = toItem(m, deps);
    if (item !== undefined) items.push(item);
  }
  return { items, ...(resume === undefined ? {} : { nextSince: resume }) };
}

export async function readMailItems(deps: MailSourceDeps, sinceMs: number): Promise<LaneItem[]> {
  return (await readMailBatch(deps, sinceMs)).items;
}
