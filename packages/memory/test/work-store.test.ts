import { PsycheError, validateResult } from "@psyche/protocol";
import { FakeClock } from "@psyche/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EverythingStore } from "../src/graph/everything.ts";
import { createGraphHandlers, type GraphHandlers } from "../src/graph/handlers.ts";
import { GraphStore, normalizeDueAt } from "../src/graph/store.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

const DAY = 86_400_000;
let env: TestEnv;
let clock: FakeClock;
let graph: GraphStore;
let handlers: GraphHandlers;

type Method = keyof GraphHandlers;
async function call<M extends Method>(
  method: M,
  params: Parameters<GraphHandlers[M]>[0],
): Promise<Awaited<ReturnType<GraphHandlers[M]>>> {
  const fn = handlers[method] as (p: typeof params) => ReturnType<GraphHandlers[M]>;
  const result = await fn(params);
  validateResult(method, result);
  return result;
}

async function rejection(p: Promise<unknown> | (() => unknown)): Promise<PsycheError> {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (err) {
    expect(err).toBeInstanceOf(PsycheError);
    return err as PsycheError;
  }
  throw new Error("expected a PsycheError");
}

beforeEach(async () => {
  clock = new FakeClock(Date.parse("2026-11-02T12:00:00Z"));
  env = await makeEnv({ clock });
  graph = new GraphStore({ sqlite: env.db.sqlite, clock });
  handlers = createGraphHandlers(graph);
});
afterEach(async () => env.cleanup());

async function makeCourse() {
  const { entity: course } = await call("memory.entities.create", {
    kind: "project",
    name: "MATH 21",
    projectType: "course",
    dueAt: "2026-12-12T23:59:00.000Z",
  });
  return course;
}

async function makeAssignment(courseId: string, name: string, dueAt: string) {
  const { entity } = await call("memory.entities.create", { kind: "assignment", name, dueAt });
  await call("memory.entities.edges.set", { src: entity.id, rel: "part_of", dst: courseId });
  return entity;
}

