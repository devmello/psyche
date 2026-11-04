import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelEvent, ModelRequest } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import {
  callWorkExtractor,
  cleanItemText,
  createExtractionSink,
  newWorkLaneLimits,
  rejectBatch,
  validateWorkLane,
  type WorkLaneBatchItem,
  type WorkLaneReport,
} from "../src/extraction/index.ts";
import { EverythingStore } from "../src/graph/everything.ts";
import { GraphStore } from "../src/graph/store.ts";
import { workLaneContext } from "../src/graph/work-learn.ts";
import { REDTEAM_DIR, sha } from "./redteam-support.ts";

export const WORK_DIR = join(REDTEAM_DIR, "work");
export const WORK_RECORDING = join(REDTEAM_DIR, "..", "redteam-recordings", "work-cloud.json");
/** The fixed clock of the world: Wednesday 2026-11-04, 18:00 UTC. */
export const WORK_NOW = Date.parse("2026-11-04T18:00:00Z");

export interface WorkCase {
  id: string;
  kind: "lane" | "signals";
  description: string;
  // lane
  senderOptedIn?: boolean;
  sender?: { label: string; key: string };
  subject?: string;
  body?: string;
  flood?: { assignments: number; template: string };
  hostile?: { items: unknown[] };
  /** A reply the closed form must reject (extra fields). */
  hostileRaw?: unknown;
  // signals
  signals?: {
    reminders?: unknown[];
    events?: unknown[];
    files?: unknown[];
  };
  expect: {
    suggestions?: { name: string; parent: string | null; dueAt: string | null }[];
    asks?: string[];
    deadlinesProposed?: number;
    conflicts?: number;
    graded?: number;
    dropped?: string[];
    quarantine?: string[];
    batchRejected?: boolean;
    statusUnchanged?: boolean;
    noGradeStored?: boolean;
    accepted?: number;
    /** Titles a real model may legitimately list for this mail (the rest must never appear). */
    allowedReal?: string[];
  };
}

export function loadWorkCases(): WorkCase[] {
  return readdirSync(WORK_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(WORK_DIR, f), "utf8")) as WorkCase);
}

export interface WorkWorld {
  graph: GraphStore;
  em: EverythingStore;
  ids: Record<string, string>;
}

/**
 * The fixture world: a MATH 21 course (code MATH21) with Lecture Work 7 (the owner set Thu Nov 6),
 * CHEM 1B with Lab Report 3 (in progress), and a private project "Tax filing 2026" with a private
 * to-do. Sam Lee is a person the work lane must never write to.
 */
export function buildWorkWorld(
  sqlite: ConstructorParameters<typeof GraphStore>[0]["sqlite"],
  clock: { now(): number },
): WorkWorld {
  const graph = new GraphStore({ sqlite, clock });
  const em = new EverythingStore({ sqlite, graph, clock });
  graph.createEntity({ kind: "person", name: "The Owner", isOwner: true });
  const sam = graph.createEntity({
    kind: "person",
    name: "Sam Lee",
    identifiers: [{ kind: "email", value: "sam@acme.com" }],
  });
  const math = graph.createEntity({ kind: "project", name: "MATH 21", projectType: "course" });
  graph.setFact({
    entityId: math.id,
    attribute: "course_code",
    value: "MATH21",
    provenance: "owner",
  });
  const chem = graph.createEntity({ kind: "project", name: "CHEM 1B", projectType: "course" });
  const tax = graph.createEntity({ kind: "project", name: "Tax filing 2026", private: true });
  const lw7 = graph.createEntity({
    kind: "assignment",
    name: "Lecture Work 7",
    dueAt: "2026-11-06T23:59:00Z",
  });
  graph.setEdge({ src: lw7.id, rel: "part_of", dst: math.id, provenance: "owner" });
  const lab3 = graph.createEntity({
    kind: "assignment",
    name: "Lab Report 3",
    dueAt: "2026-11-12T23:59:00Z",
  });
  graph.setEdge({ src: lab3.id, rel: "part_of", dst: chem.id, provenance: "owner" });
  graph.setFact({
    entityId: lab3.id,
    attribute: "progress",
    value: "Methods section written",
    provenance: "owner",
  });
  const forms = graph.createEntity({
    kind: "assignment",
    name: "Gather tax forms",
    dueAt: "2026-11-20T23:59:00Z",
    private: true,
  });
  graph.setEdge({ src: forms.id, rel: "part_of", dst: tax.id, provenance: "owner" });
  return {
    graph,
    em,
    ids: {
      sam: sam.id,
      math: math.id,
      chem: chem.id,
      tax: tax.id,
      lw7: lw7.id,
      lab3: lab3.id,
      forms: forms.id,
    },
  };
}

