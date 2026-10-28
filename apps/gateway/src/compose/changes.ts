import {
  CHANGE_KIND,
  type ChangeCategory,
  type ChangeInput,
  type ChangeRecord,
  ChangeRecorder,
  changeFromEntry,
  changesToMarkdown,
  diffFromEntry,
  type HashChainAuditLog,
  listChanges,
} from "@psyche/audit";
import type { FileChange } from "@psyche/files";
import type { MemoryFileChange } from "@psyche/memory";
import { type AuditEntry, type EventName, type EventPayload, PsycheError } from "@psyche/protocol";
import type { Call, HandlerDef } from "../context.ts";

/**
 * Owner-data change records: the recorder every write path reports to, and the `audit.change*`
 * read handlers behind the chat's change chip and the Timeline / Activity view.
 */

export function createChangeRecorder(deps: {
  audit: HashChainAuditLog;
  redact: (text: string) => string;
  publish: <E extends EventName>(event: E, payload: EventPayload<E>, threadId?: string) => void;
  onError?: (error: unknown) => void;
}): ChangeRecorder {
  return new ChangeRecorder({
    log: deps.audit,
    redact: deps.redact,
    ...(deps.onError === undefined ? {} : { onError: deps.onError }),
    onRecorded: (r) =>
      deps.publish(
        "audit.change.recorded",
        {
          seq: r.seq,
          category: r.category,
          ...(r.threadId === undefined ? {} : { threadId: r.threadId }),
          ...(r.runId === undefined ? {} : { runId: r.runId }),
        },
        r.threadId,
      ),
  });
}

type Item = { record: ChangeRecord & { category: ChangeCategory }; entry: AuditEntry };

/** An approval decision as a timeline entry (the audit log keeps these as `approval.decided`). */
function approvalItem(entry: AuditEntry): Item {
  const s = (entry.subject ?? {}) as Record<string, unknown>;
  const d = entry.data as Record<string, unknown>;
  const approvalId = String(s.approvalId ?? "");
  return {
    entry,
    record: {
      seq: entry.seq,
      hash: entry.hash,
      ts: entry.ts,
      actor: { type: entry.actor.type === "user" ? "owner" : "agent", name: String(d.via ?? "") },
      category: "approval",
      tool: "approval",
      target: { object: approvalId },
      action: String(d.decision ?? "decided"),
      ...(approvalId === "" ? {} : { approvalId }),
      outcome: "ok",
      hasDiff: false,
    },
  };
}

interface Filter {
  threadId?: string;
  runId?: string;
  categories?: readonly ChangeCategory[];
  since?: string;
  until?: string;
  beforeSeq?: number;
  limit?: number;
}

export async function collect(audit: HashChainAuditLog, f: Filter): Promise<Item[]> {
  const cats = f.categories;
  const wantApprovals = cats === undefined || cats.includes("approval");
  const changeCats = cats?.filter((c) => c !== "approval");
  const limit = f.limit ?? 200;
  const items: Item[] = [];
  if (cats === undefined || (changeCats?.length ?? 0) > 0) {
    items.push(
      ...(await listChanges(audit, {
        ...f,
        limit,
        ...(changeCats === undefined ? {} : { categories: changeCats }),
      })),
    );
  }
  if (wantApprovals) {
    // Approval entries carry no thread: a thread's view shows the ones its changes cite.
    let ids: Set<string> | undefined;
    if (f.threadId !== undefined || f.runId !== undefined) {
      const own = await listChanges(audit, { ...f, limit: 1000 });
      ids = new Set(own.flatMap((i) => (i.record.approvalId ? [i.record.approvalId] : [])));
    }
    if (ids === undefined || ids.size > 0) {
      const approvals = await audit.query({
        kind: "approval.decided",
        order: "desc",
        ...(f.since === undefined ? {} : { since: f.since }),
        ...(f.until === undefined ? {} : { until: f.until }),
        ...(f.beforeSeq === undefined ? {} : { untilSeq: f.beforeSeq }),
        limit: ids === undefined ? limit : 5000,
      });
      for (const e of approvals) {
        const id = String((e.subject as Record<string, unknown> | undefined)?.approvalId ?? "");
        if (ids !== undefined && !ids.has(id)) continue;
        items.push(approvalItem(e));
      }
    }
  }
  items.sort((a, b) => b.record.seq - a.record.seq);
  return items.slice(0, limit);
}

export function changeHandlers(deps: { audit: HashChainAuditLog }): Record<string, HandlerDef> {
  const { audit } = deps;
  return {
    "audit.changes": {
      async run(_call: Call, params: Filter) {
        const items = await collect(audit, params);
        return { changes: items.map((i) => i.record) };
      },
    },
    "audit.change": {
      async run(_call: Call, params: { seq: number }) {
        const [entry] = await audit.query({ sinceSeq: params.seq, untilSeq: params.seq + 1 });
        if (entry === undefined) throw new PsycheError("not_found", "no such audit entry");
        const item =
          entry.kind === "approval.decided"
            ? approvalItem(entry)
            : (() => {
                const record = changeFromEntry(entry);
                if (record === undefined || entry.kind !== CHANGE_KIND) {
                  throw new PsycheError("not_found", "that audit entry is not a change");
                }
                return { record, entry } as Item;
              })();
        const diff = diffFromEntry(item.entry);
        return { change: item.record, ...(diff === undefined ? {} : { diff }) };
      },
    },
    "audit.changesExport": {
      async run(_call: Call, params: Filter & { format: "json" | "markdown" }) {
        const { format, ...filter } = params;
        const items = await collect(audit, { ...filter, limit: 5000 });
        const chain = await audit.verifyDetailed();
        const verified = chain.ok;
        if (format === "markdown") {
          return {
            format,
            verified,
            data: changesToMarkdown(items as never, {
              ok: chain.ok,
              ...(chain.ok ? { count: chain.count } : {}),
            }),
          };
        }
        const withDiff = items.map((i) => ({ ...i.record, diff: diffFromEntry(i.entry) ?? null }));
        return {
          format,
          verified,
          data: `${JSON.stringify({ verified, chain: chain.ok ? { ok: true, count: chain.count } : chain, changes: withDiff }, null, 2)}\n`,
        };
      },
    },
  };
}

