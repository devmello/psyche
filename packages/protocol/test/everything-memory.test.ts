import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  EVERYTHING_MEMORY_DEFAULTS,
  EverythingMemorySettings,
  GraphCitation,
  GraphEdgeRel,
  GraphEntityKind,
  GraphFact,
  GraphSensitivity,
  HARD_BLOCKED_SENSITIVITY,
  isAdminSettingKey,
  Methods,
} from "../src/index.ts";

describe("everything memory protocol (EM0)", () => {
  it("defaults are the accepted §14 decisions and validate against the schema", () => {
    expect(Value.Check(EverythingMemorySettings, EVERYTHING_MEMORY_DEFAULTS)).toBe(true);
    const d = EVERYTHING_MEMORY_DEFAULTS;
    expect(d.enabled).toBe(false);
    expect(d.model.default.kind).toBe("none");
    expect(d.people.default).toBe("two_way");
    expect(d.retention.pendingDays).toBe(30);
    expect(d.retention.untrustedAcceptedMonths).toBe(24);
    expect(Object.values(d.sensitive).every((v) => v === false)).toBe(true);
    expect(Object.values(d.sources).every((v) => v === false)).toBe(true);
    expect(d.review.autoAcceptSelfDisclosure).toBe(false);
    expect(d.review.perSenderAutoAcceptAfter).toBe(5);
    expect(d.schedule.backfillDays).toBe("30");
    expect(d.schedule.runOnBattery).toBe(false);
    expect(d.agentAccess).toBe("accepted");
    expect(d.agentSeesSensitive).toBe(false);
    expect(d.writeCardFiles).toBe(false);
  });

  it("allows a model per source for future routing", () => {
    const withRouting = {
      ...EVERYTHING_MEMORY_DEFAULTS,
      model: {
        default: { kind: "cloud", ref: "anthropic/claude-haiku-5-5" },
        perSource: { messages: { kind: "local", ref: "ollama/qwen3:4b" } },
      },
    };
    expect(Value.Check(EverythingMemorySettings, withRouting)).toBe(true);
    const bad = { ...EVERYTHING_MEMORY_DEFAULTS, model: { default: { kind: "remote" } } };
    expect(Value.Check(EverythingMemorySettings, bad)).toBe(false);
  });

  it("has no switch for government ids or account numbers", () => {
    const sensitive = EverythingMemorySettings.properties.sensitive.properties;
    expect(Object.keys(sensitive)).not.toContain("gov_id");
    expect(Object.keys(sensitive)).not.toContain("account_numbers");
    for (const c of HARD_BLOCKED_SENSITIVITY) {
      expect(Value.Check(GraphSensitivity, c)).toBe(true);
    }
  });

  it("memory.everything settings are admin-only (the extractor holds no admin scope)", () => {
    expect(isAdminSettingKey("memory.everything")).toBe(true);
    expect(isAdminSettingKey("memory.everything.model.default")).toBe(true);
  });

  it("extends kinds and relations additively, without a `knows` edge", () => {
    expect(Value.Check(GraphEntityKind, "event")).toBe(true);
    expect(Value.Check(GraphEntityKind, "topic")).toBe(true);
    expect(Value.Check(GraphEdgeRel, "family")).toBe(true);
    expect(Value.Check(GraphEdgeRel, "knows")).toBe(false);
    expect(Value.Check(GraphEdgeRel, "works_at")).toBe(true);
  });

  it("old-shaped facts stay valid; new columns are optional", () => {
    const old = {
      id: "f1",
      entityId: "e1",
      attribute: "city",
      value: "Lisbon",
      provenance: "untrusted",
      confidence: 0.9,
      sources: [],
      evidence: null,
      validFrom: "2026-10-28T00:00:00.000Z",
      validTo: null,
      recordedAt: "2026-10-28T00:00:00.000Z",
      supersededBy: null,
      retractedAt: null,
    };
    expect(Value.Check(GraphFact, old)).toBe(true);
    expect(
      Value.Check(GraphFact, {
        ...old,
        review: "pending",
        sensitivity: "none",
        subjectKind: "self_disclosure",
      }),
    ).toBe(true);
    expect(Value.Check(GraphFact, { ...old, review: "trusted" })).toBe(false);
  });

  it("citations carry a bounded quote and a span", () => {
    const c = {
      id: "c1",
      targetKind: "fact",
      targetId: "f1",
      source: "mail",
      docId: null,
      sourceRef: "<m1@example.com>",
      quote: "my birthday is May 3",
      start: 10,
      end: 30,
      sourceHash: "abc",
      authorEntityId: null,
      provenance: "untrusted",
      observedAt: "2026-10-28T00:00:00.000Z",
      createdAt: "2026-10-28T00:00:00.000Z",
    };
    expect(Value.Check(GraphCitation, c)).toBe(true);
    expect(Value.Check(GraphCitation, { ...c, quote: "x".repeat(201) })).toBe(false);
  });

  it("registers review, quarantine and runs methods with the right scopes", () => {
    const m = Methods as Record<string, { scope: string; sideEffecting?: boolean }>;
    for (const name of ["memory.review.list", "memory.quarantine.list", "memory.runs.list"]) {
      expect(m[name]?.scope).toBe("operator.read");
    }
    for (const name of ["memory.review.decide", "memory.review.undo", "memory.quarantine.decide"]) {
      expect(m[name]?.scope).toBe("operator.write");
      expect(m[name]?.sideEffecting).toBe(true);
    }
  });
});
