import { getThread, type PsycheDb } from "@psyche/db";
import {
  folderCovers,
  type PsychePermissionBroker,
  resolveFolderPick,
  type SpaceFolderRecord,
  type SpaceFolderSource,
  type ThreadSpace,
} from "@psyche/permissions";
import { type MethodParams, PsycheError, type SpaceDetail } from "@psyche/protocol";
import { folderAccessEnv } from "../compose/protected-paths.ts";
import type { ComposedPart } from "../compose/services.ts";
import type { Call, HandlerDef } from "../context.ts";
import { SpaceStore } from "./store.ts";

/**
 * Spaces wave S2 (docs/design/spaces-2026.md §5.3): the folder scope. A Space's folders are a
 * third scope beside Settings' (Always allow) and one conversation's (Allow once):
 * - they count only in the runs of that Space (`spaceOf`), fixed at each run's start (SR3);
 * - every one passes the folder refusals and keeps its recorded real path (SR2);
 * - an automation reads them, and writes only where the owner turned on
 *   `automationsWrite` (SP8, SR4);
 * - archiving or deleting the Space stops them at once: the broker reads them live (SR14).
 * There are two ways to add or widen one:
 * - these methods, on the Mac itself (`operator.admin` on the desktop shell): add a folder, set it
 *   to read & write, let automations write;
 * - a folder card's "Allow in this Space", from any approver (a plain tap, like Always allow):
 *   adds the folder, or raises it to read & write, only where automations may not write there
 *   (`add` answers `not_raised` otherwise), and never turns on `automationsWrite`. The card says
 *   that the Space's automations can read the folder too.
 * Removing or narrowing works from any admin device.
 */

interface FolderRow {
  space_id: string;
  name: string;
  path: string;
  real: string;
  mode: string;
  automations_write: number;
}

/** Thread kinds a Space applies to; never the main chat, channels or incognito chats (SR11). */
const SPACE_THREAD_KINDS = new Set(["side", "automation"]);

const LIVE_FOLDERS = `SELECT f.space_id, s.name, f.path, f.real, f.mode, f.automations_write
  FROM space_folders f JOIN spaces s ON s.id = f.space_id
  WHERE s.archived_at IS NULL`;

function record(r: FolderRow): SpaceFolderRecord {
  return {
    spaceId: r.space_id,
    spaceName: r.name,
    path: r.path,
    real: r.real,
    mode: r.mode === "rw" ? "rw" : "ro",
    automationsWrite: r.automations_write === 1,
  };
}

/** An open (not archived) Space's id and name, or undefined. */
function openSpace(db: PsycheDb, spaceId: string): { id: string; name: string } | undefined {
  const row = db.sqlite
    .prepare("SELECT id, name FROM spaces WHERE id = ? AND archived_at IS NULL")
    .get(spaceId) as { id: string; name: string } | undefined;
  return row;
}

/**
 * The Space a run in this thread works in: a Space chat's own, or for an automation's thread the
 * Space of the automation running there (§5.1). A subagent's thread defers to its parent's run.
 * The main chat, channels and incognito chats are in none, and nor is an archived Space.
 */
export function threadSpace(db: PsycheDb, threadId: string): ThreadSpace | undefined {
  const thread = getThread(db, threadId);
  if (thread === undefined) return undefined;
  if (thread.kind === "subagent") {
    return thread.parentThreadId == null ? undefined : { parentThreadId: thread.parentThreadId };
  }
  if (!SPACE_THREAD_KINDS.has(thread.kind)) return undefined;
  let spaceId = thread.spaceId ?? null;
  if (spaceId === null && thread.kind === "automation") {
    const row = db.sqlite
      .prepare(
        `SELECT a.space_id AS spaceId FROM automation_runs r JOIN automations a ON a.id = r.automation_id
         WHERE r.thread_id = ? AND r.status = 'running' ORDER BY r.started_at DESC LIMIT 1`,
      )
      .get(threadId) as { spaceId: string | null } | undefined;
    spaceId = row?.spaceId ?? null;
  }
  if (spaceId === null) return undefined;
  const space = openSpace(db, spaceId);
  return space === undefined ? undefined : { spaceId: space.id, spaceName: space.name };
}

