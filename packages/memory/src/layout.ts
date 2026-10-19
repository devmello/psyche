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

/** Canonical spellings of well-known names, keyed by lower case. */
const CANONICAL = new Map<string, string>(
  [...PROTECTED_FILES, ...TEMPLATE_FILES].map((f) => [f.toLowerCase(), f]),
);

/**
 * Rewrites well-known names to their canonical case: root template files (`soul.md` →
 * `SOUL.md`) and the `memory/` and `skills/` directories. On a case-insensitive volume these
 * are the same files, so policy must treat them the same.
 */
export function canonicalCase(path: string): string {
  const parts = path.split("/");
  if (parts.length === 1) return CANONICAL.get(path.toLowerCase()) ?? path;
  const head = (parts[0] ?? "").toLowerCase();
  if (head === "memory" || head === "skills") parts[0] = head;
  return parts.join("/");
}

/** `BOOTSTRAP.md`: injected while it exists, so the agent may delete it but never write it. */
export const BOOTSTRAP_FILE = "BOOTSTRAP.md";

export function isProtected(path: string): boolean {
  return PROTECTED_FILES.has(canonicalCase(path));
}

/** Curated files never decay in ranking (OpenClaw keeps them evergreen too). */
export function isEvergreen(path: string): boolean {
  return path === "MEMORY.md" || path === "USER.md" || PROTECTED_FILES.has(path);
}

/** Files whose text is indexed. Skills and acceptance scripts are not memory. */
export function isIndexed(path: string): boolean {
  if (!path.endsWith(".md")) return false;
  if (canonicalCase(path).startsWith("skills/")) return false;
  return path !== "BOOTSTRAP.md";
}

/** Daily note path for a date. */
export function dailyNotePath(date: string): string {
  return `memory/${date}.md`;
}
