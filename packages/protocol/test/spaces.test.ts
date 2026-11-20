import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { Events } from "../src/events.ts";
import { Methods } from "../src/methods/index.ts";
import { Automation } from "../src/schemas/integrations.ts";
import { Space, SpaceCounts, SpaceDetail } from "../src/schemas/spaces.ts";
import { Thread } from "../src/schemas/threads.ts";
import { Widget, WidgetBindingSource } from "../src/schemas/widgets.ts";
import { bindingProblem, WIDGET_BINDINGS } from "../src/widgets-bindings.ts";

const NOW = "2026-11-20T10:00:00Z";

const METHOD_NAMES = [
  "spaces.list",
  "spaces.get",
  "spaces.create",
  "spaces.update",
  "spaces.archive",
  "spaces.restore",
  "spaces.delete",
  "spaces.folders.add",
  "spaces.folders.remove",
  "spaces.folders.setMode",
  "spaces.settings.set",
  "spaces.links.add",
  "spaces.links.remove",
  "spaces.threads.move",
  "spaces.automations.move",
  "spaces.trackers.add",
  "spaces.trackers.remove",
  "spaces.trackers.reorder",
  "spaces.trackers.refresh",
  "spaces.open",
  "spaces.context.preview",
  "spaces.proposals.list",
  "spaces.proposals.accept",
  "spaces.proposals.dismiss",
];

const required = (s: unknown): string[] => (s as { required?: string[] }).required ?? [];

describe("spaces protocol (S0)", () => {
  it("registers every spaces.* method of the design table", () => {
    const names = Object.keys(Methods);
    for (const m of METHOD_NAMES) expect(names, m).toContain(m);
  });

  it("scopes folders, settings and delete to admin", () => {
    const table = Methods as Record<string, { scope: string }>;
    for (const m of [
      "spaces.delete",
      "spaces.folders.add",
      "spaces.folders.remove",
      "spaces.folders.setMode",
      "spaces.settings.set",
    ])
      expect(table[m]?.scope, m).toBe("operator.admin");
  });

  it("registers the three space events", () => {
    const names = Object.keys(Events);
    for (const e of ["space.updated", "space.tracker.refreshed", "space.proposal.created"])
      expect(names, e).toContain(e);
  });

  it("adds the six binding sources, each with a table entry and no bindable field yet", () => {
    for (const s of ["entity", "work_due", "calendar", "reminders", "mail", "files"]) {
      expect(Value.Check(WidgetBindingSource, s), s).toBe(true);
      expect(Object.keys(WIDGET_BINDINGS), s).toContain(s);
    }
    expect(Value.Check(WidgetBindingSource, "nope")).toBe(false);
    expect(bindingProblem({ source: "mail", id: "x", field: "unread" } as never, "text")).toContain(
      "not a bindable field",
    );
  });

  it("keeps spaceId optional on Thread, Automation and Widget", () => {
    for (const s of [Thread, Automation, Widget]) {
      expect(Object.keys(s.properties)).toContain("spaceId");
      expect(required(s)).not.toContain("spaceId");
    }
  });

  it("validates a Space and rejects bad values", () => {
    const space = {
      id: "s1",
      name: "Kitchen remodel",
      description: null,
      icon: null,
      instructions: "",
      instructionsRev: 1,
      entityId: null,
      defaultPermissionMode: null,
      connectorScope: null,
      private: false,
      sort: 0,
      archivedAt: null,
      createdFrom: "owner",
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(Value.Check(Space, space)).toBe(true);
    expect(Value.Check(Space, { ...space, name: "x".repeat(61) })).toBe(false);
    expect(Value.Check(Space, { ...space, createdFrom: "agent" })).toBe(false);
    const counts = { chats: 0, trackers: 0, due: 0 };
    expect(Value.Check(SpaceCounts, counts)).toBe(true);
    expect(
      Value.Check(SpaceDetail, {
        space,
        folders: [],
        links: [],
        trackers: [],
        automationIds: [],
        goalIds: [],
        counts,
      }),
    ).toBe(true);
  });
});
