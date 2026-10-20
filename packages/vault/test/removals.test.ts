import { afterEach, describe, expect, it } from "vitest";
import { type Harness, makeHarness } from "./helpers.ts";

/** S23 design-26: removals are recorded outside the backup so a restore cannot resurrect them. */

let h: Harness | undefined;
afterEach(() => h?.cleanup());

describe("VaultOptions.removals", () => {
  it("records a deleted item and drops recorded ids from the store at unlock", async () => {
    const removed = new Set<string>();
    const removals = { record: (id: string) => removed.add(id), ids: () => removed };
    h = makeHarness({ overrides: { removals } });
    await h.vault.setup();
    const a = await h.vault.add({
      kind: "api_key",
      name: "A",
      bindings: [{ host: "a.example.test" }],
      secret: { token: "token-a-1234567890" },
    });
    const b = await h.vault.add({
      kind: "api_key",
      name: "B",
      bindings: [{ host: "b.example.test" }],
      secret: { token: "token-b-1234567890" },
    });
    await h.vault.delete(a.id);
    expect([...removed]).toEqual([a.id]);

    // A restore would bring b's row back after a later delete; simulate by recording it only.
    removed.add(b.id);
    h.vault.lock("manual");
    await h.vault.unlock("test");
    expect(await h.vault.list()).toEqual([]);
  });
});
