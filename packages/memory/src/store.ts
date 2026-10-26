import {
  chmodSync,
  type Dirent,
  existsSync,
  type FSWatcher,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AuditLog,
  type ClaimInput,
  type Clock,
  type DailyNoteInput,
  type ForgetResult,
  type LearnedFact,
  type MemoryChunk,
  type MemoryClaim,
  type MemoryFile,
  type MemoryFileInfo,
  type MemoryFlushOptions,
  type MemoryFlushResult,
  type MemoryHit,
  type MemoryJob,
  type MemoryJobKind,
  type MemorySearchOptions,
  type MemoryStore,
  type MemoryWriteOptions,
  type MemoryWriteTrace,
  type ModelMessage,
  type Provenance,
  PsycheError,
} from "@psyche/protocol";
import type Database from "better-sqlite3";
import { monotonicFactory } from "ulid";
import { chunkId, chunkText, estimateTokens, stripComments } from "./chunker.ts";
import { applyDailyWrite, formatEntry, newDailyNote, oneLine, parseDailyNote } from "./daily.ts";
import { blockingKinds } from "./filters.ts";
import { type FlushConfig, flushMemory } from "./flush.ts";
import { type ChunkInput, MemoryIndex } from "./index-db.ts";
import {
  BOOTSTRAP_FILE,
  dailyNoteDate,
  dailyNotePath,
  isGraphCard,
  isIndexed,
  isProtected,
  PERSONA_FILES,
  TEMPLATE_FILES,
  WORKSPACE_DIRS,
} from "./layout.ts";
import {
  addLearned,
  type LearnedFactLine,
  type LearnRefusal,
  learnedFactId,
  normalizeFact,
  refuseFact,
  removeLearned,
} from "./learned.ts";
import { canonicalWorkspacePath, resolveInWorkspace, toWorkspacePath } from "./paths.ts";
import { substituteTokens } from "./persona.ts";
import {
  isProvenance,
  leastTrusted,
  neverPromoted,
  type ProvenanceOrigin,
  type ProvenanceTag,
} from "./provenance.ts";
import {
  type ApprovalCheck,
  denyAllApprovals,
  etagOf,
  localDateTime,
  type MemoryEvent,
  type MemoryEventSink,
  sha256Hex,
  systemTimeZone,
  type WriteActor,
  type WriteContext,
} from "./support.ts";
import { type Embedder, tryLoadSqliteVec, VectorIndex } from "./vector.ts";

/** Repository `templates/` (S20) relative to this file: packages/memory/src → repo root. */
export const DEFAULT_TEMPLATES_DIR = fileURLToPath(new URL("../../../templates/", import.meta.url));

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_ENTRY_CHARS = 2_000;
const MIN_FORGET_CHARS = 3;
/** Files `forget` never edits: instructions and persona, not remembered facts. */
const FORGET_SKIPS = new Set(["SOUL.md", "IDENTITY.md", "AGENTS.md", "BOOTSTRAP.md"]);

export interface SqliteMemoryStoreOptions {
  /** better-sqlite3 connection of the main database, migrated (`@psyche/db` `openDb().sqlite`). */
  sqlite: Database.Database;
  /** `$PSYCHE_HOME/workspace`. Created with mode 0700 when missing. */
  workspaceDir: string;
  clock?: Clock;
  /** IANA zone for daily-note dates and times. Default: the system zone. */
  timeZone?: string;
  newId?: () => string;
  /** Embeddings for vector search; keyword search works without. */
  embedder?: Embedder;
  /** Load sqlite-vec when available (default true); otherwise brute-force cosine. */
  sqliteVec?: boolean;
  /** Confirms `memory_protected_write` approvals for agent writes. Default: deny. */
  approvals?: ApprovalCheck;
  /** Copied on first run. Default: the repository's `templates/`. `null` disables. */
  templatesDir?: string | null;
  /** Values for `{{token}}` placeholders in templates (onboarding answers). */
  templateValues?: Record<string, string>;
  onEvent?: MemoryEventSink;
  /** Records that a retraction happened (never its content). */
  audit?: Pick<AuditLog, "append">;
  /** Utility model for the pre-compaction flush; without it `flush` appends nothing. */
  flush?: FlushConfig;
}

export interface WriteOptions extends MemoryWriteOptions {
  actor?: WriteActor;
  source?: WriteContext["source"];
  /** Origin rendered in daily-note tags for `untrusted` writes. */
  origin?: ProvenanceOrigin;
}

export interface DailyNoteWithOrigin extends DailyNoteInput {
  origin?: ProvenanceOrigin;
}

interface ClaimRow {
  id: string;
  text: string;
  kind: MemoryClaim["kind"];
  provenance: Provenance;
  confidence: number;
  sources: string;
  superseded_by: string | null;
  retracted_at: string | null;
  created_at: string;
  updated_at: string;
}

