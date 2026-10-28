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
