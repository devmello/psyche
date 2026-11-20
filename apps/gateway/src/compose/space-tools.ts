import { type AgentToolRegistration, defineTool, type ToolRunContext } from "@psyche/agent-core";
import { getLibraryItem, getThread, type PsycheDb } from "@psyche/db";
import {
  type EventName,
  type EventPayload,
  PsycheError,
  SPACE_LIMITS,
  type ToolResult,
} from "@psyche/protocol";
import { Type } from "@sinclair/typebox";
import { SpaceStore } from "../spaces/store.ts";
import { hiddenByPrivateSpace, shelf, trackerThirdParty } from "./space-context.ts";

/**
 * The `space_*` agent tools (docs/design/spaces-2026.md §4.3, SP4), deferred like every tool
 * outside `ALWAYS_ON` and offered only in a run in a Space (the loop's `spaceHides`). Each one
 * works only on the run's own Space (fixed at run start, SR3). The two that add to it work only in
 * a turn that has read no third-party content: a tainted turn gets an error telling it to ask the
 * owner. `space_get` and `space_read_tracker` work in any turn (owner decision, r1 finding 3):
 * taint is sticky, and a Space chat that once read a mail must still reach its own Space. The
 * agent may add trackers and links; no tool here, or anywhere, writes a Space's instructions,
 * folders, connector scope, permission mode or privacy (SR1, SR9).
 * `space_propose` is wave S7.
 */

export interface SpaceToolDeps {
  readonly db: PsycheDb;
  publish<E extends EventName>(event: E, payload: EventPayload<E>): void;
  /**
   * Whether a memory note exists at this workspace path (`MemoryStore.entryKind`), for note
   * links. Without it the agent cannot add note links.
   */
  noteExists?: (path: string) => boolean;
}

const fail = (code: string, message: string): ToolResult => ({
  output: { error: { code, message } },
  isError: true,
  provenance: "trusted",
});

export const TAINTED_REFUSAL =
  "This turn has read third-party content, so adding to this Space is off for the rest of it. Ask the owner to do this, or to ask again in a new message.";

/**
 * The run's Space when this call may use it, else the refusal. Only the add tools (`write`) are
 * refused in a tainted turn (§4.3).
 */
function ownSpace(ctx: ToolRunContext, write: boolean): { spaceId: string } | ToolResult {
  if (write && (ctx.taint || (ctx.taintSources?.length ?? 0) > 0)) {
    return fail("tainted", TAINTED_REFUSAL);
  }
  if (ctx.spaceId === undefined) return fail("not_in_space", "This chat is not in a Space.");
  return { spaceId: ctx.spaceId };
}

/**
 * Puts a widget of the calling chat on a Space's shelf as the agent's tracker. The one place S3
 * writes `space_trackers`: wave S4's tracker store replaces this body with its own add method
 * (freeze, kind, refresh and template rules) when it lands (r1 finding 11).
 */
export function shelveAgentWidget(
  db: PsycheDb,
  input: { spaceId: string; widgetId: string; threadId: string },
): string {
  return db.sqlite.transaction(() => {
    const space = new SpaceStore(db).require(input.spaceId);
    if (space.archivedAt !== null) throw new PsycheError("conflict", "that Space is archived");
    const widget = db.sqlite
      .prepare("SELECT id, thread_id AS threadId, spec, state FROM widgets WHERE id = ?")
      .get(input.widgetId) as
      | { id: string; threadId: string; spec: string; state: string }
      | undefined;
    // Only a widget of this chat: never one another chat, Space or channel drew (SR7).
    if (widget === undefined || widget.threadId !== input.threadId) {
      throw new PsycheError("not_found", "no widget with that id in this chat");
    }
    // A frozen widget no longer updates: it cannot be a live tracker.
    if (widget.state !== "live") {
      throw new PsycheError("conflict", "that widget is frozen, so it cannot be a live tracker");
    }
    const onShelf = db.sqlite
      .prepare("SELECT space_id AS spaceId FROM space_trackers WHERE widget_id = ?")
      .get(widget.id) as { spaceId: string } | undefined;
    if (onShelf !== undefined) {
      throw new PsycheError("conflict", "that widget is already on a Space's shelf");
    }
    const { n, top } = db.sqlite
      .prepare(
        "SELECT count(*) AS n, coalesce(max(position), -1) AS top FROM space_trackers WHERE space_id = ?",
      )
      .get(input.spaceId) as { n: number; top: number };
    if (n >= SPACE_LIMITS.trackers) {
      throw new PsycheError("conflict", "this Space already has 12 trackers");
    }
    const bound = /"bind"\s*:/.test(widget.spec);
    db.sqlite
      .prepare(
        `INSERT INTO space_trackers (space_id, widget_id, position, kind, added_by, created_at)
         VALUES (?, ?, ?, ?, 'agent', ?)`,
      )
      .run(input.spaceId, widget.id, top + 1, bound ? "bound" : "agent", db.now());
    return widget.id;
  })();
}