describe("an owner tracks a course and its assignments through the protocol", () => {
  it("creates a course and assignments with due dates, and the timeline lists them", async () => {
    const course = await makeCourse();
    expect(course).toMatchObject({
      kind: "project",
      projectType: "course",
      projectStatus: "active",
      dueAt: "2026-12-12T23:59:00.000Z",
    });
    const hw7 = await makeAssignment(course.id, "Lecture Work 7", "2026-11-06T23:59:00.000Z");
    const hw8 = await makeAssignment(course.id, "Lecture Work 8", "2026-11-13");
    expect(hw7).toMatchObject({
      kind: "assignment",
      workStatus: "not_started",
      dueAt: "2026-11-06T23:59:00.000Z",
    });
    expect(hw8.dueAt).toBe("2026-11-13T00:00:00.000Z");

    const detail = await call("memory.entities.get", { id: hw7.id });
    expect(detail.facts.find((f) => f.attribute === "deadline")?.value).toBe(
      "2026-11-06T23:59:00.000Z",
    );
    expect(detail.edges.map((e) => e.rel)).toEqual(["part_of"]);

    const { rows } = await call("memory.entities.timeline", { entityId: course.id });
    const texts = rows.map(
      (r) => `${r.entityId === course.id ? "course" : "assignment"}: ${r.text}`,
    );
    expect(texts).toContain("course: Due Dec 12");
    expect(texts).toContain("assignment: Due Nov 6");
    expect(texts).toContain("assignment: Due Nov 13");
    expect(rows.find((r) => r.entityId === hw7.id)).toMatchObject({
      kind: "fact",
      provenance: "owner",
      chip: null,
      change: { attribute: "deadline", from: null, to: "2026-11-06T23:59:00.000Z" },
    });

    // The course page lists its assignments; an assignment lists only its own rows.
    const own = await call("memory.entities.timeline", { entityId: hw7.id });
    expect(own.rows.map((r) => r.text)).toEqual(["Due Nov 6"]);

    // The search finds them by kind.
    const found = await call("memory.entities.search", { q: "", kinds: ["assignment"] });
    expect(found.entities.map((e) => e.name).sort()).toEqual(["Lecture Work 7", "Lecture Work 8"]);
    expect(found.entities[0]).toMatchObject({ subtitle: "MATH 21", workStatus: "not_started" });
  });

  it("moves a due date with history, and clears it", async () => {
    const course = await makeCourse();
    const hw = await makeAssignment(course.id, "Report", "2026-11-05T12:00:00.000Z");
    clock.advance(DAY);
    const moved = await call("memory.entities.update", {
      id: hw.id,
      dueAt: "2026-11-09T12:00:00.000Z",
    });
    expect(moved.entity.dueAt).toBe("2026-11-09T12:00:00.000Z");
    const { rows } = await call("memory.entities.timeline", { entityId: hw.id });
    expect(rows.map((r) => r.text)).toEqual(["Due date moved Nov 5 → Nov 9", "Due Nov 5"]);
    expect(rows[0]?.change).toMatchObject({
      attribute: "deadline",
      from: "2026-11-05T12:00:00.000Z",
      to: "2026-11-09T12:00:00.000Z",
    });
    const cleared = await call("memory.entities.update", { id: hw.id, dueAt: null });
    expect(cleared.entity.dueAt).toBeNull();
    const detail = await call("memory.entities.get", { id: hw.id });
    expect(detail.facts.some((f) => f.attribute === "deadline")).toBe(false);
  });

  it("refuses a due date that is not a date, and a due date on a person", async () => {
    expect(
      (
        await rejection(
          call("memory.entities.create", {
            kind: "assignment",
            name: "X",
            dueAt: "Friday",
          } as never),
        )
      ).code,
    ).toBe("invalid_params");
    expect(
      (
        await rejection(
          call("memory.entities.create", {
            kind: "person",
            name: "Sam",
            dueAt: "2026-11-05T00:00:00.000Z",
          }),
        )
      ).code,
    ).toBe("invalid_params");
    expect(
      (
        await rejection(
          call("memory.entities.create", { kind: "person", name: "Sam", projectType: "course" }),
        )
      ).code,
    ).toBe("invalid_params");
  });

  it("keeps an item private and changes a project's type", async () => {
    const { entity: project } = await call("memory.entities.create", {
      kind: "project",
      name: "Remodel",
      private: true,
    });
    expect(project.private).toBe(true);
    const updated = await call("memory.entities.update", {
      id: project.id,
      projectType: "course",
      private: false,
    });
    expect(updated.entity.projectType).toBe("course");
    expect(updated.entity.private).toBeUndefined();
    const list = await call("memory.entities.search", { q: "remodel" });
    expect(list.entities[0]).toMatchObject({ projectType: "course" });
  });
});

