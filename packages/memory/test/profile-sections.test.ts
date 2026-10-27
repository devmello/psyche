import { afterEach, describe, expect, it } from "vitest";
import {
  addSectionFacts,
  bootstrapContext,
  parseLearned,
  parseSectionFacts,
  readHeader,
} from "../src/index.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

/**
 * USER.md's profile sections: what the owner says about themselves (or a resume they upload)
 * lands in the right header field or section, merges with what is there, undoes cleanly, and
 * never comes from anything but the owner's own words.
 */

const TEMPLATE =
  "# About the owner\n\n- Name:\n- Timezone:\n- Work or study:\n- Home city:\n\n## Directives (dated; latest wins)\n\n<!-- guidance -->\n\n## People\n\n<!-- people guidance -->\n\n## Preferences\n\n<!-- prefs guidance -->\n";

let env: TestEnv | undefined;
afterEach(async () => {
  await env?.cleanup();
  env = undefined;
});

const userMd = async () => (await env?.store.readFile("USER.md"))?.content ?? "";
const reset = async (content: string) => {
  await env?.store.writeFileAsOwner("USER.md", content);
};

/** What the document learner proposes for a short resume (Gateway `LEARN_DOC_SYSTEM`). */
const RESUME = [
  { text: "Goes by Priya", kind: "name" as const, field: "name" as const, value: "Priya" },
  {
    text: "Software engineer at Acme Robotics",
    kind: "other" as const,
    field: "work" as const,
    value: "Software engineer at Acme Robotics",
  },
  {
    text: "Lives in Seattle",
    kind: "other" as const,
    field: "home_city" as const,
    value: "Seattle",
  },
  {
    text: "B.S. Computer Science, UC Santa Cruz (2024)",
    kind: "other" as const,
    section: "education" as const,
  },
  {
    text: "Software engineer at Acme Robotics since 2024: perception pipeline",
    kind: "other" as const,
    section: "experience" as const,
  },
  { text: "Intern at Globex, summer 2023", kind: "other" as const, section: "experience" as const },
  { text: "TypeScript, Python, Swift, ROS", kind: "other" as const, section: "skills" as const },
  { text: "Built an open-source drone autopilot", kind: "project" as const },
];

