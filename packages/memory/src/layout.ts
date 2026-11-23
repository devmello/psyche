import { PROTECTED_MEMORY_FILES } from "@psyche/protocol";

/**
 * Workspace layout, roles and budgets (architecture §4.2, §4.8; data model §7.1; ADR-018: the
 * same names as an OpenClaw workspace).
 */

/**
 * Files the agent may change only with an approved `memory_protected_write` and never with
 * `untrusted` content (security §8). `AGENTS.md` is listed in docs/05 §8; the protocol constant
 * gains it in the S07 protocol PR, and this set includes it either way.
 */
export const PROTECTED_FILES: ReadonlySet<string> = new Set<string>([
  ...PROTECTED_MEMORY_FILES,
  "AGENTS.md",
]);

/** Files copied from `templates/` on first run. Daily notes are created by the store. */
export const TEMPLATE_FILES = [
  "SOUL.md",
  "IDENTITY.md",
  "USER.md",
  "AGENTS.md",
  "MEMORY.md",
  "interests.md",
  "BOOTSTRAP.md",
  "DREAMS.md",
] as const;

/** Directories created on first run. */
export const WORKSPACE_DIRS = ["memory", "skills"] as const;

/** Prompt budgets in characters (architecture §4.2). */
export const BUDGETS = {
  perFile: 20_000,
  total: 60_000,
  "USER.md": 4_000,
} as const;

/** Persona files injected into every session, in prompt order (architecture §4.2 step 3). */
export const PERSONA_FILES = ["SOUL.md", "IDENTITY.md", "AGENTS.md", "USER.md"] as const;

/** `IDENTITY.md` tokens and their defaults (templates/README.md, S20). */
export const TEMPLATE_DEFAULTS: Readonly<Record<string, string>> = {
  name: "Psyche",
  creature: "a pale moth with accent-colored wing spots",
  vibe: "calm, direct, warm",
  tagline: "",
  emoji: "🦋",
  avatar: "bundled:default",
  voice: "",
  owner: "the owner",
};

const DAILY_NOTE = /^memory\/(\d{4}-\d{2}-\d{2})\.md$/;
const DATED_NOTE = /^memory\/(\d{4}-\d{2}-\d{2})(?:-[a-z0-9][a-z0-9-]*)?\.md$/;

/** `memory/YYYY-MM-DD.md` → its date; `undefined` for any other path. Append-only files. */
export function dailyNoteDate(path: string): string | undefined {
  return DAILY_NOTE.exec(canonicalCase(path))?.[1];
}

/** Daily notes and slugged dated notes (`memory/YYYY-MM-DD-topic.md`): date for recency. */
export function datedNoteDate(path: string): string | undefined {
  return DATED_NOTE.exec(canonicalCase(path))?.[1];
}

/**
 * The key two workspace names share when the volume would open the same file. APFS folds more
 * than `toLowerCase`: `ſ` (U+017F) is `s`, and `ﬆ` / `ﬅ` are `st`. NFKC first, then upper and
 * lower case, so every spelling the disk accepts compares equal here. Use it for every name
 * comparison in policy; `toLowerCase` alone lets `ſoul.md` past a `SOUL.md` check.
 */
export function foldName(name: string): string {
  return name.normalize("NFKC").toUpperCase().toLowerCase();
}

/** Canonical spellings of well-known names, keyed by their fold. */
const CANONICAL = new Map<string, string>(
  [...PROTECTED_FILES, ...TEMPLATE_FILES].map((f) => [foldName(f), f]),
);

/** Directories with a canonical lower-case spelling (policy is keyed on them). */
const CANONICAL_DIRS: ReadonlySet<string> = new Set(["memory", "skills", "people", "projects"]);

/**
 * Rewrites well-known names to their canonical case: root template files (`soul.md` →
 * `SOUL.md`, `ſoul.md` → `SOUL.md`) and the `memory/`, `skills/`, `people/` and `projects/`
 * directories. On a case-insensitive volume these are the same files, so policy must treat them
 * the same. Directories that do not exist yet are canonicalised too, so a create cannot slip past
 * a card or skill check.
 */
export function canonicalCase(path: string): string {
  const parts = path.split("/");
  if (parts.length === 1) return CANONICAL.get(foldName(path)) ?? path;
  const head = foldName(parts[0] ?? "");
  if (CANONICAL_DIRS.has(head)) parts[0] = head;
  return parts.join("/");
}

/** Whether `path` is `BOOTSTRAP.md` under any case or fold spelling. */
export function isBootstrapFile(path: string): boolean {
  return canonicalCase(path) === BOOTSTRAP_FILE;
}

/** `BOOTSTRAP.md`: injected while it exists, so the agent may delete it but never write it. */
export const BOOTSTRAP_FILE = "BOOTSTRAP.md";

/** People and project cards (docs/memory/people-and-projects-2026.md §4.8): graph-written. */
export function isGraphCard(path: string): boolean {
  const p = canonicalCase(path);
  return (p.startsWith("people/") || p.startsWith("projects/")) && p.endsWith(".md");
}

/**
 * `skills/**` in the workspace holds what skills carry with them (a skill's `LESSONS.md`, which is
 * loaded next to its instructions). The agent never writes there: lessons come from the owner's
 * teaching card (actor `job`), skills from the skill installer.
 */
export function isSkillFile(path: string): boolean {
  const parts = path.replace(/^(?:\.\/)+/, "").split("/");
  return parts.length > 1 && foldName(parts[0] ?? "") === "skills";
}

export function isProtected(path: string): boolean {
  return PROTECTED_FILES.has(canonicalCase(path));
}

/** Curated files never decay in ranking (OpenClaw keeps them evergreen too). */
export function isEvergreen(path: string): boolean {
  const p = canonicalCase(path);
  return p === "MEMORY.md" || p === "USER.md" || PROTECTED_FILES.has(p);
}

/**
 * Files whose text is indexed. Skills are not memory, the ritual is an instruction, and the
 * dreaming diary only repeats what `MEMORY.md` already holds.
 */
export function isIndexed(path: string): boolean {
  const p = canonicalCase(path);
  if (!p.endsWith(".md") || p.startsWith("skills/")) return false;
  return p !== "BOOTSTRAP.md" && p !== "DREAMS.md";
}

/** Daily note path for a date. */
export function dailyNotePath(date: string): string {
  return `memory/${date}.md`;
}