describe("status", () => {
  it("an owner status fact moves the cached status; a bad value is refused", async () => {
    const course = await makeCourse();
    const hw = await makeAssignment(course.id, "HW", "2026-11-06T00:00:00.000Z");
    const set = (value: string) =>
      call("memory.entities.facts.set", { entityId: hw.id, attribute: "status", value });
    await set("submitted");
    expect(graph.getEntity(hw.id)?.workStatus).toBe("submitted");
    await set("done");
    expect(graph.getEntity(hw.id)?.workStatus).toBe("done");
    expect((await rejection(set("overdue"))).code).toBe("invalid_params");
    expect(graph.getEntity(hw.id)?.workStatus).toBe("done");
    const { rows } = await call("memory.entities.timeline", { entityId: hw.id });
    expect(rows[0]?.text).toBe("Status submitted → done");
  });

  it("the first progress note starts the work; a signal does not reopen a finished item", async () => {
    const course = await makeCourse();
    const hw = await makeAssignment(course.id, "HW", "2026-11-06T00:00:00.000Z");
    expect(graph.getEntity(hw.id)?.lastSignalAt).toBe("2026-11-02T12:00:00.000Z");
    clock.advance(DAY);
    await call("memory.entities.facts.set", {
      entityId: hw.id,
      attribute: "stopped_at",
      value: "Problem 4, part b",
    });
    const after = graph.getEntity(hw.id);
    expect(after).toMatchObject({
      workStatus: "in_progress",
      lastSignalAt: "2026-11-03T12:00:00.000Z",
    });
    const status = graph.facts(hw.id).find((f) => f.attribute === "status");
    expect(status).toMatchObject({
      value: "in_progress",
      provenance: "system",
      subjectKind: "deterministic",
    });

    await call("memory.entities.facts.set", {
      entityId: hw.id,
      attribute: "status",
      value: "done",
    });
    graph.recordSignal(hw.id, { provenance: "owner" });
    expect(graph.getEntity(hw.id)?.workStatus).toBe("done");
  });

  it("marking the course done closes its open assignments, but not a dropped one", async () => {
    const course = await makeCourse();
    const a = await makeAssignment(course.id, "A", "2026-11-06T00:00:00.000Z");
    const b = await makeAssignment(course.id, "B", "2026-11-07T00:00:00.000Z");
    const c = await makeAssignment(course.id, "C", "2026-11-08T00:00:00.000Z");
    await call("memory.entities.facts.set", {
      entityId: b.id,
      attribute: "status",
      value: "dropped",
    });
    await call("memory.entities.facts.set", {
      entityId: c.id,
      attribute: "status",
      value: "submitted",
    });
    await call("memory.entities.update", { id: course.id, projectStatus: "done" });
    expect(
      ["A", "B", "C"].map((n) => graph.search(n, { kinds: ["assignment"] })[0]?.workStatus),
    ).toEqual(["done", "dropped", "done"]);
    expect(graph.facts(a.id).find((f) => f.attribute === "status")?.provenance).toBe("system");
  });

  it("third-party text never writes work state; the store refuses it", async () => {
    const course = await makeCourse();
    const hw = await makeAssignment(course.id, "HW", "2026-11-06T00:00:00.000Z");
    for (const attribute of [
      "status",
      "deadline",
      "stopped_at",
      "next_step",
      "progress",
      "blocked_on",
    ] as const) {
      for (const provenance of ["untrusted", "agent"] as const) {
        const value =
          attribute === "status"
            ? "done"
            : attribute === "deadline"
              ? "2026-11-01T00:00:00.000Z"
              : "x";
        expect(
          graph.setFact({ entityId: hw.id, attribute, value, provenance }),
          `${attribute} ${provenance}`,
        ).toBeUndefined();
      }
    }
    expect(graph.getEntity(hw.id)).toMatchObject({
      workStatus: "not_started",
      dueAt: "2026-11-06T00:00:00.000Z",
    });
    // Untrusted text asks; it does not act.
    const t = graph.setWorkStatus(hw.id, { type: "untrusted_text", claims: "submitted" });
    expect(t).toMatchObject({
      changed: false,
      status: "not_started",
      ask: { claims: "submitted" },
    });
  });
});

