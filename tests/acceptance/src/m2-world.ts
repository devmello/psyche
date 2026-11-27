import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AutomationInput, ToolResult } from "@psyche/protocol";
import { parseSchedule } from "../../../packages/scheduler/src/schedule.ts";
import { FakeScheduler } from "../../../packages/testing/src/fakes/FakeScheduler.ts";
import { FakeTaskEngine } from "../../../packages/testing/src/fakes/FakeTaskEngine.ts";
import type { Stack, StackOverrides } from "../../../packages/testing/src/scenarios/stack.ts";
import type { Json } from "../../../packages/testing/src/scenarios/types.ts";
import type { ToolCtx, ToolImpl, World } from "../../../packages/testing/src/scenarios/world.ts";
import {
  detectFormFields,
  type FilledCopy,
  FormFillError,
  type FormValues,
  fillReceipt,
  finalizeFilledCopy,
  prepareFilledCopy,
} from "../../../packages/viewers/src/core/forms.ts";

/**
 * Fakes for the Milestone 2 scenarios (tests/acceptance/scenarios-m2), plugged into S18's
 * scenario Stack through `StackOverrides.impls` and `.services`:
 *
 * - V5 documents: `documents.form_fields` / `documents.fill_form` run the real P2 pipeline
 *   (packages/viewers detectFormFields, prepareFilledCopy) on the fixture PDF; `gmail.send`
 *   flattens a filled copy on send with `finalizeFilledCopy` (refused if the reviewed bytes
 *   changed) and records the pipeline's `fillReceipt`, then sends through the World's own fake.
 * - V8 subscriptions: a `gmail.search` that honours `newer_than:<n>d` and keywords (the World's
 *   own looks at the last five days of the inbox only); agent-core's real `task.start` built-in
 *   over a FakeTaskEngine.
 * - V9 weekly review: `goals.list` over fixtures/goals.json; agent-core's real `schedule` built-in
 *   over a FakeScheduler whose cron runs on the real scheduler's timezone-aware parser; each fire
 *   starts an unattended run on the Stack, and the loop gets the Stack's notifier, so deferred
 *   approvals notify the owner as they do in psyched.
 *
 * Tools marked provisional in shared/tools.json have no agent registration on main yet; their
 * owners replace these fakes (docs/archive/status/int-3.md).
 */

export interface M2State {
  tasks: FakeTaskEngine;
  scheduler: TzScheduler | undefined;
  filled: Map<string, FilledCopy & { sourceName: string }>;
  /** Fill receipts the send recorded (V5). */
  fillReceipts: string[];
}

/**
 * A FakeScheduler with the real scheduler's cron semantics in the automation's timezone, which
 * starts an unattended run on the Stack at every fire time (the FakeScheduler alone is UTC-only
 * and fires only when ticked).
 */
export class TzScheduler extends FakeScheduler {
  readonly #stack: Stack;
  readonly fired: { automationId: string; at: string; runId: string }[] = [];

  constructor(stack: Stack) {
    super({ clock: stack.clock });
    this.#stack = stack;
  }

  override async create(input: AutomationInput) {
    const a = await super.create(input);
    const schedule = parseSchedule(input.kind, input.schedule, input.timezone);
    const arm = (after: number) => {
      const at = schedule.next(after);
      if (at === undefined) return undefined;
      this.#stack.clock.setTimer(at, () => {
        const n = this.fired.filter((f) => f.automationId === a.id).length + 1;
        const runId = `run_${a.id}_${n}`;
        this.fired.push({ automationId: a.id, at: new Date(at).toISOString(), runId });
        // `isolated` (what the schedule built-in asks for) is its own session, as in psyched:
        // the automation does not continue the chat thread's history.
        const thread = input.sessionTarget === "main" ? undefined : `thr_${a.id}`;
        this.#stack.startRun(input.prompt, `task_${a.id}_${n}`, runId, "unattended", thread);
        arm(at);
      });
      return at;
    };
    const next = arm(this.#stack.clock.now());
    return { ...a, nextRunAt: next === undefined ? null : new Date(next).toISOString() };
  }
}

/** The overrides and the fakes' state for one Milestone 2 scenario. */
export function m2Overrides(scenario: string): { overrides: StackOverrides; state: M2State } {
  const state: M2State = {
    tasks: new FakeTaskEngine(),
    scheduler: undefined,
    filled: new Map(),
    fillReceipts: [],
  };
  const overrides: StackOverrides = {
    impls: (world, stack) => impls(scenario, world, stack, state),
    services: (stack) => {
      if (scenario === "v8-subscription-audit") {
        state.tasks = new FakeTaskEngine({ clock: stack.clock });
        return { tasks: state.tasks };
      }
      if (scenario === "v9-weekly-review") {
        state.scheduler = new TzScheduler(stack);
        return { scheduler: state.scheduler, notifier: stack.notifier };
      }
      return {};
    },
  };
  return { overrides, state };
}

