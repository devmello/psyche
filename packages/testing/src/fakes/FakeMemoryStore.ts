import {
  type ClaimInput,
  type Clock,
  type DailyNoteInput,
  type ForgetResult,
  type MemoryChunk,
  type MemoryClaim,
  type MemoryFile,
  type MemoryHit,
  type MemorySearchOptions,
  type MemoryStore,
  type MemoryWriteOptions,
  PROTECTED_MEMORY_FILES,
  type Provenance,
} from "@psyche/protocol";
import { sha256 } from "../canonical.ts";
import { FakeClock, toIso } from "../clock.ts";
import { createIdGenerator, type IdGenerator } from "../ids.ts";
import { fail } from "./errors.ts";

export interface FakeMemoryStoreOptions {
  clock?: Clock;
  ids?: IdGenerator;
  /** Approval ids accepted for protected writes. Default: any non-empty id. */
  isApproved?: (approvalId: string) => boolean;
  files?: Record<string, string>;
}

function normalizePath(path: string): string {
  if (path.length === 0 || path.startsWith("/") || path.includes("\\") || /^[a-zA-Z]:/.test(path)) {
    return fail("invalid_params", "workspace paths must be relative");
  }
  const parts = path.split("/");
  if (parts.some((p) => p === ".." || p === "." || p === "")) {
    return fail("invalid_params", "path traversal is not allowed");
  }
  return parts.join("/");
}

