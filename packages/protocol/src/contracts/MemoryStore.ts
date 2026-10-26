import type { Provenance } from "../common.ts";
import type { MemoryChunk, MemoryClaim, MemoryHit } from "../schemas/memory.ts";
import type { CallOptions } from "./Clock.ts";
import type { ModelMessage } from "./ModelProvider.ts";

/**
 * Memory store contract (architecture §4.8; data model §7; security §8; owner S07).
 * Paths are relative to the workspace; `..` and absolute paths are rejected (`invalid_params`).
 * `SOUL.md`, `IDENTITY.md`, `USER.md`, `MEMORY.md` and `AGENTS.md` are protected (security §8):
 * writes need an approved `memory_protected_write` (`approvalId`) and `untrusted` content can
 * never be written there.
 */

export const PROTECTED_MEMORY_FILES = [
  "SOUL.md",
  "IDENTITY.md",
  "USER.md",
  "MEMORY.md",
  "AGENTS.md",
] as const;

export interface MemoryFile {
  path: string;
  content: string;
  /** Opaque version for optimistic concurrency. */
  etag: string;
}

export interface MemoryWriteOptions {
  provenance: Provenance;
  /** If-match: reject with `conflict` when the current etag differs. */
  etag?: string;
  /** Required for protected files. */
  approvalId?: string;
  /** The tool call that writes (run trace §4.2): `memory.file.changed` names its run and step. */
  trace?: MemoryWriteTrace;
}

/** The run and tool call behind a memory write. */
export interface MemoryWriteTrace {
  runId: string;
  toolCallId: string;
}

export interface MemorySearchOptions {
  limit?: number;
  /** Only return chunks with one of these provenance classes. */
  provenance?: Provenance[];
  /** Restrict to workspace paths with one of these prefixes. */
  sources?: string[];
}

export interface DailyNoteInput {
  text: string;
  provenance: Provenance;
  /** `YYYY-MM-DD`; defaults to today in the store's clock. */
  date?: string;
  trace?: MemoryWriteTrace;
}

export interface ClaimInput {
  text: string;
  kind: MemoryClaim["kind"];
  provenance: Provenance;
  confidence: number;
  /** Chunk ids or workspace paths the claim is derived from. */
  sources: string[];
  supersedes?: string;
}

export interface ForgetResult {
  retractedClaimIds: string[];
  removedChunkIds: string[];
  /** Workspace files whose lines were removed (or would be, on a dry run). */
  files?: string[];
}

export interface MemoryFlushOptions extends CallOptions {
  /** The turn read untrusted content: anything noted is tagged `untrusted`, never `owner`. */
  taint?: boolean;
}

export interface MemoryFlushResult {
  /** Daily-note entries appended by the flush (0 when nothing was worth keeping). */
  appended: number;
}

export interface MemoryStore {
  readFile(path: string): Promise<MemoryFile | undefined>;
  writeFile(path: string, content: string, options: MemoryWriteOptions): Promise<MemoryFile>;
  listFiles(prefix?: string): Promise<string[]>;
  search(query: string, options?: MemorySearchOptions): Promise<MemoryHit[]>;
  /** Append-only write to `memory/YYYY-MM-DD.md`, provenance-tagged. */
  appendDailyNote(input: DailyNoteInput): Promise<{ path: string; chunk: MemoryChunk }>;
  /** Rejects (`policy_denied`) an `owner` claim derived from any `untrusted` source. */
  addClaim(input: ClaimInput): Promise<MemoryClaim>;
  listClaims(options?: { includeRetracted?: boolean }): Promise<MemoryClaim[]>;
  /** Why a fact is believed: the claim with its source chunks. */
  explain(claimId: string): Promise<{ claim: MemoryClaim; chunks: MemoryChunk[] } | undefined>;
  /** Retract matching claims and remove linked chunks; `dryRun` reports without changing. */
  forget(subject: string, options?: { dryRun?: boolean }): Promise<ForgetResult>;
  /**
   * Pre-compaction flush (architecture §4.2 step 7, §4.8): note durable facts from a private
   * copy of the conversation in today's daily note (append-only) before older turns are
   * summarized. Never called for incognito threads.
   */
  flush?(
    threadId: string,
    privateCopy: readonly ModelMessage[],
    options?: MemoryFlushOptions,
  ): Promise<MemoryFlushResult>;
}