describe("timeline merge (§3.5)", () => {
  it("merges interactions, fact history and loops newest first, with the assignments of a course", async () => {
    const course = await makeCourse();
    const hw = await makeAssignment(course.id, "Lecture Work 7", "2026-11-06T23:59:00.000Z");
    const ta = graph.createEntity({
      kind: "person",
      name: "Priya TA",
      identifiers: [{ kind: "email", value: "priya@ucsc.edu" }],
    });
    const at = (days: number, hours = 12) =>
      new Date(Date.parse("2026-11-02T00:00:00Z") + days * DAY + hours * 3_600_000).toISOString();

    // A mail on both the course and the assignment, a file day on the assignment, a note.
    const mail = graph.upsertInteraction({
      kind: "mail",
      source: "mail",
      externalRef: "m1",
      occurredAt: at(1),
      direction: "in",
      subject: "Updated​ numbers attached",
      threadKey: "t1",
      link: "mail://m1",
      projectId: course.id,
      subjects: [{ entityId: hw.id }],
      participants: [{ entityId: ta.id, role: "from" }],
    });
    graph.upsertInteraction({
      kind: "file",
      source: "files",
      externalRef: "file:hw7:2026-11-04",
      occurredAt: at(2),
      direction: "none",
      subject: "3 files in MATH21/hw7",
      projectId: null,
      subjects: [{ entityId: hw.id }],
      participants: [],
    });
    graph.upsertInteraction({
      kind: "mail",
      source: "mail",
      externalRef: "m2",
      occurredAt: at(3),
      direction: "out",
      subject: "Re: office hours",
      participants: [],
      subjects: [{ entityId: course.id }],
    });
    graph.addLoop({
      direction: "waiting_on",
      text: "the grading rubric",
      counterpartId: ta.id,
      projectId: hw.id,
      status: "open",
      provenance: "owner",
      detectedBy: "owner",
    });
    graph.addLoop({
      direction: "waiting_on",
      text: "a suggestion nobody answered",
      projectId: hw.id,
      status: "suggested",
      provenance: "untrusted",
      detectedBy: "model",
    });
    clock.advance(DAY * 4);
    graph.setFact({
      entityId: hw.id,
      attribute: "stopped_at",
      value: "Problem 4, part b",
      provenance: "owner",
    });

    const { rows, nextBefore } = await call("memory.entities.timeline", { entityId: course.id });
    expect(nextBefore).toBeNull();
    // Newest first.
    expect([...rows].map((r) => r.at)).toEqual(
      [...rows]
        .map((r) => r.at)
        .sort()
        .reverse(),
    );
    const byText = (needle: string) => rows.find((r) => r.text.includes(needle));
    expect(byText("Problem 4, part b")).toMatchObject({
      kind: "fact",
      provenance: "owner",
      entityId: hw.id,
    });
    expect(byText("Marked in progress")).toMatchObject({ provenance: "system" });
    expect(byText("Re: office hours")).toMatchObject({
      kind: "interaction",
      interactionKind: "mail",
      provenance: "owner",
      text: "You sent mail: “Re: office hours”",
      entityId: course.id,
    });
    expect(byText("Edited 3 files in MATH21/hw7")).toMatchObject({
      interactionKind: "file",
      chip: { source: "files" },
    });
    // The mail was cleaned, comes from someone else, and shows its sender on the chip.
    const received = rows.find((r) => r.id === mail);
    expect(received).toMatchObject({
      text: "New mail: “Updated numbers attached”",
      provenance: "untrusted",
      chip: { source: "mail", label: "Priya TA", link: "mail://m1" },
    });
    // Once, even though it belongs to both items.
    expect(rows.filter((r) => r.id === mail)).toHaveLength(1);
    expect(byText("Waiting on Priya TA: the grading rubric")).toMatchObject({ kind: "loop" });
    expect(rows.some((r) => r.text.includes("suggestion nobody answered"))).toBe(false);

    // Pages by time.
    const first = await call("memory.entities.timeline", { entityId: course.id, limit: 3 });
    expect(first.rows).toHaveLength(3);
    expect(first.nextBefore).toBe(first.rows[2]?.at);
    const rest = await call("memory.entities.timeline", {
      entityId: course.id,
      limit: 50,
      ...(first.nextBefore === null ? {} : { before: first.nextBefore }),
    });
    expect(rest.rows.every((r) => r.at < (first.nextBefore as string))).toBe(true);
  });

  it("a pending or discarded fact never reaches the timeline", async () => {
    const course = await makeCourse();
    const hw = await makeAssignment(course.id, "HW", "2026-11-06T00:00:00.000Z");
    const em = new EverythingStore({ sqlite: env.db.sqlite, graph, clock });
    const out = em.proposeFact({
      entityId: hw.id,
      attribute: "progress",
      value: "Submission received",
      provenance: "untrusted",
      subjectKind: "about_other",
      citations: [
        {
          source: "mail",
          sourceRef: "m9",
          quote: "Submission received",
          start: 0,
          end: 19,
          sourceHash: "h",
        },
      ],
    });
    expect(out.status).toBe("pending");
    const { rows } = await call("memory.entities.timeline", { entityId: hw.id });
    expect(rows.map((r) => r.text)).toEqual(["Due Nov 6"]);
  });

  it("an unknown entity is not found", async () => {
    expect((await rejection(call("memory.entities.timeline", { entityId: "nope" }))).code).toBe(
      "not_found",
    );
  });
});

