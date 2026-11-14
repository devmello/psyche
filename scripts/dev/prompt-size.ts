/**
 * Prints how many characters the main agent's prompt costs per turn.
 *
 *   node scripts/dev/prompt-size.ts
 *
 * "Typical turn" = the base prompt, the shipped persona templates, a skills index and a tool list
 * that turns on every guidance block, rendered the way the loop renders it. The numbers are
 * for comparing one revision of the prompts with another; they are not a token count.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

// `PROMPT_CONTEXT` and `PROMPT_TEMPLATES` point at another revision of context.ts and of the
// persona templates, to compare two revisions (extract them with `git show <rev>:<path>`).
const here = new URL(".", import.meta.url).pathname;
const {
  assembleContext,
  CANVAS_GUIDANCE,
  CAPABILITY_GUIDANCE,
  DEFAULT_BASE_PROMPT,
  DEFAULT_CONTEXT_BUDGETS,
  MAP_GUIDANCE,
  renderSystemPrompt,
  SEARCH_EVERYTHING_GUIDANCE,
  UI_GUIDANCE,
  AUTOMATION_GUIDANCE,
} = await import(
  process.env.PROMPT_CONTEXT ?? join(here, "../../packages/agent-core/src/context.ts")
);
const templates = process.env.PROMPT_TEMPLATES ?? join(here, "../../templates");

const NAMES = [
  "ask_user",
  "update_plan",
  "wrap_up",
  "tool_search",
  "load_tools",
  "request_permission",
  "memory",
  "read_file",
  "write_file",
  "edit_file",
  "list_files",
  "search_files",
  "artifact.create",
  "artifact.update",
  "render_ui",
  "update_ui",
  "find_capability",
  "search_everything",
  "propose_automation",
  "schedule",
  "notify",
  "browser.open_tab",
  "browser.fill_credential",
  "browser.request_control",
  "mail_search",
  "notes_search",
  "subagent.spawn",
  "skill_create",
];

const tools = NAMES.map((name) => ({
  name,
  description: name,
  inputSchema: {},
  sideEffect: /^(write_file|edit_file|schedule|notify|skill_create)$/.test(name)
    ? ("write" as const)
    : ("none" as const),
  provenanceOut: /^(browser\.|mail_search)/.test(name)
    ? ("untrusted" as const)
    : ("trusted" as const),
}));

// A fresh install: the persona files are the shipped templates.
const files: Record<string, string> = Object.fromEntries(
  ["SOUL.md", "IDENTITY.md", "AGENTS.md", "USER.md"].map((f) => [
    f,
    readFileSync(join(templates, f), "utf8"),
  ]),
);
const memory = {
  async readFile(path: string) {
    const content = files[path];
    return content === undefined ? undefined : { path, content };
  },
};
const skills = {
  async list() {
    return [
      { name: "morning-brief", description: "Build the morning brief.", enabled: true },
      { name: "flight-search", description: "Find and compare flights.", enabled: true },
    ];
  },
};

const ctx = await assembleContext({
  basePrompt: DEFAULT_BASE_PROMPT,
  memory: memory as never,
  skills: skills as never,
  tools,
  permissionMode: "balanced",
  runMode: "attended",
  now: Date.UTC(2026, 10, 12, 9, 0),
  timeZone: "UTC",
  budgets: DEFAULT_CONTEXT_BUDGETS,
});
const rendered = renderSystemPrompt(ctx.sections);

const rows: [string, number][] = [
  ["base prompt", DEFAULT_BASE_PROMPT.length],
  ["canvas guidance", CANVAS_GUIDANCE.length],
  ["map guidance", MAP_GUIDANCE.length],
  ["widget guidance", UI_GUIDANCE.length],
  ["capability guidance", CAPABILITY_GUIDANCE.length],
  ["search guidance", SEARCH_EVERYTHING_GUIDANCE.length],
  ["automation guidance", AUTOMATION_GUIDANCE.length],
  ["persona templates (SOUL, IDENTITY, AGENTS, USER)", Object.values(files).join("").length],
  ["assembled system prompt (typical turn)", rendered.length],
];
for (const [label, n] of rows) console.log(`${String(n).padStart(7)}  ${label}`);
