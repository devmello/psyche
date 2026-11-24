import {
  type EventName,
  type EventPayload,
  type MethodName,
  type MethodParams,
  PsycheError,
  SPACE_LIMITS,
  type SpaceContextSection,
  type SpaceDetail,
  type SpaceMigrationOffer,
  type SpaceOffers,
  type SpaceProposal,
  type SpaceSummary,
  type SpaceTracker,
  type SpaceTrackerTemplate,
  type SpaceTrackerValue,
  type ThreadListEntry,
  type Widget,
  type WidgetSpec,
} from "@psyche/protocol";

/**
 * The `spaces.*` methods of the MockGateway (docs/design/spaces-2026.md §4.2) over a fixture
 * `SpacesWorld`, so the Spaces UI (S5) runs without the real handlers (S1). Moving a thread
 * writes `spaceId` on the world's thread, adding a tracker writes it on the widget, and every
 * write emits `space.updated`, like the Gateway will.
 */

export interface SpacesWorld {
  spaces: SpaceDetail[];
  /** Per Space, how many items are due (the real count comes from Memory's work items). */
  due?: Record<string, number>;
  /** Per Space, the sections `spaces.context.preview` answers (default: the instructions). */
  previews?: Record<string, SpaceContextSection[]>;
  /** Agent proposals (`spaces.proposals.*`). */
  proposals?: SpaceProposal[];
  /** The migration offer, or null / absent when none is made or it was decided. */
  migration?: SpaceMigrationOffer | null;
  /** Per Space, the offers its page shows after chats moved in (`spaces.offers.list`). */
  offers?: Record<string, SpaceOffers>;
  /** Per Space, tracker ids that were refreshed through `spaces.trackers.refresh`, for tests. */
  refreshed?: string[];
}

export function emptySpaces(): SpacesWorld {
  return { spaces: [] };
}

export interface SpacesMockContext {
  world: () => SpacesWorld;
  threads: () => ThreadListEntry[];
  setThreads: (next: ThreadListEntry[]) => void;
  widgets: () => Widget[];
  setWidgets: (next: Widget[]) => void;
  now: () => string;
  id: (prefix: string) => string;
  emit: <E extends EventName>(event: E, payload: EventPayload<E>) => void;
}

type Handlers = { [M in MethodName]?: (params: MethodParams<M>) => unknown };

const TEMPLATE_TITLE: Record<SpaceTrackerTemplate, string> = {
  work_due: "Work due",
  next_events: "Next events",
  recent_files: "Recent files",
  mail_on_this: "Mail on this",
  checklist: "Checklist",
  automation_status: "Automation status",
};

function templateSpec(template: SpaceTrackerTemplate): WidgetSpec {
  const title = TEMPLATE_TITLE[template];
  return {
    v: 1,
    title,
    fallbackText: `${title}: nothing yet.`,
    root: { id: "root", type: "status", label: "Nothing yet", tone: "neutral" },
  } as WidgetSpec;
}

