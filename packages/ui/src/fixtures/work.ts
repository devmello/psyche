import type {
  CatchUpItem,
  GraphAnchor,
  GraphEdge,
  GraphEntity,
  GraphFact,
  GraphInteraction,
  GraphLoop,
} from "@psyche/protocol";
import type { EntityView } from "../people/types.ts";
import { FIXTURE_NOW } from "./ids.ts";
import type { FixtureWorld } from "./index.ts";
import { type GraphWorld, graphView, graphWorld, PEOPLE_IDS } from "./people.ts";

/**
 * Things due, on top of the people fixtures (docs/design/memory-everything-2026.md §2): a work
 * project with a board deck due, the kitchen remodel at home, one course with its homework, and
 * loose to-dos (rent, a passport, taxes), in every state: past due, this week, later, no date,
 * handed in, done, and one done long enough ago to have left Work due. A folder and a Reminders
 * list are linked, and the timeline rows make "where you stopped" believable. Dates sit around
 * the kit's fixture clock (Sunday 2026-10-18).
 */

export const WORK_IDS = {
  launch: PEOPLE_IDS.launch,
  kitchen: PEOPLE_IDS.kitchen,
  math: "ent_math21",
  garage: "ent_garage",
  trip: "ent_lisbon_trip",
  prof: "ent_prof_monteiro",
  priya: "ent_priya_nair",
  signoff: "ent_signoff",
  expense: "ent_expense_report",
  hardware: "ent_cabinet_hardware",
  lw7: "ent_lw7",
  deck: "ent_q3_deck",
  review: "ent_midterm_review",
  rent: "ent_pay_rent",
  passport: "ent_renew_passport",
  taxes: "ent_file_taxes",
  electrician: "ent_electrician",
  lw5: "ent_lw5",
  lw1: "ent_lw1",
} as const;

const T0 = "2026-09-01T09:00:00Z";
const OWNER = "ent_owner";

type Extra = Partial<GraphEntity>;

function entity(
  id: string,
  kind: GraphEntity["kind"],
  name: string,
  extra: Extra = {},
): GraphEntity {
  return {
    id,
    kind,
    name,
    aliases: [],
    status: "active",
    mergedInto: null,
    isOwner: false,
    pinned: false,
    hidden: false,
    dueAt: null,
    summary: null,
    summaryAt: null,
    lastInteractionAt: null,
    cardPath: null,
    createdAt: T0,
    updatedAt: T0,
    ...extra,
  };
}

function course(id: string, name: string, extra: Extra = {}): GraphEntity {
  return entity(id, "project", name, {
    projectType: "course",
    projectStatus: "active",
    ...extra,
  });
}

function assignment(
  id: string,
  name: string,
  workStatus: NonNullable<GraphEntity["workStatus"]>,
  dueAt: string | null,
  extra: Extra = {},
): GraphEntity {
  return entity(id, "assignment", name, { workStatus, dueAt, ...extra });
}

function fact(
  id: string,
  entityId: string,
  attribute: GraphFact["attribute"],
  value: string,
  provenance: GraphFact["provenance"],
  recordedAt: string,
  extra: { sources?: string[]; supersededBy?: string; evidence?: string } = {},
): GraphFact {
  return {
    id,
    entityId,
    attribute,
    value,
    provenance,
    confidence: provenance === "owner" ? 1 : provenance === "untrusted" ? 0.4 : 0.85,
    sources: extra.sources ?? [],
    evidence: extra.evidence ?? null,
    validFrom: recordedAt,
    validTo: null,
    recordedAt,
    supersededBy: extra.supersededBy ?? null,
    retractedAt: null,
  };
}

function edge(id: string, src: string, rel: GraphEdge["rel"], dst: string): GraphEdge {
  return {
    id,
    src,
    dst,
    rel,
    provenance: "owner",
    confidence: 1,
    sources: [],
    validFrom: T0,
    validTo: null,
    supersededBy: null,
    retractedAt: null,
  };
}

