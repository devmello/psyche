import { createHash } from "node:crypto";
import type { LedgerTopic } from "./ledger.ts";

/**
 * Feed sources (architecture §4.11): RSS / Atom, Hacker News, arXiv, saved items, connected
 * accounts, and paid search for gaps. Every network read goes through the injected `fetch`
 * (S09's SSRF-policed, size-capped fetch in the Gateway); nothing here writes anywhere. Source
 * text is untrusted data: tags are stripped, entities decoded, lengths capped, and the text is
 * never used as instructions.
 */

export type FetchLike = (
  url: string,
  options: { signal?: AbortSignal },
) => Promise<{ status: number; text: string }>;

export type SearchLike = (
  query: string,
  options: { signal?: AbortSignal; limit?: number },
) => Promise<{ title: string; url: string; snippet?: string; publishedAt?: string }[]>;

export type CandidateKind = "news" | "paper" | "post" | "saved" | "account" | "search";

export interface Candidate {
  /** `sha256:<16 hex>` of the normalized url (stable across runs). */
  id: string;
  url: string;
  host: string;
  title: string;
  summary: string;
  /** Source id, e.g. `rss:example.com`, `hn`, `arxiv`, `saved`, `search`. */
  source: string;
  kind: CandidateKind;
  publishedAt: string | null;
}

export interface SourceContext {
  fetch: FetchLike;
  signal?: AbortSignal;
  now: number;
  topics: readonly LedgerTopic[];
}

export interface FeedSource {
  readonly id: string;
  fetch(ctx: SourceContext): Promise<Candidate[]>;
}

export const MAX_TITLE = 200;
export const MAX_SUMMARY = 1_000;
export const MAX_ITEMS_PER_SOURCE = 50;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, code: string) => {
    const key = code.toLowerCase();
    if (key.startsWith("#x")) return String.fromCodePoint(Number.parseInt(key.slice(2), 16) || 32);
    if (key.startsWith("#")) return String.fromCodePoint(Number.parseInt(key.slice(1), 10) || 32);
    return ENTITIES[key] ?? all;
  });
}