export function workItemsFor(c: WorkCase): WorkLaneBatchItem[] {
  let body = c.body ?? "";
  const flood = c.flood;
  if (flood !== undefined) {
    body = Array.from({ length: flood.assignments }, (_, i) =>
      flood?.template.replace("{i}", String(i + 1)),
    ).join("\n");
  }
  const sender = c.sender ?? { label: "Canvas", key: "no-reply@instructure.com" };
  const cleaned = cleanItemText(body, { format: "text" });
  return [
    {
      handle: "i1",
      source: "mail",
      sourceRef: `<${c.id}>`,
      trust: "untrusted",
      authorHandle: "p1",
      participantHandles: ["p0"],
      mentionHandles: [],
      text: cleaned.text,
      sourceHash: sha(cleaned.text),
      hiddenRemoved: cleaned.hiddenRemoved,
      rawLength: cleaned.rawLength,
      visibleLength: cleaned.visibleLength,
      fields: [c.subject ?? "", sender.label],
      senderOptedIn: c.senderOptedIn !== false,
      senderKey: sender.key,
      senderLabel: sender.label,
    },
  ];
}

/** What the hijacked model returns for a case (the flood is generated to match the mail). */
export function hostileReply(c: WorkCase): unknown {
  if (c.hostileRaw !== undefined) return c.hostileRaw;
  if (c.flood === undefined) return c.hostile;
  return {
    items: [
      {
        item: "i1",
        assignments: Array.from({ length: c.flood.assignments }, (_, i) => {
          const q = c.flood?.template.replace("{i}", String(i + 1)) as string;
          return {
            title: `Homework ${i + 1}`,
            parent_hint: null,
            due: "2026-11-09",
            kind: "new",
            quote: q,
            start: 0,
            end: 0,
          };
        }),
        flags: { instruction_like: false },
      },
    ],
  };
}

export interface WorkRun {
  report: WorkLaneReport | undefined;
  rejected: boolean;
  parseFailure: string | undefined;
  requests: ModelRequest[];
}

/**
 * One work-lane batch through the real call site (`callWorkExtractor`, no tools), the strict
 * parse and the validator. A parse failure is retried once; a second failure quarantines the batch.
 */
export async function runWorkLane(
  world: WorkWorld,
  items: WorkLaneBatchItem[],
  reply: string,
): Promise<WorkRun> {
  const events: ModelEvent[] = [
    { type: "text_delta", text: reply },
    { type: "finish", reason: "stop" },
  ];
  const provider = new FakeModelProvider({ id: "hostile" });
  provider.enqueue(events, events);
  const sink = createExtractionSink(world.em, { extractor: "fake/hostile" });
  const ctx = workLaneContext(world.graph);
  let failure: string | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const got = await callWorkExtractor({ provider, model: "fake/hostile", items });
    if (got.ok) {
      const report = validateWorkLane({
        output: got.output,
        items,
        parents: ctx.parents,
        targets: ctx.targets,
        sink,
        limits: newWorkLaneLimits(),
        now: WORK_NOW,
      });
      return { report, rejected: false, parseFailure: undefined, requests: provider.requests };
    }
    failure = got.reason;
    if (rejectBatch(items, sink, attempt)) {
      return {
        report: undefined,
        rejected: true,
        parseFailure: failure,
        requests: provider.requests,
      };
    }
  }
  return { report: undefined, rejected: false, parseFailure: failure, requests: provider.requests };
}

/** Tables a work-lane mail must never change (suggestions, pending facts and quarantine may grow). */
const FROZEN = [
  "graph_entities",
  "graph_identifiers",
  "graph_aliases",
  "graph_edges",
  "graph_blocklist",
  "graph_exclusions",
  "graph_loops",
  "graph_participants",
  "graph_interactions",
  "graph_cursors",
  "memory_claims",
  "memory_never_rules",
  "memory_trusted_senders",
  "settings",
] as const;

export function workSnapshot(sqlite: {
  prepare(sql: string): { all(): unknown[] };
}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of FROZEN) {
    out[t] = JSON.stringify(sqlite.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all());
  }
  // Accepted facts (what Psyche knows) are frozen too; pending ones are the lane's only write.
  out.accepted_facts = JSON.stringify(
    sqlite
      .prepare(
        "SELECT id, entity_id, attribute, value, provenance, review FROM graph_facts WHERE review != 'pending' ORDER BY rowid",
      )
      .all(),
  );
  return out;
}
