import { PsycheError, type SideEffect } from "@psyche/protocol";
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { dailyNoteDate, isProtected } from "../layout.ts";
import { normalizeWorkspacePath } from "../paths.ts";
import type { ProvenanceOrigin } from "../provenance.ts";
import type { SqliteMemoryStore, WriteOptions } from "../store.ts";

/**
 * Handler for Anthropic's client-side memory tool, `memory_20250818` (architecture §4.3, feature
 * H4): `view`, `create`, `str_replace`, `insert`, `delete`, `rename` over `/memories`, which maps
 * to the workspace root. Claude uses it natively; other models get the same handler through a
 * regular tool with the same input schema. Every write goes through the store's rules.
 */

export const MEMORY_ROOT = "/memories";

export const MemoryCommandInput = Type.Union([
  Type.Object({
    command: Type.Literal("view"),
    path: Type.String(),
    view_range: Type.Optional(Type.Tuple([Type.Integer(), Type.Integer()])),
  }),
  Type.Object({ command: Type.Literal("create"), path: Type.String(), file_text: Type.String() }),
  Type.Object({
    command: Type.Literal("str_replace"),
    path: Type.String(),
    old_str: Type.String(),
    new_str: Type.String(),
  }),
  Type.Object({
    command: Type.Literal("insert"),
    path: Type.String(),
    insert_line: Type.Integer({ minimum: 0 }),
    insert_text: Type.String(),
  }),
  Type.Object({ command: Type.Literal("delete"), path: Type.String() }),
  Type.Object({
    command: Type.Literal("rename"),
    old_path: Type.String(),
    new_path: Type.String(),
  }),
]);
export type MemoryCommandInput = Static<typeof MemoryCommandInput>;

/**
 * The same input as one object schema, for providers that require `type: "object"` at the top
 * of a tool schema. Calls are still validated against the strict union above.
 */
export const MemoryCommandToolSchema = Type.Object({
  command: Type.Union(
    ["view", "create", "str_replace", "insert", "delete", "rename"].map((c) => Type.Literal(c)),
  ),
  path: Type.Optional(Type.String({ description: "Path under /memories" })),
  view_range: Type.Optional(Type.Tuple([Type.Integer(), Type.Integer()])),
  file_text: Type.Optional(Type.String()),
  old_str: Type.Optional(Type.String()),
  new_str: Type.Optional(Type.String()),
  insert_line: Type.Optional(Type.Integer({ minimum: 0 })),
  insert_text: Type.Optional(Type.String()),
  old_path: Type.Optional(Type.String()),
  new_path: Type.Optional(Type.String()),
});

/** Per-call context the agent loop supplies (security §3.6, §8). */
export interface MemoryToolContext {
  /** `agent`, or `untrusted` when the turn is tainted. The model never writes as the owner. */
  provenance: "agent" | "untrusted";
  /** Where tainting content came from, rendered in daily-note tags. */
  origin?: ProvenanceOrigin;
  /** An approved `memory_protected_write` for this exact call, when one was needed. */
  approvalId?: string;
  /** Incognito threads write nothing to memory. */
  incognito?: boolean;
  /** The owner's own message(s) in this turn; lets `remember` keep owner provenance. */
  ownerText?: string;
  /** A private session of the owner (not a group, channel peer or subagent). */
  privateSession?: boolean;
}

export interface ToolOutcome {
  content: string;
  isError?: boolean;
  /** `untrusted` when the result shows untrusted content: the caller taints the turn. */
  provenance: "trusted" | "untrusted";
}

/** Maps `/memories/...` to a workspace path (`""` for the root). */
export function toWorkspace(path: string): string {
  if (path === MEMORY_ROOT || path === `${MEMORY_ROOT}/`) return "";
  if (!path.startsWith(`${MEMORY_ROOT}/`)) {
    throw new PsycheError("invalid_params", `paths must start with ${MEMORY_ROOT}`);
  }
  return normalizeWorkspacePath(path.slice(MEMORY_ROOT.length + 1).replace(/\/+$/, ""));
}

