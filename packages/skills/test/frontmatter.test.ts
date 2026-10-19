import { describe, expect, it } from "vitest";
import { parseSkill, splitFrontmatter } from "../src/frontmatter.ts";
import { evaluateGates, toolMatches } from "../src/gating.ts";
import { OPEN_GATE } from "./helpers.ts";

const md = (fm: string, body = "Body\n") => `---\n${fm}\n---\n${body}`;

describe("SKILL.md frontmatter", () => {
  it("parses the Agent Skills fields with defaults", () => {
    const r = parseSkill(md("name: inbox-triage\ndescription: Sort the inbox."), "inbox-triage");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.skill.meta).toMatchObject({
      name: "inbox-triage",
      description: "Sort the inbox.",
      userInvocable: true,
      disableModelInvocation: false,
      requires: { bins: [], anyBins: [], env: [], os: [], tools: [], anyTools: [] },
    });
    expect(r.skill.body).toBe("Body\n");
  });

  it("reads gating from requires, top-level os and metadata.openclaw", () => {
    const r = parseSkill(
      md(
        [
          "name: x",
          "description: d",
          "user-invocable: false",
          "disable-model-invocation: true",
          "requires:",
          '  bins: ["ffmpeg"]',
          "  tools: [email.*]",
          "  anyTools: [messages.send, email.send]",
          "os: darwin",
          "metadata:",
          "  openclaw:",
          "    requires: { env: [OPENAI_KEY], anyBins: [rg, grep] }",
          "    os: [linux]",
        ].join("\n"),
      ),
    );
    expect(r.ok && r.skill.meta).toMatchObject({
      userInvocable: false,
      disableModelInvocation: true,
      requires: {
        bins: ["ffmpeg"],
        anyBins: ["rg", "grep"],
        env: ["OPENAI_KEY"],
        os: ["darwin", "linux"],
        tools: ["email.*"],
        anyTools: ["messages.send", "email.send"],
      },
    });
  });

  it("rejects missing or malformed fields", () => {
    const errs = (text: string, folder?: string) => {
      const r = parseSkill(text, folder);
      return r.ok ? [] : r.errors;
    };
    expect(errs("# no frontmatter")).toEqual(["missing YAML frontmatter (---)"]);
    expect(errs(md("description: d"))).toEqual(["name is required"]);
    expect(errs(md("name: Bad_Name\ndescription: d"))[0]).toMatch(/lowercase/);
    expect(errs(md("name: a--b\ndescription: d"))[0]).toMatch(/lowercase/);
    expect(errs(md("name: ok\ndescription: d"), "other")[0]).toMatch(/folder name/);
    expect(errs(md(`name: ok\ndescription: ${"x".repeat(1025)}`))[0]).toMatch(/longer/);
    expect(errs(md("name: ok\ndescription: d\nuser-invocable: yes please"))[0]).toMatch(/true or false/);
    expect(errs(md("name: ok\nname: again\ndescription: d"))[0]).toMatch(/invalid YAML/);
    expect(errs(md("- a\n- b"))).toEqual(["frontmatter must be a mapping"]);
  });

  it("caps YAML aliases (billion laughs)", () => {
    const bomb = [
      "a: &a [x, x, x, x, x, x, x, x, x]",
      "b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a]",
      "c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b]",
      "d: [*c, *c, *c, *c, *c, *c, *c, *c, *c]",
      "name: x",
      "description: d",
    ].join("\n");
    const r = parseSkill(md(bomb));
    expect(r.ok).toBe(false);
  });

  it("handles CRLF, BOM and a body-less file", () => {
    expect(splitFrontmatter("﻿---\r\nname: a\r\n---\r\nhi")).toEqual({ yaml: "name: a\n", body: "hi" });
    expect(splitFrontmatter("---\nname: a\n---")).toEqual({ yaml: "name: a\n", body: "" });
    expect(splitFrontmatter("---\nname: a\n--- trailing\n")).toBeUndefined();
  });
});

describe("gating", () => {
  const req = { bins: [], anyBins: [], env: [], os: [], tools: [], anyTools: [] };

  it("checks binaries, env and OS", () => {
    const ctx = { platform: "linux", env: { TOKEN: "1", EMPTY: "" }, hasBin: (b: string) => b === "git" };
    expect(evaluateGates({ ...req, bins: ["git"], env: ["TOKEN"] }, ctx)).toEqual({ eligible: true, missing: [] });
    expect(evaluateGates({ ...req, bins: ["ffmpeg"], env: ["EMPTY", "NOPE"], os: ["darwin"], anyBins: ["a", "b"] }, ctx).missing).toEqual([
      "os: needs darwin",
      "missing binary: ffmpeg",
      "needs one of: a, b",
      "missing env: EMPTY",
      "missing env: NOPE",
    ]);
  });

  it("matches tool families and treats an unknown registry as passing", () => {
    expect(toolMatches("email.*", "email.send")).toBe(true);
    expect(toolMatches("email.*", "emailx.send")).toBe(false);
    expect(toolMatches("browser.navigate", "browser.navigate")).toBe(true);
    const r = { ...req, tools: ["email.*"], anyTools: ["messages.send", "email.draft"] };
    expect(evaluateGates(r, { ...OPEN_GATE, tools: ["email.draft", "email.send"] }).eligible).toBe(true);
    expect(evaluateGates(r, { ...OPEN_GATE, tools: ["calendar.list"] }).missing).toEqual([
      "missing tool: email.*",
      "needs one of the tools: messages.send, email.draft",
    ]);
    expect(evaluateGates(r, OPEN_GATE).eligible).toBe(true);
  });
});