/** The broker's view of `space_folders` (`PermissionBrokerOptions.spaces`). */
export function spaceFolderSource(
  db: PsycheDb,
  changed: (spaceId: string) => void = () => {},
): SpaceFolderSource {
  return {
    spaceOf: (threadId) => threadSpace(db, threadId),
    folders: (spaceId) =>
      (
        db.sqlite
          .prepare(`${LIVE_FOLDERS} AND f.space_id = ? ORDER BY f.added_at, f.path`)
          .all(spaceId) as FolderRow[]
      ).map(record),
    all: () =>
      (
        db.sqlite
          .prepare(`${LIVE_FOLDERS} ORDER BY s.sort, s.created_at, f.added_at, f.path`)
          .all() as FolderRow[]
      ).map(record),
    add(spaceId, entry, by) {
      if (openSpace(db, spaceId) === undefined) {
        throw new PsycheError("conflict", "that Space is archived or gone");
      }
      const store = db.sqlite.transaction((): "added" | "not_raised" => {
        const had = db.sqlite
          .prepare(
            "SELECT mode, automations_write FROM space_folders WHERE space_id = ? AND path = ?",
          )
          .get(spaceId, entry.path) as { mode: string; automations_write: number } | undefined;
        // A card never raises to read & write a folder automations may write in: with the
        // flag on, that would let them write too. Only the Mac's `setMode` does (SP8).
        if (entry.mode === "rw" && had?.mode === "ro" && had.automations_write === 1) {
          return "not_raised";
        }
        // A pick a row of this Space already covers (a parent at the same or a higher mode) adds
        // nothing: a narrower row would only shadow the parent's mode and automations setting.
        const covering = (
          db.sqlite
            .prepare("SELECT path, real, mode FROM space_folders WHERE space_id = ? AND path != ?")
            .all(spaceId, entry.path) as { path: string; real: string; mode: "ro" | "rw" }[]
        ).filter((r) => folderCovers([r], entry.path, entry.mode) !== undefined);
        if (had === undefined && covering.length > 0) return "added";
        // The same folder again keeps its automations setting; a read & write pick widens it.
        db.sqlite
          .prepare(
            `INSERT INTO space_folders (space_id, path, real, mode, automations_write, added_at, added_by_device)
             VALUES (?, ?, ?, ?, 0, ?, ?)
             ON CONFLICT (space_id, path) DO UPDATE SET real = excluded.real,
               mode = CASE WHEN excluded.mode = 'rw' THEN 'rw' ELSE space_folders.mode END`,
          )
          .run(spaceId, entry.path, entry.real, entry.mode, db.now(), by.deviceId ?? null);
        touch(db, spaceId);
        return "added";
      });
      const added = store();
      if (added === "added") changed(spaceId);
      return added;
    },
    remove(spaceId, path) {
      const res = db.sqlite
        .prepare("DELETE FROM space_folders WHERE space_id = ? AND path = ?")
        .run(spaceId, path);
      if (res.changes === 0) return false;
      touch(db, spaceId);
      changed(spaceId);
      return true;
    },
  };
}

function touch(db: PsycheDb, spaceId: string): void {
  db.sqlite.prepare("UPDATE spaces SET updated_at = ? WHERE id = ?").run(db.now(), spaceId);
}

export interface SpaceFolderHandlerDeps {
  /** The broker whose runs see the folders (the composed `rawBroker`). */
  broker: () => PsychePermissionBroker | undefined;
  /** `$PSYCHE_HOME`, for the sensitive roots a folder is refused under. */
  home: string;
}

type P<
  M extends
    | "spaces.folders.add"
    | "spaces.folders.remove"
    | "spaces.folders.setMode"
    | "spaces.settings.set",
> = MethodParams<M>;

/** The Mac itself: the desktop shell on a loopback connection. */
function onHost(call: Call): boolean {
  return call.identity.desktopShell === true && call.conn.peer.remoteLoopback === true;
}

function requireHost(call: Call, what: string): void {
  if (!onHost(call)) {
    throw new PsycheError("forbidden", `${what} on your Mac`, {
      details: { reason: "host_only" },
    });
  }
}

function folderRow(db: PsycheDb, spaceId: string, path: string) {
  return db.sqlite
    .prepare("SELECT mode, automations_write FROM space_folders WHERE space_id = ? AND path = ?")
    .get(spaceId, path) as { mode: string; automations_write: number } | undefined;
}

const folderNotFound = (path: string) =>
  new PsycheError("not_found", `${path} is not a folder of this Space`);

/**
 * `spaces.folders.add|remove|setMode` and `spaces.settings.set` (§4.2), all `operator.admin`.
 * The folder added is the real path of the owner's pick, refused like Settings would refuse it.
 */
