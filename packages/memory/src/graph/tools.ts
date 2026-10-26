import {
  type EntitySummary,
  type GraphInteraction,
  type GraphLoop,
  type GraphSource,
  type Provenance,
  PsycheError,
  type ToolSpec,
} from "@psyche/protocol";
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { looksLikeInstruction } from "../filters.ts";
import type { MemoryCallClass, MemoryToolContext, ToolOutcome } from "../tools/memory-command.ts";
import { normalizeName } from "./normalize.ts";
import { type GraphStore, SOURCE_KINDS } from "./store.ts";

/**
 * The agent's people and project tools (docs/memory/people-and-projects-2026.md §6.2), and entity
 * recall in context (§6.3). The four lookups are read-only; `loop_update` is a write the broker
 * asks about. Results carry `provenance: "untrusted"` whenever they show subjects, summaries,
 * unverified facts or suggested loops, so the turn is tainted (security §3.6).
 */

const LookupInput = Type.Object({
  query: Type.String({
    minLength: 1,
    maxLength: 200,
    description: "A name, nickname, email or phone",
  }),
});
const ProjectInput = Type.Object({
  query: Type.String({ minLength: 1, maxLength: 200, description: "The project's name" }),
});
const WaitingInput = Type.Object({
  person: Type.Optional(
    Type.String({ maxLength: 200, description: "Only loops with this person" }),
  ),
  project: Type.Optional(
    Type.String({ maxLength: 200, description: "Only loops of this project" }),
  ),
  direction: Type.Optional(Type.Union([Type.Literal("i_owe"), Type.Literal("waiting_on")])),
});
const PrepInput = Type.Object({
  event_id: Type.Optional(
    Type.String({ maxLength: 200, description: "The meeting's interaction id" }),
  ),
  when: Type.Optional(
    Type.String({
      maxLength: 40,
      description: 'ISO time, or "HH:MM" today; default the next meeting',
    }),
  ),
});
const LoopInput = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 64 }),
  status: Type.Union([
    Type.Literal("done"),
    Type.Literal("snoozed"),
    Type.Literal("dismissed"),
    Type.Literal("open"),
  ]),
});

export const GRAPH_TOOL_NAMES = [
  "people_lookup",
  "project_brief",
  "waiting_on",
  "meeting_prep",
  "loop_update",
] as const;
export type GraphToolName = (typeof GRAPH_TOOL_NAMES)[number];

function spec(
  name: GraphToolName,
  description: string,
  input: TSchema,
  sideEffect: ToolSpec["sideEffect"],
): ToolSpec {
  return {
    name,
    description,
    inputSchema: JSON.parse(JSON.stringify(input)) as Record<string, unknown>,
    sideEffect,
    provenanceOut: "trusted",
  };
}

export const graphToolSpecs: readonly ToolSpec[] = [
  spec(
    "people_lookup",
    "Who someone is: how the owner knows them, their role and company, last contact, open loops and projects. If the name is ambiguous it lists the candidates; ask the owner which one before acting.",
    LookupInput,
    "none",
  ),
  spec(
    "project_brief",
    "A project's status, next step, people, recent conversations with links, open loops and upcoming meetings.",
    ProjectInput,
    "none",
  ),
  spec(
    "waiting_on",
    "Open loops: what the owner is waiting on from others and what the owner owes, oldest first, with due dates and links. Suggested loops come from other people's mail and are not confirmed.",
    WaitingInput,
    "none",
  ),
  spec(
    "meeting_prep",
    "Prep for one meeting: who is coming and who they are, the project, open loops with them, and the last conversations with links.",
    PrepInput,
    "none",
  ),
  spec(
    "loop_update",
    "Mark an open loop done, snoozed, dismissed or confirmed (open) when the owner says so.",
    LoopInput,
    "write",
  ),
];

/** Per-call classification for the broker (security §3.5). */
export function classifyGraphCall(name: string): MemoryCallClass {
  return name === "loop_update"
    ? { sideEffect: "write", paths: [], protected: false }
    : { sideEffect: "none", paths: [], protected: false };
}

function check<T extends TSchema>(schema: T, input: unknown): Static<T> {
  if (!Value.Check(schema, input)) throw new PsycheError("invalid_params", "invalid input");
  return input;
}

const day = (iso: string | null | undefined) => (typeof iso === "string" ? iso.slice(0, 10) : "");

export class GraphTools {
  readonly #graph: GraphStore;
  readonly #now: () => number;

  constructor(graph: GraphStore, options: { now?: () => number } = {}) {
    this.#graph = graph;
    this.#now = options.now ?? (() => Date.now());
  }

