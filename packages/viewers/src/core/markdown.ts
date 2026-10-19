import { diff } from "@codemirror/merge";
import { parse as parseYaml } from "yaml";

/**
 * Markdown documents (P5, docs/06 §3.8). Raw Markdown is canonical: the editor edits text, never
 * an AST, so untouched lines are never rewritten. This module holds the DOM-free parts:
 * frontmatter, persona budgets, line-diff stats and the save/conflict session.
 */

// ── Frontmatter ──────────────────────────────────────────────────────────────────────

export interface FrontmatterSplit {
  /** The exact frontmatter block including both `---` fences and the trailing newline, or "". */
  block: string;
  /** YAML between the fences, or null when there is no frontmatter. */
  yaml: string | null;
  body: string;
}

const FM = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

export function splitFrontmatter(text: string): FrontmatterSplit {
  const m = FM.exec(text);
  if (m === null) return { block: "", yaml: null, body: text };
  return { block: m[0], yaml: m[1] ?? "", body: text.slice(m[0].length) };
}

/** Rebuilds a document. An unchanged YAML string keeps the original block byte-for-byte. */
export function joinFrontmatter(
  original: FrontmatterSplit,
  yaml: string | null,
  body: string,
): string {
  if (yaml === null) return body;
  if (yaml === original.yaml) return original.block + body;
  const nl = original.block.includes("\r\n") ? "\r\n" : "\n";
  return `---${nl}${yaml.replace(/\s+$/, "")}${nl}---${nl}${body}`;
}

export type FrontmatterParse =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string };

export function parseFrontmatter(yaml: string): FrontmatterParse {
  try {
    // Plain YAML 1.2 core schema: no custom tags, no aliases bombs past the default limit.
    const data = parseYaml(yaml, { schema: "core", maxAliasCount: 50 }) as unknown;
    if (data === null || data === undefined) return { ok: true, data: {} };
    if (typeof data !== "object" || Array.isArray(data)) {
      return { ok: false, error: "Frontmatter must be a mapping of keys to values" };
    }
    return { ok: true, data: data as Record<string, unknown> };
  } catch (err) {
    return { ok: false, error: (err as Error).message.split("\n")[0] ?? "Invalid YAML" };
  }
}

// ── Persona budgets (architecture §4.2) ──────────────────────────────────────────────

export const PERSONA_BUDGETS: Readonly<Record<string, number>> = {
  "SOUL.md": 20_000,
  "IDENTITY.md": 20_000,
  "AGENTS.md": 20_000,
  "USER.md": 4_000,
};

export interface DocumentKind {
  /** Character budget when the file is injected into prompts. */
  budget?: number;
  /** Dreaming rewrites it nightly (docs/06 §3.8). */
  rewrittenNightly: boolean;
  /** Show the frontmatter panel (IDENTITY.md and any file that has frontmatter). */
  frontmatter: boolean;
}

/** Workspace-relative path → editor affordances. Only top-level workspace files are persona files. */
export function documentKind(path: string, text = ""): DocumentKind {
  const parts = path.split(/[\\/]/).filter(Boolean);
  const top = parts.length === 1 ? parts[0] : undefined;
  const budget = top === undefined ? undefined : PERSONA_BUDGETS[top];
  return {
    ...(budget === undefined ? {} : { budget }),
    rewrittenNightly: top === "MEMORY.md",
    frontmatter: top === "IDENTITY.md" || splitFrontmatter(text).yaml !== null,
  };
}

/** "6.2k / 20k" */
export function formatBudget(used: number, budget: number): string {
  const k = (n: number) =>
    n < 1000 ? String(n) : `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k`;
  return `${k(used)} / ${k(budget)}`;
}

// ── Diff stats ───────────────────────────────────────────────────────────────────────

/** Added / removed line counts between two texts ("+12 −1"). */
export function lineDiffStats(before: string, after: string): { added: number; removed: number } {
  if (before === after) return { added: 0, removed: 0 };
  // Map each distinct line to one code unit from the Private Use Area and diff those strings, so
  // CodeMirror's Myers diff works on lines.
  const ids = new Map<string, string>();
  const encode = (text: string) =>
    text
      .split(/\r?\n/)
      .map((line) => {
        let id = ids.get(line);
        if (id === undefined) {
          id = String.fromCharCode(0xe000 + (ids.size % 0x1900));
          ids.set(line, id);
        }
        return id;
      })
      .join("");
  const a = encode(before);
  const b = encode(after);
  let added = 0;
  let removed = 0;
  for (const ch of diff(a, b)) {
    removed += ch.toA - ch.fromA;
    added += ch.toB - ch.fromB;
  }
  return { added, removed };
}

// ── Save session with etag conflicts ─────────────────────────────────────────────────

export type SaveResult =
  | { ok: true; etag: string }
  | { ok: false; conflict: { etag: string; content: string } };

/** Where a document lives. `save` must reject a stale `baseEtag` with a conflict (compare-and-swap). */
export interface DocumentStore {
  load(): Promise<{ content: string; etag: string }>;
  save(content: string, baseEtag: string): Promise<SaveResult>;
}

export type SessionStatus = "loading" | "clean" | "dirty" | "saving" | "conflict" | "error";

export interface SessionState {
  status: SessionStatus;
  content: string;
  /** Content as of the last load or successful save (Diff mode's left side). */
  saved: string;
  etag: string;
  /** The other writer's version when status is "conflict" (usually the agent's edit). */
  conflict?: { content: string; etag: string };
  error?: string;
}

