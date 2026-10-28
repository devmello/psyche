import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  APP_LIBRARY_SECTIONS,
  APP_SETTINGS_SECTIONS,
  APP_TOP_LEVEL_ROUTES,
} from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { FsSkillLoader } from "../src/loader.ts";
import { BUNDLED_DIR, OPEN_GATE, tempDir } from "./helpers.ts";

/**
 * Keeps `skills/psyche-app-guide` in step with the app. Adding a Settings section, a top-level
 * route, a Library section or a slash command without describing it in the guide fails here:
 * add it to the guide (and, for a route, to `packages/protocol/src/app-routes.ts`).
 */

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const read = (rel: string) => readFileSync(`${ROOT}${rel}`, "utf8");
const guide = read("skills/psyche-app-guide/SKILL.md");

const all = (source: string, re: RegExp) => [...source.matchAll(re)].map((m) => m[1] as string);
const unique = (xs: string[]) => [...new Set(xs)];

describe("psyche-app-guide", () => {
  it("is a bundled, invocable skill whose description matches the questions it answers", async () => {
    const loader = new FsSkillLoader({
      homeDir: tempDir(),
      bundledDir: BUNDLED_DIR,
      gate: { ...OPEN_GATE, tools: [] },
    });
    const skill = (await loader.listDetailed()).find((s) => s.name === "psyche-app-guide");
    expect(skill?.status).toBe("active");
    expect(skill?.description).toMatch(/how do I/i);
    expect(skill?.description).toMatch(/where is/i);
    expect(skill?.description).toContain("app_navigate");
  });

  it("mentions every Settings section the app has, by route id", () => {
    const inCode = unique(
      all(read("packages/ui/src/screens/settings/SettingsScreen.tsx"), /\bentry\("([\w-]+)"/g),
    );
    expect(inCode.length).toBeGreaterThan(10);
    expect([...inCode].sort()).toEqual([...APP_SETTINGS_SECTIONS].sort());
    for (const id of inCode) expect(guide, `Settings section ${id}`).toContain(`\`${id}\``);
  });

  it("mentions every Settings section by its label", () => {
    const messages = ["settings.ts", "daily.ts", "mail-meetings.ts"].map((f) =>
      read(`packages/ui/src/i18n/messages/${f}`),
    );
    const label = (id: string) => {
      const key = `settings.nav.${id === "computer-use" ? "computerUse" : id}`;
      for (const m of messages) {
        const hit = new RegExp(`"${key}":\\s*"([^"]+)"`).exec(m);
        if (hit) return hit[1] as string;
      }
      return undefined;
    };
    for (const id of APP_SETTINGS_SECTIONS) {
      const l = label(id);
      expect(l, `label for ${id}`).toBeDefined();
      expect(guide, `label "${l}"`).toContain(l as string);
    }
  });

  it("mentions every top-level route and every route the shell renders", () => {
    const rail = all(read("packages/ui/src/shell/Rail.tsx"), /route: "\/([\w-]+)/g);
    const screens = all(read("apps/web/src/compose/PsycheApp.tsx"), /case "([\w-]+)":/g);
    const onboarding = all(read("apps/web/src/compose/first-run.tsx"), /page === "([\w-]+)"/g);
    const found = unique([...rail, ...screens, ...onboarding, "settings", "agent"]);
    for (const r of found) {
      expect(
        APP_TOP_LEVEL_ROUTES as readonly string[],
        `route /${r} is in app-routes.ts`,
      ).toContain(r);
    }
    for (const r of APP_TOP_LEVEL_ROUTES) expect(guide, `route /${r}`).toContain(`/${r}`);
  });

  it("mentions every Library section and agent-sheet tab", () => {
    const items = read("packages/ui/src/screens/library/library-items.ts");
    const block = items.slice(items.indexOf("LIBRARY_SECTIONS"), items.indexOf("\n];"));
    const sections = unique(all(block, /^\s+id: "(\w+)"/gm));
    expect([...sections].sort()).toEqual([...APP_LIBRARY_SECTIONS].sort());
    for (const s of sections) expect(guide, `/library/${s}`).toContain(`/library/${s}`);
    for (const tab of ["approvals", "activity", "upcoming", "soul"]) {
      expect(guide, `/agent/${tab}`).toContain(`/agent/${tab}`);
    }
  });

  it("mentions every slash command the composer has", () => {
    const names = all(read("packages/ui/src/chat/commands.ts"), /^\s+command\("(\w+)"/gm);
    expect(names).toContain("model");
    for (const n of names) expect(guide, `/${n}`).toContain(`\`/${n}`);
  });

  it("mentions the permission modes and the approval scopes", () => {
    for (const m of ["manual", "balanced", "auto", "plan"]) expect(guide).toContain(`**${m}**`);
    const scopes = all(
      read("packages/ui/src/i18n/messages/blocks.ts"),
      /"blocks\.approval\.scope\.(?:once|task|site|session|always)":\s*"([^"]+)"/g,
    );
    expect(scopes).toHaveLength(5);
    for (const s of scopes) expect(guide, s).toContain(s);
  });
});