describe("subjects", () => {
  it("one interaction can belong to the course and the assignment; deleting it removes both links", async () => {
    const course = await makeCourse();
    const hw = await makeAssignment(course.id, "HW", "2026-11-06T00:00:00.000Z");
    const id = graph.upsertInteraction({
      kind: "reminder",
      source: "reminders",
      externalRef: "r1",
      occurredAt: "2026-11-02T10:00:00.000Z",
      direction: "none",
      subject: "completed: HW",
      projectId: course.id,
      subjects: [{ entityId: hw.id, confidence: 0.9 }],
      participants: [],
    });
    expect(
      graph
        .subjectsOf(id)
        .map((s) => s.entityId)
        .sort(),
    ).toEqual([course.id, hw.id].sort());
    // Idempotent on re-upsert.
    graph.upsertInteraction({
      kind: "reminder",
      source: "reminders",
      externalRef: "r1",
      occurredAt: "2026-11-02T10:00:00.000Z",
      direction: "none",
      subjects: [{ entityId: hw.id }],
      participants: [],
    });
    expect(graph.subjectsOf(id)).toHaveLength(2);
    expect(graph.interaction(id)?.kind).toBe("reminder");
    expect(graph.deleteInteraction("reminders", "r1")).toBe(true);
    expect(graph.subjectsOf(id)).toEqual([]);
    expect(
      (await call("memory.entities.timeline", { entityId: hw.id })).rows.map((r) => r.text),
    ).toEqual(["Due Nov 6"]);
  });

  it("keeps a conversation's gist short", () => {
    const person = graph.createEntity({ kind: "person", name: "Ava" });
    const id = graph.upsertInteraction({
      kind: "chat",
      source: "chat",
      externalRef: "c1",
      occurredAt: "2026-11-02T10:00:00.000Z",
      direction: "both",
      participants: [{ entityId: person.id, role: "attendee" }],
    });
    graph.setInteractionGist(id, "Talked about Ava's school move and the Lisbon dates");
    expect(graph.interaction(id)?.gist).toBe("Talked about Ava's school move and the Lisbon dates");
    graph.setInteractionGist(id, "x".repeat(300));
    expect(graph.interaction(id)?.gist).toHaveLength(120);
    graph.setInteractionGist(id, null);
    expect(graph.interaction(id)?.gist).toBeUndefined();
  });
});

