import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProvenanceOut, TaintSource } from "@psyche/protocol";
import { WORKSPACE_PATH } from "./limits.ts";

/**
 * File-level provenance for `/workspace` (S23 design-07). Taint is turn-scoped, so untrusted
 * content only has to pass through a file to come back as trusted in a later turn. The runner
 * therefore records the provenance of every write it performs (file API) or observes
 * (`filesChanged` after an exec) and answers it on every read. A file it has no record of, or
 * whose content no longer matches the recorded write, is `untrusted`: the write was not seen,
 * so nothing vouches for it. `exec` output is `untrusted` while the workspace holds any
 * untrusted file (a command may have copied it) or when the calling turn is tainted.
 *
 * The index lives on the host, never in the volume: everything in `/workspace` is writable by
 * the agent as UID 1000, so a sidecar there could be edited away by the same payload.
 */

export interface ProvenanceRecord {
  /** Workspace-relative path, as the file API and `filesChanged` report it. */
  path: string;
  provenance: ProvenanceOut;
  sources: TaintSource[];
  /** sha256 of the bytes the file API wrote; `null` when only the write was observed (exec, edit). */
  sha256: string | null;
  /** ISO-8601. */
  recordedAt: string;
}

/** What a read, stat or listing reports for a file. */
export interface FileProvenance {
  provenance: ProvenanceOut;
  /** Empty for trusted files. */
  sources: TaintSource[];
}

/** Provenance a caller attaches to a write; absent means `untrusted` (the safe default). */
export interface WriteProvenance {
  provenance?: ProvenanceOut;
  sources?: readonly TaintSource[];
}

/** Persists one index per scope outside the container. */
export interface ProvenanceStore {
  load(scopeKey: string): Promise<ProvenanceRecord[]>;
  save(scopeKey: string, records: ProvenanceRecord[]): Promise<void>;
  remove(scopeKey: string): Promise<void>;
}

/** Records per scope; above it the oldest records go, trusted ones first (see `overflow`). */
export const PROVENANCE_RECORDS_CAP = 20_000;
/** Sources kept per record and reported per file. */
const SOURCES_CAP = 16;

/** The default store: records live as long as the process. Restarting loses them, which only makes files read as untrusted. */
export class MemoryProvenanceStore implements ProvenanceStore {
  readonly #byScope = new Map<string, ProvenanceRecord[]>();

  async load(scopeKey: string): Promise<ProvenanceRecord[]> {
    return structuredClone(this.#byScope.get(scopeKey) ?? []);
  }

  async save(scopeKey: string, records: ProvenanceRecord[]): Promise<void> {
    this.#byScope.set(scopeKey, structuredClone(records));
  }

  async remove(scopeKey: string): Promise<void> {
    this.#byScope.delete(scopeKey);
  }
}

/**
 * One JSON file per scope under `dir` (for example `$PSYCHE_HOME/sandbox/provenance`), written
 * atomically. The file name is a hash of the scope key, so scope ids never reach the file
 * system.
 */
export class FileProvenanceStore implements ProvenanceStore {
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
  }

  #file(scopeKey: string): string {
    const name = createHash("sha256").update(scopeKey).digest("hex").slice(0, 32);
    return join(this.#dir, `${name}.json`);
  }

