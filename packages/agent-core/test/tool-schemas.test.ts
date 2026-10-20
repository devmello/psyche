import { FakeSandboxRunner } from "@psyche/testing";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import {
  type AgentToolRegistration,
  codingTools,
  defineTool,
  toObjectSchema,
} from "../src/index.ts";
import { harness } from "./harness.ts";

/**
 * #414: providers take a tool's input schema only as one top-level `type: "object"`. Anthropic
 * refused every request that offered `code.git` (a top-level `anyOf`). Every built-in and every
 * tool agent-core defines must advertise an object schema; unions of variants are flattened and
 * still validated per variant.
 */

const stub = (name: string) =>
  defineTool({
    name,
    description: name,
    input: Type.Object({ path: Type.String() }),
    sideEffect: "read",
    run: async () => ({ output: {}, provenance: "trusted" }),
  });

function allTools(): AgentToolRegistration[] {
  const h = harness();
  const coding = codingTools({
    files: { read: stub("read_file"), write: stub("write_file") },
    folders: () => [],
    runner: new FakeSandboxRunner(),
    git: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
  });
  for (const t of coding) h.loop.registry.register(t);
  return h.loop.registry
    .list()
    .map((spec) => h.loop.registry.get(spec.name) as AgentToolRegistration);
}

describe("tool input schemas (#414)", () => {
  it("every built-in and coding tool advertises a top-level object", () => {
    const tools = allTools();
    const names = tools.map((t) => t.spec.name);
    expect(names).toEqual(expect.arrayContaining(["memory", "code.git", "code.run", "notify"]));
    for (const t of tools) {
      const s = t.spec.inputSchema as Record<string, unknown>;
      expect([t.spec.name, s.type]).toEqual([t.spec.name, "object"]);
      expect([t.spec.name, s.anyOf ?? s.oneOf ?? s.allOf]).toEqual([t.spec.name, undefined]);
      expect(typeof s.properties).toBe("object");
    }
  });

  it("flattens code.git's operations and still validates each one exactly", () => {
    const git = allTools().find((t) => t.spec.name === "code.git") as AgentToolRegistration;
    const s = git.spec.inputSchema as {
      properties: Record<string, { enum?: string[]; description?: string }>;
      required: string[];
    };
    expect(s.properties.op?.enum).toEqual(["status", "diff", "log", "commit", "branch", "push"]);
    expect(s.properties.op?.description).toContain("commit (requires message)");
    expect(s.properties.op?.description).toContain(
      "push (requires remote, remote_url, branch, commit)",
    );
    expect(s.required.sort()).toEqual(["op", "root"]);
    expect(git.validate?.({ root: "/r", op: "status" })).toBeUndefined();
    expect(git.validate?.({ root: "/r", op: "commit", message: "Fix" })).toBeUndefined();
    expect(git.validate?.({ root: "/r", op: "commit" })).toMatch(/message/);
    expect(git.validate?.({ root: "/r", op: "rebase" })).toMatch(/\/op: must be one of/);
  });

  it("flattens memory's commands the same way", () => {
    const memory = allTools().find((t) => t.spec.name === "memory") as AgentToolRegistration;
    const s = memory.spec.inputSchema as { properties: Record<string, { enum?: string[] }> };
    expect(s.properties.command?.enum).toEqual([
      "view",
      "create",
      "str_replace",
      "insert",
      "delete",
      "rename",
    ]);
    expect(memory.validate?.({ command: "view", path: "MEMORY.md" })).toBeUndefined();
    expect(memory.validate?.({ command: "create", path: "a.md" })).toMatch(/file_text/);
  });

  it("gives any non-object schema the object type", () => {
    expect(toObjectSchema({ properties: {} })).toMatchObject({ type: "object" });
    expect(toObjectSchema({ type: "object", properties: { a: {} } })).toEqual({
      type: "object",
      properties: { a: {} },
    });
  });
});