describe("addSectionFacts", () => {
  const fact = {
    factId: "lf_aaaaaaaaaaaa",
    date: "2026-10-26",
    threadId: "thr_1",
    kind: "other",
    section: "skills" as const,
    text: "Rust",
  };

  it("creates a missing section before Learned, appends to an existing one, keeps the rest", () => {
    const base = `${TEMPLATE}\n## Learned (dated; from your chats)\n\n- 2026-10-01 [lf_bbbbbbbbbbbb thread:T other] Runs\n`;
    const once = addSectionFacts(base, [fact]);
    expect(once).toContain(
      "## Skills\n\n- Rust <!--lf_aaaaaaaaaaaa 2026-10-26 thread:thr_1 other-->\n\n## Learned",
    );
    expect(once.replace(/\n## Skills\n\n[^\n]*\n/, "")).toBe(base);
    const twice = addSectionFacts(once, [{ ...fact, factId: "lf_cccccccccccc", text: "Go" }]);
    expect(parseSectionFacts(twice).map((f) => [f.section, f.text])).toEqual([
      ["skills", "Rust"],
      ["skills", "Go"],
    ]);
    // Into an existing section, after its guidance comment.
    const people = addSectionFacts(TEMPLATE, [
      { ...fact, section: "people", text: "Maya (sister)" },
    ]);
    expect(people).toContain("<!-- people guidance -->\n- Maya (sister) <!--lf_aaaaaaaaaaaa");
  });

  it("ignores marker-shaped lines outside a profile section", () => {
    const text =
      "# About\n\n## Directives\n\n- x <!--lf_aaaaaaaaaaaa 2026-10-26 thread:t other-->\n";
    expect(parseSectionFacts(text)).toEqual([]);
  });
});

describe("store.learnUserFacts into the profile", () => {
  it("distills a resume into header fields and sections, not only Learned", async () => {
    env = await makeEnv();
    await reset(TEMPLATE);
    const { written, refused } = await env.store.learnUserFacts(RESUME, {
      threadId: "thr_cv",
      ownerWords: true,
    });
    expect(refused).toEqual([]);
    expect(written).toHaveLength(RESUME.length);
    const user = await userMd();
    expect(readHeader(user)).toEqual({
      name: "Priya",
      work: "Software engineer at Acme Robotics",
      home_city: "Seattle",
    });
    expect(parseSectionFacts(user).map((f) => [f.section, f.text])).toEqual([
      ["education", "B.S. Computer Science, UC Santa Cruz (2024)"],
      ["experience", "Software engineer at Acme Robotics since 2024: perception pipeline"],
      ["experience", "Intern at Globex, summer 2023"],
      ["skills", "TypeScript, Python, Swift, ROS"],
      ["projects", "Built an open-source drone autopilot"],
    ]);
    // Header facts keep their Learned line as provenance; section facts are not repeated there.
    expect(
      parseLearned(user)
        .filter((l) => l.section === undefined)
        .map((l) => l.field),
    ).toEqual(["name", "work", "home_city"]);
    // The markers are stripped from the prompt: the profile reads as plain bullets.
    const ctx = await bootstrapContext(env.store);
    const injected = ctx.files.find((f) => f.path === "USER.md")?.text ?? "";
    expect(injected).toContain("## Education\n\n- B.S. Computer Science, UC Santa Cruz (2024)");
    expect(injected).not.toContain("<!--");
  });

  it("merges rather than duplicates: the same resume twice writes nothing new", async () => {
    env = await makeEnv();
    await reset(TEMPLATE);
    await env.store.learnUserFacts(RESUME, { threadId: "thr_cv", ownerWords: true });
    const before = await userMd();
    const again = await env.store.learnUserFacts(RESUME, { threadId: "thr_cv2", ownerWords: true });
    expect(again.written).toEqual([]);
    expect(again.refused.every((r) => r.reason === "duplicate")).toBe(true);
    expect(await userMd()).toBe(before);
  });

  it("fills the Timezone field from 'I'm on Pacific time', with the Learned line as provenance", async () => {
    env = await makeEnv();
    await reset(TEMPLATE);
    await env.store.learnUserFacts(
      [{ text: "Is on Pacific time", kind: "other", field: "timezone", value: "Pacific time" }],
      { threadId: "thr_tz", ownerWords: true },
    );
    const user = await userMd();
    expect(readHeader(user).timezone).toBe("America/Los_Angeles (Pacific)");
    expect(parseLearned(user).map((l) => [l.field, l.text])).toEqual([
      ["timezone", "Is on Pacific time"],
    ]);
  });

  it("keeps contact details out of the profile", async () => {
    env = await makeEnv();
    await reset(TEMPLATE);
    const { written, refused } = await env.store.learnUserFacts(
      [
        { text: "Reach at priya@example.com", kind: "other", section: "people" },
        { text: "Phone (831) 555-1234", kind: "other", section: "experience" },
        { text: "Portfolio at https://priya.dev", kind: "project" },
        { text: "Research assistant, 2019-2023", kind: "other", section: "experience" },
      ],
      { threadId: "thr_cv", ownerWords: true },
    );
    expect(refused.map((r) => r.reason)).toEqual(["sensitive", "sensitive", "sensitive"]);
    expect(written.map((f) => f.text)).toEqual(["Research assistant, 2019-2023"]);
  });

  it("undoes a section bullet with forgetLearned", async () => {
    env = await makeEnv();
    await reset(TEMPLATE);
    const { written } = await env.store.learnUserFacts(RESUME, {
      threadId: "thr_cv",
      ownerWords: true,
    });
    const skills = written.find((f) => f.section === "skills");
    expect(skills).toBeDefined();
    expect(await env.store.forgetLearned(skills?.factId ?? "")).toBe(true);
    const user = await userMd();
    expect(user).not.toContain("TypeScript, Python");
    expect(user).toContain("## Skills");
    expect(await env.store.forgetLearned(skills?.factId ?? "")).toBe(false);
  });

  it("content that is not the owner's own words never reaches the header or a section", async () => {
    env = await makeEnv();
    await reset(TEMPLATE);
    // A web page, an email or a lesson: no `ownerWords`.
    const { written } = await env.store.learnUserFacts(RESUME, { threadId: "thr_web" });
    expect(written.every((f) => f.field === undefined && f.section === undefined)).toBe(true);
    const user = await userMd();
    expect(readHeader(user)).toEqual({});
    expect(parseSectionFacts(user)).toEqual([]);
  });
});
