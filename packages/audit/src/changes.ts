import { gunzipSync, gzipSync } from "node:zlib";
import type { AuditEntry, JsonObject } from "@psyche/protocol";
import { sha256 } from "./canonical.ts";
import type { HashChainAuditLog } from "./log.ts";
import { redactSensitive } from "./sensitive.ts";

/**
 * Change records: one hash-chained audit entry (`change.recorded`) for every write that changes
 * the owner's data, with who did it, which thread and turn it came from, and before/after hashes.
 * Text changes also keep a capped, redacted, gzip+base64 unified diff, so the proof lives in the
 * audit store (never in memory) and is covered by the chain.
 */

export const CHANGE_KIND = "change.recorded";

export const CHANGE_CATEGORIES = [
  "file",
  "memory",
  "command",
  "connector",
  "skill",
  "setting",
  "approval",
] as const;
export type ChangeCategory = (typeof CHANGE_CATEGORIES)[number];

export interface ChangeActor {
  type: "agent" | "job" | "owner";
  /** Background job name ("profile-learning", "dreaming") or the owner's device surface. */
  name?: string;
}

export interface ChangeTarget {
  /** File or memory path, or a command line. */
  path?: string;
  connector?: string;
  object?: string;
}

export interface ChangeInput {
  actor: ChangeActor;
  category: ChangeCategory;
  threadId?: string;
  /** The turn (run) the change belongs to; background jobs reuse the turn they came from. */
  runId?: string;
  taskId?: string;
  toolCallId?: string;
  /** The tool or job that made the change. */
  tool: string;
  target: ChangeTarget;
  action: string;
  approvalId?: string;
  receiptId?: string;
  /** Text (diffed) or bytes (hashes and size only); undefined = did not exist. */
  before?: string | Uint8Array;
  after?: string | Uint8Array;
  outcome?: "ok" | "failed";
  /** Keep hashes and size only (settings values may hold secrets). */
  hashOnly?: boolean;
  /** Free text for non-file changes (a command's exit code, a connector summary). */
  note?: string;
}

export interface ChangeRecord {
  seq: number;
  hash: string;
  ts: string;
  actor: ChangeActor;
  category: ChangeCategory;
  threadId?: string;
  runId?: string;
  taskId?: string;
  toolCallId?: string;
  tool: string;
  target: ChangeTarget;
  action: string;
  approvalId?: string;
  receiptId?: string;
  beforeSha256?: string;
  afterSha256?: string;
  bytes?: number;
  outcome: "ok" | "failed";
  note?: string;
  hasDiff: boolean;
  diffTruncated?: boolean;
  /** Added and removed line counts, when there is a diff. */
  stats?: { added: number; removed: number };
}

export interface ChangeRecorderOptions {
  log: Pick<HashChainAuditLog, "append">;
  /** Masks live vault values in text (the vault `SecretRedactor.redact`). */
  redact?: (text: string) => string;
  /** Called after an entry is stored. */
  onRecorded?: (record: Pick<ChangeRecord, "seq" | "threadId" | "runId" | "category">) => void;
  onError?: (error: unknown) => void;
}

export const MAX_DIFF_BYTES = 64 * 1024;
/** Above this a text file is stored as hashes and size only. */
export const MAX_DIFF_SOURCE_BYTES = 512 * 1024;
const CONTEXT = 3;
const MAX_LCS_CELLS = 4_000_000;

function toBuffer(v: string | Uint8Array): Buffer {
  return typeof v === "string" ? Buffer.from(v, "utf8") : Buffer.from(v);
}

function isText(b: Buffer): boolean {
  return !b.subarray(0, 8192).includes(0);
}

type Op = { t: " " | "-" | "+"; line: string };