/**
 * A small Gmail search: `newer_than:<n>d|m|y`, `after:` / `before:` (YYYY/MM/DD), `from:`, `to:`,
 * `subject:` and `in:` / `label:` (ignored: everything is in the inbox), plain words and "quoted
 * phrases" that must all appear (Gmail's implicit AND), `OR` between two terms, and parentheses
 * as grouping. No window unless the query names one, as in Gmail.
 */
export function gmailQuery(query: string, now: number): (m: Json) => boolean {
  const tokens = query.match(/-?[a-z_]+:"[^"]*"|-?[a-z_]+:\S+|"[^"]*"|\(|\)|\S+/gi) ?? [];
  const day = 86_400_000;
  type Term = (m: Json) => boolean;
  const text = (m: Json) =>
    [m.subject, m.snippet, (m.from as Json).name, (m.from as Json).email, (m.body as Json).text]
      .join(" ")
      .toLowerCase();
  const unquote = (v: string) => v.replace(/^"|"$/g, "").toLowerCase();
  const date = (v: string) => Date.parse(v.replace(/\//g, "-"));
  const termOf = (token: string): Term | undefined => {
    const raw = token.replace(/^\(+|\)+$/g, "");
    if (raw === "OR") return undefined;
    const neg = raw.startsWith("-");
    const t = neg ? raw.slice(1) : raw;
    const op = /^([a-z_]+):(.+)$/i.exec(t);
    let f: Term | undefined;
    if (op !== null) {
      const [, key = "", value = ""] = op;
      const v = unquote(value);
      switch (key.toLowerCase()) {
        case "newer_than": {
          const n = /^(\d+)([dmy])$/.exec(v);
          const ms =
            n === null ? 0 : Number(n[1]) * day * ({ d: 1, m: 30, y: 365 }[n[2] as "d"] ?? 1);
          f = (m) => Date.parse(String(m.internalDate)) >= now - ms;
          break;
        }
        case "after":
          f = (m) => Date.parse(String(m.internalDate)) >= date(v);
          break;
        case "before":
          f = (m) => Date.parse(String(m.internalDate)) < date(v);
          break;
        case "from":
          f = (m) => `${(m.from as Json).name} ${(m.from as Json).email}`.toLowerCase().includes(v);
          break;
        case "to":
          f = (m) =>
            JSON.stringify(m.to ?? [])
              .toLowerCase()
              .includes(v);
          break;
        case "subject":
          f = (m) => String(m.subject).toLowerCase().includes(v);
          break;
        case "in":
        case "label":
        case "category":
        case "is":
        case "has":
          return undefined;
        default:
          f = (m) => text(m).includes(t.toLowerCase());
      }
    } else {
      const v = unquote(t);
      if (v === "") return undefined;
      f = (m) => text(m).includes(v);
    }
    return neg ? (m) => !(f as Term)(m) : f;
  };
  // AND of OR-groups: "a OR b c" = (a or b) and c; parentheses only group.
  const groups: Term[][] = [];
  let joinNext = false;
  for (const token of tokens) {
    const raw = token.replace(/^\(+|\)+$/g, "");
    if (raw === "") continue;
    if (raw === "OR" || raw === "|") {
      joinNext = true;
      continue;
    }
    const term = termOf(raw);
    if (term === undefined) continue;
    if (joinNext && groups.length > 0) (groups[groups.length - 1] as Term[]).push(term);
    else groups.push([term]);
    joinNext = false;
  }
  // "(a OR b OR c)" written with the parentheses first still joins: the OR rule above handles it.
  return (m) => groups.every((g) => g.some((t) => t(m)));
}

function impls(
  scenario: string,
  world: World,
  stack: Stack,
  state: M2State,
): Record<string, ToolImpl> {
  let n = 0;
  const id = (prefix: string) => `${prefix}_${String(++n).padStart(4, "0")}`;
  const fixture = <T>(name: string): T =>
    JSON.parse(readFileSync(join(world.fx.dir, "fixtures", name), "utf8")) as T;
  const ok = (output: unknown, provenance: "trusted" | "untrusted" = "trusted"): ToolResult => ({
    output,
    provenance,
  });
  const fail = (error: string, extra: Json = {}): ToolResult => ({
    output: { error, ...extra },
    isError: true,
    provenance: "trusted",
  });
  const taint = (ctx: ToolCtx, sources: string[]) =>
    world.sources.set(ctx.callId, [...new Set(sources)]);
  const net = (ctx: ToolCtx, via: "connector" | "smtp", host: string, allowedBy?: string) =>
    world.egress.push({
      step: world.step,
      callId: ctx.callId,
      via,
      host,
      ...(allowedBy === undefined ? {} : { allowedBy }),
    });
  const base = world.impls();

  // --- V5: documents -------------------------------------------------------------------------

  /** A Library PDF's bytes and where it came from (an attachment, or a filled copy). */
  const pdfOf = (libraryItemId: string) => {
    const filled = state.filled.get(libraryItemId);
    if (filled !== undefined) return { name: filled.name, bytes: filled.bytes, sender: undefined };
    const item = world.library.find((l) => l.id === libraryItemId);
    if (item === undefined) return undefined;
    for (const m of world.fx.mailbox?.messages ?? []) {
      for (const a of (m.attachments as Json[] | undefined) ?? []) {
        if (a.sha256 !== item.sha256) continue;
        const bytes = new Uint8Array(readFileSync(join(world.fx.dir, "fixtures", String(a.path))));
        return { name: String(item.name), bytes, sender: String((m.from as Json).email) };
      }
    }
    return undefined;
  };

  const documents: Record<string, ToolImpl> = {
    "documents.form_fields": async (_i, a, ctx) => {
      const pdf = pdfOf(String(a.libraryItemId));
      if (pdf === undefined) return fail("library item not found");
      const d = await detectFormFields(pdf.bytes);
      if (pdf.sender !== undefined) taint(ctx, [`email:${pdf.sender}`]);
      return ok(
        {
          kind: d.kind,
          fillable: d.fillable,
          fields: d.fields.map((f) => ({
            name: f.name,
            label: f.label,
            type: f.type,
            required: f.required,
            value: f.value,
            ...(f.options === undefined ? {} : { options: f.options }),
          })),
          unsupported: d.unsupported,
        },
        "untrusted",
      );
    },
    "documents.fill_form": async (_i, a, ctx) => {
      const pdf = pdfOf(String(a.libraryItemId));
      if (pdf === undefined) return fail("library item not found");
      const detection = await detectFormFields(pdf.bytes);
      const copy = await prepareFilledCopy(pdf, detection, a.values as FormValues);
      const itemId = id("doc");
      state.filled.set(itemId, { ...copy, sourceName: pdf.name });
      world.library.push({
        id: itemId,
        kind: "document",
        name: copy.name,
        mime: "application/pdf",
        sha256: copy.sha256,
        origin: "agent",
        tags: ["filled"],
      });
      if (pdf.sender !== undefined) taint(ctx, [`email:${pdf.sender}`]);
      return ok({
        libraryItemId: itemId,
        name: copy.name,
        sha256: copy.sha256,
        review: copy.review,
        missingRequired: copy.missingRequired,
        skipped: copy.skipped,
      });
    },
    "gmail.send": async (info, a, ctx) => {
      const attachments = (a.attachments as Json[] | undefined) ?? [];
      const sent: Json[] = [];
      for (const att of attachments) {
        const copy = state.filled.get(String(att.libraryItemId));
        if (copy === undefined) {
          sent.push(att);
          continue;
        }
        try {
          // Flatten on send; refused when the copy is not the bytes the owner reviewed.
          const final = await finalizeFilledCopy(copy, copy.sha256);
          const r = await world.broker().recordReceipt({
            ...fillReceipt({
              sourceName: copy.sourceName,
              copy,
              final,
              approvalId: ctx.approvalId ?? null,
              taskId: ctx.taskId ?? null,
              toolCallId: `${ctx.callId}.fill`,
            }),
          });
          state.fillReceipts.push(r.id);
          sent.push({ ...att, sha256: final.sha256, flattened: true, size: final.bytes.length });
        } catch (err) {
          if (err instanceof FormFillError && err.code === "binding_mismatch")
            return fail(err.message, { errorCode: "binding_mismatch" });
          throw err;
        }
      }
      return (base["gmail.send"] as ToolImpl)(info, { ...a, attachments: sent }, ctx);
    },
  };

  // --- V8: a mail search over months, not days -----------------------------------------------

  const search: Record<string, ToolImpl> = {
    "gmail.search": async (_i, a, ctx) => {
      net(ctx, "connector", "gmail.googleapis.com", "connector:google");
      const q = String(a.query ?? "");
      const match = gmailQuery(q, stack.clock.now());
      const hits = (world.fx.mailbox?.messages ?? [])
        .filter((m) => (m.labelIds as string[]).includes("INBOX"))
        .filter(match)
        .sort((x, y) => Date.parse(String(y.internalDate)) - Date.parse(String(x.internalDate)))
        .slice(0, Number(a.maxResults ?? 50));
      taint(
        ctx,
        hits.map((m) => `email:${(m.from as Json).email}`),
      );
      return ok(
        hits.map((m) => ({
          id: m.id,
          threadId: m.threadId,
          from: m.from,
          subject: m.subject,
          snippet: m.snippet,
          date: m.internalDate,
        })),
        "untrusted",
      );
    },
  };

  // --- V9: goals -----------------------------------------------------------------------------

  const goals: Record<string, ToolImpl> = {
    "goals.list": async () => {
      const g = fixture<{ goals: Json[] }>("goals.json").goals;
      return ok({ goals: g.filter((x) => x.status === "active") });
    },
  };

  switch (scenario) {
    case "v5-permission-slip":
      return documents;
    case "v8-subscription-audit":
      return search;
    case "v9-weekly-review":
      return goals;
    default:
      return {};
  }
}