function display(rel: string): string {
  return rel === "" ? MEMORY_ROOT : `${MEMORY_ROOT}/${rel}`;
}

function human(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / 1024 / 1024).toFixed(1)}M`;
}

function numbered(lines: string[], first: number): string {
  return lines.map((l, i) => `${String(first + i).padStart(6)}\t${l}`).join("\n");
}

export interface MemoryCallClass {
  sideEffect: SideEffect;
  /** Workspace paths the call reads or changes. */
  paths: string[];
  /** True when a `memory_protected_write` approval is needed before executing. */
  protected: boolean;
}

/**
 * Classifies one call for the Permission Broker: `view` reads the workspace (`none`), edits are
 * `write`, `delete` is `destructive`. Touching a protected file needs `memory_protected_write`.
 */
export function classifyMemoryCommand(input: unknown): MemoryCallClass {
  if (!Value.Check(MemoryCommandInput, input)) {
    return { sideEffect: "none", paths: [], protected: false };
  }
  const paths = input.command === "rename" ? [input.old_path, input.new_path] : [input.path];
  const rel = paths.flatMap((p) => {
    try {
      return [toWorkspace(p)];
    } catch {
      return [];
    }
  });
  const sideEffect: SideEffect =
    input.command === "view" ? "none" : input.command === "delete" ? "destructive" : "write";
  return {
    sideEffect,
    paths: rel,
    protected: input.command !== "view" && rel.some(isProtected),
  };
}

function writeOptions(ctx: MemoryToolContext, etag?: string): WriteOptions {
  return {
    provenance: ctx.provenance,
    actor: "agent",
    source: "tool",
    ...(ctx.approvalId === undefined ? {} : { approvalId: ctx.approvalId }),
    ...(ctx.origin === undefined ? {} : { origin: ctx.origin }),
    ...(etag === undefined ? {} : { etag }),
  };
}

export function assertWritable(store: SqliteMemoryStore, ctx: { incognito?: boolean }): void {
  if (ctx.incognito === true) {
    throw new PsycheError("policy_denied", "this is an incognito thread; memory writes are off");
  }
  if (store.paused) throw new PsycheError("policy_denied", "memory is paused by the owner");
}

async function view(
  store: SqliteMemoryStore,
  input: Extract<MemoryCommandInput, { command: "view" }>,
): Promise<ToolOutcome> {
  const rel = toWorkspace(input.path);
  const kind = store.entryKind(rel);
  if (kind === undefined) {
    throw new PsycheError("not_found", `The path ${input.path} does not exist.`);
  }
  if (kind === "dir") {
    const entries = store.entries(rel, 2);
    const total = entries.reduce((n, e) => n + e.bytes, 0);
    const lines = [`${human(total)}\t${display(rel)}`];
    for (const e of entries) {
      lines.push(`${human(e.bytes)}\t${display(e.path)}${e.kind === "dir" ? "/" : ""}`);
    }
    // File names written in a tainted turn are untrusted text too.
    const tainted = entries.some(
      (e) => e.kind === "file" && store.contentProvenance(e.path) === "untrusted",
    );
    return {
      content: `Here are the files and directories up to 2 levels deep in ${display(rel)}, excluding hidden items:\n${lines.join("\n")}`,
      provenance: tainted ? "untrusted" : "trusted",
    };
  }
  const file = await store.readFile(rel);
  if (file === undefined)
    throw new PsycheError("not_found", `The path ${input.path} does not exist.`);
  const lines = file.content.split("\n");
  let first = 1;
  let shown = lines;
  if (input.view_range !== undefined) {
    const [start, end] = input.view_range;
    if (start < 1 || start > lines.length || (end !== -1 && end < start)) {
      throw new PsycheError("invalid_params", `Invalid view_range for ${input.path}`);
    }
    first = start;
    shown = lines.slice(start - 1, end === -1 ? undefined : end);
  }
  return {
    content: `Here's the content of ${display(rel)} with line numbers:\n${numbered(shown, first)}`,
    provenance: store.contentProvenance(rel) === "untrusted" ? "untrusted" : "trusted",
  };
}