describe("anchors", () => {
  it("links sources to a work item through the protocol and removes them", async () => {
    const course = await makeCourse();
    const hw = await makeAssignment(course.id, "HW", "2026-11-06T00:00:00.000Z");
    const { anchor } = await call("memory.anchors.add", {
      entityId: course.id,
      kind: "folder",
      ref: "/Users/me/School/MATH21",
      label: "MATH21",
    });
    expect(anchor).toMatchObject({
      entityId: course.id,
      kind: "folder",
      addedBy: "owner",
      confirmed: true,
      label: "MATH21",
    });
    await call("memory.anchors.add", {
      entityId: course.id,
      kind: "reminder_list",
      ref: "list-1",
      label: "MATH 21",
    });
    await call("memory.anchors.add", {
      entityId: hw.id,
      kind: "folder",
      ref: "/Users/me/School/MATH21",
    });
    // Adding it twice returns it.
    expect(
      (
        await call("memory.anchors.add", {
          entityId: course.id,
          kind: "folder",
          ref: "/Users/me/School/MATH21",
        })
      ).anchor.id,
    ).toBe(anchor.id);

    expect((await call("memory.anchors.list", {})).anchors).toHaveLength(3);
    expect((await call("memory.anchors.list", { entityId: course.id })).anchors).toHaveLength(2);
    expect((await call("memory.anchors.list", { kind: "folder" })).anchors).toHaveLength(2);
    // The same folder anchors both items; both route.
    expect(
      graph
        .routeAnchor("folder", "/Users/me/School/MATH21")
        .map((a) => a.entityId)
        .sort(),
    ).toEqual([course.id, hw.id].sort());

    expect((await call("memory.anchors.remove", { id: anchor.id })).removed).toBe(true);
    expect((await call("memory.anchors.remove", { id: anchor.id })).removed).toBe(false);
    expect((await call("memory.anchors.list", { entityId: course.id })).anchors).toHaveLength(1);
  });

  it("refuses a link on a person and a malformed reference", async () => {
    const person = graph.createEntity({ kind: "person", name: "Sam" });
    const course = await makeCourse();
    expect(
      (
        await rejection(
          call("memory.anchors.add", { entityId: person.id, kind: "folder", ref: "/x" }),
        )
      ).code,
    ).toBe("invalid_params");
    expect(
      (
        await rejection(
          call("memory.anchors.add", { entityId: course.id, kind: "folder", ref: "/x\n/etc" }),
        )
      ).code,
    ).toBe("invalid_params");
    expect(
      (await rejection(call("memory.anchors.add", { entityId: "nope", kind: "folder", ref: "/x" })))
        .code,
    ).toBe("not_found");
  });

  it("a model anchor routes nothing until the owner confirms it", async () => {
    const course = await makeCourse();
    const suggested = graph.addAnchor({
      entityId: course.id,
      kind: "mail_thread",
      ref: "thread-9",
      label: "Re: syllabus",
      addedBy: "model",
    });
    expect(suggested).toMatchObject({ addedBy: "model", confirmed: false });
    expect(graph.routeAnchor("mail_thread", "thread-9")).toEqual([]);
    const { anchor } = await call("memory.anchors.add", {
      entityId: course.id,
      kind: "mail_thread",
      ref: "thread-9",
    });
    expect(anchor).toMatchObject({ id: suggested.id, confirmed: true });
    expect(graph.routeAnchor("mail_thread", "thread-9")).toHaveLength(1);
    // A rule can add one that routes at once.
    expect(
      graph.addAnchor({ entityId: course.id, kind: "chat_thread", ref: "th", addedBy: "rule" })
        .confirmed,
    ).toBe(true);
  });

  it("anchors go with the item", async () => {
    const course = await makeCourse();
    await call("memory.anchors.add", { entityId: course.id, kind: "folder", ref: "/a" });
    await call("memory.entities.forget", { id: course.id });
    expect((await call("memory.anchors.list", {})).anchors).toEqual([]);
  });
});

describe("suggestions", () => {
  it("an assignment suggestion creates nothing until the owner tracks it", async () => {
    const course = await makeCourse();
    const s = graph.suggest({
      kind: "assignment",
      entityIds: [course.id],
      name: "Lecture Work 8",
      dueAt: "2026-11-13",
      reason: "From Canvas mail",
    });
    expect(s).toMatchObject({
      kind: "assignment",
      entityIds: [course.id],
      name: "Lecture Work 8",
      dueAt: "2026-11-13T00:00:00.000Z",
    });
    // Never twice.
    expect(
      graph.suggest({
        kind: "assignment",
        entityIds: [course.id],
        name: "lecture work 8",
        dueAt: "2026-11-13",
        reason: "again",
      }),
    ).toBeUndefined();
    expect(graph.search("", { kinds: ["assignment"] })).toEqual([]);
    const listed = await call("memory.entities.suggestions", {});
    expect(listed.suggestions).toHaveLength(1);

    const answered = await call("memory.entities.suggestions.answer", {
      id: (s as { id: string }).id,
      answer: "accept",
    });
    expect(answered.entity).toMatchObject({
      kind: "assignment",
      name: "Lecture Work 8",
      dueAt: "2026-11-13T00:00:00.000Z",
      workStatus: "not_started",
    });
    expect(graph.edges((answered.entity as { id: string }).id).map((e) => [e.rel, e.dst])).toEqual([
      ["part_of", course.id],
    ]);
  });

  it("a course suggestion carries its type", async () => {
    const s = graph.suggest({
      kind: "project",
      entityIds: [],
      name: "CHEM 1B",
      projectType: "course",
      reason: "Three threads share it",
    });
    expect(s?.projectType).toBe("course");
    const answered = await call("memory.entities.suggestions.answer", {
      id: (s as { id: string }).id,
      answer: "accept",
    });
    expect(answered.entity).toMatchObject({ kind: "project", projectType: "course" });
  });
});

