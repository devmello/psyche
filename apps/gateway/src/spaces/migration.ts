import { getSetting, getThread, type PsycheDb, setSetting } from "@psyche/db";
import {
  type MethodName,
  type MethodParams,
  PsycheError,
  pinId,
  SPACE_LIMITS,
  type Space,
  type SpaceMigrationOffer,
  type SpaceOffers,
} from "@psyche/protocol";
import type { Call, HandlerDef } from "../context.ts";
import { projectPrivateError, SpaceStore } from "./store.ts";

/**
 * Migration offers (docs/design/spaces-2026.md §8, SP12). Nothing here converts anything by
 * itself: each function either reads and proposes, or runs after the owner's tap.
 *
 * - One offer for up to 5 active, non-private projects that have at least two owner or rule
 *   anchors. It stays until the owner creates or dismisses it, and then never returns.
 * - Pinned widgets stay on Home. When their chat is in a Space, the Space page offers the shelf.
 * - Standing instructions in a chat's summary stay there. When the chat is in a Space, the page
 *   offers the ones the owner gave. A pin an untrusted summary added is never offered.
 * - A chat where anyone but the owner wrote (a channel chat, or any chat with a message row that
 *   is not the owner's) offers no rules and no widgets at all (SR1): its summary can carry another
 *   person's words without taint.
 */

export const MAX_MIGRATION_PROJECTS = 5;
/** A project qualifies with at least this many owner or rule anchors (confirmed). */
export const MIN_ANCHORS = 2;

const STATE_KEY = "spaces.migration";
const dismissedKey = (spaceId: string) => `spaces.offers.dismissed.${spaceId}`;

/** What migration reads from Memory. The Gateway passes the people graph. */
export interface MigrationMemory {
  listEntities(kinds: ["project"]): readonly {
    id: string;
    name: string;
    private?: boolean | undefined;
    projectStatus?: string | undefined;
    lastInteractionAt?: string | null | undefined;
  }[];
  anchors(filter: { entityId: string }): readonly {
    kind: string;
    ref: string;
    addedBy: string;
    confirmed: boolean;
  }[];
}

/** What migration reads of a chat's compaction summary. */
export interface MigrationThreadStates {
  load(threadId: string): Promise<
    | {
        summary?:
          | {
              untrusted: boolean;
              structured?: { pinnedInstructions: string[] } | undefined;
              untrustedPins?: string[] | undefined;
            }
          | undefined;
      }
    | undefined
  >;
}

export interface MigrationDeps {
  readonly db: PsycheDb;
  readonly memory?: (() => MigrationMemory | undefined) | undefined;
  readonly states?: MigrationThreadStates | undefined;
}

const pinKey = (item: string) => item.replace(/\s+/g, " ").trim().toLowerCase();

interface Candidate {
  entityId: string;
  name: string;
  anchors: number;
  threadIds: string[];
  folders: number;
}

export class SpaceMigration {
  readonly #deps: MigrationDeps;

  constructor(deps: MigrationDeps) {
    this.#deps = deps;
  }

