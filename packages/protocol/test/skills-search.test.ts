import type { Static } from "@sinclair/typebox";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type MethodResult,
  methodSpec,
  PsycheError,
  requiresIdempotencyKey,
  type ScanFinding,
  type ScanFindingSchema,
  type SkillCommand,
  type SkillCommandSchema,
  type SkillInstallSource,
  type SkillInstallSourceSchema,
  type SkillSummary,
  type SkillSummarySchema,
  validateEventPayload,
  validateParams,
  validateResult,
} from "../src/index.ts";

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof PsycheError) return err.code;
    throw err;
  }
  return undefined;
}

const SKILLS_READS = [
  "skills.list",
  "skills.get",
  "skills.search",
  "skills.commands",
  "skills.getProposal",
];
const SKILLS_MUTATIONS = [
  "skills.proposeInstall",
  "skills.proposeUpdate",
  "skills.proposeApproval",
  "skills.install",
  "skills.setEnabled",
  "skills.remove",
];

describe("skills.* (S16)", () => {
  it("reads need operator.read; mutations are admin and side-effecting", () => {
    for (const m of SKILLS_READS) {
      expect(methodSpec(m).scope, m).toBe("operator.read");
      expect(requiresIdempotencyKey(m), m).toBe(false);
    }
    for (const m of SKILLS_MUTATIONS) {
      expect(methodSpec(m).scope, m).toBe("operator.admin");
      expect(requiresIdempotencyKey(m), m).toBe(true);
    }
  });

  it("validates install sources and skill names", () => {
    const source = { kind: "git", url: "https://example.com/s.git", ref: "v1" };
    expect(validateParams("skills.proposeInstall", { source })).toEqual({ source });
    expect(
      codeOf(() => validateParams("skills.proposeInstall", { source: { kind: "ftp", path: "x" } })),
    ).toBe("invalid_params");
    expect(codeOf(() => validateParams("skills.remove", { name: "../etc" }))).toBe(
      "invalid_params",
    );
    expect(validateParams("skills.setEnabled", { name: "inbox-triage", enabled: false })).toEqual({
      name: "inbox-triage",
      enabled: false,
    });
  });

  it("validates skill details and a get result with unreadable text", () => {
    const skill = {
      name: "pdf",
      description: "PDFs",
      source: "bundled",
      path: "/b/pdf/SKILL.md",
      trust: "bundled",
      userInvocable: true,
      disableModelInvocation: false,
      enabled: true,
      hash: "",
      status: "active",
      reasons: [],
      findings: [{ rule: "net", severity: "warn", message: "uses network", file: "run.sh" }],
      userEnabled: true,
      overrides: [],
    };
    expect(validateResult("skills.get", { skill, text: null })).toBeTruthy();
    expect(
      codeOf(() => validateResult("skills.list", { skills: [{ ...skill, status: "on" }] })),
    ).toBe("internal");
  });

  it("carries every SkillChangeEvent variant on skills.changed", () => {
    for (const payload of [
      { type: "reloaded", added: ["a"], removed: [], changed: [] },
      { type: "hash_mismatch", name: "a", source: "workspace", path: "/w/a/SKILL.md" },
      { type: "installed", name: "a", hash: "h", enabled: false },
      { type: "removed", name: "a", source: "home" },
    ]) {
      expect(validateEventPayload("skills.changed", payload), payload.type).toEqual(payload);
    }
    expect(codeOf(() => validateEventPayload("skills.changed", { type: "renamed" }))).toBe(
      "invalid_params",
    );
  });

  it("keeps the wire schemas in step with the SkillLoader contract types", () => {
    expectTypeOf<Static<typeof SkillSummarySchema>>().toEqualTypeOf<SkillSummary>();
    expectTypeOf<Static<typeof SkillInstallSourceSchema>>().toEqualTypeOf<SkillInstallSource>();
    expectTypeOf<Static<typeof ScanFindingSchema>>().toEqualTypeOf<ScanFinding>();
    expectTypeOf<Static<typeof SkillCommandSchema>>().toEqualTypeOf<SkillCommand>();
  });
});

describe("search.query (S16 additions)", () => {
  it("accepts the new scopes and optional hit fields, groups, total and warnings", () => {
    const params = { query: "x", scopes: ["ideas", "goals", "connectors"] };
    expect(validateParams("search.query", params)).toEqual(params);
    const hit = {
      scope: "goals",
      id: "g1",
      title: "Run a marathon",
      snippet: "train for a marathon",
      score: 1.5,
      threadId: null,
      route: "/goals/g1",
      kind: "goal",
      group: "goals",
      provenance: "owner",
      createdAt: 1_760_000_000_000,
      snippetHighlights: [[13, 21]],
      titleHighlights: [[6, 14]],
    };
    const result: MethodResult<"search.query"> = validateResult("search.query", {
      hits: [hit],
      groups: [{ group: "goals", count: 1, hits: [hit] }],
      total: 1,
      warnings: ["from:nobody"],
    });
    expect(result.groups?.[0]?.count).toBe(1);
    expect(
      codeOf(() =>
        validateResult("search.query", { hits: [{ ...hit, snippetHighlights: [[1, 2, 3]] }] }),
      ),
    ).toBe("internal");
    expect(validateResult("search.query", { hits: [] })).toEqual({ hits: [] });
  });
});