function lineOps(a: string[], b: string[]): Op[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const ops: Op[] = a.slice(0, start).map((line) => ({ t: " ", line }));
  if (midA.length * midB.length > MAX_LCS_CELLS) {
    for (const line of midA) ops.push({ t: "-", line });
    for (const line of midB) ops.push({ t: "+", line });
  } else {
    const w = midB.length + 1;
    const dp = new Uint32Array((midA.length + 1) * w);
    for (let i = midA.length - 1; i >= 0; i--) {
      for (let j = midB.length - 1; j >= 0; j--) {
        dp[i * w + j] =
          midA[i] === midB[j]
            ? (dp[(i + 1) * w + j + 1] ?? 0) + 1
            : Math.max(dp[(i + 1) * w + j] ?? 0, dp[i * w + j + 1] ?? 0);
      }
    }
    let i = 0;
    let j = 0;
    while (i < midA.length && j < midB.length) {
      if (midA[i] === midB[j]) {
        ops.push({ t: " ", line: midA[i] as string });
        i++;
        j++;
      } else if ((dp[(i + 1) * w + j] ?? 0) >= (dp[i * w + j + 1] ?? 0)) {
        ops.push({ t: "-", line: midA[i++] as string });
      } else {
        ops.push({ t: "+", line: midB[j++] as string });
      }
    }
    while (i < midA.length) ops.push({ t: "-", line: midA[i++] as string });
    while (j < midB.length) ops.push({ t: "+", line: midB[j++] as string });
  }
  for (const line of a.slice(endA)) ops.push({ t: " ", line });
  return ops;
}

/** A unified diff (3 lines of context) between two texts; "" when they are equal. */
export function unifiedDiff(
  before: string,
  after: string,
  label = "file",
): { diff: string; added: number; removed: number } {
  if (before === after) return { diff: "", added: 0, removed: 0 };
  const split = (s: string) => (s === "" ? [] : s.split("\n"));
  const ops = lineOps(split(before), split(after));
  let added = 0;
  let removed = 0;
  for (const o of ops) {
    if (o.t === "+") added++;
    else if (o.t === "-") removed++;
  }
  const out: string[] = [`--- a/${label}`, `+++ b/${label}`];
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((o, idx) => {
    if (o.t === " ") return;
    for (let k = Math.max(0, idx - CONTEXT); k <= Math.min(ops.length - 1, idx + CONTEXT); k++) {
      keep[k] = true;
    }
  });
  let oldNo = 1;
  let newNo = 1;
  let idx = 0;
  while (idx < ops.length) {
    if (!keep[idx]) {
      oldNo++;
      newNo++;
      idx++;
      continue;
    }
    const startOld = oldNo;
    const startNew = newNo;
    const body: string[] = [];
    let oldLen = 0;
    let newLen = 0;
    while (idx < ops.length && keep[idx]) {
      const o = ops[idx] as Op;
      body.push(`${o.t}${o.line}`);
      if (o.t !== "+") {
        oldNo++;
        oldLen++;
      }
      if (o.t !== "-") {
        newNo++;
        newLen++;
      }
      idx++;
    }
    out.push(`@@ -${startOld},${oldLen} +${startNew},${newLen} @@`, ...body);
  }
  return { diff: out.join("\n"), added, removed };
}

export function packDiff(diff: string): string {
  return gzipSync(Buffer.from(diff, "utf8")).toString("base64");
}

