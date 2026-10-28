/**
 * Search eval runner (docs/design/search-roadmap-2026.md §9, packages/search/eval/README.md).
 *
 *   pnpm --filter @psyche/search eval                      # every mode, both coverages
 *   pnpm --filter @psyche/search eval -- --mode rules --coverage full --misses
 *   pnpm --filter @psyche/search eval -- --llm --mode rules --coverage full   # Haiku answers
 *
 * Builds an in-memory `SqliteSearchIndex` from `fixtures/corpus.json`, runs every question in
 * `fixtures/questions.json` through `index.search` and scores the ranked ids against the gold
 * sources. No model runs unless `--llm` is passed; semantic search is off (BM25 only).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { Provenance, SearchIndexDocKind } from "@psyche/protocol";
import { createSearchIndex } from "../src/index.ts";
import type { SearchDoc } from "../src/types.ts";
import { llmAnswer } from "./answer.ts";
import { type IndexedCorpus, indexThroughSources } from "./indexed.ts";
import {
  answerMatches,
  type CitationScore,
  citationScore,
  mean,
  ndcgAt,
  recallAt,
  reciprocalRank,
} from "./metrics.ts";
import { type RewriteMode, rewrite } from "./rewrite.ts";

export interface CorpusDoc {
  id: string;
  kind: SearchIndexDocKind;
  source: string;
  title: string;
  text: string;
  from?: string;
  threadId?: string;
  mime?: string;
  createdAt: string;
  provenance: Provenance;
}

export interface Question {
  id: string;
  q: string;
  class: string;
  intent: "find" | "answer" | "list";
  gold: string[];
  answer: string;
  answerKeywords: string[];
}

/** The eval clock: Tuesday 2026-10-20 10:00 in Oakland. */
export const EVAL_NOW = Date.parse("2026-10-20T17:00:00Z");
export const EVAL_TZ = -420;

/**
 * Sources the Gateway indexes into `search.sqlite` today (compose/search-sources.ts): chats,
 * tasks and Library items (which include transcripts, research reports and documents). Mail,
 * iMessage, Notes, Calendar, Reminders and files in granted folders are only reachable live.
 */
export const PRODUCTION_SOURCES = new Set(["chat", "tasks", "library"]);

const MODES: RewriteMode[] = ["raw", "keywords", "rules"];
/**
 * `indexed` = production sources plus Mail, Messages, Notes, Calendar, Reminders and files, written
 * by the real source indexers (roadmap §2). `full` writes the same documents straight in.
 */
const COVERAGES = ["production", "full", "indexed"] as const;
type Coverage = (typeof COVERAGES)[number];
const KS = [1, 5, 10, 20];
/** The mock answerer cites this many top hits. */
const CITE_TOP = 3;

const print = (line = "") => process.stdout.write(`${line}\n`);

const here = dirname(fileURLToPath(import.meta.url));

export function loadFixtures(dir = join(here, "fixtures")): {
  corpus: CorpusDoc[];
  questions: Question[];
} {
  return {
    corpus: JSON.parse(readFileSync(join(dir, "corpus.json"), "utf8")) as CorpusDoc[],
    questions: JSON.parse(readFileSync(join(dir, "questions.json"), "utf8")) as Question[],
  };
}

export function toSearchDoc(d: CorpusDoc): SearchDoc {
  return {
    id: d.id,
    kind: d.kind,
    title: d.title,
    text: d.text,
    provenance: d.provenance,
    createdAt: Date.parse(d.createdAt),
    source: d.source,
    ...(d.from === undefined ? {} : { from: d.from }),
    ...(d.threadId === undefined ? {} : { threadId: d.threadId }),
    ...(d.mime === undefined ? {} : { mime: d.mime }),
  };
}

export interface QuestionResult {
  id: string;
  class: string;
  intent: Question["intent"];
  query: string;
  ranked: string[];
  gold: string[];
  recall: Record<number, number>;
  mrr: number;
  ndcg10: number;
  /** Any gold id in the top 10 (what an answer needs when several sources state the fact). */
  hit10: boolean;
  cite: CitationScore;
  answerOk?: boolean;
  usedFallback: boolean;
}

