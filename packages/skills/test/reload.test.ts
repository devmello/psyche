import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SkillChangeEvent } from "../src/loader.ts";
import { setup, skillMd, writeSkill } from "./helpers.ts";

async function until(check: () => boolean | Promise<boolean>, ms = 15_000) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("hot reload", () => {
  it("picks up added, changed and removed skills and emits one reload per burst", {
    timeout: 60_000,
  }, async () => {
    const t = setup();
    const stop = t.loader.watch(50, 1_000);
    try {
      writeSkill(t.bundledDir, "fresh", { description: "first" });
      await until(async () => (await t.loader.list()).some((s) => s.name === "fresh"));
      const reloads = () => t.events.filter((e) => (e as SkillChangeEvent).type === "reloaded");
      await until(() => reloads().length >= 1);
      expect(reloads()[0]).toMatchObject({ added: ["bundled:fresh"] });

      writeFileSync(
        join(t.bundledDir, "fresh", "SKILL.md"),
        skillMd("fresh", { description: "second" }),
      );
      await until(async () => (await t.loader.load("fresh"))?.description === "second");

      rmSync(join(t.bundledDir, "fresh"), { recursive: true });
      await until(async () => (await t.loader.list()).length === 0);
      expect(reloads().at(-1)).toMatchObject({ removed: ["bundled:fresh"] });
    } finally {
      stop();
    }
  });
});