  get #db(): PsycheDb {
    return this.#deps.db;
  }

  #decided(): boolean {
    const v = getSetting(this.#db, STATE_KEY)?.value as { decided?: boolean } | undefined;
    return v?.decided === true;
  }

  #candidates(): Candidate[] {
    const memory = this.#deps.memory?.();
    if (memory === undefined) return [];
    const linked = new Set(
      (
        this.#db.sqlite
          .prepare("SELECT entity_id FROM spaces WHERE entity_id IS NOT NULL")
          .all() as {
          entity_id: string;
        }[]
      ).map((r) => r.entity_id),
    );
    const out: (Candidate & { last: string })[] = [];
    for (const e of memory.listEntities(["project"])) {
      if (e.private === true || linked.has(e.id)) continue;
      if (e.projectStatus !== undefined && e.projectStatus !== "active") continue;
      // Only owner and rule anchors count: a model's suggestion routes nothing (memory §2.5).
      const anchors = memory
        .anchors({ entityId: e.id })
        .filter((a) => a.confirmed && (a.addedBy === "owner" || a.addedBy === "rule"));
      if (anchors.length < MIN_ANCHORS) continue;
      const threadIds = anchors
        .filter((a) => a.kind === "chat_thread")
        .map((a) => a.ref)
        .filter((id) => {
          const t = getThread(this.#db, id);
          return t !== undefined && t.kind !== "main" && t.kind !== "incognito";
        });
      out.push({
        entityId: e.id,
        name: e.name.trim().slice(0, SPACE_LIMITS.name),
        anchors: anchors.length,
        threadIds: [...new Set(threadIds)],
        folders: anchors.filter((a) => a.kind === "folder").length,
        last: e.lastInteractionAt ?? "",
      });
    }
    out.sort(
      (a, b) =>
        b.anchors - a.anchors || b.last.localeCompare(a.last) || a.name.localeCompare(b.name),
    );
    return out.filter((c) => c.name !== "").slice(0, MAX_MIGRATION_PROJECTS);
  }

  /** The one offer, or null once the owner decided or when nothing qualifies. */
  offer(): SpaceMigrationOffer | null {
    if (this.#decided()) return null;
    const projects = this.#candidates();
    if (projects.length === 0) return null;
    return {
      projects: projects.map((c) => ({
        entityId: c.entityId,
        name: c.name,
        anchors: c.anchors,
        threads: c.threadIds.length,
        folders: c.folders,
      })),
    };
  }

  /**
   * The owner's Create. Only projects in the current offer are made (a stale or forged id is
   * refused), each linked to its project, with its anchored chats that have no Space yet moved in.
   * Run inside one transaction. Closes the offer.
   */
  apply(entityIds: readonly string[]): { spaces: Space[]; movedThreadIds: string[] } {
    if (this.#decided()) throw new PsycheError("conflict", "That offer is already closed.");
    const chosen = new Set(entityIds);
    // A project made Keep private since the offer is refused by name, not as a stale offer (SR10).
    const memory = this.#deps.memory?.();
    if (memory?.listEntities(["project"]).some((e) => chosen.has(e.id) && e.private === true)) {
      throw projectPrivateError();
    }
    const candidates = this.#candidates().filter((c) => chosen.has(c.entityId));
    if (candidates.length !== chosen.size) {
      throw new PsycheError("conflict", "One of those projects is no longer on the offer.");
    }
    const store = new SpaceStore(this.#db);
    const spaces: Space[] = [];
    const movedThreadIds: string[] = [];
    for (const c of candidates) {
      const space = store.create({ name: c.name, entityId: c.entityId, createdFrom: "migration" });
      const free = c.threadIds.filter((id) => getThread(this.#db, id)?.spaceId == null);
      if (free.length > 0) movedThreadIds.push(...store.moveThreads(free, space.id).moved);
      spaces.push(space);
    }
    setSetting(this.#db, STATE_KEY, {
      decided: true,
      outcome: "created",
      at: this.#db.now(),
    });
    return { spaces, movedThreadIds };
  }

  dismiss(): void {
    setSetting(this.#db, STATE_KEY, { decided: true, outcome: "dismissed", at: this.#db.now() });
  }

  #dismissed(spaceId: string): Set<string> {
    const v = getSetting(this.#db, dismissedKey(spaceId))?.value;
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  }

  dismissOffer(spaceId: string, offerId: string): void {
    new SpaceStore(this.#db).require(spaceId);
    const set = this.#dismissed(spaceId);
    set.add(offerId);
    // Newest 200 only: a Space's dismissals are not an unbounded list.
    setSetting(this.#db, dismissedKey(spaceId), [...set].slice(-200));
  }

  /**
   * The chats among `ids` where only the owner wrote: not a channel chat, and no message row from
   * anyone else. A user-role row that is not `owner` provenance is someone else's words (a channel
   * peer, a forwarded or agent-sent request), and an `untrusted` row of any role is third-party
   * text. Read from the rows, not from the summary's taint, which a peer's plain text never sets.
   */
  #ownerOnly(ids: readonly string[]): Set<string> {
    const marks = ids.map(() => "?").join(", ");
    const rows = this.#db.sqlite
      .prepare(
        `SELECT t.id FROM threads t
         WHERE t.id IN (${marks}) AND t.kind <> 'channel'
           AND NOT EXISTS (
             SELECT 1 FROM messages m
             WHERE m.thread_id = t.id
               AND (m.provenance = 'untrusted' OR (m.role = 'user' AND m.provenance <> 'owner'))
           )`,
      )
      .all(...ids) as { id: string }[];
    return new Set(rows.map((r) => r.id));
  }

  /**
   * Offers for a Space whose chats came in: their pinned widgets (not yet on the shelf, drawn from
   * trusted content only) and the standing instructions the owner gave in them. A widget that read
   * untrusted content and a pin that an untrusted summary added are never offered.
   */
  async offers(spaceId: string): Promise<SpaceOffers> {
    const space = new SpaceStore(this.#db).require(spaceId);
    const dismissed = this.#dismissed(spaceId);
    const threads = this.#db.sqlite
      .prepare("SELECT id, title FROM threads WHERE space_id = ? ORDER BY created_at, id")
      .all(spaceId) as { id: string; title: string | null }[];
    const titles = new Map(threads.map((t) => [t.id, t.title ?? ""]));
    const widgets: SpaceOffers["widgets"] = [];
    const rules: SpaceOffers["rules"] = [];
    if (threads.length === 0) return { widgets, rules };
    const owners = this.#ownerOnly(threads.map((t) => t.id));
    const ownerThreads = threads.filter((t) => owners.has(t.id));
    if (ownerThreads.length === 0) return { widgets, rules };

    const marks = ownerThreads.map(() => "?").join(", ");
    const pinned = this.#db.sqlite
      .prepare(
        `SELECT w.id, w.thread_id, w.taint, json_extract(w.spec, '$.title') AS title
         FROM widgets w
         WHERE w.pinned = 1 AND w.thread_id IN (${marks})
           AND NOT EXISTS (SELECT 1 FROM space_trackers t WHERE t.widget_id = w.id)
         ORDER BY w.updated_at DESC, w.id`,
      )
      .all(...ownerThreads.map((t) => t.id)) as {
      id: string;
      thread_id: string;
      taint: string;
      title: string | null;
    }[];
    for (const w of pinned) {
      if ((JSON.parse(w.taint) as unknown[]).length > 0) continue;
      const id = `widget:${w.id}`;
      if (dismissed.has(id)) continue;
      widgets.push({
        id,
        widgetId: w.id,
        title: (w.title ?? "").slice(0, 120),
        fromThreadId: w.thread_id,
      });
    }

    const have = new Set(space.instructions.split(/\r?\n/).map(pinKey));
    const seen = new Set<string>();
    const states = this.#deps.states;
    if (states !== undefined) {
      for (const t of ownerThreads) {
        const summary = (await states.load(t.id))?.summary;
        const pins = summary?.structured?.pinnedInstructions ?? [];
        if (pins.length === 0) continue;
        // A summary from before pins were tracked, and untrusted, counts every pin as untrusted.
        const bad = new Set(
          (summary?.untrustedPins ?? (summary?.untrusted === true ? pins : [])).map(pinKey),
        );
        for (const text of pins) {
          const k = pinKey(text);
          if (k === "" || bad.has(k) || have.has(k) || seen.has(k)) continue;
          const id = `rule:${pinId(text)}`;
          if (dismissed.has(id)) continue;
          seen.add(k);
          rules.push({
            id,
            text,
            fromThreadId: t.id,
            fromThreadTitle: (titles.get(t.id) ?? "").slice(0, 120),
          });
        }
      }
    }
    return { widgets, rules };
  }
}

type P<M extends MethodName> = MethodParams<M>;

/** `spaces.migration.*` and `spaces.offers.*` handlers. */
export function migrationHandlers(deps: MigrationDeps): Record<string, HandlerDef> {
  const migration = new SpaceMigration(deps);
  const changed = (call: Call, spaceId: string, what: string[]) => {
    call.ctx.bus.bumpStateVersion();
    call.emit("space.updated", { spaceId, changed: what });
  };
  return {
    "spaces.migration.offer": {
      run: () => ({ offer: migration.offer() }),
    },
    "spaces.migration.apply": {
      transactional: true,
      run(call: Call, p: P<"spaces.migration.apply">) {
        const { spaces, movedThreadIds } = migration.apply(p.entityIds);
        for (const s of spaces) changed(call, s.id, ["row"]);
        for (const id of movedThreadIds) {
          const thread = getThread(call.ctx.db, id);
          if (thread !== undefined) call.emit("thread.updated", { thread }, id);
        }
        return { spaces };
      },
    },
    "spaces.migration.dismiss": {
      run() {
        migration.dismiss();
        return { ok: true as const };
      },
    },
    "spaces.offers.list": {
      run: (_call: Call, p: P<"spaces.offers.list">) => migration.offers(p.spaceId),
    },
    "spaces.offers.dismiss": {
      run(_call: Call, p: P<"spaces.offers.dismiss">) {
        migration.dismissOffer(p.spaceId, p.offerId);
        return { ok: true as const };
      },
    },
  };
}
