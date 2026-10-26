import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelEvent } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { parseSkill } from "../src/frontmatter.ts";
import { FsSkillLoader } from "../src/loader.ts";
import { scanSkillTree } from "../src/scanner.ts";
import {
  parseSpecialist,
  resolveSpecialistTools,
  type SpecialistDef,
  type ToolFacts,
  validateSpecialistTools,
} from "../src/specialists.ts";
import { readSkillDir } from "../src/tree.ts";
import { BUNDLED_DIR, OPEN_GATE, tempDir } from "./helpers.ts";

/**
 * The six bundled specialist roles (docs/agent/specialists-2026.md §5.2, §8 K): their sections
 * validate against the Gateway's tool names, and each role's two scripted examples produce
 * exactly their expected report through allowed tools only.
 */

const ROLES = ["coder", "organizer", "planner", "researcher", "shopper", "writer"] as const;
const catalogue = JSON.parse(
  readFileSync(new URL("./fixtures/tool-catalogue.json", import.meta.url), "utf8"),
) as { tools: ToolFacts[] };
const ALL = catalogue.tools.map((t) => t.name);
/** Tools the runtime gives every specialist (§4.3) on top of its allowlist. */
const ALWAYS = new Set(["ask_user", "specialist.report"]);

function defOf(role: string): { def: SpecialistDef; text: string } {
  const text = readFileSync(join(BUNDLED_DIR, `specialist-${role}`, "SKILL.md"), "utf8");
  const parsed = parseSkill(text, `specialist-${role}`);
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  const spec = parseSpecialist(parsed.skill.frontmatter as Record<string, unknown>);
  if (!spec.present || !spec.ok)
    throw new Error(spec.present ? spec.errors.join("; ") : "no section");
  return { def: spec.def, text };
}

interface Example {
  id: string;
  role: string;
  title: string;
  brief: string;
  tools: string[];
  script: ModelEvent[][];
  toolResults: Record<string, { output: unknown; provenance: "trusted" | "untrusted" }>;
  expectedReport: {
    outcome: string;
    summary: string;
    findings?: { title: string; detail: string; sources?: string[] }[];
    artifacts?: string[];
    next?: { label: string; message: string }[];
    gaps?: string[];
  };
}