/** A workspace file change reported by the memory store, as a change record. */
export function memoryChange(c: MemoryFileChange): ChangeInput {
  const actor =
    c.actor === "owner"
      ? ({ type: "owner", name: "editor" } as const)
      : c.actor === "job"
        ? ({ type: "job", name: c.link.tool ?? "memory-job" } as const)
        : ({ type: "agent" } as const);
  return {
    actor,
    category: "memory",
    ...(c.link.threadId === undefined ? {} : { threadId: c.link.threadId }),
    ...(c.link.runId === undefined ? {} : { runId: c.link.runId }),
    ...(c.link.toolCallId === undefined ? {} : { toolCallId: c.link.toolCallId }),
    tool: c.link.tool ?? (c.actor === "owner" ? "memory.write" : "memory"),
    target: {
      path: c.path,
      ...(c.renamedTo === undefined ? {} : { object: c.renamedTo }),
    },
    action: c.action,
    ...(c.approvalId === undefined ? {} : { approvalId: c.approvalId }),
    ...(c.before === undefined ? {} : { before: c.before }),
    ...(c.after === undefined ? {} : { after: c.after }),
  };
}

export function fileChange(c: FileChange): ChangeInput {
  return {
    actor: { type: "agent" },
    category: "file",
    threadId: c.threadId,
    runId: c.runId,
    ...(c.taskId === undefined ? {} : { taskId: c.taskId }),
    toolCallId: c.toolCallId,
    tool: c.tool,
    target: { path: c.path },
    action: c.action,
    ...(c.approvalId === undefined ? {} : { approvalId: c.approvalId }),
    ...(c.before === undefined ? {} : { before: c.before }),
    after: c.after,
  };
}

/** Tools whose writes are recorded with before/after content by the file and memory hooks. */
const RECORDED_ELSEWHERE = new Set([
  "write_file",
  "edit_file",
  "write_document",
  "memory",
  "remember",
  "forget",
  "persona_update",
]);

export interface ToolEffect {
  threadId: string;
  runId: string;
  taskId?: string;
  toolCallId: string;
  tool: string;
  kind: string;
  target?: { kind: string; value: string };
  outcome: "ok" | "failed" | "uncertain";
  summary: string;
  approvalId?: string;
  receiptId?: string;
}

/**
 * Every other side-effecting tool call (commands, skills, connectors, Apple apps): who, which
 * thread and turn, the approval, and what it touched. Content stays out; the receipt has the rest.
 */
export function toolEffectChange(e: ToolEffect): ChangeInput | undefined {
  if (RECORDED_ELSEWHERE.has(e.tool)) return undefined;
  const dot = e.kind.indexOf(".");
  let category: ChangeCategory;
  let target: ChangeInput["target"];
  if (e.tool === "exec_host" || e.kind === "exec" || e.kind === "exec_host") {
    category = "command";
    target = { path: e.target?.value ?? e.summary };
  } else if (e.tool.startsWith("skill_") || e.kind.startsWith("skill_")) {
    category = "skill";
    target = { object: e.target?.value ?? e.summary };
  } else if (dot > 0) {
    category = "connector";
    target = { connector: e.kind.slice(0, dot), object: e.target?.value ?? e.summary };
  } else {
    category = "connector";
    target = { connector: e.tool, object: e.target?.value ?? e.summary };
  }
  return {
    actor: { type: "agent" },
    category,
    threadId: e.threadId,
    runId: e.runId,
    ...(e.taskId === undefined ? {} : { taskId: e.taskId }),
    toolCallId: e.toolCallId,
    tool: e.tool,
    target,
    action: dot > 0 ? e.kind.slice(dot + 1) : e.kind,
    ...(e.approvalId === undefined ? {} : { approvalId: e.approvalId }),
    ...(e.receiptId === undefined ? {} : { receiptId: e.receiptId }),
    outcome: e.outcome === "ok" ? "ok" : "failed",
    note: e.outcome === "uncertain" ? `uncertain: ${e.summary}` : e.summary,
  };
}

/** The owner changed a setting: key and value hashes only (values can hold secrets). */
export function settingChange(c: {
  key: string;
  before: unknown;
  after: unknown;
  deviceId: string;
}): ChangeInput {
  const json = (v: unknown) => (v === undefined ? undefined : JSON.stringify(v));
  const before = json(c.before);
  const after = json(c.after);
  return {
    actor: { type: "owner", name: "settings" },
    category: "setting",
    tool: "settings.set",
    target: { object: c.key },
    action: before === undefined ? "create" : "update",
    hashOnly: true,
    ...(before === undefined ? {} : { before }),
    ...(after === undefined ? {} : { after }),
  };
}