export function spacesHandlers(ctx: SpacesMockContext): Handlers {
  const find = (spaceId: string): SpaceDetail => {
    const hit = ctx.world().spaces.find((s) => s.space.id === spaceId);
    if (hit === undefined) throw new PsycheError("not_found", `space ${spaceId} not found`);
    return hit;
  };
  const chatsOf = (spaceId: string) =>
    ctx.threads().filter((e) => e.thread.spaceId === spaceId && e.thread.archivedAt == null);
  const lastActivity = (detail: SpaceDetail): string | null => {
    const stamps = chatsOf(detail.space.id)
      .map((e) => e.thread.lastMessageAt ?? e.thread.updatedAt)
      .sort();
    return stamps[stamps.length - 1] ?? detail.lastActivityAt ?? null;
  };
  const counts = (detail: SpaceDetail) => ({
    chats: chatsOf(detail.space.id).length,
    trackers: detail.trackers.length,
    due: ctx.world().due?.[detail.space.id] ?? detail.counts.due,
  });
  const view = (detail: SpaceDetail): SpaceDetail => ({
    ...detail,
    counts: counts(detail),
    lastActivityAt: lastActivity(detail),
  });
  const summary = (detail: SpaceDetail): SpaceSummary => ({
    id: detail.space.id,
    name: detail.space.name,
    description: detail.space.description ?? null,
    icon: detail.space.icon ?? null,
    entityId: detail.space.entityId ?? null,
    private: detail.space.private,
    sort: detail.space.sort,
    archivedAt: detail.space.archivedAt ?? null,
    counts: counts(detail),
    lastActivityAt: lastActivity(detail),
  });
  const changed = (detail: SpaceDetail, what: string[]) => {
    detail.space = { ...detail.space, updatedAt: ctx.now() };
    ctx.emit("space.updated", { spaceId: detail.space.id, changed: what });
  };
  const setWidgetSpace = (widgetId: string, spaceId: string | null) => {
    ctx.setWidgets(ctx.widgets().map((w) => (w.id === widgetId ? { ...w, spaceId } : w)));
  };
  const addTracker = (detail: SpaceDetail, widgetId: string, addedBy: SpaceTracker["addedBy"]) => {
    if (detail.trackers.some((tr) => tr.widgetId === widgetId)) return;
    if (detail.trackers.length >= SPACE_LIMITS.trackers) {
      throw new PsycheError("conflict", `A shelf holds at most ${SPACE_LIMITS.trackers} trackers.`);
    }
    const widget = ctx.widgets().find((w) => w.id === widgetId);
    const taint = widget?.taint ?? [];
    detail.trackers = [
      ...detail.trackers,
      {
        widgetId,
        position: detail.trackers.length,
        kind: "bound",
        staleAfterS: null,
        refreshedAt: null,
        addedBy,
        createdAt: ctx.now(),
        ...(taint.length > 0 ? { taint } : {}),
      },
    ];
    setWidgetSpace(widgetId, detail.space.id);
  };
  const makeSpace = (
    p: {
      name: string;
      description?: string;
      icon?: string;
      instructions?: string;
      entityId?: string;
    },
    createdFrom: SpaceDetail["space"]["createdFrom"] = "owner",
  ): SpaceDetail => {
    const world = ctx.world();
    const now = ctx.now();
    const detail: SpaceDetail = {
      space: {
        id: ctx.id("spc"),
        name: p.name,
        description: p.description ?? null,
        icon: p.icon ?? null,
        instructions: p.instructions ?? "",
        instructionsRev: 1,
        entityId: p.entityId ?? null,
        defaultPermissionMode: null,
        connectorScope: null,
        private: false,
        sort: world.spaces.reduce((max, s) => Math.max(max, s.space.sort), 0) + 1,
        archivedAt: null,
        createdFrom,
        createdAt: now,
        updatedAt: now,
      },
      folders: [],
      links: [],
      trackers: [],
      automationIds: [],
      goalIds: [],
      counts: { chats: 0, trackers: 0, due: 0 },
      lastActivityAt: null,
    };
    world.spaces.push(detail);
    ctx.emit("space.updated", { spaceId: detail.space.id, changed: ["row"] });
    return detail;
  };
  const moveIn = (threadIds: readonly string[], spaceId: string) => {
    ctx.setThreads(
      ctx
        .threads()
        .map((e) =>
          threadIds.includes(e.thread.id) && e.thread.spaceId == null
            ? { ...e, thread: { ...e.thread, spaceId } }
            : e,
        ),
    );
  };
  const decide = (proposalId: string, status: "accepted" | "dismissed"): SpaceProposal => {
    const world = ctx.world();
    const found = (world.proposals ?? []).find((x) => x.id === proposalId);
    if (found === undefined) throw new PsycheError("not_found", `proposal ${proposalId} not found`);
    if (found.status !== "open")
      throw new PsycheError("conflict", "that proposal is already decided");
    const next = { ...found, status, decidedAt: ctx.now() };
    world.proposals = (world.proposals ?? []).map((x) => (x.id === proposalId ? next : x));
    return found;
  };
  const reindex = (detail: SpaceDetail) => {
    detail.trackers = detail.trackers.map((tr, position) => ({ ...tr, position }));
  };

  return {
    "spaces.list": (p) => {
      const archived = p.archived === true;
      return {
        spaces: ctx
          .world()
          .spaces.filter((s) => (s.space.archivedAt != null) === archived)
          .map(summary)
          .sort((a, b) => a.sort - b.sort),
      };
    },
    "spaces.get": (p) => view(find(p.spaceId)),
    "spaces.create": (p) => {
      const detail = makeSpace(p);
      return { space: detail.space };
    },
    "spaces.update": (p) => {
      const detail = find(p.spaceId);
      const s = detail.space;
      detail.space = {
        ...s,
        ...(p.name === undefined ? {} : { name: p.name }),
        ...(p.description === undefined ? {} : { description: p.description }),
        ...(p.icon === undefined ? {} : { icon: p.icon }),
        ...(p.entityId === undefined ? {} : { entityId: p.entityId }),
        ...(p.private === undefined ? {} : { private: p.private }),
        ...(p.sort === undefined ? {} : { sort: p.sort }),
        ...(p.instructions === undefined || p.instructions === s.instructions
          ? {}
          : { instructions: p.instructions, instructionsRev: s.instructionsRev + 1 }),
      };
      changed(detail, ["row"]);
      return { space: detail.space };
    },
    "spaces.archive": (p) => {
      const detail = find(p.spaceId);
      detail.space = { ...detail.space, archivedAt: ctx.now() };
      changed(detail, ["archived"]);
      return { space: detail.space };
    },
    "spaces.restore": (p) => {
      const detail = find(p.spaceId);
      detail.space = { ...detail.space, archivedAt: null };
      changed(detail, ["archived"]);
      return { space: detail.space };
    },
    "spaces.delete": (p) => {
      const detail = find(p.spaceId);
      const world = ctx.world();
      world.spaces = world.spaces.filter((s) => s !== detail);
      ctx.setThreads(
        ctx
          .threads()
          .map((e) =>
            e.thread.spaceId === p.spaceId ? { ...e, thread: { ...e.thread, spaceId: null } } : e,
          ),
      );
      for (const tr of detail.trackers) setWidgetSpace(tr.widgetId, null);
      ctx.emit("space.updated", { spaceId: p.spaceId, changed: ["deleted"] });
      return { ok: true };
    },
    "spaces.folders.add": (p) => {
      const detail = find(p.spaceId);
      if (p.path === undefined) throw new Error("pick the folder to add on your Mac");
      const folder = {
        path: p.path,
        real: p.path,
        mode: p.mode ?? "ro",
        automationsWrite: false,
        addedAt: ctx.now(),
        addedByDevice: null,
      };
      detail.folders = [...detail.folders.filter((f) => f.path !== p.path), folder];
      changed(detail, ["folders"]);
      return view(detail);
    },
    "spaces.folders.remove": (p) => {
      const detail = find(p.spaceId);
      detail.folders = detail.folders.filter((f) => f.path !== p.path);
      changed(detail, ["folders"]);
      return view(detail);
    },
    "spaces.folders.setMode": (p) => {
      const detail = find(p.spaceId);
      detail.folders = detail.folders.map((f) => (f.path === p.path ? { ...f, mode: p.mode } : f));
      changed(detail, ["folders"]);
      return view(detail);
    },
    "spaces.settings.set": (p) => {
      const detail = find(p.spaceId);
      const writes = p.automationsWrite ?? [];
      for (const w of writes) {
        if (!detail.folders.some((f) => f.path === w.path)) {
          throw new PsycheError("not_found", `${w.path} is not a folder of this Space`);
        }
      }
      if (p.defaultPermissionMode !== undefined) {
        detail.space = { ...detail.space, defaultPermissionMode: p.defaultPermissionMode };
      }
      if (p.connectorScope !== undefined) {
        detail.space = {
          ...detail.space,
          connectorScope: p.connectorScope === null ? null : [...new Set(p.connectorScope)],
        };
      }
      detail.folders = detail.folders.map((f) => {
        const w = writes.find((x) => x.path === f.path);
        return w === undefined ? f : { ...f, automationsWrite: w.allow };
      });
      changed(detail, writes.length > 0 ? ["folders", "row"] : ["row"]);
      return view(detail);
    },
    "spaces.links.add": (p) => {
      const detail = find(p.spaceId);
      // The Gateway's refusal, word for word (apps/gateway/src/spaces/handlers.ts).
      if (p.kind === "url" && !/^https?:\/\//i.test(p.ref)) {
        throw new PsycheError("invalid_params", "a URL link must start with http:// or https://");
      }
      const link = {
        id: ctx.id("lnk"),
        kind: p.kind,
        ref: p.ref,
        label: p.label,
        labelProvenance: "owner" as const,
        addedBy: "owner" as const,
        createdAt: ctx.now(),
      };
      detail.links = [...detail.links, link];
      changed(detail, ["links"]);
      return { link };
    },
    "spaces.links.remove": (p) => {
      const detail = find(p.spaceId);
      detail.links = detail.links.filter((l) => l.id !== p.linkId);
      changed(detail, ["links"]);
      return { ok: true };
    },
    "spaces.threads.move": (p) => {
      if (p.spaceId != null) find(p.spaceId);
      let moved = 0;
      const touched = new Set<string>(p.spaceId == null ? [] : [p.spaceId]);
      const next = ctx.threads().map((e) => {
        if (!p.threadIds.includes(e.thread.id)) return e;
        moved += 1;
        if (e.thread.spaceId != null) touched.add(e.thread.spaceId);
        return { ...e, thread: { ...e.thread, spaceId: p.spaceId ?? null } };
      });
      ctx.setThreads(next);
      for (const e of next) {
        if (p.threadIds.includes(e.thread.id)) ctx.emit("thread.updated", { thread: e.thread });
      }
      for (const id of touched) {
        const hit = ctx.world().spaces.find((s) => s.space.id === id);
        if (hit !== undefined) changed(hit, ["row"]);
      }
      return { moved };
    },
    "spaces.automations.move": (p) => ({ moved: p.automationIds.length }),
    "spaces.trackers.add": (p) => {
      const detail = find(p.spaceId);
      if (p.widgetId !== undefined) {
        if (!ctx.widgets().some((w) => w.id === p.widgetId)) {
          throw new PsycheError("not_found", `widget ${p.widgetId} not found`);
        }
        addTracker(detail, p.widgetId, "owner");
      } else if (p.template !== undefined) {
        const now = ctx.now();
        const widget: Widget = {
          id: ctx.id("wdg"),
          threadId: "",
          messageId: "",
          rev: 1,
          spec: templateSpec(p.template),
          taint: [],
          owner: { kind: "run", runId: "" },
          state: "live",
          pinned: false,
          spaceId: detail.space.id,
          createdAt: now,
          updatedAt: now,
        };
        ctx.setWidgets([...ctx.widgets(), widget]);
        addTracker(detail, widget.id, "template");
      } else {
        throw new PsycheError("invalid_params", "Give a widgetId or a template.");
      }
      changed(detail, ["shelf"]);
      return view(detail);
    },
    "spaces.trackers.remove": (p) => {
      const detail = find(p.spaceId);
      detail.trackers = detail.trackers.filter((tr) => tr.widgetId !== p.widgetId);
      reindex(detail);
      setWidgetSpace(p.widgetId, null);
      changed(detail, ["shelf"]);
      return view(detail);
    },
    "spaces.trackers.reorder": (p) => {
      const detail = find(p.spaceId);
      const rank = (id: string) => {
        const i = p.widgetIds.indexOf(id);
        return i === -1 ? Number.MAX_SAFE_INTEGER : i;
      };
      detail.trackers = [...detail.trackers].sort((a, b) => rank(a.widgetId) - rank(b.widgetId));
      reindex(detail);
      changed(detail, ["shelf"]);
      return view(detail);
    },
    "spaces.trackers.refresh": (p) => {
      const detail = find(p.spaceId);
      const at = ctx.now();
      detail.trackers = detail.trackers.map((tr) =>
        tr.widgetId === p.widgetId ? { ...tr, refreshedAt: at } : tr,
      );
      const world = ctx.world();
      world.refreshed = [...(world.refreshed ?? []), p.widgetId];
      ctx.emit("space.tracker.refreshed", {
        spaceId: p.spaceId,
        widgetId: p.widgetId,
        refreshedAt: at,
      });
      const tracker: SpaceTrackerValue = { widgetId: p.widgetId, refreshedAt: at, stale: false };
      return { tracker };
    },
    "spaces.open": (p) => {
      const detail = find(p.spaceId);
      return {
        trackers: detail.trackers
          .filter((tr) => tr.refreshedAt != null)
          .map(
            (tr): SpaceTrackerValue => ({
              widgetId: tr.widgetId,
              refreshedAt: tr.refreshedAt as string,
              stale: false,
            }),
          ),
      };
    },
    "spaces.context.preview": (p) => {
      const detail = find(p.spaceId);
      const preset = ctx.world().previews?.[p.spaceId];
      if (preset !== undefined) return { sections: preset };
      const text = detail.space.instructions;
      return {
        sections:
          text === ""
            ? []
            : [{ kind: "instructions", text, chars: text.length, cap: SPACE_LIMITS.instructions }],
      };
    },
    "spaces.proposals.list": (p) => ({
      proposals: (ctx.world().proposals ?? []).filter(
        (x) => p.status !== "open" || x.status === "open",
      ),
    }),
    "spaces.proposals.accept": (p) => {
      const found = decide(p.proposalId, "accepted");
      const detail = makeSpace(
        {
          name: p.name ?? found.name,
          ...(found.entityId === null ? {} : { entityId: found.entityId }),
        },
        "proposal",
      );
      moveIn(found.threadIds, detail.space.id);
      return { space: detail.space };
    },
    "spaces.proposals.dismiss": (p) => {
      decide(p.proposalId, "dismissed");
      return { ok: true };
    },
    "spaces.migration.offer": () => ({ offer: ctx.world().migration ?? null }),
    "spaces.migration.apply": (p) => {
      const world = ctx.world();
      const offer = world.migration;
      if (offer == null) throw new PsycheError("conflict", "That offer is already closed.");
      const spaces = offer.projects
        .filter((x) => p.entityIds.includes(x.entityId))
        .map((x) => makeSpace({ name: x.name, entityId: x.entityId }, "migration").space);
      world.migration = null;
      return { spaces };
    },
    "spaces.migration.dismiss": () => {
      ctx.world().migration = null;
      return { ok: true };
    },
    "spaces.offers.list": (p) => ctx.world().offers?.[p.spaceId] ?? { widgets: [], rules: [] },
    "spaces.offers.dismiss": (p) => {
      const world = ctx.world();
      const offers = world.offers?.[p.spaceId];
      if (offers !== undefined) {
        world.offers = {
          ...world.offers,
          [p.spaceId]: {
            widgets: offers.widgets.filter((w) => w.id !== p.offerId),
            rules: offers.rules.filter((r) => r.id !== p.offerId),
          },
        };
      }
      return { ok: true };
    },
  };
}