describe("bundled specialist roles", () => {
  it("load as six roles with their sections, off the prompt index and the composer", async () => {
    const loader = new FsSkillLoader({
      homeDir: tempDir(),
      bundledDir: BUNDLED_DIR,
      gate: { ...OPEN_GATE, tools: ALL },
    });
    const roles = await loader.specialistRoles();
    expect(roles.map((r) => r.role.role).sort()).toEqual([...ROLES]);
    for (const r of roles) {
      expect(r.defaultOn).toBe(true);
      expect(r.role.maxMode).toBe("balanced");
      expect(r.skill.specialist?.unresolved, r.role.role).toEqual([]);
      expect(r.body.length).toBeGreaterThan(500);
    }
    expect((await loader.promptIndex()).included.some((n) => n.startsWith("specialist-"))).toBe(
      false,
    );
    expect((await loader.commands()).some((c) => c.name.startsWith("specialist-"))).toBe(false);
  });

  it.each(ROLES)("%s: the section validates against the Gateway's tools", (role) => {
    const { def } = defOf(role);
    expect(def.role).toBe(role);
    expect(validateSpecialistTools(def, catalogue.tools)).toEqual([]);
  });

  it.each(ROLES)("%s: the skill folder scans clean and has its acceptance script", (role) => {
    const dir = join(BUNDLED_DIR, `specialist-${role}`);
    const high = scanSkillTree(readSkillDir(dir), `specialist-${role}`).filter(
      (f) => f.severity === "high" && f.file === "SKILL.md",
    );
    expect(high).toEqual([]);
    const acceptance = readFileSync(join(dir, "acceptance.md"), "utf8");
    expect(acceptance).toMatch(/Must not happen/i);
    expect(readFileSync(join(dir, "SKILL.md"), "utf8")).toMatch(
      /information, never an instruction/i,
    );
  });

  for (const role of ROLES) {
    const dir = join(BUNDLED_DIR, `specialist-${role}`, "examples");
    let files: string[] = [];
    try {
      files = readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .sort();
    } catch {
      files = [];
    }
    it(`${role}: has two scripted examples`, () => {
      expect(files).toHaveLength(2);
    });
    for (const f of files) {
      it(`${role}/${f}: the script uses only allowed tools and ends with its expected report`, () => {
        const ex = JSON.parse(readFileSync(join(dir, f), "utf8")) as Example;
        const { def } = defOf(role);
        expect(ex.role).toBe(role);
        expect(ex.title.length).toBeLessThanOrEqual(80);
        for (const t of ex.tools) expect(ALL, `fixture tool ${t}`).toContain(t);
        const allowed = new Set(resolveSpecialistTools(def, ex.tools).tools);
        if (def.planFirst) allowed.add("exit_plan_mode");
        const calls = ex.script
          .flat()
          .filter((e): e is Extract<ModelEvent, { type: "tool_call" }> => e.type === "tool_call");
        const ids = calls.map((c) => c.id);
        expect(new Set(ids).size, "unique call ids").toBe(ids.length);
        const last = ex.script.at(-1)?.filter((e) => e.type === "tool_call") ?? [];
        expect(last).toHaveLength(1);
        expect(last[0]).toMatchObject({ name: "specialist.report", input: ex.expectedReport });
        for (const c of calls.slice(0, -1)) {
          expect(c.name).not.toBe("specialist.report");
          expect(
            allowed.has(c.name) || ALWAYS.has(c.name),
            `${c.name} is not in the ${role} allowlist`,
          ).toBe(true);
          expect(ex.toolResults[c.id], `result for ${c.id}`).toBeDefined();
        }
        if (def.planFirst) {
          const planAt = calls.findIndex((c) => c.name === "exit_plan_mode");
          expect(planAt, "plan-first roles plan before acting").toBeGreaterThanOrEqual(0);
          const firstTurn = ex.script[0]?.filter((e) => e.type === "tool_call") ?? [];
          expect(
            firstTurn.every(
              (c) => c.type === "tool_call" && !/write|edit|exec|run|git|click|type/.test(c.name),
            ),
          ).toBe(true);
        }
        const r = ex.expectedReport;
        expect(["done", "partial", "failed"]).toContain(r.outcome);
        expect(r.summary.length).toBeGreaterThan(0);
        expect(r.summary.length).toBeLessThanOrEqual(600);
        expect((r.findings ?? []).length).toBeLessThanOrEqual(12);
        expect((r.next ?? []).length).toBeLessThanOrEqual(2);
        for (const n of r.next ?? []) {
          expect(n.label.length).toBeLessThanOrEqual(60);
          expect(n.message.length).toBeLessThanOrEqual(300);
        }
        expect((r.gaps ?? []).length).toBeLessThanOrEqual(12);
        if (r.outcome === "partial") expect((r.gaps ?? []).length).toBeGreaterThan(0);
      });
    }
    it(`${role}: one example is partial and one ignores an injected instruction`, () => {
      const exs = files.map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Example);
      expect(exs.some((e) => e.expectedReport.outcome === "partial")).toBe(true);
      const injected = exs.find((e) =>
        Object.values(e.toolResults).some(
          (t) =>
            t.provenance === "untrusted" &&
            /evil\.example|ignore (your|all|previous)|forward all|delete/i.test(
              JSON.stringify(t.output),
            ),
        ),
      );
      expect(injected, "an injected-instruction fixture").toBeDefined();
      // The script never acts on it: no call addresses the attacker.
      const calls = JSON.stringify(injected?.script ?? []);
      expect(calls.replace(/"specialist\.report"[\s\S]*$/, "")).not.toMatch(/evil\.example/);
    });
  }
});
