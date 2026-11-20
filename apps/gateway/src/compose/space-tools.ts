import { type AgentToolRegistration, defineTool, type ToolRunContext } from "@psyche/agent-core";
import type { PsycheDb } from "@psyche/db";
import {
  type EventName,
  type EventPayload,
  PsycheError,
  SPACE_LIMITS,
  type ToolResult,
} from "@psyche/protocol";
import { Type } from "@sinclair/typebox";
import { SpaceStore } from "../spaces/store.ts";
import { shelf, trackerThirdParty } from "./space-context.ts";

/**
 * The `space_*` agent tools (docs/design/spaces-2026.md §4.3, SP4), deferred like every tool
 * outside `ALWAYS_ON`. Each one works only on the run's own Space (fixed at run start, SR3) and
 * only in a turn that has read no third-party content: a tainted turn gets an error telling it to
 * ask the owner. The agent may add trackers and links; no tool here, or anywhere, writes a Space's
 * instructions, folders, connector scope, permission mode or privacy (SR1, SR9).
 * `space_propose` is wave S7.
 */

export interface SpaceToolDeps {
  readonly db: PsycheDb;
  publish<E extends EventName>(event: E, payload: EventPayload<E>): void;
}

const fail = (code: string, message: string): ToolResult => ({
  output: { error: { code, message } },
  isError: true,
  provenance: "trusted",
});

export const TAINTED_REFUSAL =
  "This turn has read third-party content, so the Space tools are off for the rest of it. Ask the owner to do this, or to ask again in a new message.";

/** The run's Space when this call may use it, else the refusal (tainted turns first). */
function ownSpace(ctx: ToolRunContext): { spaceId: string } | ToolResult {
  if (ctx.taint || (ctx.taintSources?.length ?? 0) > 0) return fail("tainted", TAINTED_REFUSAL);
  if (ctx.spaceId === undefined) return fail("not_in_space", "This chat is not in a Space.");
  return { spaceId: ctx.spaceId };
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
        "This chat's Space: its name, folders and modes, links, tracker ids (titles only for trackers with no third-party content) and automations. Only in a Space, and not after reading third-party content in this turn.",
      input: NoInput,
      sideEffect: "none",
      describeCall: () => ({ summary: "Read this Space" }),
      run: async (_p, ctx) => {
        const own = ownSpace(ctx);
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
        "Read trackers on this Space's shelf: title, summary, values and taint. Reading a tracker that holds third-party content marks this turn as having read it, so writes to new targets and sends ask and the other space_* tools stop working for the turn: read all you need in one call.",
      input: ReadInput,
      sideEffect: "none",
      describeCall: (p) => ({ summary: `Read ${p.widgetIds.length} Space tracker(s)` }),
      run: async (p, ctx) => {
        const own = ownSpace(ctx);
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
        const own = ownSpace(ctx);
        if (!("spaceId" in own)) return own;
        try {
          const added = db.sqlite.transaction(() => {
            const space = store().require(own.spaceId);
            if (space.archivedAt !== null)
              throw new PsycheError("conflict", "that Space is archived");
            const widget = db.sqlite
              .prepare("SELECT id, thread_id AS threadId, spec FROM widgets WHERE id = ?")
              .get(p.widgetId) as { id: string; threadId: string; spec: string } | undefined;
            // Only a widget of this chat: never one another chat, Space or channel drew (SR7).
            if (widget === undefined || widget.threadId !== ctx.threadId) {
              throw new PsycheError("not_found", "no widget with that id in this chat");
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
              .get(own.spaceId) as { n: number; top: number };
            if (n >= SPACE_LIMITS.trackers) {
              throw new PsycheError("conflict", "this Space already has 12 trackers");
            }
            const bound = /"bind"\s*:/.test(widget.spec);
            db.sqlite
              .prepare(
                `INSERT INTO space_trackers (space_id, widget_id, position, kind, added_by, created_at)
                 VALUES (?, ?, ?, ?, 'agent', ?)`,
              )
              .run(own.spaceId, widget.id, top + 1, bound ? "bound" : "agent", db.now());
            return widget.id;
          })();
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
        "Add a link to this Space: a web page (https), a Library item or a note. The owner sees it as added by Psyche. Not after reading third-party content in this turn.",
      input: AddLinkInput,
      sideEffect: "none",
      describeCall: (p) => ({ summary: `Added a link to this Space: ${p.label}` }),
      run: async (p, ctx) => {
        const own = ownSpace(ctx);
        if (!("spaceId" in own)) return own;
        if (p.kind === "url" && !URL_REF.test(p.ref)) {
          return fail("invalid_params", "a URL link must start with http:// or https://");
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
