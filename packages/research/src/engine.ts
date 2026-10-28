import { asArray, asRecord, asString, normalized, parseJson } from "./json.ts";
import {
  ASK_SYSTEM,
  CROSSCHECK_SYSTEM,
  EXTRACT_SYSTEM,
  PLAN_SYSTEM,
  SCOPE_SYSTEM,
  SYNTH_SYSTEM,
} from "./prompts.ts";
import {
  type ArtifactSink,
  type Budget,
  type Claim,
  DEFAULT_BUDGET,
  type ModelTier,
  type ProgressEvent,
  type ResearchHost,
  type ResearchPlan,
  type ResearchReport,
  ResearchStopped,
  type Source,
  type SubQuestion,
} from "./types.ts";

const PAGE_CHARS = 12_000;
/** Rough per-source cost (read + extract) and fixed synthesis cost, for the estimate. */
const TOKENS_PER_SOURCE = 4_500;
const TOKENS_SYNTH = 9_000;

export interface ResearchOptions {
  budget?: Partial<Budget>;
  includeLocal?: boolean;
  onProgress?: (e: ProgressEvent) => void;
}

/** One research run, kept so follow-ups continue with the sources already read. */
export class ResearchRun {
  readonly sources: Source[] = [];
  readonly claims: Claim[] = [];
  report: ResearchReport | undefined;
  artifactId: string | undefined;
  tokens = 0;
  private readonly pages = new Map<string, string>();
  private readonly budget: Budget;
  private readonly controller = new AbortController();
  private plan: ResearchPlan | undefined;

  private readonly host: ResearchHost;
  private readonly sink: ArtifactSink;
  private readonly opts: ResearchOptions;

  constructor(host: ResearchHost, sink: ArtifactSink, opts: ResearchOptions = {}) {
    this.host = host;
    this.sink = sink;
    this.opts = opts;
    this.budget = { ...DEFAULT_BUDGET, ...opts.budget };
  }

  /** Stops the run at the next await; `execute` then resolves as stopped. */
  stop(): void {
    this.controller.abort();
  }

  private emit(e: ProgressEvent): void {
    this.opts.onProgress?.(e);
  }

  private check(): void {
    if (this.controller.signal.aborted) throw new ResearchStopped();
  }

  private async model(tier: ModelTier, system: string, user: string): Promise<string> {
    this.check();
    const c = await this.host.complete(tier, system, user, { signal: this.controller.signal });
    this.tokens += c.tokens;
    this.emit({ type: "tokens", used: this.tokens, budget: this.budget.maxTokens });
    this.check();
    return c.text;
  }

  /** Step 1: a clarifying question when the request is ambiguous, else null. */
  async clarify(question: string): Promise<string | null> {
    this.emit({ type: "step", step: "scope" });
    const out = asRecord(parseJson(await this.model("cheap", SCOPE_SYSTEM, question)));
    return asString(out.clarify, 300) || null;
  }

  /** Step 2: the plan the owner confirms before the long run starts. */
  async makePlan(question: string): Promise<ResearchPlan> {
    this.emit({ type: "step", step: "plan" });
    const out = asRecord(parseJson(await this.model("thread", PLAN_SYSTEM, question)));
    let subQuestions: SubQuestion[] = asArray(out.subQuestions)
      .map((raw, i) => {
        const r = asRecord(raw);
        return {
          id: `q${i + 1}`,
          question: asString(r.question, 300),
          queries: asArray(r.queries)
            .map((q) => asString(q, 200))
            .filter((q) => q !== "")
            .slice(0, 2),
        };
      })
      .filter((s) => s.question !== "")
      .slice(0, 6);
    if (subQuestions.length === 0) subQuestions = [{ id: "q1", question, queries: [question] }];
    for (const s of subQuestions) if (s.queries.length === 0) s.queries = [s.question];
    const includeLocal = this.opts.includeLocal === true && this.host.localSearch !== undefined;
    const sources = Math.min(this.budget.maxSources, subQuestions.length * this.budget.perQuery);
    this.plan = {
      question,
      subQuestions,
      includeLocal,
      estimatedTokens: sources * TOKENS_PER_SOURCE + TOKENS_SYNTH,
    };
    this.emit({ type: "plan", plan: this.plan });
    return this.plan;
  }

  /** Steps 3-7. Resolves `stopped` (nothing saved) when stopped; throws only on real errors. */
  async execute(plan: ResearchPlan = this.requirePlan()): Promise<"done" | "stopped"> {
    this.plan = plan;
    try {
      await this.gather(plan.subQuestions, plan.includeLocal);
      await this.crossCheck();
      await this.writeReport(plan.question);
      this.emit({ type: "done", artifactId: this.artifactId ?? "" });
      return "done";
    } catch (e) {
      if (e instanceof ResearchStopped) {
        this.emit({ type: "stopped" });
        return "stopped";
      }
      throw e;
    }
  }

  private requirePlan(): ResearchPlan {
    if (!this.plan) throw new Error("no plan: call makePlan first");
    return this.plan;
  }

