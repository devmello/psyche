import { parseDocument, stringify } from "yaml";
import { TEMPLATE_DEFAULTS } from "./layout.ts";

/**
 * Persona file formats (data model §7.1): `IDENTITY.md` YAML frontmatter, `USER.md` dated
 * directives with active / superseded states (feature H8), and `{{token}}` substitution when
 * templates are copied (S20 templates/README.md).
 */

// --- IDENTITY.md -------------------------------------------------------------------------------

export interface Identity {
  name?: string;
  creature?: string;
  vibe?: string;
  tagline?: string;
  emoji?: string;
  avatar?: string;
  voice?: string;
  /** Any other frontmatter keys, kept as-is. */
  extra: Record<string, unknown>;
}

export interface ParsedIdentity {
  identity: Identity;
  /** Free-form self-description after the frontmatter. */
  body: string;
  /** Set when the frontmatter is missing or is not a YAML mapping. */
  error?: string;
}

const IDENTITY_KEYS = ["name", "creature", "vibe", "tagline", "emoji", "avatar", "voice"] as const;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function parseIdentity(content: string): ParsedIdentity {
  const match = FRONTMATTER.exec(content);
  if (match === null) {
    return { identity: { extra: {} }, body: content, error: "missing frontmatter" };
  }
  const body = content.slice(match[0].length);
  const doc = parseDocument(match[1] ?? "", { uniqueKeys: false });
  const data: unknown = doc.errors.length > 0 ? undefined : doc.toJS();
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return {
      identity: { extra: {} },
      body,
      error: doc.errors[0]?.message ?? "frontmatter is not a mapping",
    };
  }
  const identity: Identity = { extra: {} };
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if ((IDENTITY_KEYS as readonly string[]).includes(key)) {
      if (value !== null && value !== undefined) {
        identity[key as (typeof IDENTITY_KEYS)[number]] = String(value);
      }
    } else {
      identity.extra[key] = value;
    }
  }
  return { identity, body };
}

export function serializeIdentity(identity: Identity, body: string): string {
  const data: Record<string, unknown> = {};
  for (const key of IDENTITY_KEYS) {
    const value = identity[key];
    if (value !== undefined) data[key] = value;
  }
  Object.assign(data, identity.extra);
  return `---\n${stringify(data, { lineWidth: 0 }).trimEnd()}\n---\n${body}`;
}

// --- Template tokens ---------------------------------------------------------------------------

/**
 * Replaces `{{token}}` placeholders with the given values, falling back to the documented
 * defaults, so no raw token reaches the prompt. `{{cred:…}}` placeholders are left alone (they
 * never belong in templates, and the vault resolves them only in executors).
 */
export function substituteTokens(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (whole, key: string) => {
    if (Object.hasOwn(values, key)) return values[key] ?? "";
    if (Object.hasOwn(TEMPLATE_DEFAULTS, key)) return TEMPLATE_DEFAULTS[key] ?? "";
    return whole;
  });
}

// --- USER.md directives ------------------------------------------------------------------------

export interface Directive {
  /** 1-based line in USER.md. */
  line: number;
  date: string;
  status: "active" | "superseded";
  supersededBy?: string;
  text: string;
}

const DIRECTIVE = /^- (\d{4}-\d{2}-\d{2}) (active|superseded by (\d{4}-\d{2}-\d{2})): (.*)$/;
export const DIRECTIVES_HEADING = "## Directives (dated; latest wins)";

export function parseDirectives(content: string): Directive[] {
  const out: Directive[] = [];
  content.split("\n").forEach((line, i) => {
    const m = DIRECTIVE.exec(line.trimEnd());
    if (m === null) return;
    out.push({
      line: i + 1,
      date: m[1] ?? "",
      status: m[2] === "active" ? "active" : "superseded",
      ...(m[3] === undefined ? {} : { supersededBy: m[3] }),
      text: m[4] ?? "",
    });
  });
  return out;
}

export function activeDirectives(content: string): Directive[] {
  return parseDirectives(content).filter((d) => d.status === "active");
}

export interface DirectiveChange {
  /** `YYYY-MM-DD` of the new directive. */
  date: string;
  text: string;
  /**
   * Active directives this one replaces, matched case-insensitively as substrings of their
   * text. Each match becomes `superseded by <date>` and stays in place beside the new line.
   */
  supersedes?: string[];
}

/**
 * Adds a dated active directive at the top of the Directives section (creating the section if
 * needed) and marks the directives it replaces as superseded (OpenClaw user model: supersede
 * in place, never delete, so the history is visible but only the latest applies).
 */
export function addDirective(content: string, change: DirectiveChange): string {
  const needles = (change.supersedes ?? []).map((s) => s.toLowerCase()).filter(Boolean);
  const text = change.text.replace(/\s+/g, " ").trim();
  const lines = content.split("\n").map((line) => {
    const m = DIRECTIVE.exec(line.trimEnd());
    if (m === null || m[2] !== "active") return line;
    const body = (m[4] ?? "").toLowerCase();
    if (!needles.some((n) => body.includes(n))) return line;
    return `- ${m[1]} superseded by ${change.date}: ${m[4]}`;
  });
  const entry = `- ${change.date} active: ${text}`;
  const heading = lines.findIndex((l) => l.trim().toLowerCase().startsWith("## directives"));
  if (heading === -1) {
    const base = lines.join("\n").replace(/\n*$/, "");
    return `${base}\n\n${DIRECTIVES_HEADING}\n${entry}\n`;
  }
  // Newest first: after the heading's blank lines and guidance comments, before older entries.
  let insertAt = heading + 1;
  while (insertAt < lines.length && /^(\s*|<!--.*-->\s*)$/.test(lines[insertAt] ?? "")) {
    insertAt++;
  }
  const next = lines[insertAt];
  let padAfter = false;
  if (next?.startsWith("#")) {
    // Keep one blank line between the section and the next heading.
    if (insertAt > heading + 1 && (lines[insertAt - 1] ?? "").trim() === "") insertAt--;
    else padAfter = true;
  }
  lines.splice(insertAt, 0, ...(padAfter ? [entry, ""] : [entry]));
  return lines.join("\n");
}