  async load(scopeKey: string): Promise<ProvenanceRecord[]> {
    let text: string;
    try {
      text = await readFile(this.#file(scopeKey), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const parsed = JSON.parse(text) as { scope?: unknown; records?: unknown };
    if (parsed.scope !== scopeKey || !Array.isArray(parsed.records)) return [];
    return parsed.records.filter(isRecord);
  }

  async save(scopeKey: string, records: ProvenanceRecord[]): Promise<void> {
    await mkdir(this.#dir, { recursive: true, mode: 0o700 });
    const file = this.#file(scopeKey);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify({ scope: scopeKey, records }), { mode: 0o600 });
    await rename(tmp, file);
  }

  async remove(scopeKey: string): Promise<void> {
    await rm(this.#file(scopeKey), { force: true });
  }
}

function isRecord(value: unknown): value is ProvenanceRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.path === "string" &&
    (r.provenance === "trusted" || r.provenance === "untrusted") &&
    Array.isArray(r.sources) &&
    (r.sha256 === null || typeof r.sha256 === "string") &&
    typeof r.recordedAt === "string"
  );
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The source a read reports for a file nobody vouches for. */
function unknownSource(path: string): TaintSource {
  return { sourceKind: "workspace", origin: `${WORKSPACE_PATH}/${path}` };
}

function dedupe(sources: readonly TaintSource[]): TaintSource[] {
  const seen = new Set<string>();
  const out: TaintSource[] = [];
  for (const s of sources) {
    const key = JSON.stringify([s.sourceKind, s.origin ?? "", s.sender ?? "", s.toolCallId ?? ""]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...s });
    if (out.length >= SOURCES_CAP) break;
  }
  return out;
}

/** The in-memory index of one scope's workspace, saved through a `ProvenanceStore` after every change. */
export class WorkspaceProvenance {
  readonly #records = new Map<string, ProvenanceRecord>();
  readonly #save: (records: ProvenanceRecord[]) => Promise<void>;
  readonly #now: () => string;
  /**
   * Set once untrusted writes could not all be recorded (a capped or failed `filesChanged`
   * listing, or records evicted at the cap): the workspace then counts as holding untrusted
   * files until it is cleared. Unrecorded files read as untrusted either way.
   */
  #overflow = false;

  constructor(
    records: readonly ProvenanceRecord[],
    save: (records: ProvenanceRecord[]) => Promise<void>,
    now: () => string = () => new Date().toISOString(),
  ) {
    for (const r of records) this.#records.set(r.path, r);
    this.#save = save;
    this.#now = now;
  }

  static async load(
    store: ProvenanceStore,
    scopeKey: string,
    now?: () => string,
  ): Promise<WorkspaceProvenance> {
    const records = await store.load(scopeKey);
    return new WorkspaceProvenance(records, (r) => store.save(scopeKey, r), now);
  }

  /** What a read of `path` reports. With `bytes`, a content that differs from the recorded write is untrusted. */
  lookup(path: string, bytes?: Uint8Array): FileProvenance {
    const record = this.#records.get(path);
    if (!record) return { provenance: "untrusted", sources: [unknownSource(path)] };
    if (bytes !== undefined && record.sha256 !== null && sha256Hex(bytes) !== record.sha256) {
      return { provenance: "untrusted", sources: dedupe([...record.sources, unknownSource(path)]) };
    }
    return { provenance: record.provenance, sources: dedupe(record.sources) };
  }

  /** `true` while any recorded file is untrusted (or untrusted writes went unrecorded). */
  hasUntrusted(): boolean {
    if (this.#overflow) return true;
    for (const r of this.#records.values()) if (r.provenance === "untrusted") return true;
    return false;
  }

  /** The origins of every untrusted file, for the sources of what a command derives from them. */
  untrustedSources(): TaintSource[] {
    const all: TaintSource[] = [];
    for (const r of this.#records.values()) {
      if (r.provenance === "untrusted") all.push(...r.sources);
    }
    if (this.#overflow) all.push({ sourceKind: "workspace", origin: WORKSPACE_PATH });
    return dedupe(all);
  }

  /** Records a write the file API performed (`sha256` of the bytes) or observed (`null`). */
  async record(
    paths: readonly string[],
    write: WriteProvenance,
    sha256: string | null = null,
  ): Promise<void> {
    if (paths.length === 0) return;
    const provenance = write.provenance === "trusted" ? "trusted" : "untrusted";
    const sources = provenance === "untrusted" ? dedupe(write.sources ?? []) : [];
    const recordedAt = this.#now();
    for (const path of paths) {
      this.#records.delete(path);
      this.#records.set(path, { path, provenance, sources, sha256, recordedAt });
    }
    this.#evict();
    await this.#save([...this.#records.values()]);
  }

  /** Untrusted writes happened that could not be listed: the workspace stays untrusted. */
  async markUnrecordedUntrusted(): Promise<void> {
    if (this.#overflow) return;
    this.#overflow = true;
    await this.#save([...this.#records.values()]);
  }

  /** Forgets everything (the workspace volume was deleted). */
  async clear(): Promise<void> {
    this.#records.clear();
    this.#overflow = false;
    await this.#save([]);
  }

  get size(): number {
    return this.#records.size;
  }

  /** Insertion order is oldest first (`record` re-inserts). Losing a trusted record only makes a file read untrusted; losing an untrusted one would not, so that sets `overflow`. */
  #evict(): void {
    let excess = this.#records.size - PROVENANCE_RECORDS_CAP;
    if (excess <= 0) return;
    for (const [path, r] of this.#records) {
      if (excess <= 0) break;
      if (r.provenance !== "trusted") continue;
      this.#records.delete(path);
      excess -= 1;
    }
    for (const path of this.#records.keys()) {
      if (excess <= 0) break;
      this.#records.delete(path);
      this.#overflow = true;
      excess -= 1;
    }
  }
}