/** Plain text: CDATA unwrapped, tags removed, entities decoded, whitespace collapsed, capped. */
export function plainText(raw: string | undefined, max: number): string {
  if (raw === undefined) return "";
  const unwrapped = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  const text = decodeEntities(unwrapped.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Drops tracking params and fragments; lowercases the host; strips a trailing slash. */
export function normalizeUrl(url: string): string {
  if (!URL.canParse(url)) return url.trim();
  const u = new URL(url);
  u.hash = "";
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
  for (const key of [...u.searchParams.keys()]) {
    if (/^(utm_|fbclid|gclid|mc_|ref$|source$)/i.test(key)) u.searchParams.delete(key);
  }
  let s = u.toString();
  if (u.search === "" && s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

export function hostOf(url: string): string {
  return URL.canParse(url) ? new URL(url).hostname.toLowerCase().replace(/^www\./, "") : "";
}

export function candidateId(url: string): string {
  return `sha256:${createHash("sha256").update(normalizeUrl(url)).digest("hex").slice(0, 16)}`;
}

/** Builds a candidate from raw fields; `undefined` when there is no usable http(s) url or title. */
export function makeCandidate(
  input: {
    url: string;
    title: string;
    summary?: string;
    publishedAt?: string | null;
  },
  source: string,
  kind: CandidateKind,
): Candidate | undefined {
  const url = normalizeUrl(input.url);
  if (!/^https?:\/\//i.test(url)) return undefined;
  const title = plainText(input.title, MAX_TITLE);
  if (title === "") return undefined;
  const published =
    input.publishedAt == null || Number.isNaN(Date.parse(input.publishedAt))
      ? null
      : new Date(Date.parse(input.publishedAt)).toISOString();
  return {
    id: candidateId(url),
    url,
    host: hostOf(url),
    title,
    summary: plainText(input.summary, MAX_SUMMARY),
    source,
    kind,
    publishedAt: published,
  };
}

// --- RSS / Atom --------------------------------------------------------------------------------

function tag(block: string, name: string): string | undefined {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(block);
  return m?.[1];
}

function atomLink(block: string): string | undefined {
  const links = [...block.matchAll(/<link\b([^>]*?)\/?>(?:[\s\S]*?<\/link>)?/gi)];
  let fallback: string | undefined;
  for (const l of links) {
    const attrs = l[1] ?? "";
    const href = /href=["']([^"']+)["']/i.exec(attrs)?.[1];
    if (href === undefined) continue;
    const rel = /rel=["']([^"']+)["']/i.exec(attrs)?.[1];
    if (rel === undefined || rel === "alternate") return href;
    fallback ??= href;
  }
  return fallback;
}

/** Parses RSS 2.0 `<item>`s or Atom `<entry>`s (no XML library: feeds are untrusted input). */
export function parseFeedXml(xml: string, source: string): Candidate[] {
  const out: Candidate[] = [];
  const items = [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].map((m) => m[1] ?? "");
  const entries = [...xml.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi)].map(
    (m) => m[1] ?? "",
  );
  for (const block of items.slice(0, MAX_ITEMS_PER_SOURCE)) {
    const link = plainText(tag(block, "link"), 2_000) || atomLink(block);
    if (link === undefined || link === "") continue;
    const c = makeCandidate(
      {
        url: link,
        title: tag(block, "title") ?? "",
        summary: tag(block, "description") ?? tag(block, "content:encoded") ?? "",
        publishedAt: plainText(tag(block, "pubDate") ?? tag(block, "dc:date"), 64) || null,
      },
      source,
      "news",
    );
    if (c !== undefined) out.push(c);
  }
  for (const block of entries.slice(0, MAX_ITEMS_PER_SOURCE)) {
    const link = atomLink(block);
    if (link === undefined) continue;
    const c = makeCandidate(
      {
        url: link,
        title: tag(block, "title") ?? "",
        summary: tag(block, "summary") ?? tag(block, "content") ?? "",
        publishedAt: plainText(tag(block, "published") ?? tag(block, "updated"), 64) || null,
      },
      source,
      source.startsWith("arxiv") ? "paper" : "news",
    );
    if (c !== undefined) out.push(c);
  }
  return out;
}

export function rssSource(url: string): FeedSource {
  const id = `rss:${hostOf(url) || url}`;
  return {
    id,
    async fetch(ctx) {
      const res = await ctx.fetch(url, { signal: ctx.signal });
      if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
      return parseFeedXml(res.text, id);
    },
  };
}

// --- Hacker News -------------------------------------------------------------------------------

export const HN_FRONT_PAGE = "https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=30";

export function hackerNewsSource(endpoint: string = HN_FRONT_PAGE): FeedSource {
  return {
    id: "hn",
    async fetch(ctx) {
      const res = await ctx.fetch(endpoint, { signal: ctx.signal });
      if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
      const body = JSON.parse(res.text) as {
        hits?: {
          title?: string;
          url?: string | null;
          objectID?: string;
          created_at?: string;
          points?: number;
        }[];
      };
      const out: Candidate[] = [];
      for (const hit of (body.hits ?? []).slice(0, MAX_ITEMS_PER_SOURCE)) {
        const url =
          hit.url ?? (hit.objectID ? `https://news.ycombinator.com/item?id=${hit.objectID}` : "");
        const c = makeCandidate(
          {
            url,
            title: hit.title ?? "",
            summary: hit.points === undefined ? "" : `${hit.points} points on Hacker News`,
            publishedAt: hit.created_at ?? null,
          },
          "hn",
          "news",
        );
        if (c !== undefined) out.push(c);
      }
      return out;
    },
  };
}

// --- arXiv -------------------------------------------------------------------------------------

export const ARXIV_API = "https://export.arxiv.org/api/query";

/** One query per top topic (up to `maxTopics`), newest submissions first. */
export function arxivSource(
  options: { endpoint?: string; maxTopics?: number; perTopic?: number } = {},
): FeedSource {
  const endpoint = options.endpoint ?? ARXIV_API;
  return {
    id: "arxiv",
    async fetch(ctx) {
      const top = [...ctx.topics]
        .sort((a, b) => b.weight - a.weight)
        .slice(0, options.maxTopics ?? 3);
      const out: Candidate[] = [];
      for (const t of top) {
        const q = `all:${JSON.stringify(t.topic.replace(/"/g, ""))}`;
        const url = `${endpoint}?search_query=${encodeURIComponent(q)}&max_results=${options.perTopic ?? 10}&sortBy=submittedDate&sortOrder=descending`;
        const res = await ctx.fetch(url, { signal: ctx.signal });
        if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
        out.push(...parseFeedXml(res.text, "arxiv"));
      }
      return out;
    },
  };
}

// --- injected providers (saved items, connected accounts, Bluesky) ------------------------------

/** Candidates supplied by another package (Library saved items, S09 connector summaries, a Jetstream tap). */
export function providedSource(
  id: string,
  kind: CandidateKind,
  provider: (
    ctx: SourceContext,
  ) => Promise<{ url: string; title: string; summary?: string; publishedAt?: string | null }[]>,
): FeedSource {
  return {
    id,
    async fetch(ctx) {
      const items = await provider(ctx);
      return items
        .slice(0, MAX_ITEMS_PER_SOURCE)
        .map((i) => makeCandidate(i, id, kind))
        .filter((c): c is Candidate => c !== undefined);
    },
  };
}

/** Paid search, only for gaps: topics (weight ≥ `minWeight`) no other source covered. */
export async function searchGaps(
  search: SearchLike,
  gaps: readonly LedgerTopic[],
  options: { signal?: AbortSignal; perTopic?: number } = {},
): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const t of gaps) {
    const results = await search(t.topic, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      limit: options.perTopic ?? 5,
    });
    for (const r of results) {
      const c = makeCandidate(
        {
          url: r.url,
          title: r.title,
          summary: r.snippet ?? "",
          publishedAt: r.publishedAt ?? null,
        },
        "search",
        "search",
      );
      if (c !== undefined) out.push(c);
    }
  }
  return out;
}

export interface SourceReport {
  source: string;
  count: number;
  error?: string;
}

/** Runs every source; a failing source is reported, never fatal (UI §3.9 per-source failure rows). */
export async function collect(
  sources: readonly FeedSource[],
  ctx: SourceContext,
): Promise<{ candidates: Candidate[]; reports: SourceReport[] }> {
  const candidates: Candidate[] = [];
  const reports: SourceReport[] = [];
  for (const s of sources) {
    try {
      const got = await s.fetch(ctx);
      candidates.push(...got);
      reports.push({ source: s.id, count: got.length });
    } catch (e) {
      reports.push({
        source: s.id,
        count: 0,
        error: e instanceof Error ? e.message.slice(0, 200) : "failed",
      });
    }
  }
  return { candidates, reports };
}
