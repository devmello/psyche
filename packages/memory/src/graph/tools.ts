import {
  type EntitySummary,
  type GraphInteraction,
  type GraphLoop,
  PsycheError,
  type ToolSpec,
} from "@psyche/protocol";
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { MemoryCallClass, MemoryToolContext, ToolOutcome } from "../tools/memory-command.ts";
import { normalizeName } from "./normalize.ts";
import type { GraphStore } from "./store.ts";

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
    const meeting = this.#findMeeting(args);
    if (meeting === undefined)
      return { content: "I couldn't find that meeting.", provenance: "trusted" };
    const taint = { untrusted: typeof meeting.subject === "string" };
    const attendees = meeting.participants
      .map((p) => this.#graph.getEntity(p.entityId))
      .filter((e) => e !== undefined && e.kind === "person" && !e.isOwner);
    const parts = [
      `Meeting: ${typeof meeting.subject === "string" ? `"${meeting.subject}"` : "(untitled)"} at ${meeting.occurredAt}${typeof meeting.link === "string" ? ` ${meeting.link}` : ""}`,
    ];
    if (typeof meeting.projectId === "string") {
      const project = this.#graph.getEntity(meeting.projectId);
      if (project !== undefined)
        parts.push(`Project: ${project.name} (${project.projectStatus ?? "active"})`);
    }
    for (const a of attendees) {
      if (a === undefined) continue;
      parts.push(this.#card(a.id, taint));
      const last = this.#graph
        .interactions(a.id, { limit: 4 })
        .filter((i) => i.id !== meeting.id)
        .slice(0, 3)
        .map((i) => this.#interactionLine(i, taint));
      if (last.length > 0) parts.push(`Last with ${a.name}:\n${last.join("\n")}`);
    }
    if (attendees.length === 0) parts.push("No other attendees I know.");
    return { content: parts.join("\n\n"), provenance: taint.untrusted ? "untrusted" : "trusted" };
  }

  #findMeeting(args: Static<typeof PrepInput>): GraphInteraction | undefined {
    if (args.event_id !== undefined) {
      const i = this.#graph.interaction(args.event_id);
      return i?.kind === "meeting" ? i : undefined;
    }
    const now = this.#now();
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
    const window = this.#graph
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
}

/**
 * Entity recall (§6.3): one line per entity the owner named unambiguously, at most three, only
 * in the owner's private sessions. Names must match a whole alias.
 */
export function entityRecall(
  graph: GraphStore,
  ownerText: string,
  options: { session: "private" | "delegated" | "shared"; max?: number } = { session: "private" },
): string[] {
  if (options.session !== "private") return [];
  const text = ` ${normalizeName(ownerText)} `;
  const lines: string[] = [];
  for (const e of graph.listEntities(["person", "org", "project"])) {
    if (lines.length >= (options.max ?? 3)) break;
    if (e.isOwner || e.hidden) continue;
    const names = [e.name, ...e.aliases].map(normalizeName).filter((n) => n.length >= 3);
    if (!names.some((n) => text.includes(` ${n} `))) continue;
    // Ambiguous: another entity answers to the same name.
    const clash = graph
      .search(e.name, { kinds: [e.kind], limit: 3 })
      .filter((s) => normalizeName(s.name) === normalizeName(e.name));
    if (clash.length > 1) continue;
    // Only what the owner or a deterministic rule said: never unverified third-party claims.
    const org = graph
      .edges(e.id)
      .find((x) => x.rel === "works_at" && x.src === e.id && x.provenance !== "untrusted");
    const subtitle = org === undefined ? undefined : graph.getEntity(org.dst)?.name;
    const loops = graph
      .loops({ entityId: e.id })
      .filter((l) => l.status === "open")
      .slice(0, 1);
    const bits = [
      subtitle,
      e.lastInteractionAt === null || e.lastInteractionAt === undefined
        ? undefined
        : `last talked ${day(e.lastInteractionAt)}`,
      loops[0] === undefined
        ? undefined
        : `${loops[0].direction === "i_owe" ? "you owe" : "waiting on"}: ${loops[0].text}`,
    ].filter((b): b is string => b !== undefined && b.length > 0);
    lines.push(`${e.name} — ${bits.join("; ")}`.slice(0, 300));
  }
  return lines;
}