/**
 * Why a Library item or note link may not be added from this run, or undefined when it may: the
 * item must exist and be one this run can see (r1 finding 12).
 */
function linkRefProblem(
  db: PsycheDb,
  deps: SpaceToolDeps,
  kind: "library_item" | "note",
  ref: string,
  runSpaceId: string,
): string | undefined {
  if (kind === "library_item") {
    const item = getLibraryItem(db, ref);
    if (item === undefined || item.quarantined) return "no Library item with that id";
    const from = item.threadId == null ? undefined : getThread(db, item.threadId);
    // An item saved from an incognito chat, or a private Space's chat, is not this run's to share.
    if (from !== undefined && from.kind === "incognito") return "no Library item with that id";
    if (from !== undefined && hiddenByPrivateSpace(db, from.spaceId, runSpaceId)) {
      return "no Library item with that id";
    }
    return undefined;
  }
  if (deps.noteExists === undefined) return "notes can't be linked here";
  const path = ref.trim();
  // A workspace path to a note: relative, inside the memory folder, and existing.
  if (path === "" || path.startsWith("/") || path.split(/[\\/]/).includes("..")) {
    return "a note link is a note's path in memory, like notes/plan.md";
  }
  return deps.noteExists(path) ? undefined : "no note at that path in memory";
}

const asError = (e: unknown): ToolResult => {
  const err = PsycheError.from(e);
  return fail(err.code, err.message);
};

function widgetTitle(spec: string): string | null {
  try {
    const t = (JSON.parse(spec) as { title?: unknown }).title;
    return typeof t === "string" ? t : null;
  } catch {
    return null;
  }
}

const NoInput = Type.Object({}, { additionalProperties: false });
const ReadInput = Type.Object(
  {
    widgetIds: Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      maxItems: SPACE_LIMITS.trackers,
      description: "Tracker ids from the Space card or space_get; read them in one call.",
    }),
  },
  { additionalProperties: false },
);
const AddTrackerInput = Type.Object(
  { widgetId: Type.String({ minLength: 1, description: "A widget you drew in this chat." }) },
  { additionalProperties: false },
);
const AGENT_LINK_KINDS = ["url", "library_item", "note"] as const;
const AddLinkInput = Type.Object(
  {
    kind: Type.Union(AGENT_LINK_KINDS.map((k) => Type.Literal(k))),
    ref: Type.String({ minLength: 1, maxLength: 2048 }),
    label: Type.String({ minLength: 1, maxLength: SPACE_LIMITS.linkLabel }),
  },
  { additionalProperties: false },
);

const URL_REF = /^https?:\/\/[^\s]+$/i;