  get specs(): readonly ToolSpec[] {
    return graphToolSpecs;
  }

  async execute(name: string, input: unknown, ctx: MemoryToolContext): Promise<ToolOutcome> {
    try {
      switch (name) {
        case "people_lookup":
          return this.#lookup(check(LookupInput, input).query);
        case "project_brief":
          return this.#project(check(ProjectInput, input).query);
        case "waiting_on":
          return this.#waiting(check(WaitingInput, input));
        case "meeting_prep":
          return this.#prep(check(PrepInput, input));
        case "loop_update": {
          const args = check(LoopInput, input);
          if (ctx.incognito === true)
            throw new PsycheError("policy_denied", "this is an incognito thread");
          if (ctx.provenance === "untrusted")
            throw new PsycheError("policy_denied", "not after reading untrusted content");
          const loop = this.#graph.updateLoop(args.id, { status: args.status });
          return { content: `Loop "${loop.text}" is now ${loop.status}.`, provenance: "trusted" };
        }
        default:
          throw new PsycheError("invalid_params", `unknown tool ${name}`);
      }
    } catch (err) {
      return {
        content: `Error: ${PsycheError.from(err).message}`,
        isError: true,
        provenance: "trusted",
      };
    }
  }

  /** A compact card; marks taint when it shows anything third parties wrote. */
  #card(id: string, taint: { untrusted: boolean }): string {
    const detail = this.#graph.detail(id);
    if (detail === undefined) return "";
    const { entity } = detail;
    const lines = [`${entity.name} (${entity.kind}${entity.isOwner ? ", the owner" : ""})`];
    if (entity.summary !== null && entity.summary !== undefined) {
      lines.push(`Summary (${day(entity.summaryAt)}): ${entity.summary}`);
      taint.untrusted = true;
    }
    const facts = detail.facts.slice(0, 8).map((f) => {
      if (f.provenance === "untrusted") taint.untrusted = true;
      const how =
        f.provenance === "owner"
          ? "you said"
          : f.provenance === "untrusted"
            ? "unverified, from their messages"
            : "inferred";
      return `${f.attribute}: ${f.value} (${how})`;
    });
    if (facts.length > 0) lines.push(`Facts: ${facts.join("; ")}`);
    const rels = detail.related
      .slice(0, 5)
      .map((r) => `${r.name}${r.subtitle === null ? "" : ` (${r.subtitle})`}`);
    if (rels.length > 0) lines.push(`Related: ${rels.join(", ")}`);
    if (entity.lastInteractionAt !== null && entity.lastInteractionAt !== undefined)
      lines.push(`Last contact: ${day(entity.lastInteractionAt)}`);
    const loops = detail.openLoops.slice(0, 5).map((l) => this.#loopLine(l, taint));
    if (loops.length > 0) lines.push(`Open loops:\n${loops.join("\n")}`);
    return lines.join("\n");
  }

