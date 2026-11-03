import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  CatchUpItem,
  DailySectionId,
  GraphAnchor,
  GraphEntity,
  GraphEntityKind,
  GraphTimelineRow,
  isAdminSettingKey,
  MEMORY_SURFACES_DEFAULTS,
  MEMORY_SURFACES_SETTING_KEY,
  MEMORY_WORK_DEFAULTS,
  MEMORY_WORK_SETTING_KEY,
  MemorySurfacesSettings,
  MemoryWorkSettings,
  Methods,
} from "../src/index.ts";

const T = "2026-11-02T10:00:00.000Z";

describe("memory for everything protocol (MW0)", () => {
  it("adds assignment to the entity kinds and keeps the old ones", () => {
    for (const k of ["person", "org", "project", "place", "event", "topic", "assignment"]) {
      expect(Value.Check(GraphEntityKind, k)).toBe(true);
    }
  });

  it("an entity written before MW0 is still valid", () => {
    const old = {
      id: "e1",
      kind: "project",
      name: "Kitchen",
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
      createdAt: T,
      updatedAt: T,
    };
    expect(Value.Check(GraphEntity, old)).toBe(true);
    expect(
      Value.Check(GraphEntity, {
        ...old,
        kind: "assignment",
        projectType: "course",
        workStatus: "in_progress",
        lastSignalAt: T,
        private: true,
      }),
    ).toBe(true);
    expect(Value.Check(GraphEntity, { ...old, projectType: "client" })).toBe(false);
  });

  it("DailySectionId gains catching_up and worked_on", () => {
    expect(Value.Check(DailySectionId, "catching_up")).toBe(true);
    expect(Value.Check(DailySectionId, "worked_on")).toBe(true);
    expect(Value.Check(DailySectionId, "due")).toBe(true);
  });

  it("validates an anchor, a timeline row and a catch-up item", () => {
    expect(
      Value.Check(GraphAnchor, {
        id: "a1",
        entityId: "e1",
        kind: "reminder_list",
        ref: "list-1",
        label: "MATH 21",
        addedBy: "owner",
        confirmed: true,
        createdAt: T,
      }),
    ).toBe(true);
    expect(
      Value.Check(GraphTimelineRow, {
        id: "t1",
        at: T,
        kind: "fact",
        entityId: "e1",
        text: "Due date moved Nov 5 to Nov 9",
        provenance: "untrusted",
        change: { attribute: "deadline", from: "2026-11-05", to: "2026-11-09" },
        chip: { source: "mail", label: "Canvas", citationId: "c1", link: null },
      }),
    ).toBe(true);
    const item = {
      entityId: "e1",
      kind: "assignment",
      title: "Lecture Work 7",
      titleProvenance: "owner",
      parent: { id: "p1", name: "MATH 21" },
      dueAt: T,
      urgency: "soon",
      status: "in_progress",
      statusAsOf: T,
      stale: false,
      line: "MATH 21 · Lecture Work 7: due Thu, in progress. You stopped at problem 4b.",
      changes: [],
      resume: { text: "Problem 4b", at: T, open: { kind: "file", ref: "/x/hw7.tex" } },
      actions: ["open", "continue", "done", "snooze"],
      provenance: "owner",
    };
    expect(Value.Check(CatchUpItem, item)).toBe(true);
    expect(Value.Check(CatchUpItem, { ...item, line: "x".repeat(141) })).toBe(false);
    expect(
      Value.Check(CatchUpItem, {
        ...item,
        changes: Array(3).fill({
          text: "t",
          at: T,
          source: "mail",
          provenance: "untrusted",
          citationId: null,
        }),
      }),
    ).toBe(false);
  });

  it("registers the new methods; reads are read, anchors are admin, the rest write", () => {
    const m = Methods as Record<string, { scope: string; sideEffecting?: boolean }>;
    for (const n of ["memory.entities.timeline", "memory.catchup.list", "memory.anchors.list"]) {
      expect(m[n]?.scope, n).toBe("operator.read");
    }
    for (const n of ["memory.catchup.act", "memory.catchup.seen"]) {
      expect(m[n]?.scope, n).toBe("operator.write");
      expect(m[n]?.sideEffecting, n).toBe(true);
    }
    for (const n of ["memory.anchors.add", "memory.anchors.remove"]) {
      expect(m[n]?.scope, n).toBe("operator.admin");
      expect(m[n]?.sideEffecting, n).toBe(true);
    }
  });

  it("entities.create and update accept dueAt, projectType and private", () => {
    const create = Methods["memory.entities.create"].params;
    expect(
      Value.Check(create, {
        kind: "assignment",
        name: "Lab report",
        dueAt: T,
        projectType: "project",
        private: true,
      }),
    ).toBe(true);
    expect(Value.Check(create, { kind: "person", name: "Sam" })).toBe(true);
    const update = Methods["memory.entities.update"].params;
    expect(Value.Check(update, { id: "e1", dueAt: null, projectType: "course" })).toBe(true);
    expect(Value.Check(update, { id: "e1", projectType: "job" })).toBe(false);
  });

  it("settings defaults satisfy their schemas and match the owner's decisions", () => {
    expect(Value.Check(MemoryWorkSettings, MEMORY_WORK_DEFAULTS)).toBe(true);
    expect(Value.Check(MemorySurfacesSettings, MEMORY_SURFACES_DEFAULTS)).toBe(true);
    // W1: birthdays on; every other people-tier item off.
    expect(MEMORY_SURFACES_DEFAULTS.birthdays).toBe(true);
    expect(Object.values(MEMORY_SURFACES_DEFAULTS.tiers.people)).toEqual([
      false,
      false,
      false,
      false,
    ]);
    // §4: mail about work never reaches notifications or channels.
    expect(MEMORY_SURFACES_DEFAULTS.tiers.workMail.notification).toBe(false);
    expect(MEMORY_SURFACES_DEFAULTS.tiers.workMail.channel).toBe(false);
    // W4: both due-soon notifications are off.
    expect(MEMORY_WORK_DEFAULTS.enabled).toBe(false);
    expect(MEMORY_WORK_DEFAULTS.remind.enabled).toBe(false);
    expect(MEMORY_WORK_DEFAULTS.remind.dayOf).toBe(false);
    expect(
      Value.Check(MemoryWorkSettings, {
        ...MEMORY_WORK_DEFAULTS,
        remind: { ...MEMORY_WORK_DEFAULTS.remind, at: "18:30" },
      }),
    ).toBe(true);
    expect(
      Value.Check(MemoryWorkSettings, {
        ...MEMORY_WORK_DEFAULTS,
        remind: { ...MEMORY_WORK_DEFAULTS.remind, at: "6pm" },
      }),
    ).toBe(false);
  });

  it("memory.work and memory.surfaces settings are admin-only (W6)", () => {
    for (const k of [
      MEMORY_WORK_SETTING_KEY,
      `${MEMORY_WORK_SETTING_KEY}.trackedLists`,
      MEMORY_SURFACES_SETTING_KEY,
      `${MEMORY_SURFACES_SETTING_KEY}.tiers.people.brief`,
    ]) {
      expect(isAdminSettingKey(k), k).toBe(true);
    }
  });
});