function interaction(
  id: string,
  kind: GraphInteraction["kind"],
  source: string,
  subject: string,
  at: string,
  direction: GraphInteraction["direction"],
  projectId: string,
  extra: { link?: string; from?: string } = {},
): GraphInteraction {
  return {
    id,
    kind,
    source,
    occurredAt: at,
    direction,
    subject,
    threadKey: null,
    link: extra.link ?? null,
    projectId,
    participants: extra.from
      ? [
          { entityId: extra.from, role: "from" },
          { entityId: OWNER, role: "to" },
        ]
      : [],
  };
}

function anchor(
  id: string,
  entityId: string,
  kind: GraphAnchor["kind"],
  ref: string,
  label: string,
  addedBy: GraphAnchor["addedBy"],
  confirmed = true,
): GraphAnchor {
  return { id, entityId, kind, ref, label, addedBy, confirmed, createdAt: "2026-09-02T09:00:00Z" };
}

function loop(l: Partial<GraphLoop> & Pick<GraphLoop, "id" | "text" | "direction">): GraphLoop {
  return {
    evidence: null,
    counterpartId: null,
    projectId: null,
    dueAt: null,
    status: "open",
    sourceInteractionId: null,
    provenance: "agent",
    confidence: 0.8,
    detectedBy: "model",
    createdAt: "2026-10-12T09:00:00Z",
    closedAt: null,
    closedBy: null,
    ...l,
  };
}

