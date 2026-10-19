import { describe, expect, it } from "vitest";
import { approveFill, makeHarness, PASSWORD_FIELD } from "./helpers.ts";

describe("smoke", () => {
  it("setup, add, fill", async () => {
    const h = makeHarness();
    const { recoveryKey } = await h.vault.setup();
    expect(recoveryKey).toMatch(/^([A-Z2-7]{4}-){12}[A-Z2-7]{4}$/);
    await h.vault.add({
      kind: "login",
      name: "GitHub",
      bindings: [{ origin: "https://github.com" }],
      secret: { username: "pat", password: "correct-horse-battery-staple" },
    });
    const apr = await approveFill(h, { slug: "github", target: "https://github.com", selector: "ref_3", element: PASSWORD_FIELD });
    const handle = await h.vault.resolve("{{cred:github}}", { kind: "origin", value: "https://github.com" }, apr, {
      executor: "browser",
      element: PASSWORD_FIELD,
      selector: "ref_3",
    });
    expect(handle.use((v) => v)).toBe("correct-horse-battery-staple");
    h.cleanup();
  });
});
