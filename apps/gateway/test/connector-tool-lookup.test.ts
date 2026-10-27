import { AgentToolRegistry } from "@psyche/agent-core";
import { describe, expect, it } from "vitest";
import { connectorToolLookup } from "../src/compose/proactive.ts";

function register(reg: AgentToolRegistry, name: string) {
  reg.registerExecutor(
    { name, description: name, parameters: { type: "object", properties: {} } } as never,
    async () => ({ content: [] }) as never,
  );
}

describe("connectorToolLookup", () => {
  it("resolves a bare connector tool name to its mcp__<connector>__ registration", () => {
    const reg = new AgentToolRegistry();
    register(reg, "mcp__apple-notes-x1__notes_create");
    const lookup = connectorToolLookup(reg);
    expect(lookup.get("notes_create")?.spec.name).toBe("mcp__apple-notes-x1__notes_create");
  });

  it("prefers an exact name and returns undefined when nothing matches", () => {
    const reg = new AgentToolRegistry();
    register(reg, "notes_create");
    register(reg, "mcp__apple-notes-x1__notes_create");
    const lookup = connectorToolLookup(reg);
    expect(lookup.get("notes_create")?.spec.name).toBe("notes_create");
    expect(lookup.get("notes_delete")).toBeUndefined();
    // A suffix inside another tool's name does not match.
    expect(lookup.get("create")).toBeUndefined();
  });
});
