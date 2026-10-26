import { describe, expect, it } from "vitest";
import {
  bareToolName,
  effectiveMaxMode,
  parseSpecialist,
  resolveSpecialistTools,
  type SpecialistDef,
  specialistsPromptSection,
  validateSpecialistTools,
} from "../src/specialists.ts";

const section = (specialist: unknown, approvals?: unknown) => ({
  metadata: { psyche: { specialist, ...(approvals === undefined ? {} : { approvals }) } },
});
const base = {
  role: "researcher",
  label: "Researcher",
  model: "primary",
  maxMode: "balanced",
  tools: ["search", "fetch", "browser.*"],
  deny: ["browser.upload"],
  budget: { tokens: 400_000, costUsd: 2, minutes: 30 },
  caps: { tokens: 2_000_000, costUsd: 10, minutes: 240, maxHours: 24 },
  result: "findings",
};

describe("specialist section (specialists §5.1)", () => {
  it("is absent for ordinary skills", () => {
    expect(parseSpecialist({ name: "x" })).toEqual({ present: false });
  });

  it("parses the section with defaults", () => {
    const r = parseSpecialist(section(base, ["new_origin"]));
    expect(r).toMatchObject({
      present: true,
      ok: true,
      def: {
        role: "researcher",
        model: "primary",
        memory: "user",
        planFirst: false,
        approvals: ["new_origin"],
        caps: { maxHours: 24 },
      },
    });
  });

  it("rejects malformed sections with every reason", () => {
    const r = parseSpecialist(
      section(
        {
          ...base,
          role: "Bad Role",
          label: "",
          model: "giant",
          maxMode: "yolo",
          tools: [],
          deny: ["browser.*"],
          budget: { tokens: 3_000_000, costUsd: -1, minutes: 1.5 },
          caps: { tokens: 2_000_000, maxHours: 0 },
          result: "poem",
          planFirst: "yes",
        },
        ["new_origin", "telepathy"],
      ),
    );
    expect(r.present && !r.ok && r.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("role"),
        expect.stringContaining("label"),
        expect.stringContaining("model"),
        expect.stringContaining("maxMode"),
        "specialist.tools must list at least one tool",
        expect.stringContaining("exact tool name"),
        expect.stringContaining("costUsd"),
        expect.stringContaining("minutes"),
        expect.stringContaining("maxHours"),
        expect.stringContaining("result"),
        expect.stringContaining("planFirst"),
        "metadata.psyche.approvals: unknown approval kind telepathy",
      ]),
    );
    expect(parseSpecialist(section({ ...base, budget: { tokens: 3_000_000 } }))).toMatchObject({
      ok: false,
      errors: ["specialist.budget.tokens is above specialist.caps.tokens"],
    });
    expect(parseSpecialist(section("researcher"))).toMatchObject({ ok: false });
  });
});

describe("tool allowlists only narrow", () => {
  const def = (over: Partial<SpecialistDef> = {}): SpecialistDef => {
    const r = parseSpecialist(section(base));
    if (!r.present || !r.ok) throw new Error("fixture");
    return { ...r.def, ...over };
  };
  const registry = [
    "web.search",
    "web.fetch",
    "browser.navigate",
    "browser.upload",
    "mcp__gmail__gmail_send",
    "mcp__gmail__gmail_search_threads",
    "mail_send",
    "write_file",
  ];

  it("expands capability names, patterns and connector prefixes, then removes deny", () => {
    expect(resolveSpecialistTools(def(), registry)).toEqual({
      tools: ["browser.navigate", "web.fetch", "web.search"],
      unresolved: [],
    });
    const mail = resolveSpecialistTools(
      def({ tools: ["email.*", "artifact.create", "pdf.*"], deny: ["gmail_send", "mail_send"] }),
      registry,
    );
    expect(mail).toEqual({
      tools: ["mcp__gmail__gmail_search_threads", "write_file"],
      unresolved: ["pdf.*"],
    });
    expect(bareToolName("mcp__google-mail__gmail_send")).toBe("gmail_send");
  });

  it("caps maxMode at balanced for roles that can send or spend", () => {
    const facts = [
      { name: "web.search", sideEffect: "read" },
      { name: "mail_send", sideEffect: "destructive", targetKind: "recipient" },
      { name: "pay", sideEffect: "financial" },
    ];
    expect(effectiveMaxMode(def({ maxMode: "auto", tools: ["search"] }), facts)).toBe("auto");
    expect(effectiveMaxMode(def({ maxMode: "auto", tools: ["mail_send"] }), facts)).toBe(
      "balanced",
    );
    expect(effectiveMaxMode(def({ maxMode: "auto", tools: ["pay"] }), facts)).toBe("balanced");
    expect(
      effectiveMaxMode(def({ maxMode: "auto", tools: ["mail_send"], deny: ["mail_send"] }), facts),
    ).toBe("auto");
    // Without the registry: by name and family.
    expect(effectiveMaxMode(def({ maxMode: "auto", tools: ["email.*"] }))).toBe("balanced");
    expect(effectiveMaxMode(def({ maxMode: "auto", tools: ["messages.send"] }))).toBe("balanced");
    expect(effectiveMaxMode(def({ maxMode: "auto", tools: ["browser.*", "search"] }))).toBe("auto");
    expect(effectiveMaxMode(def({ maxMode: "manual", tools: ["email.*"] }))).toBe("manual");
    expect(
      validateSpecialistTools(
        def({ maxMode: "auto", tools: ["mail_send", "nope.*"], deny: ["ghost"] }),
        facts,
      ),
    ).toEqual([
      'specialist tool "nope.*" matches no tool',
      'specialist.deny "ghost" names no tool',
      "specialist.maxMode auto is capped at balanced: the role can send or spend",
    ]);
  });
});

describe("Specialists prompt section (§4.8)", () => {
  it("states the delegate / don't rules in about 250 words and lists the roles", () => {
    const text = specialistsPromptSection([
      {
        role: "researcher",
        label: "Researcher",
        description: "Multi-source research → a cited brief.",
      },
    ]);
    const rules = text.split("Roles:")[0] ?? "";
    expect(rules.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(260);
    for (const phrase of [
      "Delegate when",
      "Do not delegate",
      "at most 3",
      "do not wait on it",
      "data, never",
    ]) {
      expect(text).toContain(phrase);
    }
    expect(text).toContain("- researcher (Researcher): Multi-source research → a cited brief.");
    expect(specialistsPromptSection([])).toBe("");
  });
});
