import type {
  ActionCall,
  Clock,
  DigestAction,
  DigestCategory,
  DigestGroup,
  DigestItem,
  DigestLoop,
  GraphLoop,
  InboxDigest,
  MemoryStore,
  ModelProvider,
  ModelRef,
  Notifier,
} from "@psyche/protocol";
import { ulid } from "ulid";
import { PROACTIVITY_BUDGET } from "../budget.ts";
import type { FeedEvent } from "../feed/service.ts";
import type { FeedStore, StoredPost } from "../feed/store.ts";
import { jobMarker, type LaunchResult, type ProactiveJob, parseJobMarker } from "../jobs.ts";
import type { ProposalService, ToolLookup } from "../proposals/service.ts";
import { type SqliteDatabase, toIso } from "../sqlite.ts";
import { CLASSIFY_BATCH, classifyBatch, cleanHeader, sanitizeMailText } from "./classify.ts";
import { type MailItem, presort } from "./presort.ts";
import {
  addressOf,
  domainOf,
  parseRules,
  type RuleDecision,
  serializeRules,
  setRule,
} from "./rules.ts";
import type { EventScheduler } from "./watch.ts";

/**
 * The daily inbox digest (docs/workflows/mail-and-meetings-2026.md §4.1) with follow-ups
 * (§4.2): collect unread mail since the last digest, pre-sort without a model (rules first),
 * classify the rest on the utility model, build one batch proposal per bulk group, add the
 * graph's due `waiting_on` loops (at most twice each), then write one Feed post and one
 * notification (to the OS only when something needs you). Nothing is sent; every change to
 * mail is a proposal the owner approves on one card.
 */

export const MAIL_DIGEST_JOB = "mail-digest";
export const DEFAULT_DIGEST_SCHEDULE = "30 7 * * 1-5";
export const RULES_PATH = "mail/RULES.md";
const CURSOR_SOURCE = "mail.digest";
const MEETING_ASK =
  /\b(meet(ing)?|call|catch up|chat|schedule|availability|available|time to talk|grab (a )?coffee)\b/i;

export interface DigestServiceOptions {
  db: SqliteDatabase;
  clock: Clock;
  scheduler: EventScheduler;
  tools: ToolLookup;
  memory: Pick<MemoryStore, "readFile" | "writeFile">;
  proposals?: ProposalService;
  feed: FeedStore;
  notifier?: Pick<Notifier, "notify">;
  /** The utility model for classification; without it everything left after the pre-sort is FYI. */
  provider?: ModelProvider;
  model?: ModelRef;
  /** The configured model is remote: the card shows the "cloud" chip. */
  modelIsRemote?: boolean;
  /** The graph's due `waiting_on` loops (`memory.loops.list`); none until the graph is wired. */
  loops?: () => Promise<GraphLoop[]>;
  /** One line per recurring meeting skipped as "nothing new since last time" (§4.5). */
  meetingLines?: () => string[];
  /** Whether a sender is someone the owner knows (the graph, Contacts). */
  isKnownPerson?: (address: string) => Promise<boolean>;
  /** A loop counterpart's display name. */
  personName?: (entityId: string) => Promise<string | undefined>;
  /** Domains of people the owner knows, for lookalike detection (default: domains seen often). */
  knownDomains?: () => Promise<string[]>;
  accounts?: () => { apple: boolean; gmail: boolean };
  timezone?: string;
  newId?: () => string;
  onFeedEvent?: (event: FeedEvent) => void;
  onError?: (error: unknown) => void;
}

function output<T>(r: unknown, key: string): T[] {
  if (Array.isArray(r)) return r as T[];
  const inner = (r as Record<string, unknown> | null)?.[key];
  return Array.isArray(inner) ? (inner as T[]) : [];
}

function localTime(ms: number, timezone: string): { hhmm: string; date: string } {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (t: string) => f.find((p) => p.type === t)?.value ?? "00";
  return {
    hhmm: `${get("hour")}:${get("minute")}`,
    date: `${get("year")}-${get("month")}-${get("day")}`,
  };
}

export class DigestService {
  readonly #o: DigestServiceOptions;

  constructor(options: DigestServiceOptions) {
    this.#o = options;
  }

