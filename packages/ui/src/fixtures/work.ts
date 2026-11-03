import type {
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
import { type GraphWorld, graphView, graphWorld } from "./people.ts";

/**
 * A student's term on top of the people fixtures (docs/design/memory-everything-2026.md §2): two
 * courses with their assignments in every state (past due, this week, later, no date, done, one
 * old enough to have left Work due), an instructor who teaches one, a folder and a Reminders list
 * linked to it, and the timeline rows that make "where you stopped" believable. Dates sit around
 * the kit's fixture clock (Sunday 2026-10-18).
 */

export const WORK_IDS = {
  math: "ent_math21",
  chem: "ent_chem1b",
  art: "ent_art10",
  writ: "ent_writ2",
  prof: "ent_prof_monteiro",
  priya: "ent_priya_nair",
  lw5: "ent_lw5",
  lw6: "ent_lw6",
  lw7: "ent_lw7",
  review: "ent_midterm_review",
  lab3: "ent_lab_report_3",
  quiz: "ent_prelab_quiz",
  taxes: "ent_file_taxes",
  lw1: "ent_lw1",
} as const;

const W = WORK_IDS;
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
  g.entities.push(
    course(W.math, "MATH 21", {
      aliases: ["MATH 21 Linear Algebra"],
      pinned: true,
      lastSignalAt: "2026-10-17T21:40:00Z",
      lastInteractionAt: "2026-10-17T21:40:00Z",
    }),
    course(W.chem, "CHEM 1B", {
      lastSignalAt: "2026-10-09T15:00:00Z",
      lastInteractionAt: "2026-10-09T15:00:00Z",
    }),
    course(W.art, "ART 10", {
      projectStatus: "paused",
      lastSignalAt: "2026-08-30T15:00:00Z",
      lastInteractionAt: "2026-08-30T15:00:00Z",
    }),
    course(W.writ, "WRIT 2", {
      projectStatus: "done",
      lastSignalAt: "2026-06-10T15:00:00Z",
      lastInteractionAt: "2026-06-10T15:00:00Z",
    }),
    entity(W.prof, "person", "Prof. Monteiro", { lastInteractionAt: "2026-10-16T18:00:00Z" }),
    entity(W.priya, "person", "Priya Nair", { lastInteractionAt: "2026-10-15T20:00:00Z" }),
    // Past due, in progress, no activity for four days: needs the owner.
    assignment(W.lw6, "Lecture Work 6", "in_progress", "2026-10-16T23:59:00.000Z", {
      lastSignalAt: "2026-10-14T20:00:00Z",
      lastInteractionAt: "2026-10-14T20:00:00Z",
    }),
    // This week, being worked on: fresh.
    assignment(W.lw7, "Lecture Work 7", "in_progress", "2026-10-21T23:59:00.000Z", {
      lastSignalAt: "2026-10-17T21:40:00Z",
      lastInteractionAt: "2026-10-17T21:40:00Z",
    }),
    assignment(W.review, "Midterm review sheet", "not_started", "2026-10-30T23:59:00.000Z", {
      lastSignalAt: "2026-10-12T09:00:00Z",
      lastInteractionAt: "2026-10-12T09:00:00Z",
    }),
    // Due in two days, nothing done and nothing seen for nine days: stale.
    assignment(W.lab3, "Lab report 3", "not_started", "2026-10-20T23:59:00.000Z", {
      lastSignalAt: "2026-10-09T15:00:00Z",
      lastInteractionAt: "2026-10-09T15:00:00Z",
    }),
    assignment(W.quiz, "Pre-lab quiz", "submitted", "2026-10-19T17:00:00.000Z", {
      lastSignalAt: "2026-10-17T12:00:00Z",
      lastInteractionAt: "2026-10-17T12:00:00Z",
    }),
    assignment(W.taxes, "File taxes extension", "not_started", null, {
      private: true,
      lastSignalAt: "2026-10-18T09:00:00Z",
      lastInteractionAt: "2026-10-18T09:00:00Z",
    }),
    assignment(W.lw5, "Lecture Work 5", "done", "2026-10-09T23:59:00.000Z", {
      lastSignalAt: "2026-10-09T20:00:00Z",
      lastInteractionAt: "2026-10-09T20:00:00Z",
    }),
    // Done a month ago: it has left Work due, and stays on the course's timeline.
    assignment(W.lw1, "Lecture Work 1", "done", "2026-09-18T23:59:00.000Z", {
      lastSignalAt: "2026-09-18T20:00:00Z",
      lastInteractionAt: "2026-09-18T20:00:00Z",
    }),
  );

  g.edges.push(
    edge("edge_lw5_math", W.lw5, "part_of", W.math),
    edge("edge_lw6_math", W.lw6, "part_of", W.math),
    edge("edge_lw7_math", W.lw7, "part_of", W.math),
    edge("edge_lw1_math", W.lw1, "part_of", W.math),
    edge("edge_review_math", W.review, "part_of", W.math),
    edge("edge_lab3_chem", W.lab3, "part_of", W.chem),
    edge("edge_quiz_chem", W.quiz, "part_of", W.chem),
    edge("edge_lw7_prof", W.lw7, "assigned_by", W.prof),
    edge("edge_prof_math", W.prof, "teaches", W.math),
    edge("edge_priya_math", W.priya, "member_of", W.math),
  );

  g.facts.push(
    fact("fact_math_code", W.math, "course_code", "MATH 21", "owner", "2026-09-02T09:00:00Z"),
    fact("fact_math_term", W.math, "term", "Fall 2026", "owner", "2026-09-02T09:00:00Z"),
    fact("fact_math_meets", W.math, "meets", "MWF 10:40", "owner", "2026-09-02T09:00:00Z"),
    fact(
      "fact_math_next",
      W.math,
      "next_step",
      "Finish Lecture Work 7 before office hours on Tuesday",
      "owner",
      "2026-10-16T20:00:00Z",
    ),
    fact("fact_chem_term", W.chem, "term", "Fall 2026", "owner", "2026-09-02T09:00:00Z"),
    // Lecture Work 7: due date moved, started, stopped at 4b.
    fact(
      "fact_lw7_due_old",
      W.lw7,
      "deadline",
      "2026-10-19T23:59:00.000Z",
      "untrusted",
      "2026-10-12T16:00:00Z",
      { sources: ["int_lw7_mail"], supersededBy: "fact_lw7_due", evidence: "due Monday night" },
    ),
    fact(
      "fact_lw7_due",
      W.lw7,
      "deadline",
      "2026-10-21T23:59:00.000Z",
      "owner",
      "2026-10-16T20:05:00Z",
    ),
    fact("fact_lw7_status_old", W.lw7, "status", "not_started", "system", "2026-10-12T16:05:00Z", {
      supersededBy: "fact_lw7_status",
    }),
    fact("fact_lw7_status", W.lw7, "status", "in_progress", "system", "2026-10-14T20:00:00Z", {
      sources: ["int_lw7_files"],
    }),
    fact(
      "fact_lw7_progress",
      W.lw7,
      "progress",
      "Finished problems 1 to 3",
      "owner",
      "2026-10-15T21:00:00Z",
    ),
    fact(
      "fact_lw7_stopped",
      W.lw7,
      "stopped_at",
      "Problem 4, part b",
      "owner",
      "2026-10-17T21:45:00Z",
    ),
    fact(
      "fact_lw7_next",
      W.lw7,
      "next_step",
      "Finish 4b and 5, then submit on Gradescope",
      "owner",
      "2026-10-17T21:46:00Z",
    ),
    fact("fact_lw6_stopped", W.lw6, "stopped_at", "Problem 2", "owner", "2026-10-14T20:00:00Z"),
    fact("fact_lw5_status", W.lw5, "status", "done", "owner", "2026-10-09T20:00:00Z"),
  );

  g.interactions.push(
    interaction(
      "int_lw7_files",
      "file",
      "files",
      "hw7.tex and 2 more in MATH21/hw7 (40 min)",
      "2026-10-17T21:40:00Z",
      "none",
      W.lw7,
    ),
    interaction(
      "int_lw7_reminder",
      "reminder",
      "reminders",
      "Lecture Work 7",
      "2026-10-12T16:05:00Z",
      "none",
      W.lw7,
    ),
    interaction(
      "int_lw7_mail",
      "mail",
      "mail",
      "Lecture Work 7 is posted",
      "2026-10-12T16:00:00Z",
      "in",
      W.lw7,
      { link: "message://%3Clw7%40psyche.local%3E", from: W.prof },
    ),
    interaction(
      "int_math_lecture",
      "meeting",
      "calendar",
      "MATH 21 lecture",
      "2026-10-16T17:40:00Z",
      "both",
      W.math,
      { link: "calendar://event/math21-1016" },
    ),
    interaction(
      "int_math_office",
      "mail",
      "mail",
      "Office hours moved to Tuesday",
      "2026-10-16T18:00:00Z",
      "in",
      W.math,
      { link: "message://%3Coffice-1%40psyche.local%3E", from: W.prof },
    ),
    interaction(
      "int_math_chat",
      "chat",
      "chats",
      "Study plan for the midterm",
      "2026-10-15T21:10:00Z",
      "both",
      W.math,
    ),
    interaction(
      "int_lw6_files",
      "file",
      "files",
      "hw6.tex in MATH21/hw6 (15 min)",
      "2026-10-14T20:00:00Z",
      "none",
      W.lw6,
    ),
  );

  g.loops.push(
    loop({
      id: "loop_regrade",
      direction: "waiting_on",
      text: "Regrade on Lecture Work 5, problem 3",
      counterpartId: W.prof,
      projectId: W.math,
      createdAt: "2026-10-13T09:00:00Z",
    }),
  );

  g.anchors.push(
    anchor("anc_math_folder", W.math, "folder", "~/School/MATH21", "MATH21", "owner"),
    anchor("anc_math_list", W.math, "reminder_list", "MATH 21", "MATH 21", "rule"),
    anchor("anc_lw7_folder", W.lw7, "folder", "~/School/MATH21/hw7", "hw7", "owner"),
    // A model's guess: it routes nothing until the owner links it (§2.5).
    anchor(
      "anc_lw7_thread",
      W.lw7,
      "mail_thread",
      "thread-lw7",
      "Lecture Work 7 is posted",
      "model",
      false,
    ),
  );
  g.status.counts.projects += 4;
  return g;
}

/** Edits a fixture world to hold the term (for `withWorld({ edit })` and tests). */
export function withWorkWorld(world: FixtureWorld): void {
  addWork(world.graph);
}

const termGraph = addWork(graphWorld());

/** A work item's card view on the fixture term, for stories of the presentational cards. */
export function workView(id: string, now = Date.parse(FIXTURE_NOW)): EntityView {
  return graphView(termGraph, id, now) as EntityView;
}
