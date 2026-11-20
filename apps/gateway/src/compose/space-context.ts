import {
  type RunSpace,
  SPACE_INSTRUCTIONS_CAP,
  spaceSection,
  TRUSTED_CONTEXT_CAP,
  type TurnContextProvider,
} from "@psyche/agent-core";
import { getThread, type PsycheDb } from "@psyche/db";
import {
  collectWidgetBinds,
  type MethodParams,
  PsycheError,
  type SpaceContextSection,
} from "@psyche/protocol";
import type { Call, HandlerDef } from "../context.ts";
import { SpaceStore } from "../spaces/store.ts";
import type { ComposedPart, ComposeServices } from "./services.ts";
import { type SpaceToolDeps, spaceTools } from "./space-tools.ts";

/**
 * Spaces wave S3 (docs/design/spaces-2026.md §5): what a run in a Space gets.
 * - The head: the owner's instructions as a `space` section at the end of the stable head
 *   (`spaceSection` in agent-core), read once at run start with the connector scope (`spaceFor`).
 * - The per-turn block: three trusted, code-built sections of at most 1,200 characters each (the
 *   card, work in this Space, tracker summaries) from the `space` turn context provider, for
 *   owner turns and automation runs alike. They follow the run's own Space (the one its head and
 *   connector scope come from), and they are turn context, never part of the owner's words, so
 *   nothing in them becomes an owner-named target (r1 findings 1 and 4).
 * - `spaces.context.preview`: exactly those texts with their sizes.
 * A thread outside a Space gets none of it, so its prompt is byte-identical to before (SR13).
 */

/** Thread kinds a Space applies to: never channels, incognito or subagent threads (SR11). */
const SPACE_THREAD_KINDS = new Set(["side", "automation"]);

/**
 * Binding sources Psyche itself keeps (generative-ui §6.4): a tracker bound only to these, with
 * no taint, holds no third-party text. Every other source (research claims, mail, calendar,
 * reminders, files, memory, anything new) counts as third-party until proven otherwise (§5.5).
 */
const INTERNAL_BIND_SOURCES = new Set(["task", "automation", "tool_call", "job"]);

const LINE_CAP = 300;

/**
 * The run's Space for a thread: its own `space_id`, or the running automation's (§5.1). An
 * archived Space gives no context: the run is a plain chat (owner decision, r1 finding 8).
 */
export function runSpaceFor(db: PsycheDb, threadId: string): RunSpace | undefined {
  const thread = getThread(db, threadId);
  if (thread === undefined || !SPACE_THREAD_KINDS.has(thread.kind)) return undefined;
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
  return runSpaceById(db, spaceId);
}

/**
 * A Space by id for a run that inherits it (a specialist job, §5.1), or undefined when it is gone
 * or archived.
 */
export function runSpaceById(db: PsycheDb, spaceId: string): RunSpace | undefined {
  const space = new SpaceStore(db).get(spaceId);
  if (space === undefined || space.archivedAt !== null) return undefined;
  return {
    id: space.id,
    name: space.name,
    instructions: space.instructions,
    connectorScope: space.connectorScope ?? null,
  };
}

/** A line `fit` never cuts at `LINE_CAP`: its builder already capped it by whole items. */
interface WholeLine {
  whole: string;
}

/** Lines joined until the next would pass `cap`; the rest becomes one visible marker. */
function fit(lines: readonly (string | WholeLine)[], cap: number): string {
  const out: string[] = [];
  let used = 0;
  for (const [i, raw] of lines.entries()) {
    const line =
      typeof raw !== "string"
        ? raw.whole
        : raw.length > LINE_CAP
          ? `${raw.slice(0, LINE_CAP)}…`
          : raw;
    const marker = `[${lines.length - i} more lines: read them with space_get]`;
    const reserve = i === lines.length - 1 ? 0 : marker.length + 1;
    if (used + line.length + 1 + reserve > cap) {
      out.push(marker);
      break;
    }
    out.push(line);
    used += line.length + 1;
  }
  return out.join("\n");
}

interface TrackerRow {
  widgetId: string;
  kind: string;
  spec: string;
  taint: string;
}

/** Every binding source in a widget spec, at any depth the widget validator allows (r1 #5). */
function bindSources(spec: unknown): Set<string> {
  const root = (spec as { root?: unknown } | null)?.root;
  return new Set(collectWidgetBinds(root).map((b) => String(b.bind.source)));
}

/** Room the third-party ids line may take: whole ids only, then "+N more" (r1 finding 6). */
const IDS_LINE_CAP = 900;