/** Counts and sizes of the last `indexed` run (reported under its table). */
export let indexStats:
  | { counts: Record<string, number>; textBytes: number; indexBytes: number }
  | undefined;

export async function evaluate(
  corpus: CorpusDoc[],
  questions: Question[],
  mode: RewriteMode,
  coverage: Coverage,
): Promise<QuestionResult[]> {
  const index = createSearchIndex({ now: () => EVAL_NOW, tzOffsetMinutes: EVAL_TZ });
  const docs = corpus.filter((d) => coverage === "full" || PRODUCTION_SOURCES.has(d.source));
  await index.indexMany(docs.map(toSearchDoc));
  let indexed: IndexedCorpus | undefined;
  if (coverage === "indexed") {
    indexed = await indexThroughSources(index, corpus, EVAL_NOW);
    indexStats = {
      counts: indexed.counts,
      textBytes: indexed.textBytes,
      indexBytes: indexed.indexBytes,
    };
  }
  const out: QuestionResult[] = [];
  for (const q of questions) {
    const rw = rewrite(q.q, mode, EVAL_NOW, EVAL_TZ);
    const run = async (text: string) => {
      const ids = (await index.search({ q: text, collapse: false, limit: 20 })).hits.flatMap((h) =>
        indexed === undefined ? [h.id] : indexed.expand(h.id),
      );
      return [...new Set(ids)];
    };
    let ranked = await run(rw.q);
    let usedFallback = false;
    if (ranked.length === 0 && rw.fallback !== undefined) {
      ranked = await run(rw.fallback);
      usedFallback = true;
    }
    out.push({
      id: q.id,
      class: q.class,
      intent: q.intent,
      query: usedFallback ? (rw.fallback ?? rw.q) : rw.q,
      ranked,
      gold: q.gold,
      recall: Object.fromEntries(KS.map((k) => [k, recallAt(ranked, q.gold, k)])),
      mrr: reciprocalRank(ranked, q.gold),
      ndcg10: ndcgAt(ranked, q.gold, 10),
      hit10: reciprocalRank(ranked.slice(0, 10), q.gold) > 0,
      cite: citationScore(ranked.slice(0, CITE_TOP), q.gold),
      usedFallback,
    });
  }
  indexed?.cleanup();
  index.db.close();
  return out;
}

export interface Summary {
  n: number;
  zeroResults: number;
  recall: Record<number, number>;
  hit10: number;
  mrr: number;
  ndcg10: number;
  citePrecision: number;
  citeSupported: number;
  answerAccuracy?: number;
}

export function summarize(results: readonly QuestionResult[]): Summary {
  const withAnswers = results.filter((r) => r.answerOk !== undefined);
  return {
    n: results.length,
    zeroResults: results.filter((r) => r.ranked.length === 0).length / Math.max(1, results.length),
    recall: Object.fromEntries(KS.map((k) => [k, mean(results.map((r) => r.recall[k] ?? 0))])),
    hit10: mean(results.map((r) => (r.hit10 ? 1 : 0))),
    mrr: mean(results.map((r) => r.mrr)),
    ndcg10: mean(results.map((r) => r.ndcg10)),
    citePrecision: mean(results.map((r) => r.cite.precision)),
    citeSupported: mean(results.map((r) => (r.cite.supported ? 1 : 0))),
    ...(withAnswers.length === 0
      ? {}
      : { answerAccuracy: mean(withAnswers.map((r) => (r.answerOk ? 1 : 0))) }),
  };
}

const pct = (x: number) => x.toFixed(3);