export function unpackDiff(packed: string): string {
  return gunzipSync(Buffer.from(packed, "base64")).toString("utf8");
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Parses a stored `change.recorded` entry; undefined for anything else. */
export function changeFromEntry(entry: AuditEntry): ChangeRecord | undefined {
  if (entry.kind !== CHANGE_KIND) return undefined;
  const d = entry.data as Record<string, unknown>;
  const actor = d.actor as ChangeActor | undefined;
  const target = d.target as ChangeTarget | undefined;
  if (actor === undefined || target === undefined) return undefined;
  const s = (entry.subject ?? {}) as Record<string, unknown>;
  const stats = d.stats as { added: number; removed: number } | undefined;
  return {
    seq: entry.seq,
    hash: entry.hash,
    ts: entry.ts,
    actor,
    category: d.category as ChangeCategory,
    ...(str(s.threadId) === undefined ? {} : { threadId: str(s.threadId) as string }),
    ...(str(s.runId) === undefined ? {} : { runId: str(s.runId) as string }),
    ...(str(s.taskId) === undefined ? {} : { taskId: str(s.taskId) as string }),
    ...(str(d.toolCallId) === undefined ? {} : { toolCallId: str(d.toolCallId) as string }),
    tool: String(d.tool ?? ""),
    target,
    action: String(d.action ?? ""),
    ...(str(d.approvalId) === undefined ? {} : { approvalId: str(d.approvalId) as string }),
    ...(str(d.receiptId) === undefined ? {} : { receiptId: str(d.receiptId) as string }),
    ...(str(d.beforeSha256) === undefined ? {} : { beforeSha256: str(d.beforeSha256) as string }),
    ...(str(d.afterSha256) === undefined ? {} : { afterSha256: str(d.afterSha256) as string }),
    ...(typeof d.bytes === "number" ? { bytes: d.bytes } : {}),
    outcome: d.outcome === "failed" ? "failed" : "ok",
    ...(str(d.note) === undefined ? {} : { note: str(d.note) as string }),
    hasDiff: typeof d.diff === "string",
    ...(d.diffTruncated === true ? { diffTruncated: true } : {}),
    ...(stats === undefined ? {} : { stats }),
  };
}

/** The stored diff of a `change.recorded` entry, or undefined. */
export function diffFromEntry(entry: AuditEntry): string | undefined {
  const packed = (entry.data as Record<string, unknown>).diff;
  return typeof packed === "string" ? unpackDiff(packed) : undefined;
}

export class ChangeRecorder {
  readonly #o: ChangeRecorderOptions;

  constructor(options: ChangeRecorderOptions) {
    this.#o = options;
  }

  #scrub(text: string): string {
    const masked = this.#o.redact === undefined ? text : this.#o.redact(text);
    return redactSensitive(masked);
  }

  /** Never throws: a failed audit write must not fail the owner's action. */
  async record(input: ChangeInput): Promise<void> {
    try {
      await this.#record(input);
    } catch (error) {
      this.#o.onError?.(error);
    }
  }

  async #record(input: ChangeInput): Promise<void> {
    const before = input.before === undefined ? undefined : toBuffer(input.before);
    const after = input.after === undefined ? undefined : toBuffer(input.after);
    const data: JsonObject = {
      actor: { type: input.actor.type, ...(input.actor.name ? { name: input.actor.name } : {}) },
      category: input.category,
      tool: input.tool,
      target: this.#target(input.target),
      action: input.action,
      outcome: input.outcome ?? "ok",
    };
    if (input.toolCallId) data.toolCallId = input.toolCallId;
    if (input.approvalId) data.approvalId = input.approvalId;
    if (input.receiptId) data.receiptId = input.receiptId;
    if (input.note) data.note = this.#scrub(input.note).slice(0, 500);
    if (before !== undefined) data.beforeSha256 = sha256(before);
    if (after !== undefined) {
      data.afterSha256 = sha256(after);
      data.bytes = after.byteLength;
    } else if (before !== undefined) {
      data.bytes = before.byteLength;
    }
    const textual =
      input.hashOnly !== true &&
      (before === undefined || (isText(before) && before.byteLength <= MAX_DIFF_SOURCE_BYTES)) &&
      (after === undefined || (isText(after) && after.byteLength <= MAX_DIFF_SOURCE_BYTES)) &&
      (before !== undefined || after !== undefined);
    if (textual && data.beforeSha256 !== data.afterSha256) {
      const label = input.target.path ?? input.target.object ?? "content";
      const d = unifiedDiff(
        this.#scrub(before?.toString("utf8") ?? ""),
        this.#scrub(after?.toString("utf8") ?? ""),
        label,
      );
      let text = d.diff;
      if (Buffer.byteLength(text, "utf8") > MAX_DIFF_BYTES) {
        text = `${Buffer.from(text, "utf8").subarray(0, MAX_DIFF_BYTES).toString("utf8")}\n… diff truncated`;
        data.diffTruncated = true;
      }
      data.diff = packDiff(text);
      data.stats = { added: d.added, removed: d.removed };
    }
    const subject: JsonObject = {};
    if (input.threadId) subject.threadId = input.threadId;
    if (input.runId) subject.runId = input.runId;
    if (input.taskId) subject.taskId = input.taskId;
    const entry = await this.#o.log.append(
      {
        kind: CHANGE_KIND,
        actor: {
          type:
            input.actor.type === "owner" ? "user" : input.actor.type === "job" ? "system" : "agent",
          ...(input.runId && input.actor.type === "agent" ? { runId: input.runId } : {}),
        },
        ...(Object.keys(subject).length > 0 ? { subject } : {}),
        data,
      },
      { verbatim: ["diff"] },
    );
    this.#o.onRecorded?.({
      seq: entry.seq,
      category: input.category,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
    });
  }

  #target(t: ChangeTarget): JsonObject {
    const out: JsonObject = {};
    if (t.path) out.path = this.#scrub(t.path).slice(0, 1000);
    if (t.connector) out.connector = t.connector;
    if (t.object) out.object = this.#scrub(t.object).slice(0, 500);
    return out;
  }
}