function toClaim(row: ClaimRow): MemoryClaim {
  return {
    id: row.id,
    text: row.text,
    kind: row.kind,
    provenance: row.provenance,
    confidence: row.confidence,
    sources: JSON.parse(row.sources) as string[],
    supersededBy: row.superseded_by,
    retractedAt: row.retracted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const CLAIM_KINDS = new Set(["fact", "preference", "relationship", "directive", "event"]);

function fail(code: PsycheError["code"], message: string): never {
  throw new PsycheError(code, message);
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * `MemoryStore` over the workspace folder (source of truth) and the index tables in the main
 * database. See README.md for the file formats and provenance rules.
 */
export class SqliteMemoryStore implements MemoryStore {
  readonly root: string;
  readonly clock: Clock;
  readonly timeZone: string;
  readonly #db: Database.Database;
  readonly #index: MemoryIndex;
  readonly #newId: () => string;
  readonly #approvals: ApprovalCheck;
  readonly #templatesDir: string | null;
  readonly #templateValues: Record<string, string>;
  readonly #onEvent: MemoryEventSink | undefined;
  readonly #audit: Pick<AuditLog, "append"> | undefined;
  readonly #flush: FlushConfig | undefined;
  #embedQueue: Promise<unknown> = Promise.resolve();
  #watcher: FSWatcher | undefined;
  #syncTimer: ReturnType<typeof setTimeout> | undefined;
  #rescan: ReturnType<typeof setInterval> | undefined;
  #watching = false;
  readonly #usedApprovals = new Set<string>();
  #syncing: Promise<unknown> = Promise.resolve();

  constructor(options: SqliteMemoryStoreOptions) {
    this.#db = options.sqlite;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.timeZone = options.timeZone ?? systemTimeZone();
    this.#newId = options.newId ?? monotonicFactory();
    this.#approvals = options.approvals ?? denyAllApprovals;
    this.#templatesDir =
      options.templatesDir === undefined ? DEFAULT_TEMPLATES_DIR : options.templatesDir;
    this.#templateValues = options.templateValues ?? {};
    this.#onEvent = options.onEvent;
    this.#audit = options.audit;
    this.#flush = options.flush;
    ensureDir(options.workspaceDir);
    this.root = options.workspaceDir;
    const useVec = options.embedder !== undefined && options.sqliteVec !== false;
    const vector = new VectorIndex(this.#db, useVec && tryLoadSqliteVec(this.#db));
    this.#index = new MemoryIndex({
      sqlite: this.#db,
      now: () => this.#nowIso(),
      vector,
      ...(options.embedder === undefined ? {} : { embedder: options.embedder }),
    });
  }

  /**
   * Creates the workspace on first run (templates, `memory/`, `skills/`) and indexes whatever
   * is on disk. Safe to call on every start.
   */
  async init(): Promise<void> {
    for (const dir of WORKSPACE_DIRS) ensureDir(join(this.root, dir));
    if (this.#state("workspace.initialized") === undefined) this.#copyTemplates();
    await this.sync();
  }

  /** Stops the watcher and waits for background embedding. */
  async close(): Promise<void> {
    this.unwatch();
    await this.idle();
  }

  /** Resolves when queued embedding and sync work has finished. */
  async idle(): Promise<void> {
    await this.#syncing;
    await this.#embedQueue;
  }

  get vectorMode(): "sqlite-vec" | "brute-force" | "off" {
    return this.#index.vectorMode;
  }

  // --- small helpers ----------------------------------------------------------------------------

  #nowIso(): string {
    return new Date(this.clock.now()).toISOString();
  }

  /** Today's date and the current time in the store's zone. */
  now(): { date: string; time: string } {
    return localDateTime(this.clock.now(), this.timeZone);
  }

  /** Sends an event to `onEvent` (used by persona edits and jobs outside this class). */
  publish(event: MemoryEvent): void {
    this.#emit(event);
  }

  #emit(event: MemoryEvent): void {
    try {
      this.#onEvent?.(event);
    } catch {
      // A failing listener must not break memory writes.
    }
  }

  #state(key: string): unknown {
    const row = this.#db.prepare("SELECT value FROM memory_state WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row === undefined ? undefined : JSON.parse(row.value);
  }

  #setState(key: string, value: unknown): void {
    this.#db
      .prepare(
        "INSERT INTO memory_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      )
      .run(key, JSON.stringify(value), this.#nowIso());
  }

  /** Pause flag (Soul & Memory "pause memory"): no flush, remember or tool writes from chats. */
  get paused(): boolean {
    return this.#state("paused") === true;
  }

  setPaused(paused: boolean): boolean {
    this.#setState("paused", paused);
    return paused;
  }

  /** Validated workspace path in its on-disk / canonical spelling (see paths.ts). */
  canonicalPath(path: string): string {
    return canonicalWorkspacePath(this.root, path);
  }

  #abs(path: string): string {
    return resolveInWorkspace(this.root, path);
  }

  #readDisk(path: string): string | undefined {
    const abs = this.#abs(path);
    if (!existsSync(abs)) return undefined;
    const st = statSync(abs);
    if (!st.isFile()) return undefined;
    return readFileSync(abs, "utf8");
  }

  #writeDisk(path: string, content: string): number {
    const abs = this.#abs(path);
    ensureDir(dirname(abs));
    if (existsSync(abs) && !statSync(abs).isFile()) fail("conflict", `${path} is a directory`);
    const tmp = join(dirname(abs), `.${randomSuffix()}.tmp`);
    writeFileSync(tmp, content, { mode: FILE_MODE });
    renameSync(tmp, abs);
    return statSync(abs).mtimeMs;
  }

  #scheduleEmbedding(): void {
    this.#embedQueue = this.#embedQueue.then(() => this.#index.embedPending()).catch(() => 0);
  }

  // --- indexing ---------------------------------------------------------------------------------

  #chunksFor(path: string, content: string, provenance: Provenance): ChunkInput[] {
    if (!isIndexed(path)) return [];
    // Credentials typed into a file outside Psyche never reach search results.
    const clean = (c: ChunkInput) => blockingKinds(c.text, true).length === 0;
    return this.#rawChunks(path, content, provenance).filter(clean);
  }

  #rawChunks(path: string, content: string, provenance: Provenance): ChunkInput[] {
    if (dailyNoteDate(path) !== undefined) {
      return parseDailyNote(content).map((e) => ({
        id: chunkId(path, e.lineStart, e.text),
        source: path,
        lineStart: e.lineStart,
        lineEnd: e.lineEnd,
        text: e.text,
        provenance: e.provenance,
        tokenCount: estimateTokens(e.text),
      }));
    }
    return chunkText(stripComments(content)).map((c) => ({
      id: chunkId(path, c.lineStart, c.text),
      source: path,
      lineStart: c.lineStart,
      lineEnd: c.lineEnd,
      text: c.text,
      provenance,
      tokenCount: c.tokenCount,
    }));
  }

  #indexFile(path: string, content: string, provenance: Provenance, mtimeMs: number | null): void {
    this.#index.upsertFile({
      path,
      sha256: sha256Hex(content),
      bytes: Buffer.byteLength(content),
      provenance,
      mtimeMs,
    });
    this.#index.replaceChunks(path, this.#chunksFor(path, content, provenance));
    this.#scheduleEmbedding();
  }

  #unindexFile(path: string): string[] {
    return this.#index.deleteFile(path);
  }

  /** All regular workspace files, relative, sorted; hidden entries are skipped. */
  #walk(prefix = ""): string[] {
    const out: string[] = [];
    const visit = (dir: string) => {
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        const abs = join(dir, e.name);
        if (e.isDirectory()) visit(abs);
        else if (e.isFile()) out.push(toWorkspacePath(this.root, abs));
      }
    };
    visit(this.root);
    return out.filter((p) => p.startsWith(prefix)).sort();
  }

  /**
   * Reconciles the index with the disk: files changed outside Psyche (Finder, an editor, git)
   * are reindexed as the owner's edits and announced with `source: "external"`; deleted files
   * leave the index.
   */
  async sync(): Promise<{ changed: string[]; removed: string[] }> {
    const run = async () => {
      const changed: string[] = [];
      const removed: string[] = [];
      const onDisk = new Set(this.#walk());
      for (const path of onDisk) {
        const abs = join(this.root, ...path.split("/"));
        const st = statSync(abs);
        const row = this.#index.getFile(path);
        if (row !== undefined && row.mtime_ms === st.mtimeMs && row.bytes === st.size) continue;
        const content = readFileSync(abs, "utf8");
        if (row !== undefined && row.sha256 === sha256Hex(content)) {
          this.#index.upsertFile({ ...row, mtimeMs: st.mtimeMs, provenance: row.provenance });
          continue;
        }
        // The old text is gone from disk; its indexed chunks stand in for it.
        const before =
          row === undefined
            ? undefined
            : this.#index
                .chunksBySource(path)
                .map((c) => c.text)
                .join("\n");
        const provenance = ownerEditProvenance(row?.provenance, before, content);
        this.#indexFile(path, content, provenance, st.mtimeMs);
        changed.push(path);
        this.#emit({
          event: "memory.file.changed",
          payload: { path, etag: etagOf(content), source: "external", provenance },
        });
      }
      for (const row of this.#index.listFiles()) {
        if (onDisk.has(row.path)) continue;
        this.#unindexFile(row.path);
        removed.push(row.path);
        this.#emit({
          event: "memory.file.changed",
          payload: { path: row.path, etag: null, source: "external" },
        });
      }
      return { changed, removed };
    };
    const result = this.#syncing.then(run, run);
    this.#syncing = result.catch(() => undefined);
    return result;
  }

  /**
   * Watches the workspace for edits outside Psyche: `fs.watch` events trigger a debounced
   * `sync`, and a periodic rescan catches what the platform watcher drops (FSEvents can miss
   * changes made just after a watch starts; network and synced folders may send none).
   */
  watch(options: { debounceMs?: number; rescanMs?: number } = {}): void {
    if (this.#watching) return;
    this.#watching = true;
    const debounceMs = options.debounceMs ?? 300;
    const schedule = () => {
      if (this.#syncTimer !== undefined) clearTimeout(this.#syncTimer);
      this.#syncTimer = setTimeout(() => {
        this.#syncTimer = undefined;
        void this.sync().catch(() => undefined);
      }, debounceMs);
    };
    try {
      this.#watcher = watch(this.root, { recursive: true }, schedule);
      this.#watcher.on("error", () => {
        this.#watcher?.close();
        this.#watcher = undefined;
      });
    } catch {
      this.#watcher = undefined; // the rescan still runs
    }
    this.#rescan = setInterval(schedule, options.rescanMs ?? 30_000);
    this.#rescan.unref();
  }

  unwatch(): void {
    if (this.#syncTimer !== undefined) clearTimeout(this.#syncTimer);
    if (this.#rescan !== undefined) clearInterval(this.#rescan);
    this.#syncTimer = undefined;
    this.#rescan = undefined;
    this.#watcher?.close();
    this.#watcher = undefined;
    this.#watching = false;
  }

  // --- templates --------------------------------------------------------------------------------

  #copyTemplates(): void {
    const dir = this.#templatesDir;
    if (dir === null || !existsSync(dir)) return;
    const fresh = !PERSONA_FILES.some((f) => existsSync(join(this.root, f)));
    for (const file of TEMPLATE_FILES) {
      if (file === "BOOTSTRAP.md" && !fresh) continue;
      const src = join(dir, file);
      if (!existsSync(src) || existsSync(join(this.root, file))) continue;
      const text = substituteTokens(readFileSync(src, "utf8"), this.#templateValues);
      const mtime = this.#writeDisk(file, text);
      this.#indexFile(file, text, "system", mtime);
    }
    this.#setState("workspace.initialized", this.#nowIso());
  }

  /** True when `path` still holds exactly the template it was created from. */
  isUnmodifiedTemplate(path: string): boolean {
    const dir = this.#templatesDir;
    if (dir === null || !(TEMPLATE_FILES as readonly string[]).includes(path)) return false;
    const src = join(dir, path);
    const current = this.#readDisk(path);
    if (!existsSync(src) || current === undefined) return false;
    return current === substituteTokens(readFileSync(src, "utf8"), this.#templateValues);
  }

  // --- MemoryStore: files -----------------------------------------------------------------------

  async readFile(path: string): Promise<MemoryFile | undefined> {
    const p = this.canonicalPath(path);
    const content = this.#readDisk(p);
    return content === undefined ? undefined : { path: p, content, etag: etagOf(content) };
  }

  async listFiles(prefix = ""): Promise<string[]> {
    return this.#walk(prefix);
  }

  /** Files with size, etag, protection and provenance for the Soul & Memory sheet. */
  async listFileInfo(prefix = ""): Promise<MemoryFileInfo[]> {
    return this.#walk(prefix).map((path) => {
      const abs = join(this.root, ...path.split("/"));
      const st = statSync(abs);
      const content = readFileSync(abs, "utf8");
      const row = this.#index.getFile(path);
      return {
        path,
        bytes: st.size,
        etag: etagOf(content),
        protected: isProtected(path),
        provenance: row?.provenance ?? "owner",
        updatedAt: new Date(st.mtimeMs).toISOString(),
      };
    });
  }

  /** `file`, `dir` or `undefined` for a workspace path (`""` is the workspace root). */
  entryKind(path: string): "file" | "dir" | undefined {
    const abs = path === "" ? this.root : this.#abs(this.canonicalPath(path));
    if (!existsSync(abs)) return undefined;
    const st = statSync(abs);
    return st.isDirectory() ? "dir" : st.isFile() ? "file" : undefined;
  }

  /** Files and directories under `dir` up to `depth` levels, hidden entries skipped. */
  entries(dir: string, depth = 2): { path: string; kind: "file" | "dir"; bytes: number }[] {
    const base = dir === "" ? this.root : this.#abs(this.canonicalPath(dir));
    const out: { path: string; kind: "file" | "dir"; bytes: number }[] = [];
    const visit = (abs: string, level: number) => {
      if (level > depth) return;
      for (const e of readdirSync(abs, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        if (e.name.startsWith(".")) continue;
        const child = join(abs, e.name);
        const path = toWorkspacePath(this.root, child);
        if (e.isDirectory()) {
          out.push({ path, kind: "dir", bytes: 0 });
          visit(child, level + 1);
        } else if (e.isFile()) {
          out.push({ path, kind: "file", bytes: statSync(child).size });
        }
      }
    };
    visit(base, 1);
    return out;
  }

  /**
   * Least-trusted provenance of a file's content: the file's own class combined with its
   * entries (a daily note with one `untrusted` entry is `untrusted` to read).
   */
  contentProvenance(path: string): Provenance {
    const p = this.canonicalPath(path);
    const row = this.#index.getFile(p);
    let prov: Provenance = row?.provenance ?? "owner";
    for (const c of this.#index.chunksBySource(p)) prov = leastTrusted(prov, c.provenance);
    return prov;
  }

  /** The agent's write (contract): protected files need an approval. */
  async writeFile(path: string, content: string, options: WriteOptions): Promise<MemoryFile> {
    return this.write(path, content, options);
  }

  /**
   * Feature #509: writes facts learned from the owner's own words to USER.md's Learned section,
   * as this package's job (the one writer). Each proposal is refused when empty, too long,
   * sensitive (secrets and cards always; government ids, financial accounts and health), worded
   * like an instruction, or already known (USER.md or a live claim). Returns what was written.
   */
  async learnUserFacts(
    proposals: readonly { text: string; kind: LearnedFact["kind"]; lessonId?: string }[],
    context: {
      threadId: string;
      /**
       * Teaching loop (docs/agent/teaching-loop-2026.md §4): the learned fact a correction
       * replaces. Its line goes first, so the corrected fact is not refused as a duplicate.
       */
      replaces?: string;
    },
  ): Promise<{ written: LearnedFactLine[]; refused: { text: string; reason: LearnRefusal }[] }> {
    const original = (await this.readFile("USER.md"))?.content ?? "";
    const current =
      context.replaces === undefined
        ? original
        : (removeLearned(original, context.replaces) ?? original);
    const claims = (await this.listClaims()).map((c) => normalizeFact(c.text));
    const known = [
      ...current
        .split("\n")
        .map((l) => normalizeFact(l.replace(/^- \d{4}-\d{2}-\d{2} \[[^\]]*\] /, ""))),
      ...claims,
    ].filter((k) => k !== "");
    const written: LearnedFactLine[] = [];
    const refused: { text: string; reason: LearnRefusal }[] = [];
    const date = this.now().date;
    for (const p of proposals) {
      const reason = refuseFact(p.text, known);
      if (reason !== undefined) {
        refused.push({ text: p.text, reason });
        continue;
      }
      const text = p.text.replace(/\s+/g, " ").trim();
      written.push({
        factId: learnedFactId(text, context.threadId),
        text,
        kind: p.kind,
        date,
        threadId: context.threadId,
        ...(p.lessonId === undefined ? {} : { lessonId: p.lessonId }),
      });
      known.push(normalizeFact(text));
    }
    if (written.length > 0) {
      await this.write("USER.md", addLearned(current, written), {
        provenance: "owner",
        actor: "job",
        source: "job",
      });
    }
    return { written, refused };
  }

  /** Undo for one learned fact (#509): removes its line; false when it is already gone. */
  async forgetLearned(factId: string): Promise<boolean> {
    const current = (await this.readFile("USER.md"))?.content;
    if (current === undefined) return false;
    const next = removeLearned(current, factId);
    if (next === undefined) return false;
    await this.write("USER.md", next, { provenance: "owner", actor: "job", source: "job" });
    return true;
  }

  /** The owner's own write from a paired device: no approval, owner provenance. */
  async writeFileAsOwner(path: string, content: string, options: { etag?: string } = {}) {
    return this.write(path, content, {
      provenance: "owner",
      actor: "owner",
      source: "api",
      ...(options.etag === undefined ? {} : { etag: options.etag }),
    });
  }

  async #checkProtected(
    path: string,
    provenance: Provenance,
    actor: WriteActor,
    approvalId: string | undefined,
    request: Parameters<ApprovalCheck>[1],
  ): Promise<void> {
    if (isGraphCard(path) && actor === "agent") {
      // Cards are written by the graph and edited by the owner; the agent uses the graph tools.
      fail("policy_denied", "people and project cards are edited in Psyche or by you");
    }
    if (path === BOOTSTRAP_FILE && actor === "agent" && request.operation !== "delete") {
      // Injected into every private session while it exists: the agent may only delete it.
      fail("policy_denied", "BOOTSTRAP.md can only be deleted by the agent");
    }
    if (!isProtected(path)) return;
    if (provenance === "untrusted") {
      fail("policy_denied", `untrusted content cannot be written to ${path}`);
    }
    if (actor !== "agent") return;
    if (approvalId === undefined || approvalId.length === 0) {
      fail("approval_required", `${path} needs a memory_protected_write approval`);
    }
    // Approvals are single-use: one approved call, one change.
    if (this.#usedApprovals.has(approvalId) || !(await this.#approvals(approvalId, request))) {
      fail("approval_required", `${path} needs a memory_protected_write approval`);
    }
    this.#usedApprovals.add(approvalId);
  }

  /** Every write goes through here; see README "Write rules". */
  async write(path: string, content: string, options: WriteOptions): Promise<MemoryFile> {
    const p = this.canonicalPath(path);
    const actor = options.actor ?? "agent";
    const provenance = options.provenance;
    if (!isProvenance(provenance)) fail("invalid_params", "unknown provenance");
    await this.#checkProtected(p, provenance, actor, options.approvalId, {
      path: p,
      operation: "write",
      contentSha256: sha256Hex(content),
    });
    const current = this.#readDisk(p);
    if (options.etag !== undefined && (current === undefined || etagOf(current) !== options.etag)) {
      fail("conflict", `etag mismatch for ${p}`);
    }
    let next = content;
    if (dailyNoteDate(p) !== undefined && actor !== "job") {
      const tag: ProvenanceTag = {
        provenance,
        ...(options.origin === undefined ? {} : { origin: options.origin }),
      };
      next = applyDailyWrite(current, content, tag, this.now().time);
    }
    if (actor !== "job") this.#refuseSensitive(current, next);

    const row = this.#index.getFile(p);
    let fileProvenance: Provenance = provenance;
    if (actor === "agent" && current !== undefined) {
      fileProvenance = leastTrusted(row?.provenance ?? "agent", provenance);
    } else if (actor === "owner") {
      fileProvenance = ownerEditProvenance(row?.provenance, current, next);
    }
    const mtime = this.#writeDisk(p, next);
    this.#indexFile(p, next, fileProvenance, mtime);
    const etag = etagOf(next);
    this.#emit({
      event: "memory.file.changed",
      payload: {
        path: p,
        etag,
        source: options.source ?? (actor === "job" ? "job" : actor === "owner" ? "api" : "tool"),
        provenance: fileProvenance,
        ...traced(options.trace),
      },
    });
    return { path: p, content: next, etag };
  }

  /** Credentials and card numbers never enter the workspace (security §8, shared rules). */
  #refuseSensitive(previous: string | undefined, next: string): void {
    const before = new Set((previous ?? "").split("\n"));
    const added = next
      .split("\n")
      .filter((l) => !before.has(l))
      .join("\n");
    // Whole-content check too, so a secret split across lines is caught; content that already
    // held one (an edit made outside Psyche) can still be edited.
    const whole =
      blockingKinds(next, true).length > 0 &&
      (previous === undefined || blockingKinds(previous, true).length === 0);
    if (whole || blockingKinds(added, true).length > 0) {
      fail(
        "policy_denied",
        "content looks like a credential or card number; keep it in the vault and refer to it as {{cred:slug}}",
      );
    }
  }

  /** Deletes a file or a directory of files (memory tool `delete`). */
  async delete(path: string, options: WriteOptions): Promise<string[]> {
    const p = this.canonicalPath(path);
    const actor = options.actor ?? "agent";
    const abs = this.#abs(p);
    if (!existsSync(abs)) fail("not_found", `${p} does not exist`);
    const files = statSync(abs).isDirectory() ? this.#walk(`${p}/`) : [p];
    for (const f of files) {
      if (dailyNoteDate(f) !== undefined && actor === "agent") {
        fail("policy_denied", "daily notes are append-only");
      }
      await this.#checkProtected(f, options.provenance, actor, options.approvalId, {
        path: f,
        operation: "delete",
      });
    }
    // Only the listed (non-hidden, checked) files go; directories are removed once empty.
    for (const f of files) rmSync(this.#abs(f), { force: true });
    if (statSync(abs, { throwIfNoEntry: false })?.isDirectory() === true) removeEmptyDirs(abs);
    for (const f of files) {
      this.#unindexFile(f);
      this.#emit({
        event: "memory.file.changed",
        payload: {
          path: f,
          etag: null,
          source: options.source ?? "tool",
          ...traced(options.trace),
        },
      });
    }
    return files;
  }

  /** Renames a file (memory tool `rename`); the destination must not exist. */
  async rename(from: string, to: string, options: WriteOptions): Promise<MemoryFile> {
    const src = this.canonicalPath(from);
    const dst = this.canonicalPath(to);
    const actor = options.actor ?? "agent";
    const content = this.#readDisk(src);
    if (content === undefined) fail("not_found", `${src} does not exist`);
    if (existsSync(this.#abs(dst))) fail("conflict", `${dst} already exists`);
    if (actor === "agent" && (dailyNoteDate(src) ?? dailyNoteDate(dst)) !== undefined) {
      fail("policy_denied", "daily notes are append-only");
    }
    // The moved text keeps its own provenance: renaming cannot launder untrusted content.
    const provenance =
      actor === "owner"
        ? options.provenance
        : leastTrusted(this.contentProvenance(src), options.provenance);
    const request = {
      operation: "rename" as const,
      newPath: dst,
      contentSha256: sha256Hex(content),
    };
    if (isProtected(src) || isProtected(dst)) {
      const p = isProtected(dst) ? dst : src;
      await this.#checkProtected(p, provenance, actor, options.approvalId, { ...request, path: p });
    }
    if (isGraphCard(src) || isGraphCard(dst)) {
      const p = isGraphCard(dst) ? dst : src;
      await this.#checkProtected(p, provenance, actor, undefined, { ...request, path: p });
    }
    if (dst === BOOTSTRAP_FILE || src === BOOTSTRAP_FILE) {
      await this.#checkProtected(BOOTSTRAP_FILE, provenance, actor, undefined, {
        ...request,
        path: BOOTSTRAP_FILE,
      });
    }
    ensureDir(dirname(this.#abs(dst)));
    renameSync(this.#abs(src), this.#abs(dst));
    this.#unindexFile(src);
    this.#indexFile(dst, content, provenance, statSync(this.#abs(dst)).mtimeMs);
    const source = options.source ?? "tool";
    const trace = traced(options.trace);
    this.#emit({
      event: "memory.file.changed",
      payload: { path: src, etag: null, source, ...trace },
    });
    this.#emit({
      event: "memory.file.changed",
      payload: { path: dst, etag: etagOf(content), source, provenance, ...trace },
    });
    return { path: dst, content, etag: etagOf(content) };
  }

  // --- MemoryStore: daily notes and search ------------------------------------------------------

  async search(query: string, options: MemorySearchOptions = {}): Promise<MemoryHit[]> {
    const sources = options.sources?.map((s) => s.replace(/^\/+/, ""));
    return this.#index.search(
      query,
      {
        ...(options.limit === undefined ? {} : { limit: options.limit }),
        ...(options.provenance === undefined ? {} : { provenance: options.provenance }),
        ...(sources === undefined ? {} : { sources }),
      },
      this.clock.now(),
    );
  }

  async appendDailyNote(input: DailyNoteWithOrigin): Promise<{ path: string; chunk: MemoryChunk }> {
    if (!isProvenance(input.provenance)) fail("invalid_params", "unknown provenance");
    const now = this.now();
    const date = input.date ?? now.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) {
      fail("invalid_params", "date must be YYYY-MM-DD");
    }
    const text = oneLine(input.text);
    if (text.length === 0) fail("invalid_params", "daily-note text is empty");
    if (text.length > MAX_ENTRY_CHARS) fail("invalid_params", "daily-note entry is too long");
    if (blockingKinds(text, true).length > 0) {
      fail(
        "policy_denied",
        "content looks like a credential or card number; keep it in the vault and refer to it as {{cred:slug}}",
      );
    }
    const path = dailyNotePath(date);
    const current = this.#readDisk(path) ?? newDailyNote(date);
    const base = current.length === 0 || current.endsWith("\n") ? current : `${current}\n`;
    const tag: ProvenanceTag = {
      provenance: input.provenance,
      ...(input.origin === undefined ? {} : { origin: input.origin }),
    };
    const line = formatEntry(now.time, tag, text);
    const next = `${base}${line}\n`;
    const lineNo = next.trimEnd().split("\n").length;
    const row = this.#index.getFile(path);
    const fileProvenance = leastTrusted(row?.provenance ?? input.provenance, input.provenance);
    const mtime = this.#writeDisk(path, next);
    this.#indexFile(path, next, fileProvenance, mtime);
    this.#emit({
      event: "memory.file.changed",
      payload: {
        path,
        etag: etagOf(next),
        // A daily-note append by a tool call names its run (run trace §4.2).
        source: input.trace === undefined ? "job" : "tool",
        provenance: fileProvenance,
        ...traced(input.trace),
      },
    });
    const chunk = this.#index.getChunk(chunkId(path, lineNo, text));
    if (chunk === undefined) fail("internal", "daily-note entry was not indexed");
    return { path, chunk };
  }

  // --- MemoryStore: claims ----------------------------------------------------------------------

  #claimRow(id: string): ClaimRow | undefined {
    return this.#db.prepare("SELECT * FROM memory_claims WHERE id = ?").get(id) as
      | ClaimRow
      | undefined;
  }

  getClaim(id: string): MemoryClaim | undefined {
    const row = this.#claimRow(id);
    return row === undefined ? undefined : toClaim(row);
  }

  /**
   * Provenance classes a claim source refers to (chunk id, workspace path or `claim:<id>`), or
   * `undefined` when it resolves to nothing. A claim's own provenance already carries the least
   * trust of its sources (see `addClaim`), so `claim:` references need no recursion.
   */
  #sourceProvenances(source: string): Provenance[] | undefined {
    const chunk = this.#index.getChunk(source);
    if (chunk !== undefined) return [chunk.provenance];
    if (source.startsWith("claim:")) {
      const claim = this.#claimRow(source.slice(6));
      return claim === undefined ? undefined : [claim.provenance];
    }
    const file = this.#index.getFile(source);
    if (file !== undefined) {
      return [file.provenance, ...this.#index.chunksBySource(source).map((c) => c.provenance)];
    }
    return undefined;
  }

  async addClaim(input: ClaimInput): Promise<MemoryClaim> {
    if (!isProvenance(input.provenance)) fail("invalid_params", "unknown provenance");
    if (!CLAIM_KINDS.has(input.kind)) fail("invalid_params", "unknown claim kind");
    const text = oneLine(input.text);
    if (text.length === 0) fail("invalid_params", "claim text is empty");
    if (!(input.confidence >= 0 && input.confidence <= 1)) {
      fail("invalid_params", "confidence must be between 0 and 1");
    }
    if (blockingKinds(text, true).length > 0) {
      fail("policy_denied", "content looks like a credential or card number");
    }
    const sources = [...new Set(input.sources)];
    const resolved = sources.map((s) => this.#sourceProvenances(s));
    const derived = resolved.flatMap((r) => r ?? []);
    let provenance: Provenance = input.provenance;
    if (input.provenance === "owner") {
      // Fail closed: a source that no longer resolves (lines moved, file gone) proves nothing.
      if (resolved.some((r) => r === undefined)) {
        fail("policy_denied", "an owner claim needs sources that still exist");
      }
      if (derived.some(neverPromoted)) {
        fail("policy_denied", "untrusted or system content cannot become an owner claim");
      }
    } else {
      // Other claims inherit the least trust of their sources, so later confirmation can tell.
      for (const p of derived) if (neverPromoted(p)) provenance = leastTrusted(provenance, p);
    }
    if (input.supersedes !== undefined && this.#claimRow(input.supersedes) === undefined) {
      fail("not_found", `claim ${input.supersedes} does not exist`);
    }
    const now = this.#nowIso();
    const id = this.#newId();
    this.#db.transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO memory_claims (id, text, kind, provenance, confidence, sources, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, text, input.kind, provenance, input.confidence, JSON.stringify(sources), now, now);
      if (input.supersedes !== undefined) {
        this.#db
          .prepare("UPDATE memory_claims SET superseded_by = ?, updated_at = ? WHERE id = ?")
          .run(id, now, input.supersedes);
      }
      for (const s of sources)
        if (this.#index.getChunk(s) !== undefined) this.#index.setChunkClaim(s, id);
    })();
    return toClaim(this.#claimRow(id) as ClaimRow);
  }

  async listClaims(options: { includeRetracted?: boolean } = {}): Promise<MemoryClaim[]> {
    const rows = this.#db
      .prepare(
        `SELECT * FROM memory_claims ${options.includeRetracted === true ? "" : "WHERE retracted_at IS NULL"} ORDER BY created_at, id`,
      )
      .all() as ClaimRow[];
    return rows.map(toClaim);
  }

  async explain(
    claimId: string,
  ): Promise<{ claim: MemoryClaim; chunks: MemoryChunk[] } | undefined> {
    const claim = this.getClaim(claimId);
    if (claim === undefined) return undefined;
    const seen = new Map<string, MemoryChunk>();
    for (const c of this.#index.allChunks()) {
      if (
        c.claimId === claimId ||
        claim.sources.includes(c.id) ||
        claim.sources.includes(c.source)
      ) {
        seen.set(c.id, c);
      }
    }
    return { claim, chunks: [...seen.values()] };
  }

  /**
   * Retracts claims that mention `subject` (as a whole word or phrase, case-insensitive),
   * deletes the daily-note entries and file lines that mention it (and entries linked to
   * retracted claims), rebuilds the index for those files, and appends a retraction line that
   * names no content (security §8 "Forget / retraction"). Retracted claims keep their id and
   * dates but lose their text and sources. When the agent asks (`actor: "agent"`), a change to
   * a protected file needs an approved `memory_protected_write`.
   */
  async forget(
    subject: string,
    options: { dryRun?: boolean; actor?: WriteActor; approvalId?: string } = {},
  ): Promise<ForgetResult> {
    const phrase = oneLine(subject);
    if (phrase.length < MIN_FORGET_CHARS) {
      fail("invalid_params", `forget needs at least ${MIN_FORGET_CHARS} characters`);
    }
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu");
    const mentions = (text: string) => pattern.test(text);

    const claims = (await this.listClaims()).filter((c) => mentions(c.text));
    const claimIds = new Set(claims.map((c) => c.id));
    const linked = (c: MemoryChunk) => typeof c.claimId === "string" && claimIds.has(c.claimId);
    const chunks = this.#index.allChunks().filter((c) => mentions(c.text) || linked(c));

    // Lines to drop per file.
    const edits = new Map<string, string>();
    for (const path of this.#walk()) {
      if (FORGET_SKIPS.has(path) || path.startsWith("skills/") || !path.endsWith(".md")) continue;
      const content = this.#readDisk(path);
      if (content === undefined) continue;
      const lines = content.split("\n");
      const drop = new Set<number>();
      if (dailyNoteDate(path) !== undefined) {
        const starts = new Set(
          chunks.filter((c) => c.source === path && linked(c)).map((c) => c.lineStart),
        );
        for (const e of parseDailyNote(content)) {
          if (mentions(e.text) || starts.has(e.lineStart)) {
            for (let n = e.lineStart; n <= e.lineEnd; n++) drop.add(n);
          }
        }
      } else {
        lines.forEach((l, i) => {
          if (mentions(l)) drop.add(i + 1);
        });
      }
      if (drop.size > 0) edits.set(path, lines.filter((_, i) => !drop.has(i + 1)).join("\n"));
    }
    const result: ForgetResult = {
      retractedClaimIds: claims.map((c) => c.id),
      removedChunkIds: chunks.map((c) => c.id),
      files: [...edits.keys()],
    };
    if (options.dryRun === true) return result;

    if (options.actor === "agent") {
      const touched = [...edits.keys()].filter(isProtected);
      if (touched.length > 1) {
        fail(
          "approval_required",
          `forget would change ${touched.join(", ")}; ask the owner to do it in Soul & Memory`,
        );
      }
      for (const path of touched) {
        await this.#checkProtected(path, "agent", "agent", options.approvalId, {
          path,
          operation: "write",
          contentSha256: sha256Hex(edits.get(path) ?? ""),
        });
      }
    }
    // Files first: if a write fails, no claim has been retracted yet.
    for (const [path, content] of edits) {
      // Removing lines adds nothing: the file keeps its provenance.
      const kept = this.#index.getFile(path)?.provenance ?? "owner";
      const provenance = kept === "untrusted" && isProtected(path) ? "agent" : kept;
      await this.write(path, content, { provenance, actor: "job", source: "job" });
    }
    const now = this.#nowIso();
    this.#db.transaction(() => {
      const retract = this.#db.prepare(
        "UPDATE memory_claims SET text = '[retracted]', sources = '[]', retracted_at = ?, updated_at = ? WHERE id = ?",
      );
      for (const c of claims) retract.run(now, now, c.id);
    })();
    // Chunks of files forget does not edit (persona files) leave the index until they change.
    this.#index.deleteChunks(
      chunks.map((c) => c.id).filter((id) => this.#index.getChunk(id) !== undefined),
    );
    if (claims.length + chunks.length + edits.size > 0) {
      await this.appendDailyNote({
        text: `Retracted ${claims.length} claim(s) and removed ${chunks.length} memory chunk(s) from ${edits.size} file(s) at the owner's request.`,
        provenance: "system",
      });
      await this.#audit
        ?.append({
          kind: "memory.retraction",
          actor: { type: options.actor === "agent" ? "agent" : "system" },
          data: { claims: claims.length, chunks: chunks.length, files: edits.size },
        })
        .catch(() => undefined);
    }
    return result;
  }

  /**
   * Pre-compaction flush (contract `MemoryStore.flush`): durable facts from a private copy of the
   * conversation go to today's daily note only. Tainted turns are noted as `untrusted`.
   */
  async flush(
    threadId: string,
    privateCopy: readonly ModelMessage[],
    options: MemoryFlushOptions & { incognito?: boolean } = {},
  ): Promise<MemoryFlushResult> {
    if (this.#flush === undefined) {
      this.finishJob(this.startJob("flush"), "skipped", "no flush model configured");
      return { appended: 0 };
    }
    return flushMemory(this, this.#flush, threadId, privateCopy, options);
  }

  /**
   * Records that `memory_search` returned these chunks for a query (only a hash of the
   * normalized query is kept). Dreaming uses recall counts to promote agent inferences.
   */
  recordRecall(chunkIds: readonly string[], query: string): void {
    if (chunkIds.length === 0) return;
    const hash = sha256Hex(oneLine(query).toLowerCase());
    const now = this.#nowIso();
    const insert = this.#db.prepare(
      "INSERT INTO memory_recalls (chunk_id, query_hash, created_at) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM memory_chunks WHERE id = ?)",
    );
    this.#db.transaction(() => {
      for (const id of new Set(chunkIds)) insert.run(id, hash, now, id);
    })();
  }

  /** Recall count and distinct queries per chunk since `sinceIso` (all time by default). */
  recallStats(sinceIso = ""): Map<string, { count: number; queries: number }> {
    const rows = this.#db
      .prepare(
        "SELECT chunk_id AS id, count(*) AS count, count(DISTINCT query_hash) AS queries FROM memory_recalls WHERE created_at >= ? GROUP BY chunk_id",
      )
      .all(sinceIso) as { id: string; count: number; queries: number }[];
    return new Map(rows.map((r) => [r.id, { count: r.count, queries: r.queries }]));
  }

  /** All indexed chunks (dreaming reads the daily-note entries). */
  allChunks(): MemoryChunk[] {
    return this.#index.allChunks();
  }

  /** JSON state of a memory job (e.g. the dreaming ledger). */
  getState<T>(key: string): T | undefined {
    return this.#state(key) as T | undefined;
  }

  setState(key: string, value: unknown): void {
    this.#setState(key, value);
  }

  /** Marks a claim superseded by another (dreaming, directive changes). */
  supersede(claimId: string, byClaimId: string): void {
    this.#db
      .prepare("UPDATE memory_claims SET superseded_by = ?, updated_at = ? WHERE id = ?")
      .run(byClaimId, this.#nowIso(), claimId);
  }

  // --- jobs, status, reset ----------------------------------------------------------------------

  startJob(kind: MemoryJobKind): MemoryJob {
    const job: MemoryJob = {
      id: this.#newId(),
      kind,
      status: "running",
      startedAt: this.#nowIso(),
      endedAt: null,
      summary: null,
    };
    this.#db
      .prepare(
        "INSERT INTO memory_jobs (id, kind, status, started_at, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(job.id, kind, job.status, job.startedAt, job.startedAt);
    this.#emit({ event: "memory.job.updated", payload: { job } });
    return job;
  }

  finishJob(job: MemoryJob, status: "ok" | "failed" | "skipped", summary: string): MemoryJob {
    const done: MemoryJob = { ...job, status, endedAt: this.#nowIso(), summary };
    this.#db
      .prepare("UPDATE memory_jobs SET status = ?, ended_at = ?, summary = ? WHERE id = ?")
      .run(status, done.endedAt, summary, job.id);
    this.#emit({ event: "memory.job.updated", payload: { job: done } });
    return done;
  }

  listJobs(limit = 10): MemoryJob[] {
    return (
      this.#db
        .prepare("SELECT * FROM memory_jobs ORDER BY started_at DESC, id DESC LIMIT ?")
        .all(limit) as {
        id: string;
        kind: MemoryJobKind;
        status: MemoryJob["status"];
        started_at: string;
        ended_at: string | null;
        summary: string | null;
      }[]
    ).map((r) => ({
      id: r.id,
      kind: r.kind,
      status: r.status,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      summary: r.summary,
    }));
  }

  status() {
    const { files, chunks } = this.#index.counts();
    const claims = (
      this.#db
        .prepare("SELECT count(*) AS n FROM memory_claims WHERE retracted_at IS NULL")
        .get() as {
        n: number;
      }
    ).n;
    return {
      paused: this.paused,
      vectorSearch: this.vectorMode,
      files,
      chunks,
      claims,
      lastJobs: this.listJobs(5),
    };
  }

  /**
   * Deletes every workspace file (hidden entries such as `.git` are kept), chunk and claim and
   * re-creates the templates. The UI asks for a typed confirmation before calling this.
   */
  async reset(options: { dryRun?: boolean } = {}) {
    const files = this.#walk();
    const { chunks } = this.#index.counts();
    const claims = (
      this.#db.prepare("SELECT count(*) AS n FROM memory_claims").get() as { n: number }
    ).n;
    const dryRun = options.dryRun === true;
    if (!dryRun) {
      await this.idle();
      for (const entry of readdirSync(this.root)) {
        if (entry.startsWith(".")) continue;
        rmSync(join(this.root, entry), { recursive: true, force: true });
      }
      this.#db.transaction(() => {
        this.#index.clear();
        this.#db.exec("UPDATE memory_claims SET superseded_by = NULL; DELETE FROM memory_claims;");
        this.#db.prepare("DELETE FROM memory_state WHERE key = 'workspace.initialized'").run();
      })();
      for (const f of files) {
        this.#emit({
          event: "memory.file.changed",
          payload: { path: f, etag: null, source: "api" },
        });
      }
      await this.init();
    }
    return { files, chunks, claims, dryRun };
  }
}

