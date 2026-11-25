import { describe, expect, it, vi } from "vitest";
import { applyMatrixEntries } from "../src/compose/connector-matrix.ts";

type Registry = Parameters<typeof applyMatrixEntries>[0];

/** A registry that refuses one action (an allow on a send, say) and records what it applied. */
function fakeRegistry(refuse: string) {
  const applied: Record<string, string>[] = [];
  const registry = {
    setMatrix: async (_id: string, patch: Record<string, string>) => {
      if (refuse in patch) throw new Error(`${refuse} refused`);
      applied.push(patch);
      return undefined;
    },
  };
  return { registry: registry as unknown as Registry, applied };
}

describe("applyMatrixEntries (Settings → Connectors save)", () => {
  it("applies the rest of the batch and names the one entry that was refused", async () => {
    const { registry, applied } = fakeRegistry("mail.send");
    const onFailed = vi.fn();
    await applyMatrixEntries(
      registry,
      "apple-mail",
      [
        ["mail.organize", "deny"],
        ["mail.send", "allow"],
      ],
      onFailed,
    );
    expect(applied).toEqual([{ "mail.organize": "deny" }]);
    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(onFailed.mock.calls[0]?.[0]).toBe("mail.send");
  });

  it("reports nothing when the whole batch applies in one call", async () => {
    const { registry, applied } = fakeRegistry("never-sent");
    const onFailed = vi.fn();
    await applyMatrixEntries(
      registry,
      "apple-mail",
      [
        ["mail.organize", "ask"],
        ["mail.read", "deny"],
      ],
      onFailed,
    );
    expect(applied).toEqual([{ "mail.organize": "ask", "mail.read": "deny" }]);
    expect(onFailed).not.toHaveBeenCalled();
  });
});