/** Adds the term to a graph: courses, assignments, their facts, links, mail and file days. */
export function addWork(g: GraphWorld): GraphWorld {
  const K = WORK_IDS;
  // Two projects already live in the people fixtures: Q4 launch (work) and Kitchen remodel (home).
  const launch = g.entities.find((e) => e.id === K.launch);
  const kitchen = g.entities.find((e) => e.id === K.kitchen);
  if (launch) launch.lastSignalAt = "2026-10-17T21:40:00Z";
  if (kitchen) kitchen.lastSignalAt = "2026-10-14T12:00:00Z";

  g.entities.push(
    course(K.math, "MATH 21", {
      aliases: ["MATH 21 Linear Algebra"],
      lastSignalAt: "2026-10-17T21:40:00Z",
      lastInteractionAt: "2026-10-17T21:40:00Z",
    }),
    entity(K.garage, "project", "Garage clean-out", {
      projectType: "project",
      projectStatus: "paused",
      lastSignalAt: "2026-08-30T15:00:00Z",
      lastInteractionAt: "2026-08-30T15:00:00Z",
    }),
    entity(K.trip, "project", "Lisbon trip", {
      projectType: "project",
      projectStatus: "done",
      lastSignalAt: "2026-06-10T15:00:00Z",
      lastInteractionAt: "2026-06-10T15:00:00Z",
    }),
    entity(K.prof, "person", "Prof. Monteiro", { lastInteractionAt: "2026-10-16T18:00:00Z" }),
    entity(K.priya, "person", "Priya Nair", { lastInteractionAt: "2026-10-15T20:00:00Z" }),

    // Past due, in progress, nothing for four days: the one that needs the owner.
    assignment(
      K.signoff,
      "Sign off on the launch copy",
      "in_progress",
      "2026-10-16T23:59:00.000Z",
      {
        lastSignalAt: "2026-10-14T20:00:00Z",
        lastInteractionAt: "2026-10-14T20:00:00Z",
      },
    ),
    // Handed in, due tomorrow.
    assignment(K.expense, "Expense report", "submitted", "2026-10-19T17:00:00.000Z", {
      lastSignalAt: "2026-10-17T12:00:00Z",
      lastInteractionAt: "2026-10-17T12:00:00Z",
    }),
    // Due in two days, not started, nothing seen for nine days: stale.
    assignment(K.hardware, "Order cabinet hardware", "not_started", "2026-10-20T23:59:00.000Z", {
      lastSignalAt: "2026-10-09T15:00:00Z",
      lastInteractionAt: "2026-10-09T15:00:00Z",
    }),
    // This week, being worked on: fresh.
    assignment(K.lw7, "Lecture Work 7", "in_progress", "2026-10-21T23:59:00.000Z", {
      lastSignalAt: "2026-10-17T21:40:00Z",
      lastInteractionAt: "2026-10-17T21:40:00Z",
    }),
    assignment(K.deck, "Q3 board deck", "in_progress", "2026-10-22T23:59:00.000Z", {
      lastSignalAt: "2026-10-17T21:46:00Z",
      lastInteractionAt: "2026-10-17T21:40:00Z",
    }),
    // Later.
    assignment(K.review, "Midterm review sheet", "not_started", "2026-10-30T23:59:00.000Z", {
      lastSignalAt: "2026-10-12T09:00:00Z",
      lastInteractionAt: "2026-10-12T09:00:00Z",
    }),
    assignment(K.rent, "Pay rent", "not_started", "2026-11-01T23:59:00.000Z", {
      lastSignalAt: "2026-10-01T09:00:00Z",
      lastInteractionAt: "2026-10-01T09:00:00Z",
    }),
    assignment(K.passport, "Renew passport", "not_started", "2026-12-01T23:59:00.000Z", {
      lastSignalAt: "2026-10-05T09:00:00Z",
      lastInteractionAt: "2026-10-05T09:00:00Z",
    }),
    // No date, and kept private: it shows on its own page only.
    assignment(K.taxes, "File taxes", "not_started", null, {
      private: true,
      lastSignalAt: "2026-10-18T09:00:00Z",
      lastInteractionAt: "2026-10-18T09:00:00Z",
    }),
    // Done this month: still in Work due for 14 days.
    assignment(K.electrician, "Book the electrician", "done", "2026-10-12T23:59:00.000Z", {
      lastSignalAt: "2026-10-12T16:00:00Z",
      lastInteractionAt: "2026-10-12T16:00:00Z",
    }),
    assignment(K.lw5, "Lecture Work 5", "done", "2026-10-09T23:59:00.000Z", {
      lastSignalAt: "2026-10-09T20:00:00Z",
      lastInteractionAt: "2026-10-09T20:00:00Z",
    }),
    // Done a month ago: it has left Work due, and stays on the course's timeline.
    assignment(K.lw1, "Lecture Work 1", "done", "2026-09-18T23:59:00.000Z", {
      lastSignalAt: "2026-09-18T20:00:00Z",
      lastInteractionAt: "2026-09-18T20:00:00Z",
    }),
  );

  g.edges.push(
    edge("edge_signoff_launch", K.signoff, "part_of", K.launch),
    edge("edge_expense_launch", K.expense, "part_of", K.launch),
    edge("edge_deck_launch", K.deck, "part_of", K.launch),
    edge("edge_deck_sam", K.deck, "assigned_by", PEOPLE_IDS.samLee),
    edge("edge_hardware_kitchen", K.hardware, "part_of", K.kitchen),
    edge("edge_electrician_kitchen", K.electrician, "part_of", K.kitchen),
    edge("edge_lw5_math", K.lw5, "part_of", K.math),
    edge("edge_lw7_math", K.lw7, "part_of", K.math),
    edge("edge_lw1_math", K.lw1, "part_of", K.math),
    edge("edge_review_math", K.review, "part_of", K.math),
    edge("edge_lw7_prof", K.lw7, "assigned_by", K.prof),
    edge("edge_prof_math", K.prof, "teaches", K.math),
    edge("edge_priya_math", K.priya, "member_of", K.math),
  );

  g.facts.push(
    fact("fact_math_code", K.math, "course_code", "MATH 21", "owner", "2026-09-02T09:00:00Z"),
    fact("fact_math_term", K.math, "term", "Fall 2026", "owner", "2026-09-02T09:00:00Z"),
    fact("fact_math_meets", K.math, "meets", "MWF 10:40", "owner", "2026-09-02T09:00:00Z"),
    fact(
      "fact_math_next",
      K.math,
      "next_step",
      "Finish Lecture Work 7 before office hours on Tuesday",
      "owner",
      "2026-10-16T20:00:00Z",
    ),

    // Q3 board deck: due date moved, started, stopped at the pricing table.
    fact(
      "fact_deck_due_old",
      K.deck,
      "deadline",
      "2026-10-20T23:59:00.000Z",
      "untrusted",
      "2026-10-12T16:00:00Z",
      { sources: ["int_deck_mail"], supersededBy: "fact_deck_due", evidence: "by Tuesday?" },
    ),
    fact(
      "fact_deck_due",
      K.deck,
      "deadline",
      "2026-10-22T23:59:00.000Z",
      "owner",
      "2026-10-16T20:05:00Z",
    ),
    fact(
      "fact_deck_status_old",
      K.deck,
      "status",
      "not_started",
      "system",
      "2026-10-12T16:05:00Z",
      {
        supersededBy: "fact_deck_status",
      },
    ),
    fact("fact_deck_status", K.deck, "status", "in_progress", "system", "2026-10-14T20:00:00Z", {
      sources: ["int_deck_files"],
    }),
    fact(
      "fact_deck_progress",
      K.deck,
      "progress",
      "Outline and slides 1 to 8",
      "owner",
      "2026-10-15T21:00:00Z",
    ),
    fact(
      "fact_deck_stopped",
      K.deck,
      "stopped_at",
      "Slide 9, the pricing table",
      "owner",
      "2026-10-17T21:45:00Z",
    ),
    fact(
      "fact_deck_next",
      K.deck,
      "next_step",
      "Add last quarter's numbers, then send to Sam",
      "owner",
      "2026-10-17T21:46:00Z",
    ),

    // Lecture Work 7: started, stopped at 4b.
    fact(
      "fact_lw7_due",
      K.lw7,
      "deadline",
      "2026-10-21T23:59:00.000Z",
      "owner",
      "2026-10-16T20:05:00Z",
    ),
    fact("fact_lw7_status", K.lw7, "status", "in_progress", "system", "2026-10-14T20:00:00Z", {
      sources: ["int_lw7_files"],
    }),
    fact(
      "fact_lw7_progress",
      K.lw7,
      "progress",
      "Finished problems 1 to 3",
      "owner",
      "2026-10-15T21:00:00Z",
    ),
    fact(
      "fact_lw7_stopped",
      K.lw7,
      "stopped_at",
      "Problem 4, part b",
      "owner",
      "2026-10-17T21:45:00Z",
    ),
    fact(
      "fact_lw7_next",
      K.lw7,
      "next_step",
      "Finish 4b and 5, then submit on Gradescope",
      "owner",
      "2026-10-17T21:46:00Z",
    ),

    fact(
      "fact_signoff_stopped",
      K.signoff,
      "stopped_at",
      "Paragraph 3",
      "owner",
      "2026-10-14T20:00:00Z",
    ),
    fact("fact_lw5_status", K.lw5, "status", "done", "owner", "2026-10-09T20:00:00Z"),
  );

  g.interactions.push(
    interaction(
      "int_deck_files",
      "file",
      "files",
      "Q3 deck.key and 2 more in Documents/Acme (40 min)",
      "2026-10-17T21:40:00Z",
      "none",
      K.deck,
    ),
    interaction(
      "int_deck_reminder",
      "reminder",
      "reminders",
      "Q3 board deck",
      "2026-10-12T16:05:00Z",
      "none",
      K.deck,
    ),
    interaction(
      "int_deck_mail",
      "mail",
      "mail",
      "Q3 board deck by Tuesday?",
      "2026-10-12T16:00:00Z",
      "in",
      K.deck,
      { link: "message://%3Cdeck-1%40acme.com%3E", from: PEOPLE_IDS.samLee },
    ),
    interaction(
      "int_lw7_files",
      "file",
      "files",
      "hw7.tex and 2 more in MATH21/hw7 (40 min)",
      "2026-10-17T21:40:00Z",
      "none",
      K.lw7,
    ),
    interaction(
      "int_math_lecture",
      "meeting",
      "calendar",
      "MATH 21 lecture",
      "2026-10-16T17:40:00Z",
      "both",
      K.math,
      { link: "calendar://event/math21-1016" },
    ),
    interaction(
      "int_math_office",
      "mail",
      "mail",
      "Office hours moved to Tuesday",
      "2026-10-16T18:00:00Z",
      "in",
      K.math,
      { link: "message://%3Coffice-1%40psyche.local%3E", from: K.prof },
    ),
    interaction(
      "int_math_chat",
      "chat",
      "chats",
      "Study plan for the midterm",
      "2026-10-15T21:10:00Z",
      "both",
      K.math,
    ),
    interaction(
      "int_signoff_files",
      "file",
      "files",
      "launch-copy.md in Documents/Acme (15 min)",
      "2026-10-14T20:00:00Z",
      "none",
      K.signoff,
    ),
  );

  g.loops.push(
    loop({
      id: "loop_regrade",
      direction: "waiting_on",
      text: "Regrade on Lecture Work 5, problem 3",
      counterpartId: K.prof,
      projectId: K.math,
      createdAt: "2026-10-13T09:00:00Z",
    }),
  );

  g.anchors.push(
    anchor("anc_launch_folder", K.launch, "folder", "~/Documents/Acme", "Acme", "owner"),
    anchor("anc_deck_folder", K.deck, "folder", "~/Documents/Acme/Q3-deck", "Q3-deck", "owner"),
    // A model's guess: it routes nothing until the owner links it (§2.5).
    anchor(
      "anc_deck_thread",
      K.deck,
      "mail_thread",
      "thread-deck",
      "Q3 board deck by Tuesday?",
      "model",
      false,
    ),
    anchor("anc_math_folder", K.math, "folder", "~/School/MATH21", "MATH21", "owner"),
    anchor("anc_math_list", K.math, "reminder_list", "MATH 21", "MATH 21", "rule"),
    anchor("anc_lw7_folder", K.lw7, "folder", "~/School/MATH21/hw7", "hw7", "owner"),
  );
  g.status.counts.projects += 3;
  return g;
}

