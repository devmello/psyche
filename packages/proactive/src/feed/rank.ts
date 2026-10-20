import { cosine, type Embedder } from "./embeddings.ts";
import { type LedgerTopic, normalizeTopic } from "./ledger.ts";
import type { Candidate } from "./sources.ts";

/**
 * Candidate pool → clusters → recall × recency (architecture §4.11). Deterministic: the same
 * pool, ledger and clock give the same order; the shortlist shuffle is seeded.
 */

export interface Cluster {
  id: string;
  members: Candidate[];
  vector: number[];
  /** Normalized words of every member's title and summary (lexical topic matching). */
  words: Set<string>;
}

const STOP_WORDS = new Set(["the", "and", "for", "with", "from", "that", "this", "are", "was"]);

export function wordsOf(text: string): Set<string> {
  return new Set(
    normalizeTopic(text)
      .split(" ")
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w)),
  );
}

/** Every content word of the topic appears in the text (so "celebrity news" matches a celebrity-news item). */
export function containsTopic(words: ReadonlySet<string>, topic: string): boolean {
  const needed = [...wordsOf(topic)];
  return needed.length > 0 && needed.every((w) => words.has(w));
}

/** Similarity of a topic to a cluster: the embedding cosine, with a floor when the words match. */
export function topicSimilarity(topicVector: readonly number[], topic: string, k: Cluster): number {
  const sim = Math.max(0, cosine(topicVector, k.vector));
  return containsTopic(k.words, topic) ? Math.max(sim, LEXICAL_MATCH_SIMILARITY) : sim;
}

export const LEXICAL_MATCH_SIMILARITY = 0.6;

export interface ScoredCluster extends Cluster {
  score: number;
  /** Best matching topic and its contribution (`undefined` when nothing matched). */
  interest?: { topic: string; similarity: number; weight: number };
  recall: number;
  recency: number;
  ageHours: number | null;
  reasons: string[];
}

export const CLUSTER_THRESHOLD = 0.82;
export const EXCLUDE_THRESHOLD = 0.6;
export const RECENCY_HALF_LIFE_HOURS = 36;
export const EXPLORATION_RECALL_CEILING = 0.3;

export function embedText(c: Candidate): string {
  return `${c.title}. ${c.summary}`.slice(0, 1_200);
}

/** One candidate per normalized url. */
export function dedupe(candidates: readonly Candidate[]): Candidate[] {
  const seen = new Map<string, Candidate>();
  for (const c of candidates) if (!seen.has(c.id)) seen.set(c.id, c);
  return [...seen.values()];
}

function normTitle(t: string): string {
  return normalizeTopic(t);
}

/** Greedy clustering by embedding similarity or identical normalized title (multi-source clusters). */
export async function cluster(
  candidates: readonly Candidate[],
  embed: Embedder,
  threshold: number = CLUSTER_THRESHOLD,
): Promise<Cluster[]> {
  const unique = dedupe(candidates);
  const vectors = await embed(unique.map(embedText));
  const clusters: Cluster[] = [];
  const byTitle = new Map<string, Cluster>();
  unique.forEach((c, i) => {
    const v = vectors[i] ?? [];
    const title = normTitle(c.title);
    let home = byTitle.get(title);
    if (home === undefined) {
      let best: { cluster: Cluster; sim: number } | undefined;
      for (const k of clusters) {
        const sim = cosine(k.vector, v);
        if (sim >= threshold && (best === undefined || sim > best.sim)) best = { cluster: k, sim };
      }
      home = best?.cluster;
    }
    if (home === undefined) {
      const k: Cluster = { id: c.id, members: [c], vector: [...v], words: wordsOf(embedText(c)) };
      clusters.push(k);
      byTitle.set(title, k);
      return;
    }
    home.members.push(c);
    for (const w of wordsOf(embedText(c))) home.words.add(w);
    // Running centroid.
    const n = home.members.length;
    home.vector = home.vector.map((x, j) => (x * (n - 1) + (v[j] ?? 0)) / n);
  });
  return clusters;
}

export function recencyOf(
  publishedAt: string | null,
  now: number,
): { recency: number; ageHours: number | null } {
  if (publishedAt === null) return { recency: 0.5, ageHours: null };
  const age = Math.max(0, (now - Date.parse(publishedAt)) / 3_600_000);
  return { recency: 2 ** (-age / RECENCY_HALF_LIFE_HOURS), ageHours: age };
}

