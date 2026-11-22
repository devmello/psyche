import type { PsycheDb } from "@psyche/db";
import {
  PsycheError,
  SPACE_LIMITS,
  type Space,
  type SpaceCounts,
  type SpaceCreatedFrom,
  type SpaceDetail,
  type SpaceFolder,
  type SpaceLink,
  type SpaceProposal,
  type SpaceSummary,
  type SpaceTracker,
  type TaintSource,
} from "@psyche/protocol";
import { spaceMainTargetError } from "@psyche/scheduler";

/**
 * Spaces (docs/design/spaces-2026.md §4.1): rows in the Gateway's own database. A Space is a
 * container, not a store: it holds ids and owner settings. Folders and settings are written by
 * wave S2, trackers by S4; this store reads them so `spaces.get` is complete from the start.
 */

interface SpaceRow {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  instructions: string;
  entity_id: string | null;
  default_permission_mode: string | null;
  connector_scope: string | null;
  private: number;
  sort: number;
  archived_at: string | null;
  created_from: string;
  created_at: string;
  updated_at: string;
  instructions_rev: number;
  paused_automation_ids: string | null;
}

interface FolderRow {
  path: string;
  real: string;
  mode: string;
  automations_write: number;
  added_at: string;
  added_by_device: string | null;
}

interface LinkRow {
  id: string;
  kind: string;
  ref: string;
  label: string;
  label_provenance: string;
  added_by: string;
  created_at: string;
}

interface TrackerRow {
  widget_id: string;
  position: number;
  kind: string;
  stale_after_s: number | null;
  refreshed_at: string | null;
  added_by: string;
  created_at: string;
  taint: string;
}

interface ProposalRow {
  id: string;
  name: string;
  reason: string;
  entity_id: string | null;
  thread_ids: string;
  taint: string;
  status: string;
  created_at: string;
  decided_at: string | null;
}

export interface NewSpace {
  readonly name: string;
  readonly description?: string | undefined;
  readonly icon?: string | undefined;
  readonly instructions?: string | undefined;
  readonly entityId?: string | undefined;
  readonly createdFrom?: SpaceCreatedFrom;
}

export interface SpacePatch {
  readonly name?: string | undefined;
  readonly description?: string | null | undefined;
  readonly icon?: string | null | undefined;
  readonly instructions?: string | undefined;
  readonly entityId?: string | null | undefined;
  readonly private?: boolean | undefined;
  readonly sort?: number | undefined;
}

/**
 * A Keep-private project gets no Space (SR10): a Space shows on Home and in the Spaces list. The
 * UI says it through `errors.reason.project_private`.
 */
export const projectPrivateError = (): PsycheError =>
  new PsycheError("forbidden", "That project is Keep private, so it can't have a Space.", {
    details: { reason: "project_private" },
  });

const notFound = (id: string): PsycheError => new PsycheError("not_found", `space ${id} not found`);

