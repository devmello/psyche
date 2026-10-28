import { afterEach, describe, expect, it } from "vitest";
import type { MemoryFileChange } from "../src/store.ts";
import { type MemoryToolContext, MemoryTools } from "../src/tools/index.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

let env: TestEnv | undefined;
afterEach(async () => {
  await env?.cleanup();
  env = undefined;
});

const link = { threadId: "thr_1", runId: "run_1", toolCallId: "call_1" };
const agent: MemoryToolContext = { provenance: "agent", privateSession: true, link };

describe("file change reporting", () => {
  it("reports memory-tool writes with the thread and turn, remember appends, and owner edits", async () => {
    const seen: MemoryFileChange[] = [];
    env = await makeEnv({ onChange: (c) => seen.push(c) });
    const tools = new MemoryTools(env.store);
    await tools.execute(
      "memory",
      { command: "create", path: "/memories/memory/agent/note.md", file_text: "hello" },
      agent,
    );
    await tools.execute("remember", { text: "Likes tea" }, agent);
    await env.store.writeFileAsOwner("memory/agent/note.md", "hello there");

    const create = seen.find((c) => c.path === "memory/agent/note.md" && c.action === "create");
    expect(create).toMatchObject({
      actor: "agent",
      after: "hello",
      link: { ...link, tool: "memory" },
    });
    const append = seen.find((c) => c.action === "append");
    expect(append).toMatchObject({ actor: "agent", link: { tool: "remember", threadId: "thr_1" } });
    expect(append?.after).toContain("Likes tea");
    const owner = seen.find((c) => c.actor === "owner");
    expect(owner).toMatchObject({ action: "update", before: "hello", after: "hello there" });
  });

  it("reports deletes and ignores no-op writes", async () => {
    const seen: MemoryFileChange[] = [];
    env = await makeEnv({ onChange: (c) => seen.push(c) });
    await env.store.writeFileAsOwner("memory/x.md", "a");
    await env.store.writeFileAsOwner("memory/x.md", "a");
    await env.store.delete("memory/x.md", { provenance: "owner", actor: "owner", source: "api" });
    expect(seen.map((c) => c.action)).toEqual(["create", "delete"]);
    expect(seen[1]?.before).toBe("a");
  });

  it("a failing sink never fails the write", async () => {
    env = await makeEnv({
      onChange: () => {
        throw new Error("boom");
      },
    });
    await expect(env.store.writeFileAsOwner("memory/y.md", "ok")).resolves.toMatchObject({
      content: "ok",
    });
  });
});