export interface SessionOptions {
  /** Autosave delay after the last edit; false = explicit Save only. Default 1500 ms. */
  autosaveMs?: number | false;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * One open document. Edits mark it dirty and (optionally) autosave; every save is a
 * compare-and-swap on the etag, so an agent edit to the same file surfaces as a conflict instead
 * of being overwritten. A conflict stops autosave until the user resolves it.
 */
export class DocumentSession {
  #state: SessionState = { status: "loading", content: "", saved: "", etag: "" };
  #listeners = new Set<(s: SessionState) => void>();
  #timer: unknown;
  #saving: Promise<void> | undefined;
  readonly #autosaveMs: number | false;
  readonly #setTimer: (fn: () => void, ms: number) => unknown;
  readonly #clearTimer: (handle: unknown) => void;

  private readonly store: DocumentStore;
  constructor(store: DocumentStore, opts: SessionOptions = {}) {
    this.store = store;
    this.#autosaveMs = opts.autosaveMs ?? 1500;
    this.#setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.#clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  get state(): Readonly<SessionState> {
    return this.#state;
  }

  subscribe(fn: (s: SessionState) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  async load(): Promise<void> {
    try {
      const { content, etag } = await this.store.load();
      this.#set({ status: "clean", content, saved: content, etag });
    } catch (err) {
      this.#set({ ...this.#state, status: "error", error: (err as Error).message });
    }
  }

  edit(content: string): void {
    if (this.#state.status === "loading") return;
    if (content === this.#state.content) return;
    const inConflict = this.#state.status === "conflict";
    const status: SessionStatus = inConflict
      ? "conflict"
      : content === this.#state.saved
        ? "clean"
        : "dirty";
    this.#set({ ...this.#state, content, status });
    this.#cancelTimer();
    if (status === "dirty" && this.#autosaveMs !== false) {
      this.#timer = this.#setTimer(() => void this.save(), this.#autosaveMs);
    }
  }

  /** Saves now. Resolves after the store answers; conflicts are state, not exceptions. */
  async save(): Promise<void> {
    this.#cancelTimer();
    if (this.#saving !== undefined) await this.#saving;
    const s = this.#state;
    if (s.status !== "dirty" && s.status !== "error") return;
    const content = s.content;
    this.#set({ ...s, status: "saving" });
    this.#saving = (async () => {
      try {
        const res = await this.store.save(content, s.etag);
        const now = this.#state;
        if (res.ok) {
          const edited = now.content !== content;
          this.#set({
            status: edited ? "dirty" : "clean",
            content: now.content,
            saved: content,
            etag: res.etag,
          });
          if (edited && this.#autosaveMs !== false) {
            this.#timer = this.#setTimer(() => void this.save(), this.#autosaveMs);
          }
        } else {
          this.#set({ ...now, status: "conflict", conflict: res.conflict });
        }
      } catch (err) {
        this.#set({ ...this.#state, status: "error", error: (err as Error).message });
      } finally {
        this.#saving = undefined;
      }
    })();
    await this.#saving;
  }

  /** Drops local edits back to the last saved content. */
  discard(): void {
    this.#cancelTimer();
    const s = this.#state;
    if (s.status === "conflict" && s.conflict !== undefined) {
      this.#set({
        status: "clean",
        content: s.conflict.content,
        saved: s.conflict.content,
        etag: s.conflict.etag,
      });
      return;
    }
    this.#set({ status: "clean", content: s.saved, saved: s.saved, etag: s.etag });
  }

  /**
   * The file changed elsewhere (file watcher, agent `edit_file`). A clean document follows it;
   * a dirty one goes to conflict so nothing is lost.
   */
  remoteChanged(remote: { content: string; etag: string }): void {
    const s = this.#state;
    if (remote.etag === s.etag) return;
    if (s.status === "clean") {
      this.#set({
        status: "clean",
        content: remote.content,
        saved: remote.content,
        etag: remote.etag,
      });
      return;
    }
    if (remote.content === s.content) {
      this.#set({ status: "clean", content: s.content, saved: remote.content, etag: remote.etag });
      return;
    }
    this.#cancelTimer();
    this.#set({ ...s, status: "conflict", conflict: remote });
  }

  /**
   * Resolves a conflict: keep mine (overwrite theirs), take theirs, or a merged text. "mine" and
   * merged text save against the remote etag.
   */
  async resolve(choice: "mine" | "theirs" | { merged: string }): Promise<void> {
    const s = this.#state;
    if (s.status !== "conflict" || s.conflict === undefined) return;
    if (choice === "theirs") {
      this.discard();
      return;
    }
    const content = choice === "mine" ? s.content : choice.merged;
    this.#set({ status: "dirty", content, saved: s.conflict.content, etag: s.conflict.etag });
    await this.save();
  }

  dispose(): void {
    this.#cancelTimer();
    this.#listeners.clear();
  }

  #cancelTimer() {
    if (this.#timer !== undefined) this.#clearTimer(this.#timer);
    this.#timer = undefined;
  }

  #set(next: SessionState) {
    this.#state = next;
    for (const fn of this.#listeners) fn(next);
  }
}

/** An in-memory store with compare-and-swap semantics (tests, Storybook, the web demo). */
export class MemoryDocumentStore implements DocumentStore {
  #version = 1;
  content: string;
  constructor(content: string) {
    this.content = content;
  }

  get etag(): string {
    return `v${this.#version}`;
  }

  async load() {
    return { content: this.content, etag: this.etag };
  }

  async save(content: string, baseEtag: string): Promise<SaveResult> {
    if (baseEtag !== this.etag)
      return { ok: false, conflict: { content: this.content, etag: this.etag } };
    this.content = content;
    this.#version++;
    return { ok: true, etag: this.etag };
  }

  /** Simulates another writer (the agent). */
  externalWrite(content: string): { content: string; etag: string } {
    this.content = content;
    this.#version++;
    return { content, etag: this.etag };
  }
}