describe("relations", () => {
  it("assigned_by, teaches and part_of connect the right kinds", async () => {
    const course = await makeCourse();
    const hw = await makeAssignment(course.id, "HW", "2026-11-06T00:00:00.000Z");
    const prof = graph.createEntity({ kind: "person", name: "Prof Lee" });
    const dept = graph.createEntity({ kind: "org", name: "Math Dept" });
    await call("memory.entities.edges.set", { src: hw.id, rel: "assigned_by", dst: prof.id });
    await call("memory.entities.edges.set", { src: prof.id, rel: "teaches", dst: course.id });
    // One assigner at a time.
    await call("memory.entities.edges.set", { src: hw.id, rel: "assigned_by", dst: dept.id });
    expect(
      graph
        .edges(hw.id)
        .filter((e) => e.rel === "assigned_by")
        .map((e) => e.dst),
    ).toEqual([dept.id]);
    for (const bad of [
      { src: prof.id, rel: "assigned_by", dst: hw.id },
      { src: hw.id, rel: "teaches", dst: course.id },
      { src: course.id, rel: "part_of", dst: hw.id },
      { src: hw.id, rel: "member_of", dst: course.id },
    ] as const) {
      expect((await rejection(call("memory.entities.edges.set", bad))).code).toBe("invalid_params");
    }
    // An assignment belongs to one course at a time.
    const other = await call("memory.entities.create", {
      kind: "project",
      name: "CHEM 1B",
      projectType: "course",
    });
    await call("memory.entities.edges.set", { src: hw.id, rel: "part_of", dst: other.entity.id });
    expect(
      graph
        .edges(hw.id)
        .filter((e) => e.rel === "part_of")
        .map((e) => e.dst),
    ).toEqual([other.entity.id]);
  });
});

describe("a citation is dropped when its source is deleted", () => {
  it("removes the citation and the work fact left with none, but keeps the owner's", async () => {
    const course = await makeCourse();
    const hw = await makeAssignment(course.id, "HW", "2026-11-06T00:00:00.000Z");
    const em = new EverythingStore({ sqlite: env.db.sqlite, graph, clock });
    const cite = {
      source: "reminders" as const,
      sourceRef: "rem-7",
      quote: "HW done",
      start: 0,
      end: 7,
      sourceHash: "h",
    };
    const out = em.proposeFact({
      entityId: hw.id,
      attribute: "progress",
      value: "Reminder ticked off",
      provenance: "agent",
      subjectKind: "deterministic",
      autoAccept: true,
      citations: [cite],
    });
    expect(out.status).toBe("auto_accepted");
    const factId = (out as { fact: { id: string } }).fact.id;
    expect(em.citations("fact", factId)).toHaveLength(1);
    expect(
      (await call("memory.entities.timeline", { entityId: hw.id })).rows.some(
        (r) => r.text === "Progress: Reminder ticked off",
      ),
    ).toBe(true);

    // The owner's own deadline fact has no citation to lose.
    const dropped = em.dropSource("reminders", "rem-7");
    expect(dropped).toMatchObject({ citations: 1, facts: 1 });
    expect(em.citations("fact", factId)).toEqual([]);
    expect(graph.getFact(factId)).toBeUndefined();
    const { rows } = await call("memory.entities.timeline", { entityId: hw.id });
    expect(rows.map((r) => r.text)).toEqual(["Due Nov 6"]);
  });
});

describe("normalizeDueAt", () => {
  it("accepts ISO dates and times and nothing else", () => {
    expect(normalizeDueAt("2026-11-06")).toBe("2026-11-06T00:00:00.000Z");
    expect(normalizeDueAt("2026-11-06T23:59")).toBe("2026-11-06T23:59:00.000Z");
    expect(normalizeDueAt("2026-11-06 23:59:30")).toBe("2026-11-06T23:59:30.000Z");
    expect(normalizeDueAt("2026-11-06T23:59:00-08:00")).toBe("2026-11-07T07:59:00.000Z");
    for (const bad of ["Friday", "Nov 6", "6/11/2026", "2026-13-40", "", "  "]) {
      expect(normalizeDueAt(bad), bad).toBeNull();
    }
    expect(normalizeDueAt(null)).toBeNull();
  });
});