/** Removes `dir` and its subdirectories if they hold nothing (hidden files keep them). */
function removeEmptyDirs(dir: string): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() && !e.isSymbolicLink()) removeEmptyDirs(join(dir, e.name));
  }
  try {
    rmdirSync(dir);
  } catch {
    // not empty (hidden entries): leave it
  }
}

/**
 * Provenance after the owner edits a file (API or outside Psyche). The owner endorses what
 * they saved, except that untrusted text the edit kept stays untrusted: only a rewrite that
 * keeps none of the old lines makes an untrusted file the owner's.
 */
export function ownerEditProvenance(
  previous: Provenance | undefined,
  before: string | undefined,
  after: string,
): Provenance {
  if (previous !== "untrusted" || before === undefined) return "owner";
  const old = new Set(before.split("\n").filter((l) => l.trim().length > 0));
  return after.split("\n").some((l) => old.has(l)) ? "untrusted" : "owner";
}

function ensureDir(dir: string): void {
  if (existsSync(dir)) return;
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  chmodSync(dir, DIR_MODE);
}

/** The run and tool call behind a write, for `memory.file.changed` (run trace §4.2). */
function traced(trace: MemoryWriteTrace | undefined): { runId?: string; toolCallId?: string } {
  return trace === undefined ? {} : { runId: trace.runId, toolCallId: trace.toolCallId };
}