/** Edits a fixture world to hold the work items (for `withWorld({ edit })` and tests). */
export function withWorkWorld(world: FixtureWorld): void {
  addWork(world.graph);
}

/**
 * What `memory.catchup.list` answers for Home on the fixture clock, as the Gateway writes it (the
 * §5.3 line templates, the past-due ask first): a work deliverable past its day, a home project's
 * errand with a stale status, and a bill. A general mix on purpose; none of it is school.
 */
export function workCatchUp(): CatchUpItem[] {
  const K = WORK_IDS;
  const item = (
    entityId: string,
    title: string,
    line: string,
    extra: Partial<CatchUpItem> = {},
  ): CatchUpItem => ({
    entityId,
    kind: "assignment",
    title,
    titleProvenance: "owner",
    urgency: "soon",
    status: "not_started",
    statusAsOf: "2026-10-09T15:00:00Z",
    stale: false,
    line,
    changes: [],
    actions: ["open", "continue", "done", "snooze"],
    provenance: "owner",
    ...extra,
  });
  return [
    item(
      K.signoff,
      "Sign off on the launch copy",
      "Q4 launch · Did you finish Sign off on the launch copy? It was due Oct 16.",
      {
        parent: { id: K.launch, name: "Q4 launch" },
        dueAt: "2026-10-16T23:59:00.000Z",
        urgency: "overdue",
        status: "overdue",
        statusAsOf: "2026-10-14T20:00:00Z",
        actions: ["open", "done", "snooze"],
        ask: true,
      },
    ),
    item(
      K.hardware,
      "Order cabinet hardware",
      "Kitchen remodel · Order cabinet hardware: due Tue, not started, as of Fri.",
      {
        parent: { id: K.kitchen, name: "Kitchen remodel" },
        dueAt: "2026-10-20T23:59:00.000Z",
        stale: true,
      },
    ),
    item(K.rent, "Pay rent", "Pay rent: due Nov 1, not started.", {
      dueAt: "2026-11-01T23:59:00.000Z",
      urgency: "later",
      statusAsOf: "2026-10-01T09:00:00Z",
    }),
  ];
}

/** Gives a fixture world its work items and the Gateway's Home list of what to catch up on. */
export function withCatchUp(world: FixtureWorld): void {
  addWork(world.graph);
  world.graph.catchUp = workCatchUp();
}

const termGraph = addWork(graphWorld());

/** A work item's card view on the fixture term, for stories of the presentational cards. */
export function workView(id: string, now = Date.parse(FIXTURE_NOW)): EntityView {
  return graphView(termGraph, id, now) as EntityView;
}