  #loopLine(l: GraphLoop, taint: { untrusted: boolean }): string {
    if (l.status === "suggested" || l.provenance === "untrusted") taint.untrusted = true;
    const verb = l.direction === "i_owe" ? "You owe" : "Waiting on";
    const who =
      l.counterpartId === null || l.counterpartId === undefined
        ? ""
        : ` ${this.#graph.getEntity(l.counterpartId)?.name ?? ""}`;
    const due = l.dueAt === null || l.dueAt === undefined ? "" : ` (due ${day(l.dueAt)})`;
    const state = l.status === "suggested" ? " [suggested, unconfirmed]" : "";
    return `- ${verb}${who}: ${l.text}${due}${state} [loop:${l.id}]`;
  }

  #interactionLine(i: GraphInteraction, taint: { untrusted: boolean }): string {
    if (typeof i.subject === "string") taint.untrusted = true;
    const subject = typeof i.subject === "string" ? ` "${i.subject}"` : "";
    const link = typeof i.link === "string" ? ` ${i.link}` : "";
    return `- ${day(i.occurredAt)} ${i.kind} ${i.direction}${subject}${link}`;
  }

  #lookup(query: string): ToolOutcome {
    const hits = this.#graph.search(query, { kinds: ["person", "org"], limit: 5 });
    if (hits.length === 0)
      return { content: `I don't know anyone matching "${query}".`, provenance: "trusted" };
    const taint = { untrusted: false };
    const [first, second] = hits;
    const ambiguous =
      second !== undefined &&
      normalizeName(first?.name ?? "").split(" ")[0] === normalizeName(second.name).split(" ")[0] &&
      this.#graph.strength(second.id) * 3 >= this.#graph.strength(first?.id ?? "");
    if (ambiguous) {
      const options = hits
        .filter(
          (h) =>
            normalizeName(h.name).split(" ")[0] === normalizeName(first?.name ?? "").split(" ")[0],
        )
        .slice(0, 3)
        .map(
          (h: EntitySummary) =>
            `- ${h.name}${h.subtitle === null ? "" : ` (${h.subtitle})`}, last contact ${day(h.lastInteractionAt) || "never"} [id:${h.id}]`,
        );
      return {
        content: `Several people match "${query}". Ask the owner which one:\n${options.join("\n")}`,
        provenance: "trusted",
      };
    }
    const cards = hits.slice(0, 1).map((h) => this.#card(h.id, taint));
    return { content: cards.join("\n\n"), provenance: taint.untrusted ? "untrusted" : "trusted" };
  }

  #project(query: string): ToolOutcome {
    const hit = this.#graph.search(query, { kinds: ["project"], limit: 1 })[0];
    if (hit === undefined)
      return { content: `No project matches "${query}".`, provenance: "trusted" };
    const taint = { untrusted: false };
    const card = this.#card(hit.id, taint);
    const recent = this.#graph
      .projectInteractions(hit.id, 10)
      .map((i) => this.#interactionLine(i, taint));
    const nowIso = new Date(this.#now()).toISOString();
    const upcoming = this.#graph
      .projectInteractions(hit.id, 50)
      .filter((i) => i.kind === "meeting" && i.occurredAt > nowIso)
      .map((i) => this.#interactionLine(i, taint));
    const parts = [card, `Status: ${hit.projectStatus ?? "active"}`];
    if (recent.length > 0) parts.push(`Recent:\n${recent.join("\n")}`);
    if (upcoming.length > 0) parts.push(`Upcoming:\n${upcoming.join("\n")}`);
    return { content: parts.join("\n"), provenance: taint.untrusted ? "untrusted" : "trusted" };
  }

  #waiting(args: Static<typeof WaitingInput>): ToolOutcome {
    const taint = { untrusted: false };
    const person =
      args.person === undefined
        ? undefined
        : this.#graph.search(args.person, { kinds: ["person", "org"], limit: 1 })[0];
    const project =
      args.project === undefined
        ? undefined
        : this.#graph.search(args.project, { kinds: ["project"], limit: 1 })[0];
    if (args.person !== undefined && person === undefined)
      return { content: `I don't know anyone matching "${args.person}".`, provenance: "trusted" };
    const loops = this.#graph.loops({
      ...(args.direction === undefined ? {} : { direction: args.direction }),
      ...(person === undefined ? {} : { entityId: person.id }),
      ...(project === undefined ? {} : { projectId: project.id }),
    });
    if (loops.length === 0) return { content: "No open loops.", provenance: "trusted" };
    return {
      content: loops.map((l) => this.#loopLine(l, taint)).join("\n"),
      provenance: taint.untrusted ? "untrusted" : "trusted",
    };
  }

  #prep(args: Static<typeof PrepInput>): ToolOutcome {
    const prep = meetingPrep(this.#graph, {
      ...(args.event_id === undefined ? {} : { interactionId: args.event_id }),
      ...(args.when === undefined ? {} : { when: args.when }),
      now: this.#now(),
    });
    if (prep === undefined)
      return { content: "I couldn't find that meeting.", provenance: "trusted" };
    const { meeting } = prep;
    const taint = { untrusted: prep.untrusted };
    const parts = [
      `Meeting: ${typeof meeting.subject === "string" ? `"${meeting.subject}"` : "(untitled)"} at ${meeting.occurredAt}${typeof meeting.link === "string" ? ` ${meeting.link}` : ""}`,
    ];
    if (prep.project !== null)
      parts.push(`Project: ${prep.project.name} (${prep.project.projectStatus ?? "active"})`);
    for (const a of prep.attendees) {
      parts.push(this.#card(a.entity.id, taint));
      const last = a.recent.map((i) => this.#interactionLine(i, taint));
      if (last.length > 0) parts.push(`Last with ${a.entity.name}:\n${last.join("\n")}`);
    }
    if (prep.attendees.length === 0) parts.push("No other attendees I know.");
    return { content: parts.join("\n\n"), provenance: taint.untrusted ? "untrusted" : "trusted" };
  }
}

/** What a meeting-prep card shows (§6.6); the scheduling and the card belong to the caller. */
export interface MeetingPrep {
  meeting: GraphInteraction;
  project: EntitySummary | null;
  attendees: { entity: EntitySummary; openLoops: GraphLoop[]; recent: GraphInteraction[] }[];
  /** The subject or a recent interaction's subject was written by someone else. */
  untrusted: boolean;
}

