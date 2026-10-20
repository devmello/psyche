import type { JsonObject } from "@psyche/protocol";
import { parse as parseYaml } from "yaml";

/**
 * `SKILL.md` = YAML frontmatter between `---` lines, then Markdown (Agent Skills format, the
 * fields OpenClaw adds, and the `requires.tools` / `requires.anyTools` keys S20 proposed).
 */

export interface SkillRequires {
  /** Every binary must be on PATH. */
  bins: string[];
  /** At least one binary must be on PATH. */
  anyBins: string[];
  /** Every environment variable must be set and non-empty. */
  env: string[];
  /** `process.platform` values (`darwin`, `linux`); empty means any. */
  os: string[];
  /** Every tool must be registered and enabled; `email.*` matches a family. */
  tools: string[];
  /** At least one tool must be present. */
  anyTools: string[];
}

export interface SkillMeta {
  name: string;
  description: string;
  userInvocable: boolean;
  disableModelInvocation: boolean;
  requires: SkillRequires;
  /** `allowed-tools` (informational; a skill never widens tool policy). */
  allowedTools: string[];
  /** `permissions`: approval kinds the skill's steps expect to request (manifest, T2). */
  permissions: string[];
  /** `prompts`: prompt files the skill ships, relative to its folder (manifest, T2). */
  prompts: string[];
  version?: string;
  license?: string;
  homepage?: string;
}

export interface ParsedSkill {
  meta: SkillMeta;
  frontmatter: JsonObject;
  body: string;
}

export type ParseResult = { ok: true; skill: ParsedSkill } | { ok: false; errors: string[] };

export const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_NAME = 64;
export const MAX_DESCRIPTION = 1024;
const MAX_FRONTMATTER = 16 * 1024;

/** Splits `---\nyaml\n---\nbody`; `undefined` when the file has no frontmatter block. */
export function splitFrontmatter(text: string): { yaml: string; body: string } | undefined {
  const src = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!src.startsWith("---\n")) return undefined;
  const end = src.indexOf("\n---", 3);
  if (end < 0) return undefined;
  const after = src.indexOf("\n", end + 4);
  const closing = src.slice(end + 1, after < 0 ? undefined : after);
  if (closing.trim() !== "---") return undefined;
  return { yaml: src.slice(4, end + 1), body: after < 0 ? "" : src.slice(after + 1) };
}

function strings(value: unknown, field: string, errors: string[]): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value as string[];
  errors.push(`${field} must be a string or a list of strings`);
  return [];
}

function bool(value: unknown, fallback: boolean, field: string, errors: string[]): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  errors.push(`${field} must be true or false`);
  return fallback;
}

function obj(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function optString(value: unknown, field: string, errors: string[]): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" || typeof value === "number") return String(value);
  errors.push(`${field} must be a string`);
  return undefined;
}

/**
 * Parses and validates a `SKILL.md`. `expectedName` (the folder name) must equal `name`.
 * YAML aliases are capped and keys must be unique, so a hostile frontmatter cannot expand.
 */
export function parseSkill(text: string, expectedName?: string): ParseResult {
  const split = splitFrontmatter(text);
  if (split === undefined) return { ok: false, errors: ["missing YAML frontmatter (---)"] };
  if (split.yaml.length > MAX_FRONTMATTER) {
    return { ok: false, errors: [`frontmatter is larger than ${MAX_FRONTMATTER} bytes`] };
  }
  let data: unknown;
  try {
    data = parseYaml(split.yaml, { schema: "core", maxAliasCount: 20, uniqueKeys: true });
  } catch (err) {
    return { ok: false, errors: [`invalid YAML: ${(err as Error).message.split("\n")[0]}`] };
  }
  const fm = obj(data);
  if (fm === undefined) return { ok: false, errors: ["frontmatter must be a mapping"] };

  const errors: string[] = [];
  const name = fm.name;
  if (typeof name !== "string" || name.length === 0) errors.push("name is required");
  else if (name.length > MAX_NAME || !NAME_PATTERN.test(name))
    errors.push("name must be 1-64 lowercase letters, digits and single hyphens");
  else if (expectedName !== undefined && name !== expectedName)
    errors.push(`name "${name}" must equal its folder name "${expectedName}"`);
  const description = fm.description;
  if (typeof description !== "string" || description.trim().length === 0)
    errors.push("description is required");
  else if (description.length > MAX_DESCRIPTION)
    errors.push(`description is longer than ${MAX_DESCRIPTION} characters`);

  const req = obj(fm.requires) ?? {};
  const oc = obj(obj(obj(fm.metadata)?.openclaw)?.requires) ?? {};
  const ocOs = obj(obj(fm.metadata)?.openclaw)?.os;
  const merge = (field: string, ...values: unknown[]) => [
    ...new Set(values.flatMap((v) => strings(v, field, errors))),
  ];
  const requires: SkillRequires = {
    bins: merge("requires.bins", req.bins, oc.bins),
    anyBins: merge("requires.anyBins", req.anyBins, oc.anyBins),
    env: merge("requires.env", req.env, oc.env),
    os: merge("requires.os", req.os, fm.os, ocOs),
    tools: merge("requires.tools", req.tools),
    anyTools: merge("requires.anyTools", req.anyTools),
  };
  const meta: SkillMeta = {
    name: typeof name === "string" ? name : "",
    description: typeof description === "string" ? description.trim() : "",
    userInvocable: bool(fm["user-invocable"], true, "user-invocable", errors),
    disableModelInvocation: bool(
      fm["disable-model-invocation"],
      false,
      "disable-model-invocation",
      errors,
    ),
    requires,
    allowedTools: strings(fm["allowed-tools"], "allowed-tools", errors),
    permissions: [...new Set(strings(fm.permissions, "permissions", errors))],
    prompts: [...new Set(strings(fm.prompts, "prompts", errors))],
  };
  const version = optString(fm.version ?? obj(fm.metadata)?.version, "version", errors);
  const license = optString(fm.license, "license", errors);
  const homepage = optString(fm.homepage, "homepage", errors);
  if (version !== undefined) meta.version = version;
  if (license !== undefined) meta.license = license;
  if (homepage !== undefined) meta.homepage = homepage;
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, skill: { meta, frontmatter: fm as JsonObject, body: split.body } };
}