function row(label: string, s: Summary): string {
  const cells = [
    label,
    String(s.n),
    pct(s.zeroResults),
    ...KS.map((k) => pct(s.recall[k] ?? 0)),
    pct(s.hit10),
    pct(s.mrr),
    pct(s.ndcg10),
    pct(s.citePrecision),
    pct(s.citeSupported),
  ];
  if (s.answerAccuracy !== undefined) cells.push(pct(s.answerAccuracy));
  return `| ${cells.join(" | ")} |`;
}

function header(first: string, answers: boolean): string {
  const cols = [
    first,
    "n",
    "zero",
    ...KS.map((k) => `R@${k}`),
    "hit@10",
    "MRR",
    "nDCG@10",
    `cite P@${CITE_TOP}`,
    "cite ok",
  ];
  if (answers) cols.push("answer ok");
  return `| ${cols.join(" | ")} |\n|${cols.map(() => " --- ").join("|")}|`;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      mode: { type: "string" },
      coverage: { type: "string" },
      classes: { type: "boolean", default: false },
      misses: { type: "boolean", default: false },
      llm: { type: "boolean", default: false },
      only: { type: "string" },
      out: { type: "string" },
    },
  });
  const { corpus, questions: all } = loadFixtures();
  const only = values.only?.split(",");
  const questions = only === undefined ? all : all.filter((q) => only.includes(q.id));
  const modes = values.mode === undefined ? MODES : [values.mode as RewriteMode];
  const coverages = values.coverage === undefined ? COVERAGES : [values.coverage as Coverage];
  const byId = new Map(corpus.map((d) => [d.id, d]));
  const report: Record<string, { summary: Summary; byClass: Record<string, Summary> }> = {};

  print(`corpus ${corpus.length} docs, ${questions.length} questions, BM25 only\n`);
  for (const coverage of coverages) {
    const results = new Map<RewriteMode, QuestionResult[]>();
    for (const mode of modes) {
      const res = await evaluate(corpus, questions, mode, coverage);
      if (values.llm) {
        for (const r of res) {
          const q = questions.find((x) => x.id === r.id);
          if (q === undefined) continue;
          const a = await llmAnswer(
            q.q,
            r.ranked.slice(0, 8).flatMap((id) => byId.get(id) ?? []),
          );
          r.cite = citationScore(a.citations, q.gold);
          if (q.answerKeywords.length > 0) r.answerOk = answerMatches(a.answer, q.answerKeywords);
        }
      }
      results.set(mode, res);
    }
    print(`## coverage: ${coverage}\n`);
    if (coverage === "indexed" && indexStats !== undefined)
      print(
        `source docs: ${Object.entries(indexStats.counts)
          .map(([k, v]) => `${k} ${v}`)
          .join(
            ", ",
          )}; text ${(indexStats.textBytes / 1000).toFixed(0)} kB, index file ${(indexStats.indexBytes / 1000).toFixed(0)} kB\n`,
      );
    print(header("mode", values.llm));
    for (const [mode, res] of results) {
      const summary = summarize(res);
      print(row(mode, summary));
      const classes = [...new Set(res.map((r) => r.class))].sort();
      report[`${coverage}/${mode}`] = {
        summary,
        byClass: Object.fromEntries(
          classes.map((c) => [c, summarize(res.filter((r) => r.class === c))]),
        ),
      };
    }
    print();
    if (values.classes) {
      for (const [mode] of results) {
        print(`### ${coverage}/${mode} by class\n`);
        print(header("class", values.llm));
        for (const [c, s] of Object.entries(report[`${coverage}/${mode}`]?.byClass ?? {}))
          print(row(c, s));
        print();
      }
    }
    if (values.misses) {
      for (const [mode, res] of results) {
        print(`### ${coverage}/${mode} misses (R@10 < 1)\n`);
        for (const r of res.filter((x) => (x.recall[10] ?? 0) < 1))
          print(
            `- ${r.id} [${r.class}] \`${r.query}\` → ${r.ranked.slice(0, 5).join(", ") || "∅"} (gold ${r.gold.join(", ")})`,
          );
        print();
      }
    }
  }
  if (values.out !== undefined) writeFileSync(values.out, `${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