export interface ChangeFilter {
  threadId?: string;
  runId?: string;
  categories?: readonly ChangeCategory[];
  since?: string;
  until?: string;
  beforeSeq?: number;
  limit?: number;
}

/** Newest first. */
export async function listChanges(
  log: Pick<HashChainAuditLog, "query">,
  f: ChangeFilter = {},
): Promise<{ record: ChangeRecord; entry: AuditEntry }[]> {
  const entries = await log.query({
    kind: CHANGE_KIND,
    order: "desc",
    ...(f.since === undefined ? {} : { since: f.since }),
    ...(f.until === undefined ? {} : { until: f.until }),
    ...(f.beforeSeq === undefined ? {} : { untilSeq: f.beforeSeq }),
    subject: {
      ...(f.threadId === undefined ? {} : { threadId: f.threadId }),
      ...(f.runId === undefined ? {} : { runId: f.runId }),
    },
  });
  const out: { record: ChangeRecord; entry: AuditEntry }[] = [];
  const cats = f.categories === undefined ? undefined : new Set(f.categories);
  for (const entry of entries) {
    const record = changeFromEntry(entry);
    if (record === undefined) continue;
    if (cats !== undefined && !cats.has(record.category)) continue;
    out.push({ record, entry });
    if (out.length >= (f.limit ?? 200)) break;
  }
  return out;
}

/** A readable Markdown export (oldest first) with each stored diff. */
export function changesToMarkdown(
  items: readonly { record: ChangeRecord; entry: AuditEntry }[],
  chain: { ok: boolean; count?: number },
): string {
  const lines = [
    "# Psyche activity",
    "",
    `Audit chain: ${chain.ok ? "verified" : "NOT verified"}${chain.count === undefined ? "" : ` (${chain.count} entries)`}`,
    "",
  ];
  for (const { record: r, entry } of [...items].reverse()) {
    const target =
      r.target.path ?? [r.target.connector, r.target.object].filter(Boolean).join(" · ");
    lines.push(
      `## ${r.ts} · ${r.action} · ${target}`,
      "",
      `- Actor: ${r.actor.type}${r.actor.name ? ` (${r.actor.name})` : ""}`,
      `- Tool: ${r.tool} · ${r.category}${r.outcome === "failed" ? " · failed" : ""}`,
      ...(r.threadId ? [`- Thread: ${r.threadId}${r.runId ? ` · turn ${r.runId}` : ""}`] : []),
      ...(r.approvalId ? [`- Approval: ${r.approvalId}`] : []),
      ...(r.beforeSha256 ? [`- Before: ${r.beforeSha256}`] : []),
      ...(r.afterSha256 ? [`- After: ${r.afterSha256}`] : []),
      `- Entry: #${r.seq} ${r.hash}`,
      "",
    );
    const diff = diffFromEntry(entry);
    if (diff !== undefined) lines.push("```diff", diff, "```", "");
  }
  return lines.join("\n");
}