function spaceFromRow(r: SpaceRow): Space {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    icon: r.icon,
    instructions: r.instructions,
    instructionsRev: r.instructions_rev,
    entityId: r.entity_id,
    defaultPermissionMode: r.default_permission_mode as Space["defaultPermissionMode"],
    connectorScope: r.connector_scope === null ? null : (JSON.parse(r.connector_scope) as string[]),
    private: r.private === 1,
    sort: r.sort,
    archivedAt: r.archived_at,
    createdFrom: r.created_from as SpaceCreatedFrom,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function proposalFromRow(r: ProposalRow): SpaceProposal {
  return {
    id: r.id,
    name: r.name,
    reason: r.reason,
    entityId: r.entity_id,
    threadIds: JSON.parse(r.thread_ids) as string[],
    taint: JSON.parse(r.taint) as SpaceProposal["taint"],
    status: r.status as SpaceProposal["status"],
    createdAt: r.created_at,
    decidedAt: r.decided_at,
  };
}

export class SpaceStore {
  readonly #db: PsycheDb;

  constructor(db: PsycheDb) {
    this.#db = db;
  }

  #row(id: string): SpaceRow | undefined {
    return this.#db.sqlite.prepare("SELECT * FROM spaces WHERE id = ?").get(id) as
      | SpaceRow
      | undefined;
  }

  #require(id: string): SpaceRow {
    const row = this.#row(id);
    if (row === undefined) throw notFound(id);
    return row;
  }

  #touch(id: string): void {
    this.#db.sqlite
      .prepare("UPDATE spaces SET updated_at = ? WHERE id = ?")
      .run(this.#db.now(), id);
  }

  get(id: string): Space | undefined {
    const row = this.#row(id);
    return row === undefined ? undefined : spaceFromRow(row);
  }

  require(id: string): Space {
    return spaceFromRow(this.#require(id));
  }

  /** A Space chats and automations may join: it exists and is not archived. */
  requireOpen(id: string): Space {
    const space = this.require(id);
    if (space.archivedAt !== null) throw new PsycheError("conflict", "that Space is archived");
    return space;
  }

  counts(spaceId: string): SpaceCounts {
    const chats = this.#db.sqlite
      // An automation's run threads are not chats of the Space (they stay in the run history).
      .prepare(
        "SELECT count(*) AS n FROM threads WHERE space_id = ? AND archived_at IS NULL AND session_key NOT LIKE 'cron:%'",
      )
      .get(spaceId) as { n: number };
    const trackers = this.#db.sqlite
      .prepare("SELECT count(*) AS n FROM space_trackers WHERE space_id = ?")
      .get(spaceId) as { n: number };
    // Due items come from the query sources (wave S4).
    return { chats: chats.n, trackers: trackers.n, due: 0 };
  }

  lastActivityAt(spaceId: string): string | null {
    const row = this.#db.sqlite
      .prepare(
        "SELECT max(coalesce(last_message_at, created_at)) AS at FROM threads WHERE space_id = ? AND session_key NOT LIKE 'cron:%'",
      )
      .get(spaceId) as { at: string | null };
    return row.at;
  }

  list(archived: boolean): SpaceSummary[] {
    const rows = this.#db.sqlite
      .prepare(
        `SELECT * FROM spaces WHERE archived_at IS ${archived ? "NOT" : ""} NULL ORDER BY sort, created_at, id`,
      )
      .all() as SpaceRow[];
    return rows.map((r) => {
      const s = spaceFromRow(r);
      return {
        id: s.id,
        name: s.name,
        description: s.description,
        icon: s.icon,
        entityId: s.entityId,
        private: s.private,
        sort: s.sort,
        archivedAt: s.archivedAt,
        counts: this.counts(s.id),
        lastActivityAt: this.lastActivityAt(s.id),
      };
    });
  }

  detail(id: string): SpaceDetail {
    const space = this.require(id);
    const folders = (
      this.#db.sqlite
        .prepare("SELECT * FROM space_folders WHERE space_id = ? ORDER BY added_at, path")
        .all(id) as FolderRow[]
    ).map(
      (f): SpaceFolder => ({
        path: f.path,
        real: f.real,
        mode: f.mode as SpaceFolder["mode"],
        automationsWrite: f.automations_write === 1,
        addedAt: f.added_at,
        addedByDevice: f.added_by_device,
      }),
    );
    const trackers = (
      this.#db.sqlite
        .prepare(
          `SELECT t.*, w.taint AS taint FROM space_trackers t JOIN widgets w ON w.id = t.widget_id
            WHERE t.space_id = ? ORDER BY t.position, t.created_at`,
        )
        .all(id) as TrackerRow[]
    ).map(
      (t): SpaceTracker => ({
        widgetId: t.widget_id,
        position: t.position,
        kind: t.kind as SpaceTracker["kind"],
        staleAfterS: t.stale_after_s,
        refreshedAt: t.refreshed_at,
        addedBy: t.added_by as SpaceTracker["addedBy"],
        createdAt: t.created_at,
        // The widget's taint (section 5.5): a tainted tracker enters a run's context as a count.
        taint: JSON.parse(t.taint) as TaintSource[],
      }),
    );
    const automationIds = (
      this.#db.sqlite
        .prepare("SELECT id FROM automations WHERE space_id = ? ORDER BY created_at, id")
        .all(id) as { id: string }[]
    ).map((a) => a.id);
    return {
      space,
      folders,
      links: this.links(id),
      trackers,
      automationIds,
      goalIds: [],
      counts: this.counts(id),
      lastActivityAt: this.lastActivityAt(id),
    };
  }

  create(input: NewSpace): Space {
    const name = input.name.trim();
    if (name === "") throw new PsycheError("invalid_params", "a Space needs a name");
    if (input.entityId !== undefined) this.#requireEntityFree(input.entityId, null);
    const at = this.#db.now();
    const id = this.#db.newId();
    const top = this.#db.sqlite
      .prepare("SELECT coalesce(max(sort), -1) AS m FROM spaces")
      .get() as {
      m: number;
    };
    this.#db.sqlite
      .prepare(
        `INSERT INTO spaces (id, name, description, icon, instructions, entity_id, private, sort,
           created_from, created_at, updated_at, instructions_rev)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 1)`,
      )
      .run(
        id,
        name,
        input.description ?? null,
        input.icon ?? null,
        input.instructions ?? "",
        input.entityId ?? null,
        top.m + 1,
        input.createdFrom ?? "owner",
        at,
        at,
      );
    return this.require(id);
  }

  #requireEntityFree(entityId: string, selfId: string | null): void {
    const taken = this.#db.sqlite
      .prepare("SELECT id FROM spaces WHERE entity_id = ? AND id IS NOT ?")
      .get(entityId, selfId) as { id: string } | undefined;
    if (taken !== undefined) {
      throw new PsycheError("conflict", "that project already has a Space");
    }
  }

  /** Applies a patch; returns the Space and which parts changed (for the event). */
  update(id: string, patch: SpacePatch): Space {
    const current = this.#require(id);
    const sets: string[] = [];
    const args: Record<string, unknown> = { id };
    const put = (col: string, value: unknown) => {
      sets.push(`${col} = @${col}`);
      args[col] = value;
    };
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (name === "" || name.length > SPACE_LIMITS.name) {
        throw new PsycheError("invalid_params", "a Space name is 1 to 60 characters");
      }
      put("name", name);
    }
    if (patch.description !== undefined) put("description", patch.description);
    if (patch.icon !== undefined) put("icon", patch.icon);
    if (patch.instructions !== undefined && patch.instructions !== current.instructions) {
      put("instructions", patch.instructions);
      put("instructions_rev", current.instructions_rev + 1);
    }
    if (patch.entityId !== undefined) {
      if (patch.entityId !== null) this.#requireEntityFree(patch.entityId, id);
      put("entity_id", patch.entityId);
    }
    if (patch.private !== undefined) put("private", patch.private ? 1 : 0);
    if (patch.sort !== undefined) put("sort", patch.sort);
    put("updated_at", this.#db.now());
    this.#db.sqlite.prepare(`UPDATE spaces SET ${sets.join(", ")} WHERE id = @id`).run(args);
    return this.require(id);
  }

  /** Marks the Space archived; `pausedAutomationIds` is what the archive switched off. */
  archive(id: string, at: string, pausedAutomationIds: readonly string[]): Space {
    this.#require(id);
    this.#db.sqlite
      .prepare(
        "UPDATE spaces SET archived_at = ?, paused_automation_ids = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        at,
        pausedAutomationIds.length === 0 ? null : JSON.stringify(pausedAutomationIds),
        at,
        id,
      );
    return this.require(id);
  }

  /** Enabled automations of the Space, not Psyche's own: the ones an archive pauses. */
  enabledAutomationIds(spaceId: string): string[] {
    return (
      this.#db.sqlite
        .prepare("SELECT id FROM automations WHERE space_id = ? AND enabled = 1 AND system = 0")
        .all(spaceId) as { id: string }[]
    ).map((a) => a.id);
  }

  /** Clears the archive mark and returns the automations the archive had paused. */
  unarchive(id: string): { space: Space; paused: string[] } {
    const row = this.#require(id);
    const paused =
      row.paused_automation_ids === null ? [] : (JSON.parse(row.paused_automation_ids) as string[]);
    this.#db.sqlite
      .prepare(
        "UPDATE spaces SET archived_at = NULL, paused_automation_ids = NULL, updated_at = ? WHERE id = ?",
      )
      .run(this.#db.now(), id);
    return { space: this.require(id), paused };
  }

  /**
   * Deletes the Space. Folders, links and shelf rows cascade; chats and automations stay with no
   * Space (their foreign key is SET NULL). Returns the chats that were in it.
   */
  delete(id: string): string[] {
    this.#require(id);
    const threadIds = (
      this.#db.sqlite.prepare("SELECT id FROM threads WHERE space_id = ?").all(id) as {
        id: string;
      }[]
    ).map((t) => t.id);
    // Templates were drawn by the Gateway for this Space alone: their values go with it (SR14).
    this.#db.sqlite
      .prepare(
        "DELETE FROM widgets WHERE id IN (SELECT widget_id FROM space_trackers WHERE space_id = ? AND added_by = 'template')",
      )
      .run(id);
    this.#db.sqlite.prepare("DELETE FROM spaces WHERE id = ?").run(id);
    return threadIds;
  }

  // --- Links --------------------------------------------------------------------------------

  links(spaceId: string): SpaceLink[] {
    return (
      this.#db.sqlite
        .prepare("SELECT * FROM space_links WHERE space_id = ? ORDER BY created_at, id")
        .all(spaceId) as LinkRow[]
    ).map(linkFromRow);
  }

  addLink(
    spaceId: string,
    link: { kind: SpaceLink["kind"]; ref: string; label: string },
    /** Who adds it: the agent's links keep `label_provenance: 'agent'` (spaces-2026 §4.3). */
    by: "owner" | "agent" = "owner",
  ): SpaceLink {
    this.#require(spaceId);
    const dup = this.#db.sqlite
      .prepare("SELECT 1 AS x FROM space_links WHERE space_id = ? AND kind = ? AND ref = ?")
      .get(spaceId, link.kind, link.ref);
    if (dup !== undefined) throw new PsycheError("conflict", "that link is already in the Space");
    const id = this.#db.newId();
    const at = this.#db.now();
    this.#db.sqlite
      .prepare(
        `INSERT INTO space_links (id, space_id, kind, ref, label, label_provenance, added_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, spaceId, link.kind, link.ref, link.label, by, by, at);
    this.#touch(spaceId);
    return linkFromRow(
      this.#db.sqlite.prepare("SELECT * FROM space_links WHERE id = ?").get(id) as LinkRow,
    );
  }

  removeLink(spaceId: string, linkId: string): void {
    this.#require(spaceId);
    const res = this.#db.sqlite
      .prepare("DELETE FROM space_links WHERE id = ? AND space_id = ?")
      .run(linkId, spaceId);
    if (res.changes === 0) throw new PsycheError("not_found", `link ${linkId} not found`);
    this.#touch(spaceId);
  }

  // --- Moves --------------------------------------------------------------------------------

  /**
   * Moves chats into a Space or out (null). All-or-nothing: an unknown chat, the main chat, or an
   * archived target fails the whole batch. Returns the chats that changed Space and the Spaces
   * they left.
   */
  moveThreads(
    threadIds: readonly string[],
    spaceId: string | null,
  ): { moved: string[]; from: Set<string> } {
    if (spaceId !== null) this.requireOpen(spaceId);
    const ids = [...new Set(threadIds)];
    const rows: { id: string; kind: string; space_id: string | null }[] = [];
    for (const id of ids) {
      const row = this.#db.sqlite
        .prepare("SELECT id, kind, space_id, imported FROM threads WHERE id = ?")
        .get(id) as
        | { id: string; kind: string; space_id: string | null; imported: string | null }
        | undefined;
      if (row === undefined) throw new PsycheError("not_found", `thread ${id} not found`);
      // Backstop for every caller: an imported conversation is somebody's file and stays out.
      if (row.imported !== null) {
        throw new PsycheError(
          "forbidden",
          "Imported conversations are read-only: they cannot be moved.",
        );
      }
      if (row.kind === "main") {
        throw new PsycheError("invalid_params", "the main chat cannot be put in a Space");
      }
      rows.push(row);
    }
    const at = this.#db.now();
    const moved: string[] = [];
    const from = new Set<string>();
    const stmt = this.#db.sqlite.prepare(
      "UPDATE threads SET space_id = ?, updated_at = ? WHERE id = ?",
    );
    for (const r of rows) {
      if (r.space_id === spaceId) continue;
      stmt.run(spaceId, at, r.id);
      moved.push(r.id);
      if (r.space_id !== null) from.add(r.space_id);
    }
    return { moved, from };
  }

  moveAutomations(
    automationIds: readonly string[],
    spaceId: string | null,
  ): { moved: string[]; from: Set<string> } {
    if (spaceId !== null) this.requireOpen(spaceId);
    const ids = [...new Set(automationIds)];
    const rows: { id: string; system: number; space_id: string | null; target: string }[] = [];
    for (const id of ids) {
      const row = this.#db.sqlite
        .prepare(
          "SELECT id, system, space_id, session_target AS target FROM automations WHERE id = ?",
        )
        .get(id) as
        | { id: string; system: number; space_id: string | null; target: string }
        | undefined;
      if (row === undefined) throw new PsycheError("not_found", `automation ${id} not found`);
      if (row.system === 1) {
        throw new PsycheError("invalid_params", "Psyche's own routines cannot be put in a Space");
      }
      // A run in the main chat would get neither the Space's head nor its scope (r1 finding 1).
      if (spaceId !== null && row.target === "main") throw spaceMainTargetError();
      rows.push(row);
    }
    const moved: string[] = [];
    const from = new Set<string>();
    const stmt = this.#db.sqlite.prepare(
      "UPDATE automations SET space_id = ?, updated_at = ? WHERE id = ?",
    );
    const at = this.#db.now();
    for (const r of rows) {
      if (r.space_id === spaceId) continue;
      stmt.run(spaceId, at, r.id);
      // Its run threads follow it: none stays marked with a Space the automation has left.
      this.#db.sqlite
        .prepare(
          "UPDATE threads SET space_id = ? WHERE kind = 'automation' AND session_key LIKE ? ESCAPE '\\'",
        )
        .run(spaceId, `cron:${r.id.replace(/[\\%_]/g, "\\$&")}:%`);
      moved.push(r.id);
      if (r.space_id !== null) from.add(r.space_id);
    }
    return { moved, from };
  }

  // --- Proposals ----------------------------------------------------------------------------

  proposals(onlyOpen: boolean): SpaceProposal[] {
    return (
      this.#db.sqlite
        .prepare(
          `SELECT * FROM space_proposals ${onlyOpen ? "WHERE status = 'open'" : ""} ORDER BY created_at, id`,
        )
        .all() as ProposalRow[]
    ).map(proposalFromRow);
  }

  proposal(id: string): SpaceProposal {
    const row = this.#db.sqlite.prepare("SELECT * FROM space_proposals WHERE id = ?").get(id) as
      | ProposalRow
      | undefined;
    if (row === undefined) throw new PsycheError("not_found", `proposal ${id} not found`);
    return proposalFromRow(row);
  }

  decideProposal(id: string, status: "accepted" | "dismissed"): void {
    const res = this.#db.sqlite
      .prepare(
        "UPDATE space_proposals SET status = ?, decided_at = ? WHERE id = ? AND status = 'open'",
      )
      .run(status, this.#db.now(), id);
    if (res.changes === 0) throw new PsycheError("conflict", "that proposal is already decided");
  }
}

function linkFromRow(r: LinkRow): SpaceLink {
  return {
    id: r.id,
    kind: r.kind as SpaceLink["kind"],
    ref: r.ref,
    label: r.label,
    labelProvenance: r.label_provenance as SpaceLink["labelProvenance"],
    addedBy: r.added_by as SpaceLink["addedBy"],
    createdAt: r.created_at,
  };
}