/**
 * The data side of meeting prep: attendees (people other than the owner) with their open loops
 * and last three other interactions, and the meeting's project. Finds the meeting by interaction
 * id, by the source item (`source: "calendar"`, the event id), or nearest to `when` (ISO or
 * "HH:MM" today; default now) within 30 minutes before to 7 days after.
 */
export function meetingPrep(
  graph: GraphStore,
  query: {
    interactionId?: string;
    source?: string;
    externalRef?: string;
    when?: string;
    now?: number;
  },
): MeetingPrep | undefined {
  const meeting = findMeeting(graph, query);
  if (meeting === undefined) return undefined;
  let untrusted = typeof meeting.subject === "string";
  const attendees: MeetingPrep["attendees"] = [];
  for (const p of meeting.participants) {
    const e = graph.getEntity(p.entityId);
    if (e === undefined || e.kind !== "person" || e.isOwner) continue;
    const entity = graph.summary(e.id);
    if (entity === undefined) continue;
    const recent = graph
      .interactions(e.id, { limit: 4 })
      .filter((i) => i.id !== meeting.id)
      .slice(0, 3);
    if (recent.some((i) => typeof i.subject === "string" && i.direction !== "out"))
      untrusted = true;
    const openLoops = graph
      .loops({ entityId: e.id })
      .filter((l) => l.status === "open" || l.status === "suggested");
    if (openLoops.some((l) => l.provenance === "untrusted")) untrusted = true;
    attendees.push({ entity, openLoops, recent });
  }
  const project =
    typeof meeting.projectId === "string" ? (graph.summary(meeting.projectId) ?? null) : null;
  return { meeting, project, attendees, untrusted };
}

function findMeeting(
  graph: GraphStore,
  args: {
    interactionId?: string;
    source?: string;
    externalRef?: string;
    when?: string;
    now?: number;
  },
): GraphInteraction | undefined {
  if (args.interactionId !== undefined) {
    const i = graph.interaction(args.interactionId);
    return i?.kind === "meeting" ? i : undefined;
  }
  if (args.source !== undefined && args.externalRef !== undefined) {
    const i = graph.interactionByRef(args.source, args.externalRef);
    return i?.kind === "meeting" ? i : undefined;
  }
  const now = args.now ?? Date.now();
  let target = now;
  if (args.when !== undefined) {
    const hm = /^(\d{1,2}):(\d{2})$/.exec(args.when.trim());
    if (hm !== null) {
      const d = new Date(now);
      d.setHours(Number(hm[1]), Number(hm[2]), 0, 0);
      target = d.getTime();
    } else if (!Number.isNaN(Date.parse(args.when))) {
      target = Date.parse(args.when);
    }
  }
  const window = graph
    .interactionsBetween(
      new Date(target - 30 * 60_000).toISOString(),
      new Date(target + 7 * 86_400_000).toISOString(),
    )
    .filter((i) => i.kind === "meeting");
  return window.sort(
    (a, b) =>
      Math.abs(Date.parse(a.occurredAt) - target) - Math.abs(Date.parse(b.occurredAt) - target),
  )[0];
}

/** Recall limits (§6.3): characters per line, lines per turn, and characters in all. */
export const ENTITY_RECALL_LIMITS = { line: 300, entities: 3, chars: 900 };

export interface EntityRecallOptions {
  session: "private" | "delegated" | "shared";
  max?: number;
  /** Characters across every line (the section's budget). */
  budget?: number;
  /** `memory.graph.sources`: interactions and loops from a source turned off are not recalled. */
  sources?: Partial<Record<GraphSource, boolean>>;
  /** Interactions older than this are not recalled, even before the nightly retention runs. */
  retentionDays?: number;
  now?: number;
}

const DAY_MS = 86_400_000;
/** A label recall may show as written: letters, digits, spaces and name punctuation only. */
const PLAIN_LABEL = /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} .,'’&-]{0,79}$/u;
const plain = (s: string | null | undefined): string | undefined => {
  const t = s?.replace(/\s+/g, " ").trim();
  return t !== undefined && PLAIN_LABEL.test(t) && !looksLikeInstruction(t) ? t : undefined;
};
/** Only the owner's own data or a deterministic rule's (never `agent` or `untrusted`). */
const ownerData = (p: Provenance) => p === "owner" || p === "system";
const titleCase = (s: string) =>
  s.replace(/(^|\s)(\p{L})/gu, (_, a, b: string) => a + b.toUpperCase());

