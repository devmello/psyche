import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrapContext } from "../src/context.ts";
import { TEMPLATE_FILES } from "../src/layout.ts";
import { activeDirectives, addDirective, parseIdentity } from "../src/persona.ts";
import { DEFAULT_TEMPLATES_DIR } from "../src/store.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

// S20's shipped templates (templates/, repository root).
const present = TEMPLATE_FILES.every((f) => existsSync(join(DEFAULT_TEMPLATES_DIR, f)));

let env: TestEnv | undefined;
afterEach(async () => {
  await env?.cleanup();
  env = undefined;
});

describe.skipIf(!present)("the shipped templates", () => {
  it("make a readable workspace with no raw tokens and valid IDENTITY.md frontmatter", async () => {
    env = await makeEnv({
      templatesDir: DEFAULT_TEMPLATES_DIR,
      templateValues: { name: "Flash", creature: "a pink hippo", owner: "Pat" },
    });
    for (const f of TEMPLATE_FILES) {
      const content = (await env.store.readFile(f))?.content ?? "";
      expect(content.length, f).toBeGreaterThan(0);
      expect(content, f).not.toMatch(/\{\{(?!cred:)[a-z_]+\}\}/);
    }
    const { identity, error } = parseIdentity(
      (await env.store.readFile("IDENTITY.md"))?.content ?? "",
    );
    expect(error).toBeUndefined();
    expect(identity).toMatchObject({ name: "Flash", creature: "a pink hippo", emoji: "🦋" });
    expect(env.store.isUnmodifiedTemplate("SOUL.md")).toBe(true);
  });

  it("fit the prompt budgets without truncation", async () => {
    env = await makeEnv({ templatesDir: DEFAULT_TEMPLATES_DIR });
    const ctx = await bootstrapContext(env.store);
    expect(ctx.files.filter((f) => f.truncated || f.missing)).toEqual([]);
    expect(ctx.totalChars).toBeLessThan(60_000);
    expect(ctx.text).not.toContain("<!--");
  });

  it("USER.md accepts dated directives in its Directives section", async () => {
    env = await makeEnv({ templatesDir: DEFAULT_TEMPLATES_DIR });
    const user = (await env.store.readFile("USER.md"))?.content ?? "";
    const next = addDirective(user, { date: "2026-10-19", text: "Keep replies short." });
    expect(activeDirectives(next).map((d) => d.text)).toEqual(["Keep replies short."]);
    const lines = next.split("\n");
    const heading = lines.findIndex((l) => l.startsWith("## Directives"));
    const entry = lines.findIndex((l) => l.startsWith("- 2026-10-19 active"));
    const people = lines.findIndex((l) => l.startsWith("## People"));
    expect(heading).toBeLessThan(entry);
    expect(entry).toBeLessThan(people);
  });
});