  #id(): string {
    return this.#o.newId?.() ?? ulid(this.#o.clock.now());
  }

  async #run(tool: string, params: Record<string, unknown>): Promise<unknown> {
    const reg = this.#o.tools.get(tool);
    if (reg === undefined) return undefined;
    const callId = `digest:${tool}:${this.#id()}`;
    const signal = new AbortController().signal;
    const r =
      "run" in reg && reg.run !== undefined
        ? await reg.run(params, {
            callId,
            threadId: "system:mail-digest",
            runId: "mail-digest",
            taint: true,
            permissionMode: "balanced",
            mode: "unattended",
            signal,
            onUpdate: () => {},
          })
        : await reg.execute(callId, params, signal, () => {});
    if (r.isError === true) throw new Error(`${tool} failed`);
    return r.output;
  }

  // --- collect ---------------------------------------------------------------------------------

  async #collect(since: Record<string, string>): Promise<MailItem[]> {
    const out: MailItem[] = [];
    const max = PROACTIVITY_BUDGET.mail.maxMessages;
    if (this.#o.tools.get("mail_search") !== undefined) {
      try {
        const msgs = output<Record<string, unknown>>(
          await this.#run("mail_search", { unread: true, since: since.apple, limit: max }),
          "messages",
        );
        let reads = 0;
        for (const m of msgs.slice(0, max)) {
          if (typeof m.id !== "string") continue;
          const item: MailItem = {
            account: String(m.account ?? "mail"),
            id: m.id,
            threadId: m.id,
            from: String(m.from ?? ""),
            subject: String(m.subject ?? ""),
            at: String(m.date ?? since.apple),
            preview: "",
            via: "apple",
            ...(typeof m.link === "string" ? { link: m.link } : {}),
          };
          out.push(item);
          // Bodies for the classifier, capped; headers decide the rest.
          if (
            reads < PROACTIVITY_BUDGET.mail.maxBodyReads &&
            this.#o.tools.get("mail_read") !== undefined
          ) {
            reads += 1;
            try {
              const full = (await this.#run("mail_read", {
                id: m.id,
                ...(typeof m.mailbox === "string" ? { mailbox: m.mailbox } : {}),
              })) as { body?: unknown } | undefined;
              if (typeof full?.body === "string") item.preview = sanitizeMailText(full.body);
            } catch (e) {
              this.#o.onError?.(e);
            }
          }
        }
      } catch (e) {
        this.#o.onError?.(e);
      }
    }
    if (this.#o.tools.get("gmail_search_threads") !== undefined) {
      try {
        const after = Math.floor(Date.parse(since.gmail ?? since.apple ?? "") / 1000);
        const threads = output<Record<string, unknown>>(
          await this.#run("gmail_search_threads", {
            query: `is:unread after:${after}`,
            maxResults: 50,
          }),
          "threads",
        );
        for (const t of threads) {
          if (typeof t.id !== "string") continue;
          out.push({
            account: "gmail",
            id: t.id,
            threadId: t.id,
            from: String(t.from ?? ""),
            subject: String(t.subject ?? ""),
            at: String(t.date ?? ""),
            preview: sanitizeMailText(String(t.snippet ?? "")),
            via: "gmail",
            link: `https://mail.google.com/mail/u/0/#inbox/${t.id}`,
          });
        }
      } catch (e) {
        this.#o.onError?.(e);
      }
    }
    return out.slice(0, max);
  }

  /** Records senders; returns the addresses never seen before this digest. */
  #senders(items: readonly MailItem[], at: string): Set<string> {
    const fresh = new Set<string>();
    const get = this.#o.db.prepare("SELECT address FROM mail_senders WHERE address = ?");
    const upsert = this.#o.db.prepare(
      `INSERT INTO mail_senders (address, first_seen_at, last_seen_at, messages) VALUES (?, ?, ?, 1)
       ON CONFLICT (address) DO UPDATE SET last_seen_at = excluded.last_seen_at, messages = messages + 1`,
    );
    for (const m of items) {
      const a = addressOf(m.from);
      if (a === "") continue;
      if (get.get(a) === undefined && !fresh.has(a)) fresh.add(a);
      upsert.run(a, at, at);
    }
    return fresh;
  }

  async #knownDomains(): Promise<string[]> {
    if (this.#o.knownDomains !== undefined) return this.#o.knownDomains();
    const rows = this.#o.db
      .prepare("SELECT address FROM mail_senders WHERE messages >= 3")
      .all() as { address: string }[];
    return [...new Set(rows.map((r) => domainOf(r.address)).filter((d) => d !== ""))];
  }

  async readRules() {
    const f = await this.#o.memory.readFile(RULES_PATH);
    return { file: parseRules(f?.content ?? "# Mail rules\n"), etag: f?.etag };
  }

  /** The card's Allow / Not now / Always archive and category moves (spec §4.1 "Learning"). */
  async setSenderRule(
    from: string,
    decision: RuleDecision,
    options: { category?: string; days?: number } = {},
  ): Promise<void> {
    const { file, etag } = await this.readRules();
    const today = localTime(this.#o.clock.now(), this.#o.timezone ?? "UTC").date;
    setRule(file, {
      decision,
      pattern: addressOf(from),
      why: `from the digest ${today}`,
      ...(decision === "category" ? { category: options.category ?? "fyi" } : {}),
      ...(decision === "not_now"
        ? {
            until: localTime(
              this.#o.clock.now() + (options.days ?? 7) * 86_400_000,
              this.#o.timezone ?? "UTC",
            ).date,
          }
        : {}),
    });
    await this.#o.memory.writeFile(RULES_PATH, serializeRules(file), {
      provenance: "owner",
      ...(etag === undefined ? {} : { etag }),
    });
  }

  // --- the digest ------------------------------------------------------------------------------

  async run(): Promise<{ digest: InboxDigest; post: StoredPost; notified: boolean }> {
    const nowMs = this.#o.clock.now();
    const now = toIso(nowMs);
    const tz = this.#o.timezone ?? "UTC";
    const local = localTime(nowMs, tz);
    const dayAgo = toIso(nowMs - 86_400_000);
    const since = {
      apple: this.#o.scheduler.getCursor(CURSOR_SOURCE, "apple") ?? dayAgo,
      gmail: this.#o.scheduler.getCursor(CURSOR_SOURCE, "gmail") ?? dayAgo,
    };
    const items = await this.#collect(since);
    const fresh = this.#senders(items, now);
    const { file } = await this.readRules();
    const knownDomains = await this.#knownDomains();

    const decided: {
      item: MailItem;
      category: DigestCategory;
      because?: string;
      summary: string;
    }[] = [];
    const toModel: MailItem[] = [];
    for (const m of items) {
      const address = addressOf(m.from);
      const known = (await this.#o.isKnownPerson?.(address)) ?? false;
      const pre = presort(m, {
        rules: file.rules,
        today: local.date,
        knownDomains,
        isFirstTime: fresh.has(address),
        isKnownPerson: known,
      });
      if (pre.category === undefined) toModel.push(m);
      else
        decided.push({
          item: m,
          category: pre.category,
          summary: cleanHeader(m.subject, 200),
          ...(pre.because === undefined ? {} : { because: pre.because }),
        });
    }
    for (let i = 0; i < toModel.length; i += CLASSIFY_BATCH) {
      const batch = toModel.slice(i, i + CLASSIFY_BATCH);
      const { results } = await classifyBatch(this.#o.provider, this.#o.model, batch);
      batch.forEach((m, j) => {
        const r = results[j] ?? { category: "fyi" as const, summary: m.subject };
        decided.push({
          item: m,
          category: r.category,
          summary: r.summary,
          ...(r.because === undefined ? {} : { because: r.because }),
        });
      });
    }

    const postId = this.#id();
    const toItem = (d: (typeof decided)[number]): DigestItem => {
      const actions: DigestAction[] =
        d.category === "needs_you" || d.category === "soon"
          ? [
              "draft_reply",
              "remind",
              ...(MEETING_ASK.test(`${d.item.subject} ${d.item.preview}`)
                ? (["propose_times"] as const)
                : []),
              "open",
            ]
          : d.category === "screen"
            ? ["allow_sender", "not_now", "always_archive"]
            : ["open"];
      return {
        thread: {
          account: d.item.account,
          threadId: d.item.threadId,
          messageId: d.item.id,
          subject: cleanHeader(d.item.subject, 500),
          from: cleanHeader(d.item.from, 320),
          ...(d.item.link === undefined ? {} : { link: d.item.link }),
          ...(d.item.at === "" ? {} : { at: d.item.at }),
        },
        category: d.category,
        summary: d.summary,
        ...(d.because === undefined ? {} : { because: d.because }),
        actions,
      };
    };
    const by = (c: DigestCategory) => decided.filter((d) => d.category === c);

    // One batch proposal per bulk group (spec §8.1): mark read or archive, never send or delete.
    const groups: DigestGroup[] = [];
    const proposalIds: string[] = [];
    const group = (category: DigestCategory, verb: "read" | "archive", noun: string) => {
      const list = by(category);
      if (list.length === 0) return;
      const calls = list.slice(0, 100).flatMap((d): ActionCall[] => {
        const subject = cleanHeader(d.item.subject, 80);
        if (d.item.via === "apple") {
          const tool = verb === "read" ? "mail_set_flags" : "mail_move";
          if (this.#o.tools.get(tool) === undefined) return [];
          return [
            {
              tool,
              params:
                verb === "read"
                  ? { ids: [d.item.id], read: true }
                  : { ids: [d.item.id], to: "archive" },
              summary: `${verb === "read" ? "Mark read" : "Archive"}: ${subject}`,
            },
          ];
        }
        if (this.#o.tools.get("gmail_modify_labels") === undefined) return [];
        return [
          {
            tool: "gmail_modify_labels",
            params: {
              threadId: d.item.threadId,
              add: [],
              remove: [verb === "read" ? "UNREAD" : "INBOX"],
            },
            summary: `${verb === "read" ? "Mark read" : "Archive"}: ${subject}`,
          },
        ];
      });
      const title = `${verb === "read" ? "Mark" : "Archive"} ${list.length} ${noun}${verb === "read" ? " read" : ""}`;
      let proposalId: string | null = null;
      if (calls.length > 0 && this.#o.proposals !== undefined) {
        const p = this.#o.proposals.create({
          title,
          calls,
          createdBy: { job: "mail.digest" },
          postId,
          taintSources: [{ sourceKind: "email", origin: "digest" }],
        });
        proposalId = p.id;
        proposalIds.push(p.id);
      }
      groups.push({ category, count: list.length, title: `${list.length} ${noun}`, proposalId });
    };
    group("newsletters", "read", "newsletters");
    group("notifications", "archive", "notifications and receipts");
    group("fyi", "read", "FYI");

    // Follow-ups: the graph's due waiting-on loops, each shown in at most two digests (§4.2).
    const waitingOn: DigestLoop[] = [];
    for (const loop of (await this.#o.loops?.()) ?? []) {
      if (loop.direction !== "waiting_on" || loop.status !== "open") continue;
      if (loop.dueAt != null && loop.dueAt > now) continue;
      const row = this.#o.db
        .prepare("SELECT shown_count FROM digest_loops WHERE loop_id = ?")
        .get(loop.id) as { shown_count: number } | undefined;
      const shown = row?.shown_count ?? 0;
      if (shown >= PROACTIVITY_BUDGET.mail.nudgeShowMax) continue;
      this.#o.db
        .prepare(
          `INSERT INTO digest_loops (loop_id, shown_count, last_shown_at) VALUES (?, 1, ?)
           ON CONFLICT (loop_id) DO UPDATE SET shown_count = shown_count + 1, last_shown_at = excluded.last_shown_at`,
        )
        .run(loop.id, now);
      const name =
        loop.counterpartId == null ? undefined : await this.#o.personName?.(loop.counterpartId);
      waitingOn.push({
        loop,
        shownCount: shown + 1,
        ...(name === undefined ? {} : { counterpart: name }),
      });
    }

    const counts: Record<string, number> = {};
    for (const d of decided) counts[d.category] = (counts[d.category] ?? 0) + 1;
    const needsYou = [...by("needs_you"), ...by("soon")].map(toItem);
    const digest: InboxDigest = {
      id: postId,
      createdAt: now,
      since: since.apple,
      until: now,
      accounts: [...new Set(items.map((m) => m.account))],
      counts,
      needsYou,
      groups,
      waitingOn,
      screen: by("screen").map(toItem),
      unverified: by("unverified").map(toItem),
      taint: items.length > 0,
      ...(this.#o.modelIsRemote === true && toModel.length > 0 ? { usedCloudModel: true } : {}),
    };
    const need = needsYou.filter((i) => i.category === "needs_you").length;
    const title = `Inbox · ${local.hhmm} · ${need === 0 ? "nothing needs you" : `${need} need${need === 1 ? "s" : ""} you`}`;
    const body = [
      ...needsYou.slice(0, 5).map((i) => `- **${i.thread.from ?? ""}**: ${i.summary}`),
      ...groups.map((g) => `- ${g.title}`),
      ...(waitingOn.length === 0
        ? []
        : [`- Waiting on ${waitingOn.length} repl${waitingOn.length === 1 ? "y" : "ies"}`]),
      ...(this.#o.meetingLines?.() ?? []).map((l) => `- ${l}`),
    ].join("\n");
    const post: StoredPost = {
      id: postId,
      title,
      bodyMd: body === "" ? "No new mail." : body,
      citations: [],
      cluster: null,
      score: 1,
      reasons: ["inbox digest", ...Object.entries(counts).map(([k, v]) => `${k}: ${v}`)],
      exploration: false,
      briefingId: null,
      feedback: null,
      createdAt: now,
      batchId: postId,
      kind: "digest",
      refs: { proposalIds, threads: needsYou.map((i) => i.thread) },
      card: { type: "digest", digest },
    };
    this.#o.feed.insert(post);
    const { batchId: _b, readAt: _r, ...wire } = post;
    this.#o.onFeedEvent?.({ event: "feed.updated", payload: { posts: [wire] } });

    // One notification a day; the OS only when something needs you (§3 rule 5).
    let notified = false;
    if (this.#o.notifier !== undefined) {
      await this.#o.notifier.notify({
        kind: "briefing",
        title,
        body:
          need === 0
            ? `${items.length} new, nothing needs you`
            : needsYou
                .slice(0, 3)
                .map((i) => i.thread.from ?? "")
                .join(", "),
        route: `/feed/${postId}`,
        dedupeKey: `mail:digest:${local.date}`,
        ...(need === 0 ? { surfaces: ["desktop", "web"] } : {}),
      });
      notified = true;
    }
    this.#o.scheduler.setCursor(CURSOR_SOURCE, "apple", now);
    this.#o.scheduler.setCursor(CURSOR_SOURCE, "gmail", now);
    return { digest, post, notified };
  }

  async ensureSchedule(options: { schedule?: string; timezone?: string; enabled?: boolean } = {}) {
    const prompt = jobMarker(MAIL_DIGEST_JOB, "daily");
    const fields = {
      title: "Inbox digest",
      schedule: options.schedule ?? DEFAULT_DIGEST_SCHEDULE,
      timezone: options.timezone ?? this.#o.timezone ?? "UTC",
      sessionTarget: "main",
      delivery: {},
      prompt,
      enabled: options.enabled ?? true,
      scratch: null,
    };
    const existing = (await this.#o.scheduler.list()).find((a) => a.prompt.trim() === prompt);
    return existing === undefined
      ? this.#o.scheduler.create({ kind: "cron", system: true, ...fields })
      : this.#o.scheduler.update(existing.id, fields);
  }

  /** The digest runs in-process (`withProactiveJobs`); it notifies itself, so it reports `no_reply`. */
  job(): ProactiveJob {
    return {
      name: "mail digest",
      matches: (a) => parseJobMarker(a.prompt)?.job === MAIL_DIGEST_JOB,
      run: async (): Promise<LaunchResult> => {
        const r = await this.run();
        const c = r.digest.counts;
        return {
          status: "no_reply",
          summary: `needs you ${c.needs_you ?? 0}, newsletters ${c.newsletters ?? 0}, notifications ${c.notifications ?? 0}, screen ${c.screen ?? 0}`,
        };
      },
    };
  }
}
