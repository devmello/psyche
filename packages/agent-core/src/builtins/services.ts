import {
  type Clock,
  type MemoryStore,
  type Notifier,
  PROTECTED_MEMORY_FILES,
  PsycheError,
  type Scheduler,
  type TaintSource,
  type TaskEngine,
  type ToolCallDescription,
} from "@psyche/protocol";
import { type Static, Type } from "@sinclair/typebox";
import { type AgentToolRegistration, defineTool, type ToolRunContext } from "../registry.ts";
import { localDate, sha256 } from "../util.ts";
import type { TurnToolContext } from "./turn.ts";

/** Protected paths (security §8): writes are `write` + `memory_protected_write`, always asked. */
export const PROTECTED_PATHS: ReadonlySet<string> = new Set<string>([
  ...PROTECTED_MEMORY_FILES,
  "AGENTS.md",
]);

const PROTECTED_FOLDED = new Set([...PROTECTED_PATHS].map((p) => p.toLowerCase()));

/** Case-folded: a store on case-insensitive APFS would write `soul.md` into `SOUL.md`. */
export function isProtectedPath(path: string): boolean {
  return PROTECTED_FOLDED.has(path.toLowerCase());
}

const Path = Type.String({ minLength: 1, maxLength: 512 });

/** The Anthropic `memory_20250818` command set over the workspace (architecture §4.8). */
export const MemoryInput = Type.Union([
  Type.Object({
    command: Type.Literal("view"),
    path: Path,
    view_range: Type.Optional(
      Type.Array(Type.Integer({ minimum: 1 }), { minItems: 2, maxItems: 2 }),
    ),
  }),
  Type.Object({ command: Type.Literal("create"), path: Path, file_text: Type.String() }),
  Type.Object({
    command: Type.Literal("str_replace"),
    path: Path,
    old_str: Type.String({ minLength: 1 }),
    new_str: Type.String(),
  }),
  Type.Object({
    command: Type.Literal("insert"),
    path: Path,
    insert_line: Type.Integer({ minimum: 0 }),
    insert_text: Type.String(),
  }),
  Type.Object({ command: Type.Literal("delete"), path: Path }),
  Type.Object({ command: Type.Literal("rename"), old_path: Path, new_path: Path }),
]);
export type MemoryInput = Static<typeof MemoryInput>;

/** `/memories/x.md`, `/x.md` and `x.md` all mean the workspace path `x.md`. */
export function workspacePath(path: string): string {
  return path.replace(/^\/memories(?:\/|$)/, "").replace(/^\/+/, "");
}

const DAILY_NOTE = /^memory\/(\d{4}-\d{2}-\d{2})\.md$/i;

/**
 * `MemoryFile` carries no provenance, so only content whose origin is known reads as trusted:
 * the protected persona files (owner-approved writes only) and daily notes without an
 * `[untrusted]` line. Any other workspace file may hold what a tainted turn wrote.
 */
function viewProvenance(path: string, content: string): "trusted" | "untrusted" {
  if (/\[untrusted\]/i.test(content)) return "untrusted";
  return isProtectedPath(path) || DAILY_NOTE.test(path) ? "trusted" : "untrusted";
}

/**
 * Writes to the workspace are Psyche's own store (`none`), except the protected persona files,
 * which become `write` with an exact binding so the approval covers this content only.
 */
export function describeMemoryCall(p: MemoryInput): ToolCallDescription {
  if (p.command === "view") return { summary: `Read ${workspacePath(p.path) || "the workspace"}` };
  const path = workspacePath(p.command === "rename" ? p.new_path : p.path);
  const source = p.command === "rename" ? workspacePath(p.old_path) : path;
  const summary = `Memory ${p.command} ${path}`;
  if (!isProtectedPath(path) && !isProtectedPath(source)) return { summary };
  const content =
    p.command === "create"
      ? p.file_text
      : p.command === "str_replace"
        ? `${p.old_str}\u0000${p.new_str}`
        : p.command === "insert"
          ? `${p.insert_line}\u0000${p.insert_text}`
          : "";
  return {
    sideEffect: "write",
    kind: "memory_protected_write",
    target: { kind: "path", value: path },
    bindingFields: { path, source, operation: p.command, contentHash: sha256(content) },
    grantKey: `memory|${path}`,
    summary,
  };
}

function numbered(content: string, range?: number[]): string {
  const lines = content.split("\n");
  const from = range?.[0] ?? 1;
  const to = range?.[1] ?? lines.length;
  return lines
    .slice(from - 1, to)
    .map((l, i) => `${String(i + from).padStart(6)}\t${l}`)
    .join("\n");
}

