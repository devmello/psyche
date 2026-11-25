import type { GraphLoop } from "@psyche/protocol";
import type Database from "better-sqlite3";

/**
 * Which loops a remote viewer may see (docs/design/promise-ledger-2026.md section 7.2). A remote
 * viewer is anything but the desktop shell on this Mac: iOS, a remote desktop, the web shell, the
 * CLI over the network. The rule is fail-closed and read from the row, never from the caller:
 *
 * - a loop is visible only when `graph_loops.remote_visible = 1`; null, 0 and a missing row hide;
 * - a loop that cites Messages (its `source_kind`, any `graph_citations` row for it, or a message
 *   as its source interaction) is hidden whatever `remote_visible` says;
 * - any read error hides everything.
 *
 * This file only reads. The writer of `remote_visible` (the ledger store) is not touched here.
 */

/** Who is reading: `full` is the desktop shell on this Mac (loopback plus the shell's proof). */
export interface LoopViewer {
  full: boolean;
}

/** The viewer of an in-process caller that has not said who it is: never the full view. */
export const REMOTE_LOOP_VIEWER: LoopViewer = { full: false };

export interface LoopVisibility {
  /** The subset of `ids` a remote viewer may see. Never throws: an error returns the empty set. */
  remoteVisible(ids: readonly string[]): Set<string>;
}

const CHUNK = 400;

/**
 * The part of the rule that does not depend on the column: no Messages marker on the loop, its
 * citations or its source interaction. `l` is the `graph_loops` alias. The reader, the writer
 * (`markLoopRemoteVisible`) and the backfill all use this one fragment.
 */
const NO_MESSAGES_MARKER = `COALESCE(l.source_kind, '') <> 'messages'
  AND NOT EXISTS (
    SELECT 1 FROM graph_citations c
    WHERE c.target_kind = 'loop' AND c.target_id = l.id AND c.source = 'messages')
  AND NOT EXISTS (
    SELECT 1 FROM graph_interactions x
    WHERE x.id = l.source_interaction_id AND x.kind = 'message')`;

/**
 * Sets `remote_visible = 1` on a loop that has no Messages marker (the writer of a new loop calls
 * this; a Messages source or citation leaves it 0). Never throws.
 */
export function markLoopRemoteVisible(sqlite: Database.Database, id: string): void {
  try {
    sqlite
      .prepare(
        `UPDATE graph_loops AS l SET remote_visible = 1 WHERE l.id = ? AND ${NO_MESSAGES_MARKER}`,
      )
      .run(id);
  } catch {
    // The column stays 0: hidden from remote viewers, never shown by mistake.
  }
}

/**
 * Once, for loops written before the column was set: the same rule over every loop. Returns how
 * many rows changed. It runs in code, not in a migration, so the encrypted store gets it too.
 */
export function backfillLoopRemoteVisible(sqlite: Database.Database): number {
  try {
    return sqlite
      .prepare(
        `UPDATE graph_loops AS l SET remote_visible = 1
          WHERE l.remote_visible = 0 AND ${NO_MESSAGES_MARKER}`,
      )
      .run().changes;
  } catch {
    return 0;
  }
}

export function createLoopVisibility(sqlite: Database.Database): LoopVisibility {
  return {
    remoteVisible(ids) {
      const out = new Set<string>();
      const unique = [...new Set(ids)];
      try {
        for (let i = 0; i < unique.length; i += CHUNK) {
          const part = unique.slice(i, i + CHUNK);
          const rows = sqlite
            .prepare(
              `SELECT l.id AS id FROM graph_loops l
               WHERE l.id IN (${part.map(() => "?").join(", ")})
                 AND l.remote_visible = 1
                 AND ${NO_MESSAGES_MARKER}`,
            )
            .all(...part) as { id: string }[];
          for (const r of rows) out.add(r.id);
        }
      } catch {
        return new Set();
      }
      return out;
    },
  };
}

/**
 * The loop as a remote viewer sees it: no quoted sentence, no person link, no source interaction
 * (each is a way into Memory, or the source's own words). The project stays: iOS filters project
 * to-dos on it, and projects are already readable through `memory.entities.get`.
 */
export function scrubLoopForRemote(loop: GraphLoop): GraphLoop {
  return {
    ...loop,
    evidence: null,
    counterpartId: null,
    sourceInteractionId: null,
  };
}

/** The loop for one viewer, or `null` when this viewer may not know it exists. */
export function loopForViewer(
  loop: GraphLoop,
  viewer: LoopViewer,
  visibility: LoopVisibility | undefined,
): GraphLoop | null {
  if (viewer.full) return loop;
  if (visibility === undefined) return null;
  return visibility.remoteVisible([loop.id]).has(loop.id) ? scrubLoopForRemote(loop) : null;
}

/** Many loops for one viewer, in order, dropping the hidden ones in one read. */
export function loopsForViewer(
  loops: readonly GraphLoop[],
  viewer: LoopViewer,
  visibility: LoopVisibility | undefined,
): GraphLoop[] {
  if (viewer.full) return [...loops];
  if (visibility === undefined) return [];
  const ok = visibility.remoteVisible(loops.map((l) => l.id));
  return loops.filter((l) => ok.has(l.id)).map(scrubLoopForRemote);
}
