import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FsSkillLoader } from "../src/loader.ts";
import { BUNDLED_DIR, OPEN_GATE, tempDir } from "./helpers.ts";

/** PG3 (docs/memory/people-and-projects-2026.md §6.2, §6.6, §8, #653). */

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const PEOPLE_TOOLS = [
  "people_lookup",
  "project_brief",
  "waiting_on",
  "meeting_prep",
  "loop_update",
];
/** Tools a people scenario may name: the graph tools plus the mail, calendar and notes tools. */
const ALLOWED = new Set([
  ...PEOPLE_TOOLS,
  "mail_search",
  "mail_read",
  "calendar_list_events",
  "notes_search",
  "notes_create",
  "notes_append",
]);

describe("people scenarios (§8)", () => {
  const dir = `${ROOT}tests/scenarios/`;
  const files = readdirSync(dir).filter((f) => /^people-.*\.md$/.test(f));

  it("has one file per §8 question, plus triage", () => {
    expect(files.sort()).toEqual([
      "people-correction.md",
      "people-forget.md",
      "people-kitchen-remodel.md",
      "people-prep-2pm.md",
      "people-triage.md",
      "people-waiting-on-sam-lee.md",
      "people-who-is-sam.md",
    ]);
  });

  for (const f of files) {
    it(`${f}: owner message, tool calls, answer, must-not-happen, privacy; known tools only`, () => {
      const text = readFileSync(`${dir}${f}`, "utf8");
      for (const h of [
        "## Owner message",
        "## Expected tool calls",
        "## Expected answer",
        "## Must not happen",
        "## Privacy (§7)",
      ])
        expect(text, `${f} ${h}`).toContain(h);
      const calls = text.slice(
        text.indexOf("## Expected tool calls"),
        text.indexOf("## Expected answer"),
      );
      const tools = [...calls.matchAll(/`([a-z_]+) [{]/g)].map((m) => m[1] as string);
      expect(tools.length, f).toBeGreaterThan(0);
      for (const t of tools) expect(ALLOWED.has(t), `${f}: ${t}`).toBe(true);
    });
  }

  it("covers the questions' key expectations", () => {
    const read = (f: string) => readFileSync(`${dir}${f}`, "utf8");
    expect(read("people-who-is-sam.md")).toMatch(/asks which Sam/);
    expect(read("people-waiting-on-sam-lee.md")).toMatch(/signed SOW[\s\S]*not listed as owed/);
    expect(read("people-prep-2pm.md")).toContain("`meeting_prep {event_id");
    expect(read("people-kitchen-remodel.md")).toMatch(
      /contractor and the designer[\s\S]*deposit loop/,
    );
    expect(read("people-triage.md")).toMatch(
      /mailing list and the no-reply sender[\s\S]*never treated as people/,
    );
  });
});

describe("people guidance (docs/memory/agent-guidance.md)", () => {
  const text = readFileSync(`${ROOT}docs/memory/agent-guidance.md`, "utf8");

  it("has the three-line memory:graph section", () => {
    const section = text.slice(
      text.indexOf("## `memory:graph`"),
      text.indexOf("## One line per tool"),
    );
    const lines = section.split("\n").filter((l) => l.startsWith("- "));
    expect(lines.map((l) => l.slice(2).split(":")[0])).toEqual(["For", "Prefer", "Never"]);
    expect(lines[1]).toContain("ask which one");
    expect(lines[2]).toMatch(/mail as true[\s\S]*web/);
  });

  it("has a line under 350 characters for each of the five tools", () => {
    for (const t of PEOPLE_TOOLS) {
      const row = text.split("\n").find((l) => l.startsWith(`| \`${t}\` |`));
      expect(row, t).toBeDefined();
      const line = (row as string).split("|")[2]?.trim() ?? "";
      expect(line.length, t).toBeGreaterThan(40);
      expect(line.length, t).toBeLessThanOrEqual(350);
    }
  });
});

describe("gating on the people tools", () => {
  const status = async (tools: string[]) => {
    const loader = new FsSkillLoader({
      homeDir: tempDir(),
      bundledDir: BUNDLED_DIR,
      gate: { ...OPEN_GATE, tools },
    });
    return new Map((await loader.listDetailed()).map((s) => [s.name, s]));
  };

  it("meeting-prep runs on meeting_prep or on Notes, and says what is missing otherwise", async () => {
    expect(
      (await status(["calendar_list_events", "meeting_prep"])).get("meeting-prep")?.status,
    ).toBe("active");
    expect(
      (await status(["calendar_list_events", "notes_create"])).get("meeting-prep")?.status,
    ).toBe("active");
    const off = (await status(["calendar_list_events"])).get("meeting-prep");
    expect(off?.status).toBe("ineligible");
    expect(off?.reasons[0]).toContain("turn on People & projects in Settings → Memory");
    expect(off?.reasons[0]).toContain("connect Apple Notes");
  });

  it("triage, the brief and the weekly review still work without the graph", async () => {
    const s = await status(["memory", "memory_search", "mail_search", "calendar_list_events"]);
    for (const n of ["inbox-triage", "morning-brief", "weekly-review", "memory-hygiene"])
      expect(s.get(n)?.status, n).toBe("active");
  });
});