export interface MemoryToolOptions {
  clock: Clock;
  timeZone: string;
}

export function memoryTool(store: MemoryStore, options: MemoryToolOptions): AgentToolRegistration {
  return defineTool({
    name: "memory",
    description:
      "Your workspace memory (memory_20250818 commands: view, create, str_replace, insert, delete, rename). Daily notes live in memory/YYYY-MM-DD.md and are append-only. SOUL.md, IDENTITY.md, USER.md, AGENTS.md and MEMORY.md change only with the owner's approval.",
    input: MemoryInput,
    sideEffect: "none",
    targetKind: "path",
    describeCall: describeMemoryCall,
    run: async (p, ctx) => {
      // A tainted turn can never write as the agent: its notes are quoted data (security §3.6).
      const provenance = ctx.taint ? "untrusted" : "agent";
      const touched =
        p.command === "view"
          ? []
          : p.command === "rename"
            ? [workspacePath(p.old_path), workspacePath(p.new_path)]
            : [workspacePath(p.path)];
      const guarded = touched.find(isProtectedPath);
      if (ctx.taint && guarded !== undefined) {
        // Untrusted-derived writes go only to the daily note (security §3.6, §8).
        throw new PsycheError(
          "policy_denied",
          `a turn that read untrusted content cannot change ${guarded}`,
        );
      }
      // The run trace links the change to this call's step (run trace §4.2).
      const trace = { runId: ctx.runId, toolCallId: ctx.callId };
      const write = (path: string, content: string, etag?: string) =>
        store.writeFile(path, content, {
          provenance,
          trace,
          ...(etag === undefined ? {} : { etag }),
          ...(ctx.approvalId === undefined ? {} : { approvalId: ctx.approvalId }),
        });
      const today = localDate(options.clock.now(), options.timeZone);
      switch (p.command) {
        case "view": {
          const path = workspacePath(p.path);
          const file = path === "" ? undefined : await store.readFile(path);
          if (file === undefined) {
            const files = await store.listFiles(path === "" ? "" : `${path.replace(/\/$/, "")}/`);
            if (files.length === 0 && path !== "") {
              throw new PsycheError("not_found", `${path} does not exist`);
            }
            // File names a tainted turn chose are data too.
            const known = files.every((f) => isProtectedPath(f) || DAILY_NOTE.test(f));
            return {
              output: { directory: path || "/", files },
              provenance: known ? "trusted" : "untrusted",
            };
          }
          return {
            output: numbered(file.content, p.view_range),
            provenance: viewProvenance(path, file.content),
          };
        }
        case "create":
        case "insert": {
          const path = workspacePath(p.path);
          const daily = DAILY_NOTE.exec(path);
          if (daily !== null) {
            if (daily[1] !== today) {
              throw new PsycheError(
                "invalid_params",
                `only today's note (memory/${today}.md) can be appended to`,
              );
            }
            const text = p.command === "create" ? p.file_text : p.insert_text;
            const r = await store.appendDailyNote({ text, provenance, date: today, trace });
            return { output: { appended: r.path }, provenance: "trusted" };
          }
          if (p.command === "create") {
            await write(path, p.file_text);
            return { output: { created: path }, provenance: "trusted" };
          }
          const file = await store.readFile(path);
          if (file === undefined) throw new PsycheError("not_found", `${path} does not exist`);
          const lines = file.content.split("\n");
          if (p.insert_line > lines.length) {
            throw new PsycheError(
              "invalid_params",
              `insert_line ${p.insert_line} is past the end (${lines.length} lines)`,
            );
          }
          lines.splice(p.insert_line, 0, p.insert_text);
          await write(path, lines.join("\n"), file.etag);
          return { output: { inserted: path, line: p.insert_line + 1 }, provenance: "trusted" };
        }
        case "str_replace": {
          const path = workspacePath(p.path);
          if (DAILY_NOTE.test(path)) {
            throw new PsycheError("invalid_params", "daily notes are append-only");
          }
          const file = await store.readFile(path);
          if (file === undefined) throw new PsycheError("not_found", `${path} does not exist`);
          const count = file.content.split(p.old_str).length - 1;
          if (count !== 1) {
            throw new PsycheError(
              "invalid_params",
              `old_str must occur exactly once in ${path} (found ${count})`,
            );
          }
          await write(
            path,
            file.content.replace(p.old_str, () => p.new_str),
            file.etag,
          );
          return { output: { replaced: path }, provenance: "trusted" };
        }
        case "delete":
        case "rename":
          throw new PsycheError(
            "not_implemented",
            `memory ${p.command} needs MemoryStore support (requested from S07); use str_replace instead`,
          );
      }
    },
  });
}

