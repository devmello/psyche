import { describe, expect, it } from "vitest";
import { CTX, call, makeBroker, path } from "./helpers.ts";

/**
 * The memory tool names its protected-file writes itself (`memory_protected_write`, `write`); any
 * other memory call is Psyche's own notes. Notes are no longer judged as protected writes, so a
 * tainted turn can record (as untrusted, by the tool) and the owner can grant them like other
 * writes, while the protected files keep their floor and the tainted denial.
 */
describe("memory tool: own notes vs protected files", () => {
  it("a note under memory/agent/ is an ordinary write, not a protected one", async () => {
    const h = makeBroker();
    const d = await h.broker.decide(
      call("memory", "none", undefined, { params: { command: "create" } }),
      CTX,
    );
    expect(d.decision).toBe("ask");
    expect(d.approvalKind).not.toBe("memory_protected_write");
    expect(d.rule).not.toBe("memory:protected_path");
  });

  it("protected files still always ask, and a tainted turn is denied", async () => {
    const h = makeBroker();
    for (const file of ["MEMORY.md", "USER.md", "SOUL.md", "IDENTITY.md", "AGENTS.md"]) {
      const protectedWrite = call("memory", "write", path(file), {
        kind: "memory_protected_write",
      });
      const ask = await h.broker.decide(protectedWrite, CTX);
      expect(ask.decision, file).toBe("ask");
      expect(ask.approvalKind, file).toBe("memory_protected_write");
      const tainted = await h.broker.decide(protectedWrite, { ...CTX, taint: true });
      expect(tainted.decision, file).toBe("deny");
    }
  });
});

/**
 * Balanced friction (live QA, 2026-11-25): every `memory` call asked, reads included, because the
 * `memory` write floor overrode the tool's own `none`. Psyche's own notes now run without a card;
 * anything else keeps its decision.
 */
describe("memory tool: no card for the agent's own memory in Balanced", () => {
  const memory = (params: Record<string, unknown>) => call("memory", "none", undefined, { params });
  const decide = (c: ReturnType<typeof call>, mode = CTX.permissionMode) =>
    makeBroker().broker.decide(c, { ...CTX, permissionMode: mode });

  it.each([
    ["a folder view", { command: "view", path: "memory/agent" }],
    ["a folder view with a trailing slash", { command: "view", path: "/memories/memory/agent/" }],
    ["a file view", { command: "view", path: "memory/agent/commitments.md" }],
    ["a workspace view", { command: "view", path: "/" }],
    ["creating a note", { command: "create", path: "memory/agent/commitments.md", file_text: "x" }],
    [
      "a note via /memories/",
      { command: "create", path: "/memories/memory/agent/a.md", file_text: "x" },
    ],
    [
      "appending to today's note",
      { command: "insert", path: "memory/2026-11-25.md", insert_line: 0, insert_text: "x" },
    ],
    [
      "editing a note",
      { command: "str_replace", path: "memory/agent/a.md", old_str: "a", new_str: "b" },
    ],
  ])("%s runs without a card", async (_name, params) => {
    const d = await decide(memory(params));
    expect(d.decision, d.trace.join(" ")).toBe("allow");
  });

  it("control: an automation's workflow state still asks (any workflow's state, not the run's own)", async () => {
    const d = await decide(
      call("automation_state_set", "write", undefined, { params: { group: "evening", data: {} } }),
    );
    expect(d.decision).toBe("ask");
  });

  it.each([
    ["a write outside memory/", { command: "create", path: "notes.md", file_text: "x" }],
    [
      "a dot-dot escape",
      { command: "create", path: "memory/../skills/x/SKILL.md", file_text: "x" },
    ],
    ["a backslash path", { command: "create", path: "memory\\agent\\a.md", file_text: "x" }],
    ["a top-level memory file", { command: "create", path: "memory", file_text: "x" }],
    ["a delete", { command: "delete", path: "memory/agent/a.md" }],
    [
      "a rename",
      { command: "rename", old_path: "memory/agent/a.md", new_path: "memory/agent/b.md" },
    ],
  ])("control: %s still asks", async (_name, params) => {
    expect((await decide(memory(params))).decision).toBe("ask");
  });

  it("control: Manual still asks for a note, and plan mode still refuses it", async () => {
    const note = memory({ command: "create", path: "memory/agent/a.md", file_text: "x" });
    expect((await decide(note, "manual")).decision).toBe("ask");
    expect((await decide(note, "plan")).decision).toBe("deny");
    // A read is side-effect free in every mode, plan included.
    const view = memory({ command: "view", path: "memory/agent" });
    expect((await decide(view, "manual")).decision).toBe("allow");
    expect((await decide(view, "plan")).decision).toBe("allow");
  });

  it("control: a tainted turn still asks before writing a note", async () => {
    const note = memory({ command: "create", path: "memory/agent/a.md", file_text: "x" });
    const d = await makeBroker().broker.decide(note, { ...CTX, taint: true });
    expect(d.decision).toBe("ask");
  });

  it("control: writes to the owner's own files keep their decision", async () => {
    const h = makeBroker({ policy: { folders: [{ path: "/Users/o/Projects", mode: "ro" }] } });
    const decided = (c: ReturnType<typeof call>) => h.broker.decide(c, CTX);
    // Outside every granted folder: refused; in a read-only one: refused; an Apple Files move asks.
    expect((await decided(call("write_file", "write", path("/Users/o/Documents/a.md")))).rule).toBe(
      "folder:not_granted",
    );
    expect((await decided(call("write_file", "write", path("/Users/o/Projects/a.md")))).rule).toBe(
      "folder:read_only",
    );
    expect(
      (await decided(call("node.files.move", "write", path("/Users/o/Documents/a.md")))).decision,
    ).toBe("ask");
  });
});
