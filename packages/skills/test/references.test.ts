import { describe, expect, it } from "vitest";
import { setup, writeSkill } from "./helpers.ts";

/**
 * `$name` references inject only the skills the `/` menu lists: enabled and user-invocable. An
 * owner-only role prompt (`user-invocable: false`) never resolves from a reference, whatever the
 * text says. The real loader, not a stub.
 */
describe("resolveReferences: the same set as the / menu", () => {
  it("does not resolve an enabled skill that is not user-invocable", async () => {
    const t = setup();
    writeSkill(t.bundledDir, "inbox-triage");
    writeSkill(t.bundledDir, "specialist-coder", { frontmatter: "user-invocable: false\n" });

    const menu = (await t.loader.commands()).map((c) => c.name);
    expect(menu).toEqual(["inbox-triage"]);

    const refs = await t.loader.resolveReferences("$specialist-coder then $inbox-triage");
    expect(refs.map((r) => r.name)).toEqual(["inbox-triage"]);

    const onlyOwnerOnly = await t.loader.resolveReferences("$specialist-coder please");
    expect(onlyOwnerOnly).toEqual([]);
  });
});