/** Executes one memory command. Errors come back as `isError` results, never throws. */
export async function executeMemoryCommand(
  store: SqliteMemoryStore,
  input: unknown,
  ctx: MemoryToolContext,
): Promise<ToolOutcome> {
  try {
    if (!Value.Check(MemoryCommandInput, input)) {
      throw new PsycheError("invalid_params", "invalid memory command input");
    }
    if (input.command === "view") return await view(store, input);
    assertWritable(store, ctx);
    switch (input.command) {
      case "create": {
        const rel = toWorkspace(input.path);
        if (store.entryKind(rel) !== undefined) {
          throw new PsycheError("conflict", `File ${input.path} already exists`);
        }
        await store.write(rel, input.file_text, writeOptions(ctx));
        return { content: `File created successfully at: ${display(rel)}`, provenance: "trusted" };
      }
      case "str_replace": {
        const rel = toWorkspace(input.path);
        const file = await store.readFile(rel);
        if (file === undefined)
          throw new PsycheError("not_found", `The path ${input.path} does not exist.`);
        if (input.old_str.length === 0) throw new PsycheError("invalid_params", "old_str is empty");
        const count = file.content.split(input.old_str).length - 1;
        if (count === 0) {
          throw new PsycheError(
            "invalid_params",
            `No replacement was performed, old_str did not appear verbatim in ${input.path}.`,
          );
        }
        if (count > 1) {
          throw new PsycheError(
            "invalid_params",
            `No replacement was performed. Multiple occurrences of old_str in ${input.path}; make it unique.`,
          );
        }
        if (dailyNoteDate(rel) !== undefined) {
          throw new PsycheError("policy_denied", "daily notes are append-only");
        }
        const next = file.content.replace(input.old_str, () => input.new_str);
        await store.write(rel, next, writeOptions(ctx, file.etag));
        return {
          content: `The memory file ${display(rel)} has been edited.`,
          provenance: "trusted",
        };
      }
      case "insert": {
        const rel = toWorkspace(input.path);
        const file = await store.readFile(rel);
        if (file === undefined)
          throw new PsycheError("not_found", `The path ${input.path} does not exist.`);
        const lines = file.content.split("\n");
        if (file.content.endsWith("\n")) lines.pop();
        if (input.insert_line > lines.length) {
          throw new PsycheError(
            "invalid_params",
            `Invalid insert_line ${input.insert_line}; ${input.path} has ${lines.length} lines.`,
          );
        }
        lines.splice(input.insert_line, 0, ...input.insert_text.replace(/\n$/, "").split("\n"));
        await store.write(rel, `${lines.join("\n")}\n`, writeOptions(ctx, file.etag));
        return { content: `The file ${display(rel)} has been edited.`, provenance: "trusted" };
      }
      case "delete": {
        const rel = toWorkspace(input.path);
        if (rel === "")
          throw new PsycheError("policy_denied", "the workspace root cannot be deleted");
        await store.delete(rel, writeOptions(ctx));
        return { content: `Successfully deleted ${display(rel)}`, provenance: "trusted" };
      }
      case "rename": {
        const from = toWorkspace(input.old_path);
        const to = toWorkspace(input.new_path);
        if (from === "" || to === "")
          throw new PsycheError("invalid_params", "cannot rename the root");
        await store.rename(from, to, writeOptions(ctx));
        return {
          content: `Successfully renamed ${display(from)} to ${display(to)}`,
          provenance: "trusted",
        };
      }
    }
  } catch (err) {
    const e = PsycheError.from(err);
    return { content: `Error: ${e.message}`, isError: true, provenance: "trusted" };
  }
}
