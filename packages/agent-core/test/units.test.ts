import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import {
  AgentToolRegistry,
  applyPlanUpdate,
  completeComposerCommand,
  defineTool,
  describeMemoryCall,
  mcpToolName,
  normalizeQuestions,
  parseComposerInput,
  parseMcpToolName,
  splitForCompaction,
  validateAnswer,
} from "../src/index.ts";
import { spec } from "./harness.ts";

describe("update_plan semantics", () => {
  const items = [
    { text: "a", status: "pending" as const },
    { text: "b", status: "pending" as const },
    { text: "c", status: "pending" as const },
  ];

  it("a new list starts its first pending item", () => {
    expect(applyPlanUpdate([], { items }).map((i) => i.status)).toEqual([
      "in_progress",
      "pending",
      "pending",
    ]);
  });

  it("advance completes the current item and starts the next", () => {
    const s1 = applyPlanUpdate([], { items });
    const s2 = applyPlanUpdate(s1, { advance: true });
    expect(s2.map((i) => i.status)).toEqual(["completed", "in_progress", "pending"]);
    const s3 = applyPlanUpdate(applyPlanUpdate(s2, { advance: true }), { advance: true });
    expect(s3.map((i) => i.status)).toEqual(["completed", "completed", "completed"]);
  });

  it("done/start work out of order and keep exactly one in progress", () => {
    const s1 = applyPlanUpdate([], { items });
    expect(applyPlanUpdate(s1, { done: [1], start: 3 }).map((i) => i.status)).toEqual([
      "completed",
      "pending",
      "in_progress",
    ]);
    expect(() => applyPlanUpdate(s1, { start: 3 })).toThrow(/exactly one/);
    expect(() => applyPlanUpdate(s1, { done: [9] })).toThrow(/does not exist/);
    expect(() => applyPlanUpdate([], { advance: true })).toThrow(/no checklist/);
    expect(() => applyPlanUpdate(s1, {})).toThrow(/needs items/);
  });
});

describe("composer commands (C9)", () => {
  it("parses every command into an intent", () => {
    const cases: [string, unknown][] = [
      [
        "/model anthropic/claude-sonnet-5-5",
        { kind: "model", model: "anthropic/claude-sonnet-5-5" },
      ],
      ["/model", { kind: "model" }],
      ["/new", { kind: "new" }],
      ["/btw what time is it", { kind: "btw", text: "what time is it" }],
      ["/fork", { kind: "fork" }],
      [
        "/schedule every weekday 7am brief me",
        { kind: "schedule", text: "every weekday 7am brief me" },
      ],
      ["/incognito", { kind: "incognito" }],
      ["/forget my old address", { kind: "forget", subject: "my old address" }],
      ["/remember I prefer aisle seats", { kind: "remember", text: "I prefer aisle seats" }],
      ["/plan reorganize my inbox", { kind: "plan", text: "reorganize my inbox" }],
      ["/status", { kind: "status" }],
      ["/export json", { kind: "export", format: "json" }],
      ["/export", { kind: "export", format: "md" }],
      ["/stop", { kind: "stop" }],
    ];
    for (const [input, intent] of cases) {
      expect(parseComposerInput(input), input).toEqual({ type: "command", intent });
    }
  });

  it("returns usage errors, plain messages and the // escape", () => {
    expect(parseComposerInput("/remember")).toMatchObject({
      type: "error",
      message: "usage: /remember <fact>",
    });
    expect(parseComposerInput("/stop now")).toMatchObject({ type: "error" });
    expect(parseComposerInput("/model gpt")).toMatchObject({ type: "error" });
    expect(parseComposerInput("/export pdf")).toMatchObject({ type: "error" });
    expect(parseComposerInput("/frobnicate")).toMatchObject({
      type: "error",
      message: "unknown command /frobnicate",
    });
    expect(parseComposerInput("hello /new")).toEqual({ type: "message", text: "hello /new" });
    expect(parseComposerInput("//new is a command")).toEqual({
      type: "message",
      text: "/new is a command",
    });
    expect(completeComposerCommand("/f").map((c) => c.name)).toEqual(["fork", "forget"]);
  });
});