function turnOf(ctx: ToolRunContext) {
  return (ctx as Partial<TurnToolContext>).turn;
}

export function taskStartTool(tasks: TaskEngine): AgentToolRegistration {
  return defineTool({
    name: "task.start",
    description:
      "Start a background task for long-running work that should outlive this turn. It inherits this turn's taint.",
    input: Type.Object(
      {
        title: Type.String({ minLength: 1, maxLength: 120 }),
        goal: Type.String({ minLength: 1, maxLength: 4_000 }),
        checklist: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 20 })),
        // Where its commands run (L1–L5); absent means the owner's default.
        workspace: Type.Optional(Type.Union([Type.Literal("sandbox"), Type.Literal("vm")])),
      },
      { additionalProperties: false },
    ),
    // Delegation persists instructions that run later, maybe unattended (design-08): `write`,
    // matching the broker's floor, with its own approval kind.
    sideEffect: "write",
    describeCall: (p) => ({ kind: "task_start", summary: `Started task "${p.title}"` }),
    run: async (p, ctx) => {
      const task = await tasks.create({
        threadId: ctx.threadId,
        title: p.title,
        goal: p.goal,
        createdFrom: "chat",
        taint: ctx.taint,
        // The sources travel with the task (design-08): every run starts tainted with them.
        ...(ctx.taint && ctx.taintSources !== undefined && ctx.taintSources.length > 0
          ? { taintSources: structuredClone(ctx.taintSources) as TaintSource[] }
          : {}),
        ...(p.checklist === undefined
          ? {}
          : { checklist: p.checklist.map((text) => ({ text, status: "pending" as const })) }),
        ...(p.workspace === undefined ? {} : { workspace: p.workspace }),
      });
      turnOf(ctx)?.emitBlock({ type: "task", taskId: task.id });
      return { output: { taskId: task.id, status: task.status }, provenance: "trusted" };
    },
  });
}

export function scheduleTool(scheduler: Scheduler, defaultTimeZone: string): AgentToolRegistration {
  return defineTool({
    name: "schedule",
    description:
      "Create an automation that runs a prompt on a schedule (cron expression, or an ISO-8601 interval such as PT1H). Automations run unattended.",
    input: Type.Object(
      {
        title: Type.String({ minLength: 1, maxLength: 120 }),
        kind: Type.Union([Type.Literal("cron"), Type.Literal("interval")]),
        schedule: Type.String({ minLength: 1, maxLength: 120 }),
        prompt: Type.String({ minLength: 1, maxLength: 8_000 }),
        timezone: Type.Optional(Type.String({ minLength: 1 })),
      },
      { additionalProperties: false },
    ),
    // A standing automation is persistent configuration: never silent.
    sideEffect: "write",
    describeCall: (p) => ({ summary: `Schedule "${p.title}" (${p.schedule})` }),
    run: async (p, ctx) => {
      const automation = await scheduler.create({
        kind: p.kind,
        title: p.title,
        schedule: p.schedule,
        timezone: p.timezone ?? defaultTimeZone,
        sessionTarget: "isolated",
        delivery: { thread: ctx.threadId },
        prompt: p.prompt,
        scratch: null,
        enabled: true,
      });
      return {
        output: { automationId: automation.id, nextRunAt: automation.nextRunAt ?? null },
        provenance: "trusted",
      };
    },
  });
}

export function notifyTool(notifier: Notifier): AgentToolRegistration {
  return defineTool({
    name: "notify",
    description: "Send the owner a notification (in-app inbox, fanned out to their devices).",
    input: Type.Object(
      {
        title: Type.String({ minLength: 1, maxLength: 120 }),
        body: Type.String({ minLength: 1, maxLength: 2_000 }),
      },
      { additionalProperties: false },
    ),
    sideEffect: "write",
    targetKind: "recipient",
    describeCall: (p) => ({
      target: { kind: "recipient", value: "owner" },
      // Read before and after it runs (#307): never "Notified" for something not yet sent.
      summary: `Notify the owner: ${p.title}`,
    }),
    run: async (p, ctx) => {
      const n = await notifier.notify({
        kind: "proactive",
        title: p.title,
        body: p.body,
        ...(ctx.taskId === undefined ? {} : { taskId: ctx.taskId }),
      });
      return { output: { notificationId: n.id }, provenance: "trusted" };
    },
  });
}