export function spaceFolderHandlers(deps: SpaceFolderHandlerDeps): Record<string, HandlerDef> {
  const done = (call: Call, spaceId: string, what: string[], emit = true): SpaceDetail => {
    call.afterCommit(() => deps.broker()?.spaceFoldersChanged());
    call.ctx.bus.bumpStateVersion();
    // A revoke through the broker is announced by the source itself (`spaceFolderSource`).
    if (emit) call.emit("space.updated", { spaceId, changed: what });
    return new SpaceStore(call.ctx.db).detail(spaceId);
  };

  return {
    "spaces.folders.add": {
      async prepare(call: Call, p: P<"spaces.folders.add">) {
        requireHost(call, "Add folders");
        new SpaceStore(call.ctx.db).requireOpen(p.spaceId);
        if (p.path === undefined) {
          throw new PsycheError("invalid_params", "pick the folder to add on your Mac");
        }
        return resolveFolderPick(p.path, folderAccessEnv(deps.home));
      },
      transactional: true,
      run(call: Call, p: P<"spaces.folders.add">): SpaceDetail {
        const real = call.prepared as string;
        new SpaceStore(call.ctx.db).requireOpen(p.spaceId);
        const mode = p.mode ?? "ro";
        call.ctx.db.sqlite
          .prepare(
            `INSERT INTO space_folders (space_id, path, real, mode, automations_write, added_at, added_by_device)
             VALUES (?, ?, ?, ?, 0, ?, ?)
             ON CONFLICT (space_id, path) DO UPDATE SET real = excluded.real, mode = excluded.mode`,
          )
          .run(p.spaceId, real, real, mode, call.ctx.db.now(), call.identity.deviceId);
        touch(call.ctx.db, p.spaceId);
        return done(call, p.spaceId, ["folders"]);
      },
    },
    "spaces.folders.remove": {
      async run(call: Call, p: P<"spaces.folders.remove">): Promise<SpaceDetail> {
        new SpaceStore(call.ctx.db).require(p.spaceId);
        const broker = deps.broker();
        const removed =
          broker === undefined
            ? spaceFolderSource(call.ctx.db).remove(p.spaceId, p.path)
            : await broker.revokeSpaceFolder(p.spaceId, p.path);
        if (!removed) throw folderNotFound(p.path);
        return done(call, p.spaceId, ["folders"], broker === undefined);
      },
    },
    "spaces.folders.setMode": {
      transactional: true,
      run(call: Call, p: P<"spaces.folders.setMode">): SpaceDetail {
        // Read & write widens what the agent may do: only from the Mac. Read only narrows.
        if (p.mode === "rw") requireHost(call, "Let Psyche change files");
        new SpaceStore(call.ctx.db).require(p.spaceId);
        if (folderRow(call.ctx.db, p.spaceId, p.path) === undefined) throw folderNotFound(p.path);
        call.ctx.db.sqlite
          .prepare("UPDATE space_folders SET mode = ? WHERE space_id = ? AND path = ?")
          .run(p.mode, p.spaceId, p.path);
        touch(call.ctx.db, p.spaceId);
        return done(call, p.spaceId, ["folders"]);
      },
    },
    "spaces.settings.set": {
      transactional: true,
      run(call: Call, p: P<"spaces.settings.set">): SpaceDetail {
        const db = call.ctx.db;
        new SpaceStore(db).require(p.spaceId);
        const what: string[] = [];
        // Letting automations change files widens what an unattended run may do (SP8): only
        // from the Mac. Turning it off works from any admin device.
        const writes = p.automationsWrite ?? [];
        if (writes.some((w) => w.allow)) requireHost(call, "Let automations change files");
        for (const w of writes) {
          if (folderRow(db, p.spaceId, w.path) === undefined) throw folderNotFound(w.path);
        }
        for (const w of writes) {
          db.sqlite
            .prepare(
              "UPDATE space_folders SET automations_write = ? WHERE space_id = ? AND path = ?",
            )
            .run(w.allow ? 1 : 0, p.spaceId, w.path);
        }
        if (writes.length > 0) what.push("folders");
        // Both only ever narrow at run time (SR5): the mode is capped by the owner's global
        // setting, and the connector scope only leaves tools out.
        if (p.defaultPermissionMode !== undefined) {
          db.sqlite
            .prepare("UPDATE spaces SET default_permission_mode = ? WHERE id = ?")
            .run(p.defaultPermissionMode, p.spaceId);
          what.push("row");
        }
        if (p.connectorScope !== undefined) {
          const scope = p.connectorScope === null ? null : [...new Set(p.connectorScope)];
          db.sqlite
            .prepare("UPDATE spaces SET connector_scope = ? WHERE id = ?")
            .run(scope === null ? null : JSON.stringify(scope), p.spaceId);
          if (!what.includes("row")) what.push("row");
        }
        touch(db, p.spaceId);
        return done(call, p.spaceId, what.length === 0 ? ["row"] : what);
      },
    },
  };
}

/** Wave S2's composition: the folder handlers over the composed broker. */
export function composeSpaceFolders(deps: SpaceFolderHandlerDeps): ComposedPart {
  return { handlers: spaceFolderHandlers(deps) };
}
