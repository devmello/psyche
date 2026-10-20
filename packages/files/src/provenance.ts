import type { ProvenanceOut, TaintSource } from "@psyche/protocol";
import { isUnder } from "./paths.ts";

/**
 * File-level provenance for host files (S23 design-07, the host-side twin of the sandbox's
 * `/workspace` index from #97). Taint is turn-scoped, so untrusted text only has to pass
 * through a file to come back clean in a later turn. The file tools therefore record the
 * provenance of every write they perform and answer it on read.
 *
 * Security §3.6 lists non-workspace files as `untrusted`, so a read is `untrusted` by default.
 * It is `trusted` only when all of these hold: the path lies under a configured trusted root
 * (a folder Psyche alone writes), the index holds a `trusted` record for it, and the file's
 * bytes still hash to that record. Anything written in a tainted turn, edited outside Psyche,
 * or never seen is `untrusted`.
 */

export interface FileProvenanceRecord {
  /** Canonical real path. */
  path: string;
  provenance: ProvenanceOut;
  /** Empty for trusted writes. */
  sources: TaintSource[];
  /** sha256 of the bytes written. */
  sha256: string;
  /** ISO-8601. */
  recordedAt: string;
}

/** Persists write records; the default keeps them in memory (a restart only makes files untrusted). */
export interface FileProvenanceIndex {
  get(path: string): FileProvenanceRecord | undefined;
  record(record: FileProvenanceRecord): void;
}

/** Records kept by the in-memory index; the oldest go first above it. */
export const PROVENANCE_RECORDS_CAP = 10_000;
const SOURCES_CAP = 16;

export class MemoryFileProvenance implements FileProvenanceIndex {
  readonly #records = new Map<string, FileProvenanceRecord>();

  get(path: string): FileProvenanceRecord | undefined {
    const r = this.#records.get(path);
    return r === undefined ? undefined : structuredClone(r);
  }

  record(record: FileProvenanceRecord): void {
    this.#records.delete(record.path);
    this.#records.set(record.path, {
      ...record,
      sources: record.sources.slice(0, SOURCES_CAP).map((s) => ({ ...s })),
    });
    while (this.#records.size > PROVENANCE_RECORDS_CAP) {
      const oldest = this.#records.keys().next().value;
      if (oldest === undefined) break;
      this.#records.delete(oldest);
    }
  }
}

/** The provenance a read reports for `path` whose current bytes hash to `sha256`. */
export function readProvenance(
  index: FileProvenanceIndex,
  trustedRoots: readonly string[],
  path: string,
  sha256: string | undefined,
): ProvenanceOut {
  if (sha256 === undefined || !trustedRoots.some((root) => isUnder(path, root))) {
    return "untrusted";
  }
  const r = index.get(path);
  return r?.provenance === "trusted" && r.sha256 === sha256 ? "trusted" : "untrusted";
}
