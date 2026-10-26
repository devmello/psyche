import { describe, expect, it } from "vitest";
import { unifiedDiff } from "../src/diff.ts";
import { buildPromptIndex, extractSkillReferences, type IndexableSkill } from "../src/prompt.ts";

const skill = (name: string, over: Partial<IndexableSkill> = {}): IndexableSkill => ({
  name,
  description: `Helps with ${name}.`,
  source: "bundled",
  trust: "bundled",
  ...over,
});

describe("prompt index", () => {
  it("lists workspace skills first, escapes text and stays inside the budget", () => {
    const idx = buildPromptIndex([
      skill("zeta"),
      skill("alpha", { source: "home", trust: "unknown", description: 'Uses <b>&"quotes"' }),
      skill("mine", { source: "workspace", trust: "local" }),
    ]);
    expect(idx.included).toEqual(["mine", "alpha", "zeta"]);
    expect(idx.text).toContain(
      '<skill name="alpha" trust="unknown">Uses &lt;b&gt;&amp;&quot;quotes&quot;</skill>',
    );
    expect(idx.text.startsWith("<available_skills>")).toBe(true);
    expect(idx.text.endsWith("</available_skills>")).toBe(true);
    expect(idx.omitted).toEqual([]);
  });

  it("truncates with an explicit omitted marker, never silently", () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      skill(`skill-${String(i).padStart(2, "0")}`, { description: "x".repeat(200) }),
    );
    const idx = buildPromptIndex(many, { budgetChars: 3_000 });
    expect(idx.text.length).toBeLessThanOrEqual(3_000);
    expect(idx.included.length).toBeGreaterThan(0);
    expect(idx.included.length + idx.omitted.length).toBe(50);
    expect(idx.text).toContain(`<omitted count="${idx.omitted.length}">`);
    expect(idx.text).toContain("skills_search");
  });

  it("clips long descriptions", () => {
    const idx = buildPromptIndex([skill("a", { description: "word ".repeat(200) })], {
      maxDescriptionChars: 50,
    });
    expect(idx.text).toMatch(/>(word ){9}word…<\/skill>/);
  });

  it("fits every bundled skill in agent-core's 8 000-character budget", async () => {
    const { FsSkillLoader } = await import("../src/loader.ts");
    const { BUNDLED_DIR, OPEN_GATE, tempDir } = await import("./helpers.ts");
    const loader = new FsSkillLoader({
      homeDir: tempDir(),
      bundledDir: BUNDLED_DIR,
      gate: OPEN_GATE,
    });
    const idx = await loader.promptIndex();
    expect(idx.included).toHaveLength(19);
    expect(idx.omitted).toEqual([]);
    expect(idx.text.length).toBeLessThanOrEqual(8_000);
  });
});

describe("$skill references", () => {
  it("finds known names, unique, in order, at most eight", () => {
    const known = new Set([
      "inbox-triage",
      "weekly-review",
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
      "g",
      "h",
      "i",
    ]);
    expect(
      extractSkillReferences("do $weekly-review then $inbox-triage and $weekly-review", known),
    ).toEqual(["weekly-review", "inbox-triage"]);
    expect(
      extractSkillReferences("costs $5 and $unknown-skill, not a$inbox-triage", known),
    ).toEqual([]);
    expect(extractSkillReferences("($a) $b $c $d $e $f $g $h $i", known)).toHaveLength(8);
  });
});

describe("unified diff", () => {
  it("renders hunks with context", () => {
    const a = ["1", "2", "3", "4", "5", "6", "7", "8", "9"].join("\n");
    const b = ["1", "2", "3", "4", "five", "6", "7", "8", "9", "10"].join("\n");
    expect(unifiedDiff("SKILL.md", a, b)).toBe(
      "--- a/SKILL.md\n+++ b/SKILL.md\n@@ -2,8 +2,9 @@\n 2\n 3\n 4\n-5\n+five\n 6\n 7\n 8\n 9\n+10\n",
    );
    expect(unifiedDiff("x", "same", "same")).toBe("");
    expect(unifiedDiff("new.sh", undefined, "echo hi")).toBe(
      "--- /dev/null\n+++ b/new.sh\n@@ -0,0 +1,1 @@\n+echo hi\n",
    );
  });
});
