import { ApprovalKind, type SkillManifestDecl } from "@psyche/protocol";
import type { SkillMeta } from "./frontmatter.ts";
import { type SkillTree, safeRelPath, textOf } from "./tree.ts";

/**
 * A skill's manifest (feature T2): what it declares it needs, derived from `SKILL.md`
 * frontmatter. `tools` merges `allowed-tools`, `requires.tools` and `requires.anyTools`;
 * `permissions` are approval kinds (`send_email`, `file_write`, …) its steps expect to request;
 * `prompts` are prompt files it ships. The trust card shows it, the `skill_install` binding
 * covers it, and the install policy (`policy.ts`) refuses a manifest that asks for too much.
 * Declaring is not granting: every tool call still goes through the Permission Broker.
 */
export type SkillManifest = SkillManifestDecl;

const KINDS = new Set((ApprovalKind as unknown as { enum: string[] }).enum);
const TOOL_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.:-]*(\.\*)?$|^\*$/;
export const MAX_DECLARED = 64;

export type ManifestResult =
  | { ok: true; manifest: SkillManifest }
  | { ok: false; errors: string[] };

const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort();

/** Builds and validates the manifest; `tree` checks that declared prompt files exist. */
export function manifestOf(meta: SkillMeta, tree?: SkillTree): ManifestResult {
  const errors: string[] = [];
  const tools = sorted([...meta.allowedTools, ...meta.requires.tools, ...meta.requires.anyTools]);
  for (const t of tools) {
    if (!TOOL_PATTERN.test(t))
      errors.push(`tools: "${clip(t)}" is not a tool name or family.* glob`);
  }
  const permissions = sorted(meta.permissions);
  for (const p of permissions) {
    if (!KINDS.has(p)) errors.push(`permissions: "${clip(p)}" is not an approval kind`);
  }
  const prompts = sorted(meta.prompts);
  for (const p of prompts) {
    const rel = safeRelPath(p);
    if (rel === undefined || rel !== p) {
      errors.push(`prompts: "${clip(p)}" must be a relative path inside the skill folder`);
      continue;
    }
    if (!p.endsWith(".md")) errors.push(`prompts: "${clip(p)}" must be a Markdown file`);
    if (p === "SKILL.md") errors.push("prompts: SKILL.md is always the skill's prompt");
    if (tree !== undefined) {
      const f = tree.get(p);
      if (f === undefined) errors.push(`prompts: "${clip(p)}" is not in the skill folder`);
      else if (textOf(f) === undefined) errors.push(`prompts: "${clip(p)}" is not UTF-8 text`);
    }
  }
  for (const [field, list] of [
    ["tools", tools],
    ["permissions", permissions],
    ["prompts", prompts],
  ] as const) {
    if (list.length > MAX_DECLARED) errors.push(`${field}: more than ${MAX_DECLARED} entries`);
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, manifest: { tools, permissions, prompts } };
}

/** Whether two manifests declare different needs (update detection). */
export function manifestsDiffer(a: SkillManifest | undefined, b: SkillManifest | undefined) {
  return JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);
}

function clip(s: string): string {
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}
