import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SKILLS_DIR = new URL("../../../skills/", import.meta.url);

// `email.*` is a capability family for gating (`anyTools`), not a tool id: no tool is registered
// as `email.search`, so a skill that names one sends the model to a tool it cannot call. The mail
// tools are `mail_*` (Apple Mail) and `gmail_*` (Gmail). Only backticked names are checked, so the
// frontmatter gating entries (`"email.*"`) stay as they are.
const UNREGISTERED_FAMILY_NAME = /`email\.[a-z_]+`/g;

describe("skills name only tools the model can call", () => {
  const skills = readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  it("finds the skills folder", () => {
    expect(skills.length).toBeGreaterThan(0);
  });

  it.each(skills)("%s does not name an email.* method id", (name) => {
    const text = readFileSync(new URL(`${name}/SKILL.md`, SKILLS_DIR), "utf8");
    expect(text.match(UNREGISTERED_FAMILY_NAME) ?? []).toEqual([]);
  });

  it("still catches an email.* name (positive control)", () => {
    expect("use `email.search` first".match(UNREGISTERED_FAMILY_NAME)).toEqual(["`email.search`"]);
  });
});