/** `lead` and as many whole ids as fit in `cap`, then how many more `space_get` lists. */
export function idsLine(lead: string, ids: readonly string[], cap = IDS_LINE_CAP): string {
  let text = lead;
  for (const [i, id] of ids.entries()) {
    const next = `${text}${i === 0 ? "" : ", "}${id}`;
    const rest = ids.length - i - 1;
    const tail = rest === 0 ? "" : ` (+${rest} more: space_get lists them)`;
    if (next.length + tail.length > cap) {
      return `${text}${i === 0 ? "" : " "}(+${ids.length - i} more: space_get lists them)`;
    }
    text = next;
  }
  return text;
}

/**
 * Whether a tracker may hold third-party content (§5.5, SR6): any taint, a query tracker (its
 * source carries its own provenance, wave S4), or a binding to anything but Psyche's own records.
 * Fail closed: an unreadable spec or taint counts as third-party.
 */
export function trackerThirdParty(row: Pick<TrackerRow, "kind" | "spec" | "taint">): boolean {
  if (row.kind === "query") return true;
  try {
    const taint = JSON.parse(row.taint) as unknown;
    if (!Array.isArray(taint) || taint.length > 0) return true;
    const sources = bindSources(JSON.parse(row.spec));
    return [...sources].some((s) => !INTERNAL_BIND_SOURCES.has(s));
  } catch {
    return true;
  }
}

export function shelf(db: PsycheDb, spaceId: string): TrackerRow[] {
  return db.sqlite
    .prepare(
      `SELECT t.widget_id AS widgetId, t.kind AS kind, w.spec AS spec, w.taint AS taint
       FROM space_trackers t JOIN widgets w ON w.id = t.widget_id
       WHERE t.space_id = ? ORDER BY t.position, t.created_at, t.widget_id`,
    )
    .all(spaceId) as TrackerRow[];
}

function oneLine(text: unknown): string {
  return typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
}

export interface SpaceTurnSections {
  card: string;
  work: string;
  trackers: string;
}

/**
 * The three per-turn sections, code-built from owner data only, each within `TRUSTED_CONTEXT_CAP`.
 * Link labels are the owner's; the agent's are counted. Third-party trackers appear only as a
 * count with ids, never with a title or a value (lazy taint, §5.5 rule 2).
 */
export function spaceTurnSections(db: PsycheDb, spaceId: string): SpaceTurnSections {
  const store = new SpaceStore(db);
  const detail = store.detail(spaceId);
  const { space } = detail;
  const card: string[] = [
    `You are working in the Space "${space.name}"${space.private ? " (kept private)" : ""}.`,
  ];
  if (typeof space.description === "string" && space.description.trim() !== "") {
    card.push(oneLine(space.description));
  }
  card.push(
    detail.folders.length === 0
      ? "Folders: none granted in this Space."
      : `Folders: ${detail.folders.map((f) => `${f.path} (${f.mode === "rw" ? "read & write" : "read only"})`).join("; ")}`,
  );
  const ownerLinks = detail.links.filter((l) => l.labelProvenance === "owner");
  const otherLinks = detail.links.length - ownerLinks.length;
  for (const l of ownerLinks) card.push(`Link: ${oneLine(l.label)} (${l.kind})`);
  if (otherLinks > 0) card.push(`${otherLinks} more links added by Psyche (space_get lists them).`);
  const runs = db.sqlite
    .prepare(
      `SELECT title, next_run_at AS nextRunAt FROM automations
       WHERE space_id = ? AND enabled = 1 AND next_run_at IS NOT NULL
       ORDER BY next_run_at, id LIMIT 5`,
    )
    .all(spaceId) as { title: string; nextRunAt: string }[];
  for (const r of runs) card.push(`Automation "${oneLine(r.title)}" runs next at ${r.nextRunAt}.`);
  card.push(`Chats in this Space: ${detail.counts.chats}.`);

  const work =
    space.entityId === null
      ? ""
      : `This Space is linked to the memory project ${space.entityId}. Its status, next step and work due are in memory; memory and search tools rank it first here.`;

  const rows = shelf(db, spaceId);
  const own: string[] = [];
  const thirdParty: string[] = [];
  for (const row of rows) {
    if (trackerThirdParty(row)) {
      thirdParty.push(row.widgetId);
      continue;
    }
    let spec: { title?: unknown; fallbackText?: unknown } = {};
    try {
      spec = JSON.parse(row.spec) as typeof spec;
    } catch {
      thirdParty.push(row.widgetId);
      continue;
    }
    own.push(`Tracker ${row.widgetId} "${oneLine(spec.title)}": ${oneLine(spec.fallbackText)}`);
  }
  const trackerLines: (string | WholeLine)[] = [...own];
  if (thirdParty.length > 0) {
    // First, and never cut mid-id: the ids are how the agent reaches these trackers. Whole ids
    // only, then "+N more" when they do not all fit (`space_get` lists every one).
    trackerLines.unshift({
      whole: idsLine(
        `${thirdParty.length} ${thirdParty.length === 1 ? "tracker holds" : "trackers hold"} third-party content and ${thirdParty.length === 1 ? "is" : "are"} not shown; read with space_read_tracker (it marks this turn as having read third-party content): `,
        thirdParty,
      ),
    });
  }
  return {
    card: fit(card, TRUSTED_CONTEXT_CAP),
    work: fit(work === "" ? [] : [work], TRUSTED_CONTEXT_CAP),
    trackers: fit(trackerLines, TRUSTED_CONTEXT_CAP),
  };
}