  private overBudget(): boolean {
    return this.tokens >= this.budget.maxTokens || this.sources.length >= this.budget.maxSources;
  }

  private async gather(subs: SubQuestion[], includeLocal: boolean): Promise<void> {
    // Pick candidates sequentially (search is cheap), then read them with bounded parallelism.
    const queue: {
      url: string;
      title: string;
      sub: SubQuestion;
      kind: "web" | "local";
      text?: string;
    }[] = [];
    const seen = new Set(this.sources.map((s) => s.url));
    this.emit({ type: "step", step: "read" });
    for (const sub of subs) {
      for (const q of sub.queries) {
        this.check();
        const hits = await this.host.search(q, {
          count: this.budget.perQuery,
          signal: this.controller.signal,
        });
        for (const h of hits.slice(0, this.budget.perQuery)) {
          if (seen.has(h.url) || !/^https?:\/\//.test(h.url)) continue;
          seen.add(h.url);
          queue.push({ url: h.url, title: h.title, sub, kind: "web" });
        }
        if (includeLocal && this.host.localSearch) {
          for (const l of await this.host.localSearch(q, { signal: this.controller.signal })) {
            if (seen.has(l.url)) continue;
            seen.add(l.url);
            queue.push({ url: l.url, title: l.title, sub, kind: "local", text: l.text });
          }
        }
      }
    }
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        this.check();
        const item = queue[next++];
        if (!item || this.overBudget()) return;
        await this.readOne(item);
      }
    };
    await Promise.all(Array.from({ length: this.budget.concurrency }, worker));
  }

  private async readOne(item: {
    url: string;
    title: string;
    sub: SubQuestion;
    kind: "web" | "local";
    text?: string;
  }): Promise<void> {
    this.emit({ type: "source", url: item.url, title: item.title, status: "reading" });
    let text: string;
    let title = item.title;
    try {
      if (item.text !== undefined) text = item.text;
      else {
        const page = await this.host.fetch(item.url, { signal: this.controller.signal });
        text = page.text;
        title = page.title || title;
      }
    } catch {
      this.check();
      this.emit({ type: "source", url: item.url, title, status: "failed" });
      return;
    }
    text = text.slice(0, PAGE_CHARS);
    this.pages.set(item.url, text);
    this.emit({ type: "step", step: "extract" });
    const out = asRecord(
      parseJson(
        await this.model(
          "cheap",
          EXTRACT_SYSTEM,
          `Sub-question: ${item.sub.question}\n<source url="${item.url}">\n${text}\n</source>`,
        ),
      ),
    );
    const page = normalized(text);
    let added = 0;
    for (const raw of asArray(out.claims).slice(0, 5)) {
      const r = asRecord(raw);
      const claim = asString(r.text, 500);
      const quote = asString(r.quote, 400);
      // A quote that is not on the page is a hallucination (or an injected one): drop it.
      if (claim === "" || quote === "" || !page.includes(normalized(quote))) continue;
      this.claims.push({
        id: `c${this.claims.length + 1}`,
        sourceUrl: item.url,
        subQuestionId: item.sub.id,
        text: claim,
        quote,
        corroboratedBy: [],
      });
      added++;
    }
    this.emit({ type: "source", url: item.url, title, status: "read" });
    this.emit({ type: "claims", count: this.claims.length });
    if (added > 0 && !this.sources.some((s) => s.url === item.url)) {
      this.sources.push({
        n: 0,
        url: item.url,
        title,
        kind: item.kind,
        subQuestionId: item.sub.id,
      });
    }
  }

  private async crossCheck(): Promise<void> {
    this.emit({ type: "step", step: "crosscheck" });
    if (this.claims.length < 2) return;
    const list = this.claims.map((c) => `${c.id}: ${c.text} (${c.sourceUrl})`).join("\n");
    const out = asRecord(parseJson(await this.model("cheap", CROSSCHECK_SYSTEM, list)));
    const byId = new Map(this.claims.map((c) => [c.id, c]));
    for (const group of asArray(out.agree)) {
      const claims = asArray(group)
        .map((id) => byId.get(asString(id, 20)))
        .filter((c): c is Claim => c !== undefined);
      for (const c of claims)
        for (const o of claims)
          if (o !== c && o.sourceUrl !== c.sourceUrl && !c.corroboratedBy.includes(o.sourceUrl))
            c.corroboratedBy.push(o.sourceUrl);
    }
    for (const raw of asArray(out.conflicts)) {
      const r = asRecord(raw);
      const note = asString(r.note, 300);
      for (const id of asArray(r.ids)) {
        const c = byId.get(asString(id, 20));
        if (c && note !== "") c.conflict = note;
      }
    }
  }

  /** Numbers sources by first citation in `markdown`-order, dropping sources never cited. */
  private async writeReport(question: string): Promise<void> {
    this.emit({ type: "step", step: "synthesize" });
    const index = new Map(this.sources.map((s, i) => [s.url, i + 1]));
    const claimLines = this.claims
      .filter((c) => index.has(c.sourceUrl))
      .map((c) => {
        const flags = [
          c.corroboratedBy.length > 0 ? `corroborated by ${c.corroboratedBy.length} more` : "",
          c.conflict ? `conflict: ${c.conflict}` : "",
        ].filter(Boolean);
        return `[${index.get(c.sourceUrl)}] ${c.text}${flags.length ? ` (${flags.join("; ")})` : ""}`;
      })
      .join("\n");
    const out = asRecord(
      parseJson(
        await this.model("thread", SYNTH_SYSTEM, `Question: ${question}\n\nClaims:\n${claimLines}`),
      ),
    );
    const sections = asArray(out.sections)
      .map((s) => {
        const r = asRecord(s);
        return { heading: asString(r.heading, 200), body: asString(r.body, 8_000) };
      })
      .filter((s) => s.body !== "");
    const summary = asString(out.summary, 4_000);
    const openQuestions = asArray(out.openQuestions)
      .map((q) => asString(q, 300))
      .filter((q) => q !== "");
    this.report = this.renumber(
      asString(out.title, 200) || question.slice(0, 120),
      summary,
      sections,
      openQuestions,
      index,
    );
    this.emit({ type: "step", step: "save" });
    this.check();
    if (this.artifactId === undefined) {
      this.artifactId = (await this.sink.create(this.report.title, this.report.markdown)).id;
    } else {
      await this.sink.update(this.artifactId, this.report.markdown);
    }
  }

  /** Rewrites the model's provisional `[k]` into 1..N by order of appearance; unknown ones go. */
  private renumber(
    title: string,
    summary: string,
    sections: { heading: string; body: string }[],
    openQuestions: string[],
    index: Map<string, number>,
  ): ResearchReport {
    const byProvisional = new Map<number, Source>();
    for (const s of this.sources) byProvisional.set(index.get(s.url) ?? 0, s);
    const finalN = new Map<Source, number>();
    const rewrite = (text: string): string =>
      text
        .replace(/\[(\d+(?:\s*,\s*\d+)*)\]/g, (_m, list: string) => {
          const ns: number[] = [];
          for (const k of list.split(",")) {
            const src = byProvisional.get(Number(k));
            if (!src) continue;
            if (!finalN.has(src)) finalN.set(src, finalN.size + 1);
            ns.push(finalN.get(src) as number);
          }
          return ns.length === 0 ? "" : `[${[...new Set(ns)].sort((a, b) => a - b).join(", ")}]`;
        })
        .replace(/ +([.,;])/g, "$1");
    const s2 = rewrite(summary);
    const secs = sections.map((s) => ({ heading: s.heading, body: rewrite(s.body) }));
    const cited = [...finalN.entries()].sort((a, b) => a[1] - b[1]).map(([s, n]) => ({ ...s, n }));
    this.sources.splice(0, this.sources.length, ...cited);
    const md = [
      `# ${title}`,
      "",
      "## Summary",
      "",
      s2,
      ...secs.flatMap((s) => ["", `## ${s.heading}`, "", s.body]),
      ...(openQuestions.length > 0
        ? ["", "## Open questions", "", ...openQuestions.map((q) => `- ${q}`)]
        : []),
      "",
      "## Sources",
      "",
      ...cited.map((s) => `${s.n}. [${s.title || s.url}](${s.url})`),
      "",
    ].join("\n");
    return { title, summary: s2, sections: secs, openQuestions, sources: cited, markdown: md };
  }

  /** Follow-up: answer from the sources already read. */
  async ask(question: string): Promise<string> {
    const report = this.report;
    if (!report) throw new Error("no report yet");
    const n = new Map(report.sources.map((s) => [s.url, s.n]));
    const claims = this.claims
      .filter((c) => n.has(c.sourceUrl))
      .map((c) => `[${n.get(c.sourceUrl)}] ${c.text}`)
      .join("\n");
    return this.model("thread", ASK_SYSTEM, `Claims:\n${claims}\n\nQuestion: ${question}`);
  }

  /** Follow-up: "dig deeper on section k". Reads more sources for it and rewrites the report. */
  async digDeeper(sectionIndex: number, extraQueries?: string[]): Promise<"done" | "stopped"> {
    const report = this.report;
    if (!report || !this.plan) throw new Error("no report yet");
    const section = report.sections[sectionIndex];
    if (!section) throw new Error(`no section ${sectionIndex + 1}`);
    const sub: SubQuestion = {
      id: `d${sectionIndex + 1}`,
      question: section.heading,
      queries: extraQueries?.length ? extraQueries : [`${this.plan.question} ${section.heading}`],
    };
    this.budget.maxSources += this.budget.perQuery;
    try {
      await this.gather([sub], this.plan.includeLocal);
      await this.crossCheck();
      await this.writeReport(this.plan.question);
      this.emit({ type: "done", artifactId: this.artifactId ?? "" });
      return "done";
    } catch (e) {
      if (e instanceof ResearchStopped) {
        this.emit({ type: "stopped" });
        return "stopped";
      }
      throw e;
    }
  }
}
