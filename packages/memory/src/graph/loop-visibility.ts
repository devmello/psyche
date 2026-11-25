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
                 AND COALESCE(l.source_kind, '') <> 'messages'
                 AND NOT EXISTS (
                   SELECT 1 FROM graph_citations c
                   WHERE c.target_kind = 'loop' AND c.target_id = l.id AND c.source = 'messages')
                 AND NOT EXISTS (
                   SELECT 1 FROM graph_interactions x
                   WHERE x.id = l.source_interaction_id AND x.kind = 'message')`,
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
 * The loop as a remote viewer sees it: no quoted sentence, no person or project link, no source
 * interaction (each is a way into Memory, or the source's own words).
 */
export function scrubLoopForRemote(loop: GraphLoop): GraphLoop {
  return {
    ...loop,
    evidence: null,
    counterpartId: null,
    projectId: null,
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