const TITLES: Record<keyof SpaceTurnSections, string> = {
  card: "This Space",
  work: "Work in this Space",
  trackers: "Trackers in this Space",
};

function asSections(s: SpaceTurnSections): { title: string; text: string }[] {
  return (Object.keys(TITLES) as (keyof SpaceTurnSections)[])
    .filter((k) => s[k] !== "")
    .map((k) => ({ title: TITLES[k], text: s[k] }));
}

/**
 * The per-turn provider, for owner turns and automation runs alike. The loop asks it only for the
 * owner's own runs and passes the run's Space (`spaceFor`, fixed at run start), so the card always
 * matches the head and the connector scope: an automation aimed at the main chat, or at a chat in
 * another Space, never gets its own Space's card there (r1 finding 1). The sections are turn
 * context in the first user message, never the owner's words, so an address or path in them is
 * not an owner-named target (r1 finding 4).
 */
export function spaceContextProvider(db: PsycheDb): TurnContextProvider {
  return {
    name: "space",
    async provide(input) {
      if (input.spaceId === undefined) return undefined;
      const sections = asSections(spaceTurnSections(db, input.spaceId));
      if (sections.length === 0) return undefined;
      return { trusted: true, source: { sourceKind: "context" }, sections };
    },
  };
}

/**
 * SP7, SR10: a chat in a private Space is left out of "From your other chats" in any run outside
 * that Space.
 */
export function hiddenByPrivateSpace(
  db: PsycheDb,
  threadSpaceId: string | null | undefined,
  runSpaceId: string | undefined,
): boolean {
  if (threadSpaceId === null || threadSpaceId === undefined) return false;
  if (threadSpaceId === runSpaceId) return false;
  return new SpaceStore(db).get(threadSpaceId)?.private !== false;
}

export function previewHandler(): HandlerDef {
  return {
    run(call: Call, p: MethodParams<"spaces.context.preview">) {
      const db = call.ctx.db;
      const space = new SpaceStore(db).require(p.spaceId);
      if (p.threadId !== undefined && getThread(db, p.threadId)?.spaceId !== p.spaceId) {
        throw new PsycheError("invalid_params", "that chat is not in this Space");
      }
      const head = spaceSection(space)?.text ?? "";
      const turn = spaceTurnSections(db, p.spaceId);
      const sections: SpaceContextSection[] = [
        { kind: "instructions", text: head, chars: head.length, cap: SPACE_INSTRUCTIONS_CAP },
        ...(["card", "work", "trackers"] as const).map((kind) => ({
          kind,
          text: turn[kind],
          chars: turn[kind].length,
          cap: TRUSTED_CONTEXT_CAP,
        })),
      ];
      return { sections };
    },
  };
}

export interface SpaceRunContext {
  readonly part: ComposedPart;
  /** For the agent loop: the run's Space, read once at run start. */
  spaceFor(threadId: string): RunSpace | undefined;
  /** For the agent loop: the Space a specialist job inherits (§5.1). */
  spaceById(spaceId: string): RunSpace | undefined;
  readonly provider: TurnContextProvider;
}

/** Wave S3's composition: the loop's `spaceFor` and provider, the tools and the preview. */
export function composeSpaceContext(
  services: ComposeServices,
  extra: Pick<SpaceToolDeps, "noteExists"> = {},
): SpaceRunContext {
  const { db } = services;
  const unregister = spaceTools({
    db,
    publish: (event, payload) => services.publish(event, payload),
    ...extra,
  }).map((t) => services.tools.register(t));
  return {
    part: {
      handlers: { "spaces.context.preview": previewHandler() },
      stop: () => {
        for (const u of unregister) u();
      },
    },
    spaceFor: (threadId) => runSpaceFor(db, threadId),
    spaceById: (spaceId) => runSpaceById(db, spaceId),
    provider: spaceContextProvider(db),
  };
}
