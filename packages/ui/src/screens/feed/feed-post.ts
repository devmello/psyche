import type { FeedPost } from "@psyche/protocol";
import { t } from "../../i18n/core.ts";

/**
 * Derived facts about a feed post. `FeedPost` has no kind field (docs/archive/status/s12.md gap 5), so
 * the kind label is derived here, in this order:
 *  1. `exploration` → exploration slot (labelled with its topic when one is known);
 *  2. `cluster` → news cluster;
 *  3. reasons: `watch:` → watch result, `deadline` / `reminder` → reminder,
 *     `goal:` / `trip:` / `suggest` → suggestion;
 *  4. `briefingId` → briefing;
 *  5. otherwise suggestion.
 */

export type FeedKind = "exploration" | "news" | "watch" | "reminder" | "suggestion" | "briefing";

const KIND_LABEL: Record<FeedKind, string> = {
  get exploration() {
    return t("screens.feed.kind.exploration");
  },
  get news() {
    return t("screens.feed.kind.news");
  },
  get watch() {
    return t("screens.feed.kind.watch");
  },
  get reminder() {
    return t("screens.feed.kind.reminder");
  },
  get suggestion() {
    return t("screens.feed.kind.suggestion");
  },
  get briefing() {
    return t("screens.feed.kind.briefing");
  },
};

export function feedKind(post: FeedPost): FeedKind {
  if (post.exploration) return "exploration";
  if (post.cluster !== null) return "news";
  const reasons = post.reasons.map((r) => r.toLowerCase());
  if (reasons.some((r) => r.startsWith("watch:"))) return "watch";
  if (reasons.some((r) => r.startsWith("deadline") || r.startsWith("reminder"))) return "reminder";
  if (reasons.some((r) => /^(goal|trip):/.test(r) || r.startsWith("suggest"))) return "suggestion";
  if (post.briefingId !== null) return "briefing";
  return "suggestion";
}

/** "Briefing", "News cluster", "Lisbon · exploration slot". */
export function feedKindLabel(post: FeedPost): string {
  const kind = feedKind(post);
  if (kind !== "exploration") return KIND_LABEL[kind];
  const topic = feedTopic(post);
  return topic === null ? KIND_LABEL.exploration : t("screens.feed.explorationTopic", { topic });
}

/** The topic a post is about: the cluster topic, else the value of the first topical reason. */
export function feedTopic(post: FeedPost): string | null {
  const clusterTopic = post.cluster?.topic;
  if (typeof clusterTopic === "string" && clusterTopic.trim() !== "") return clusterTopic.trim();
  for (const reason of post.reasons) {
    const m = /^(interest|topic|goal|trip|watch):\s*(.+)$/i.exec(reason.trim());
    const value = m?.[2]?.replace(/\s+\d+(\.\d+)?$/, "").trim();
    if (value) return value;
  }
  return null;
}

export interface FeedSource {
  name: string;
  url: string;
  /** One letter for the badge (no remote favicons). */
  letter: string;
}

function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.hostname === "" ? null : u.hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Distinct sources in citation order. */
export function feedSources(post: FeedPost): FeedSource[] {
  const seen = new Set<string>();
  const out: FeedSource[] = [];
  for (const c of post.citations) {
    const name = c.source ?? hostOf(c.url) ?? c.title;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, url: c.url, letter: (name.match(/[a-z0-9]/i)?.[0] ?? "?").toUpperCase() });
  }
  return out;
}

/** The source "Hide source" applies to: the first web source, else the first source. */
export function primarySource(post: FeedPost): string | null {
  const sources = feedSources(post);
  return (sources.find((s) => /^https?:/i.test(s.url)) ?? sources[0])?.name ?? null;
}

/** Turns `[n]` markers into links to the n-th citation, so citations stay clickable. */
export function withCitationLinks(md: string, citations: FeedPost["citations"]): string {
  return md.replace(/\[(\d+)\](?!\()/g, (whole, n: string) => {
    const c = citations[Number(n) - 1];
    // Streamdown's link hardening only passes web links; in-app sources (psyche://…) stay
    // plain markers and are listed in the sources row instead.
    if (c === undefined || !/^https?:\/\//i.test(c.url)) return whole;
    const url = c.url.replace(/ /g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29");
    return `[\\[${n}\\]](${url})`;
  });
}