export function spaceTools(deps: SpaceToolDeps): AgentToolRegistration[] {
  const { db } = deps;
  const store = () => new SpaceStore(db);
  const changed = (spaceId: string, what: string) => {
    deps.publish("space.updated", { spaceId, changed: [what] });
  };

  return [
    defineTool({
      name: "space_get",
      description:
        "This chat's Space: its name, folders and modes, links, tracker ids (titles only for trackers with no third-party content) and automations. Only in a Space.",
      input: NoInput,
      sideEffect: "none",
      describeCall: () => ({ summary: "Read this Space" }),
      run: async (_p, ctx) => {
        const own = ownSpace(ctx, false);
        if (!("spaceId" in own)) return own;
        try {
          const detail = store().detail(own.spaceId);
          const automations = db.sqlite
            .prepare(
              "SELECT id, title, enabled, next_run_at AS nextRunAt FROM automations WHERE space_id = ? ORDER BY created_at, id",
            )
            .all(own.spaceId) as {
            id: string;
            title: string;
            enabled: number;
            nextRunAt: string | null;
          }[];
          return {
            output: {
              space: {
                id: detail.space.id,
                name: detail.space.name,
                description: detail.space.description,
                private: detail.space.private,
                archived: detail.space.archivedAt !== null,
              },
              folders: detail.folders.map((f) => ({ path: f.path, mode: f.mode })),
              links: detail.links.map((l) => ({
                id: l.id,
                kind: l.kind,
                ref: l.ref,
                // A label written by a third party is never shown as text the model may trust.
                label: l.labelProvenance === "untrusted" ? null : l.label,
                addedBy: l.addedBy,
              })),
              trackers: shelf(db, own.spaceId).map((row) => {
                const thirdParty = trackerThirdParty(row);
                return {
                  widgetId: row.widgetId,
                  kind: row.kind,
                  thirdParty,
                  title: thirdParty ? null : widgetTitle(row.spec),
                };
              }),
              automations: automations.map((a) => ({
                id: a.id,
                title: a.title,
                enabled: a.enabled === 1,
                nextRunAt: a.nextRunAt,
              })),
            },
            provenance: "trusted",
          };
        } catch (e) {
          return asError(e);
        }
      },
    }),
    defineTool({
      name: "space_read_tracker",
      description:
        "Read trackers on this Space's shelf: title, summary, values and taint. Reading a tracker that holds third-party content marks this turn as having read it, so writes to new targets and sends ask and space_add_tracker and space_add_link stop working for the turn: read all you need in one call.",
      input: ReadInput,
      sideEffect: "none",
      describeCall: (p) => ({ summary: `Read ${p.widgetIds.length} Space tracker(s)` }),
      run: async (p, ctx) => {
        const own = ownSpace(ctx, false);
        if (!("spaceId" in own)) return own;
        const rows = new Map(shelf(db, own.spaceId).map((r) => [r.widgetId, r]));
        const missing = p.widgetIds.filter((id) => !rows.has(id));
        if (missing.length > 0) {
          return fail("not_found", `Not on this Space's shelf: ${missing.join(", ")}`);
        }
        let untrusted = false;
        const trackers = [...new Set(p.widgetIds)].map((id) => {
          const row = rows.get(id) as NonNullable<ReturnType<typeof rows.get>>;
          const thirdParty = trackerThirdParty(row);
          if (thirdParty) untrusted = true;
          let spec: unknown = null;
          let taint: unknown = [];
          try {
            spec = JSON.parse(row.spec);
            taint = JSON.parse(row.taint);
          } catch {
            untrusted = true;
          }
          return { widgetId: id, kind: row.kind, thirdParty, taint, spec };
        });
        // Third-party values are data: the loop taints the turn from this provenance (§5.5).
        return { output: { trackers }, provenance: untrusted ? "untrusted" : "trusted" };
      },
    }),
    defineTool({
      name: "space_add_tracker",
      description:
        "Put a widget you drew in this chat on this Space's shelf, where it stays live (12 at most). The owner sees it as added by Psyche and can remove it. Not after reading third-party content in this turn.",
      input: AddTrackerInput,
      sideEffect: "none",
      describeCall: () => ({ summary: "Added a tracker to this Space" }),
      run: async (p, ctx) => {
        const own = ownSpace(ctx, true);
        if (!("spaceId" in own)) return own;
        try {
          const added = shelveAgentWidget(db, {
            spaceId: own.spaceId,
            widgetId: p.widgetId,
            threadId: ctx.threadId,
          });
          changed(own.spaceId, "trackers");
          return { output: { widgetId: added, spaceId: own.spaceId }, provenance: "trusted" };
        } catch (e) {
          return asError(e);
        }
      },
    }),
    defineTool({
      name: "space_add_link",
      description:
        "Add a link to this Space: a web page (https), a Library item (its id) or a note (its path in memory). The owner sees it as added by Psyche. Not after reading third-party content in this turn.",
      input: AddLinkInput,
      sideEffect: "none",
      describeCall: (p) => ({ summary: `Added a link to this Space: ${p.label}` }),
      run: async (p, ctx) => {
        const own = ownSpace(ctx, true);
        if (!("spaceId" in own)) return own;
        if (p.kind === "url" && !URL_REF.test(p.ref)) {
          return fail("invalid_params", "a URL link must start with http:// or https://");
        }
        if (p.kind !== "url") {
          const problem = linkRefProblem(db, deps, p.kind, p.ref, own.spaceId);
          if (problem !== undefined) return fail("not_found", problem);
        }
        try {
          const space = store().require(own.spaceId);
          if (space.archivedAt !== null) return fail("conflict", "that Space is archived");
          const link = store().addLink(
            own.spaceId,
            { kind: p.kind, ref: p.ref, label: p.label },
            "agent",
          );
          changed(own.spaceId, "links");
          return { output: { linkId: link.id }, provenance: "trusted" };
        } catch (e) {
          return asError(e);
        }
      },
    }),
  ];
}