/**
 * Entity recall (§6.3): one line per entity the owner named unambiguously, at most three, only
 * in the owner's private sessions. Names must match a whole alias.
 *
 * Every line is safe for a trusted context section: the name is the owner's own words (the
 * stored name only when it is the same words, recased), and the rest comes from owner or system
 * provenance (Contacts, the owner's edits, rules over the owner's sent mail). Subjects, display
 * names, summaries, model output and suggested loops never appear. Hidden or blocklisted people,
 * sources turned off, and interactions past retention are left out.
 */
export function entityRecall(
  graph: GraphStore,
  ownerText: string,
  options: EntityRecallOptions = { session: "private" },
): string[] {
  if (options.session !== "private") return [];
  const max = Math.min(options.max ?? ENTITY_RECALL_LIMITS.entities, ENTITY_RECALL_LIMITS.entities);
  let budget = options.budget ?? ENTITY_RECALL_LIMITS.chars;
  const now = options.now ?? Date.now();
  const cutoff = now - (options.retentionDays ?? 540) * DAY_MS;
  const sourceOn = (kind: GraphInteraction["kind"]) => {
    if (options.sources === undefined) return true;
    const source = (Object.keys(SOURCE_KINDS) as GraphSource[]).find((s) =>
      SOURCE_KINDS[s].includes(kind),
    );
    return source === undefined || options.sources[source] === true;
  };
  const text = ` ${normalizeName(ownerText)} `;
  const lines: string[] = [];
  for (const e of graph.listEntities(["person", "org", "project"])) {
    if (lines.length >= max) break;
    if (e.isOwner || e.hidden || e.status !== "active") continue;
    const names = [e.name, ...e.aliases].map(normalizeName).filter((n) => n.length >= 3);
    const said = names
      .filter((n) => text.includes(` ${n} `))
      .sort((a, b) => b.length - a.length)[0];
    if (said === undefined) continue;
    // Ambiguous: another entity answers to the same name.
    const clash = graph
      .search(e.name, { kinds: [e.kind], limit: 3 })
      .filter((s) => normalizeName(s.name) === normalizeName(e.name));
    if (clash.length > 1) continue;
    // "Don't track" or forgotten identifiers: nothing is recalled about them.
    const idents = graph.identifiers(e.id);
    if (idents.some((i) => graph.isBlocked(i.kind, i.value))) continue;
    const interactions = graph.interactions(e.id, { limit: 50 }).filter((i) => {
      const at = Date.parse(i.occurredAt);
      return at >= cutoff && at <= now && sourceOn(i.kind);
    });
    // Known only from sources turned off (or past retention): not recalled.
    const known =
      idents.length === 0 ||
      interactions.length > 0 ||
      idents.some(
        (i) =>
          i.linkedBy === "owner" ||
          (i.source === "contacts" &&
            (options.sources === undefined || options.sources.contacts === true)),
      );
    if (!known) continue;
    const kept = new Set(interactions.map((i) => i.id));
    // A display name from someone's mail could say anything: show the owner's words instead.
    const stored = normalizeName(e.name) === said ? plain(e.name) : undefined;
    const name = stored ?? titleCase(said);
    const org = graph
      .edges(e.id)
      .find((x) => x.rel === "works_at" && x.src === e.id && ownerData(x.provenance));
    const orgName = org === undefined ? undefined : plain(graph.getEntity(org.dst)?.name);
    const title = plain(
      graph.facts(e.id).find((f) => f.attribute === "title" && ownerData(f.provenance))?.value,
    );
    const loop = graph
      .loops({ entityId: e.id, status: ["open"] })
      .find(
        (l) =>
          ownerData(l.provenance) &&
          (l.sourceInteractionId == null || kept.has(l.sourceInteractionId)) &&
          !looksLikeInstruction(l.text),
      );
    const last = interactions[0]?.occurredAt;
    const bits = [
      title !== undefined && orgName !== undefined ? `${title} at ${orgName}` : (title ?? orgName),
      last === undefined ? undefined : `last talked ${day(last)}`,
      loop === undefined
        ? undefined
        : `${loop.direction === "i_owe" ? "you owe" : "waiting on"}: ${loop.text.replace(/\s+/g, " ")}`,
    ].filter((b): b is string => b !== undefined && b.length > 0);
    if (bits.length === 0) continue;
    const line = `${name} — ${bits.join("; ")}`.slice(0, ENTITY_RECALL_LIMITS.line);
    if (line.length > budget) break;
    budget -= line.length;
    lines.push(line);
  }
  return lines;
}