describe("tool registry (C3)", () => {
  it("names connector tools mcp__<server>__<tool> and parses them back", () => {
    expect(mcpToolName("notion", "delete_page")).toBe("mcp__notion__delete_page");
    expect(parseMcpToolName("mcp__notion__delete_page")).toEqual({
      server: "notion",
      tool: "delete_page",
    });
    expect(parseMcpToolName("mcp__my_srv__a__b")).toEqual({ server: "my_srv", tool: "a__b" });
    expect(parseMcpToolName("browser.click")).toBeUndefined();
    expect(() => mcpToolName("a__b", "t")).toThrow();
  });

  it("rejects duplicates, unregisters, and filters by mode, run mode and toggles", () => {
    const r = new AgentToolRegistry();
    const execute = async () => ({ output: null, provenance: "trusted" as const });
    const off = r.register({ spec: spec("read_file", "read"), execute });
    r.register({ spec: spec("ask_user", "none"), execute });
    r.register({ spec: spec("exit_plan_mode", "none"), execute });
    r.register({ spec: spec("calc", "none"), execute });
    expect(() => r.register({ spec: spec("calc", "none"), execute })).toThrow(/already registered/);
    const names = (x: ReturnType<typeof r.active>) => x.tools.map((t) => t.spec.name);
    expect(names(r.active({ permissionMode: "balanced", runMode: "attended" }))).toEqual([
      "read_file",
      "ask_user",
      "calc",
    ]);
    expect(names(r.active({ permissionMode: "plan", runMode: "attended" }))).toEqual([
      "ask_user",
      "exit_plan_mode",
      "calc",
    ]);
    expect(names(r.active({ permissionMode: "balanced", runMode: "unattended" }))).toEqual([
      "read_file",
      "calc",
    ]);
    const toggled = r.active({
      permissionMode: "balanced",
      runMode: "attended",
      toggles: { calc: false },
    });
    expect(toggled.hidden.get("calc")).toBe("turned off in settings");
    off();
    expect(r.get("read_file")).toBeUndefined();
    expect(r.list().map((s) => s.name)).toEqual(["ask_user", "exit_plan_mode", "calc"]);
  });

  it("defineTool turns a TypeBox schema into plain JSON Schema and validates params", async () => {
    const tool = defineTool({
      name: "add",
      description: "Add",
      input: Type.Object({ a: Type.Number(), b: Type.Number() }),
      sideEffect: "none",
      run: async (p) => ({ output: p.a + p.b, provenance: "trusted" }),
    });
    expect(Object.getOwnPropertySymbols(tool.spec.inputSchema)).toHaveLength(0);
    expect(tool.spec.inputSchema).toMatchObject({ type: "object", required: ["a", "b"] });
    expect(tool.validate?.({ a: 1 })).toMatch(/b/);
    expect(tool.validate?.({ a: 1, b: 2 })).toBeUndefined();
  });

  it("memory writes to protected files are write + memory_protected_write bound to the content", () => {
    const a = describeMemoryCall({ command: "create", path: "/memories/SOUL.md", file_text: "x" });
    const b = describeMemoryCall({ command: "create", path: "SOUL.md", file_text: "y" });
    expect(a).toMatchObject({
      sideEffect: "write",
      kind: "memory_protected_write",
      target: { value: "SOUL.md" },
    });
    expect(a.bindingFields).not.toEqual(b.bindingFields);
    expect(
      describeMemoryCall({ command: "rename", old_path: "AGENTS.md", new_path: "x.md" }).kind,
    ).toBe("memory_protected_write");
    expect(
      describeMemoryCall({ command: "create", path: "notes/a.md", file_text: "x" }).sideEffect,
    ).toBeUndefined();
  });
});

describe("questions (C4)", () => {
  const q = (header: string, labels: string[], multiSelect = false) => ({
    question: `${header}?`,
    header,
    multiSelect,
    options: labels.map((label) => ({ label })),
  });

  it("puts the recommended option first and checks answers by header", () => {
    const [n] = normalizeQuestions({ questions: [q("Seat", ["Aisle", "Window (Recommended)"])] });
    expect(n?.options.map((o) => o.label)).toEqual(["Window (Recommended)", "Aisle"]);
    const qs = normalizeQuestions({
      questions: [q("Seat", ["A", "B"]), q("Meals", ["Veg", "Fish"], true)],
    });
    expect(() => validateAnswer(qs, { Seat: "A", Meals: ["Veg"] })).not.toThrow();
    expect(() => validateAnswer(qs, { Seat: "my own text", Meals: [] })).not.toThrow();
    expect(() => validateAnswer(qs, { Seat: ["A"], Meals: ["Veg"] })).toThrow(/one answer/);
    expect(() => validateAnswer(qs, { Seat: "A" })).toThrow(/missing/);
  });

  it("rejects duplicate headers, an explicit Other and unsafe previews", () => {
    expect(() =>
      normalizeQuestions({ questions: [q("A", ["x", "y"]), q("A", ["x", "y"])] }),
    ).toThrow(/duplicate header/);
    expect(() => normalizeQuestions({ questions: [q("A", ["x", "other"])] })).toThrow(/Other/);
    const preview = q("A", ["x", "y"]);
    (preview.options[0] as { preview?: string }).preview = "<script>alert(1)</script>";
    expect(() => normalizeQuestions({ questions: [preview] })).toThrow(/scripts/);
  });
});

describe("compaction split", () => {
  it("never separates a tool call from its result", () => {
    const user = (t: string) => ({
      role: "user" as const,
      parts: [{ type: "text" as const, text: t }],
    });
    const messages = [
      user("1"),
      {
        role: "assistant" as const,
        parts: [{ type: "tool_call" as const, id: "c", name: "t", input: {} }],
      },
      { role: "tool" as const, parts: [{ type: "tool_result" as const, callId: "c", output: 1 }] },
      user("2"),
      user("3"),
    ];
    const { older, recent } = splitForCompaction(messages, 2);
    expect(older).toHaveLength(3);
    expect(recent).toEqual([user("2"), user("3")]);
    expect(splitForCompaction(messages.slice(0, 3), 2).older).toHaveLength(0);
  });
});