export interface RankInputs {
  topics: readonly LedgerTopic[];
  topicVectors: readonly number[][];
  excluded: readonly string[];
  excludedVectors: readonly number[][];
  hiddenHosts: readonly string[];
  now: number;
  /** A briefing's instructions as one more interest (weight 0.8). */
  focus?: { text: string; vector: number[] };
}

/** Recall × recency per cluster; excluded topics and hidden hosts drop out. Highest first. */
export function scoreClusters(clusters: readonly Cluster[], inputs: RankInputs): ScoredCluster[] {
  const hidden = new Set(inputs.hiddenHosts.map((h) => h.toLowerCase()));
  const out: ScoredCluster[] = [];
  for (const k of clusters) {
    const members = k.members.filter((m) => !hidden.has(m.host));
    if (members.length === 0) continue;
    if (
      inputs.excluded.some(
        (topic, i) =>
          topicSimilarity(inputs.excludedVectors[i] ?? [], topic, k) >= EXCLUDE_THRESHOLD,
      )
    ) {
      continue;
    }
    let interest: ScoredCluster["interest"];
    let recall = 0;
    inputs.topics.forEach((t, i) => {
      const sim = topicSimilarity(inputs.topicVectors[i] ?? [], t.topic, k);
      const contribution = sim * t.weight;
      if (contribution > recall) {
        recall = contribution;
        interest = { topic: t.topic, similarity: sim, weight: t.weight };
      }
    });
    if (inputs.focus !== undefined) {
      const sim = Math.max(0, cosine(inputs.focus.vector, k.vector)) * 0.8;
      if (sim > recall) {
        recall = sim;
        interest = { topic: "briefing instructions", similarity: sim / 0.8, weight: 0.8 };
      }
    }
    const newest = members
      .map((m) => m.publishedAt)
      .filter((p): p is string => p !== null)
      .sort()
      .at(-1);
    const { recency, ageHours } = recencyOf(newest ?? null, inputs.now);
    const multi = Math.min(0.1, 0.05 * Math.log2(members.length));
    const score = recall * (0.5 + 0.5 * recency) + multi;
    const reasons = [
      interest === undefined
        ? "no ledger match"
        : `interest: ${interest.topic} ${(interest.similarity * interest.weight).toFixed(2)}`,
      ageHours === null ? "undated" : `recency ${ageHours < 1 ? "<1" : Math.round(ageHours)}h`,
    ];
    if (members.length > 1) reasons.push(`${members.length} sources`);
    out.push({
      ...k,
      members,
      score,
      recall,
      recency,
      ageHours,
      reasons,
      ...(interest === undefined ? {} : { interest }),
    });
  }
  return out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

/** mulberry32: a small seeded PRNG so the rerank shortlist order is reproducible. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  const rnd = seededRandom(seed);
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

export function seedFrom(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Exploration slots: the freshest clusters the ledger did not ask for (recall below the ceiling). */
export function pickExploration(
  scored: readonly ScoredCluster[],
  chosen: ReadonlySet<string>,
  count: number,
): ScoredCluster[] {
  return scored
    .filter((k) => !chosen.has(k.id) && k.recall < EXPLORATION_RECALL_CEILING)
    .sort(
      (a, b) =>
        b.recency - a.recency || b.members.length - a.members.length || a.id.localeCompare(b.id),
    )
    .slice(0, count);
}

/** Topics with weight ≥ `minWeight` that no cluster matches at ≥ `minSimilarity` (paid search gaps). */
export function gapTopics(
  scored: readonly ScoredCluster[],
  topics: readonly LedgerTopic[],
  topicVectors: readonly number[][],
  options: { minWeight?: number; minSimilarity?: number } = {},
): LedgerTopic[] {
  const minWeight = options.minWeight ?? 0.6;
  const minSim = options.minSimilarity ?? 0.5;
  return topics.filter((t, i) => {
    if (t.weight < minWeight) return false;
    const v = topicVectors[i] ?? [];
    return !scored.some((k) => topicSimilarity(v, t.topic, k) >= minSim);
  });
}