function terms(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * In-memory workspace + index. Each file is one chunk (whole-file chunks are enough for tests);
 * daily-note appends are one chunk per entry. Search is term-overlap scoring with recency.
 */
export class FakeMemoryStore implements MemoryStore {
  readonly clock: Clock;
  #ids: IdGenerator;
  #isApproved: (id: string) => boolean;
  #files = new Map<string, { content: string; etag: string; provenance: Provenance }>();
  #chunks = new Map<string, MemoryChunk>();
  #claims = new Map<string, MemoryClaim>();

  constructor(options: FakeMemoryStoreOptions = {}) {
    this.clock = options.clock ?? new FakeClock();
    this.#ids = options.ids ?? createIdGenerator();
    this.#isApproved = options.isApproved ?? ((id) => id.length > 0);
    for (const [path, content] of Object.entries(options.files ?? {})) {
      this.#put(normalizePath(path), content, "owner");
    }
  }

  #put(path: string, content: string, provenance: Provenance): MemoryFile {
    const etag = sha256(content).slice(7, 23);
    this.#files.set(path, { content, etag, provenance });
    for (const [id, c] of this.#chunks)
      if (c.source === path && !path.startsWith("memory/")) this.#chunks.delete(id);
    if (!path.startsWith("memory/")) this.#addChunk(path, content, provenance, 1);
    return { path, content, etag };
  }

  #addChunk(source: string, text: string, provenance: Provenance, lineStart: number): MemoryChunk {
    const now = toIso(this.clock.now());
    const lines = Math.max(1, text.split("\n").length);
    const chunk: MemoryChunk = {
      id: this.#ids.next("chk"),
      source,
      lineStart,
      lineEnd: lineStart + lines - 1,
      text,
      provenance,
      claimId: null,
      tokenCount: terms(text).length,
      createdAt: now,
      updatedAt: now,
    };
    this.#chunks.set(chunk.id, chunk);
    return chunk;
  }

  async readFile(path: string): Promise<MemoryFile | undefined> {
    const p = normalizePath(path);
    const f = this.#files.get(p);
    return f === undefined ? undefined : { path: p, content: f.content, etag: f.etag };
  }

  async writeFile(path: string, content: string, options: MemoryWriteOptions): Promise<MemoryFile> {
    const p = normalizePath(path);
    const isProtected = (PROTECTED_MEMORY_FILES as readonly string[]).includes(p);
    if (isProtected && options.provenance === "untrusted") {
      return fail("policy_denied", `untrusted content cannot be written to ${p}`);
    }
    if (
      isProtected &&
      (options.approvalId === undefined || !this.#isApproved(options.approvalId))
    ) {
      return fail("approval_required", `${p} needs a memory_protected_write approval`);
    }
    const current = this.#files.get(p);
    if (options.etag !== undefined && current?.etag !== options.etag) {
      return fail("conflict", `etag mismatch for ${p}`);
    }
    return this.#put(p, content, options.provenance);
  }

  async listFiles(prefix = ""): Promise<string[]> {
    return [...this.#files.keys()].filter((p) => p.startsWith(prefix)).sort();
  }

  async search(query: string, options: MemorySearchOptions = {}): Promise<MemoryHit[]> {
    const q = new Set(terms(query));
    if (q.size === 0) return [];
    const now = this.clock.now();
    const hits: MemoryHit[] = [];
    for (const chunk of this.#chunks.values()) {
      if (options.provenance !== undefined && !options.provenance.includes(chunk.provenance))
        continue;
      if (options.sources !== undefined && !options.sources.some((s) => chunk.source.startsWith(s)))
        continue;
      const t = terms(chunk.text);
      const overlap = t.filter((x) => q.has(x)).length;
      if (overlap === 0) continue;
      const bm25 = overlap / (t.length + 1);
      const ageDays = (now - Date.parse(chunk.updatedAt)) / 86_400_000;
      const score = bm25 * 0.9 + 0.5 ** (ageDays / 30) * 0.1;
      hits.push({ chunk: structuredClone(chunk), score, bm25 });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, options.limit ?? 10);
  }

  async appendDailyNote(input: DailyNoteInput): Promise<{ path: string; chunk: MemoryChunk }> {
    const date = input.date ?? toIso(this.clock.now()).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail("invalid_params", "date must be YYYY-MM-DD");
    const path = `memory/${date}.md`;
    const current = this.#files.get(path);
    const time = toIso(this.clock.now()).slice(11, 16);
    const line = `- ${time} [${input.provenance}] ${input.text.replace(/\n/g, " ")}`;
    const content =
      current === undefined ? `# ${date}\n\n${line}\n` : `${current.content}${line}\n`;
    this.#files.set(path, {
      content,
      etag: sha256(content).slice(7, 23),
      provenance: current?.provenance ?? "agent",
    });
    const lineNo = content.trimEnd().split("\n").length;
    const chunk = this.#addChunk(path, input.text, input.provenance, lineNo);
    return { path, chunk: structuredClone(chunk) };
  }

  async addClaim(input: ClaimInput): Promise<MemoryClaim> {
    if (input.provenance === "owner") {
      const untrustedSource = input.sources.some((s) => {
        const chunk = this.#chunks.get(s);
        if (chunk !== undefined) return chunk.provenance === "untrusted";
        return [...this.#chunks.values()].some(
          (c) => c.source === s && c.provenance === "untrusted",
        );
      });
      if (untrustedSource) {
        return fail("policy_denied", "untrusted content cannot become an owner claim");
      }
    }
    const now = toIso(this.clock.now());
    const claim: MemoryClaim = {
      id: this.#ids.next("clm"),
      text: input.text,
      kind: input.kind,
      provenance: input.provenance,
      confidence: input.confidence,
      sources: [...input.sources],
      supersededBy: null,
      retractedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    if (input.supersedes !== undefined) {
      const old = this.#claims.get(input.supersedes);
      if (old !== undefined) {
        old.supersededBy = claim.id;
        old.updatedAt = now;
      }
    }
    this.#claims.set(claim.id, claim);
    for (const s of input.sources) {
      const chunk = this.#chunks.get(s);
      if (chunk !== undefined) chunk.claimId = claim.id;
    }
    return structuredClone(claim);
  }

  async listClaims(options: { includeRetracted?: boolean } = {}): Promise<MemoryClaim[]> {
    return [...this.#claims.values()]
      .filter((c) => options.includeRetracted === true || c.retractedAt == null)
      .map((c) => structuredClone(c));
  }

  async explain(
    claimId: string,
  ): Promise<{ claim: MemoryClaim; chunks: MemoryChunk[] } | undefined> {
    const claim = this.#claims.get(claimId);
    if (claim === undefined) return undefined;
    const chunks = [...this.#chunks.values()].filter(
      (c) =>
        c.claimId === claimId || claim.sources.includes(c.id) || claim.sources.includes(c.source),
    );
    return { claim: structuredClone(claim), chunks: chunks.map((c) => structuredClone(c)) };
  }

  async forget(subject: string, options: { dryRun?: boolean } = {}): Promise<ForgetResult> {
    const needle = subject.toLowerCase();
    const claims = [...this.#claims.values()].filter(
      (c) => c.retractedAt == null && c.text.toLowerCase().includes(needle),
    );
    const chunkIds = [...this.#chunks.values()]
      .filter(
        (c) => c.text.toLowerCase().includes(needle) || claims.some((cl) => cl.id === c.claimId),
      )
      .map((c) => c.id);
    if (options.dryRun !== true) {
      const now = toIso(this.clock.now());
      for (const c of claims) {
        c.retractedAt = now;
        c.updatedAt = now;
      }
      for (const id of chunkIds) this.#chunks.delete(id);
    }
    return { retractedClaimIds: claims.map((c) => c.id), removedChunkIds: chunkIds };
  }
}
