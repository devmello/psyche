import { createHash } from "node:crypto";
import {
  PsycheError,
  type SideEffect,
  type ToolCallAuthority,
  type ToolCallDescription,
  type ToolRegistration,
  type ToolResult,
} from "@psyche/protocol";
import { stringify } from "yaml";
import { MAX_DESCRIPTION, MAX_NAME, NAME_PATTERN, parseSkill } from "./frontmatter.ts";
import { type FsSkillLoader, treeDiff } from "./loader.ts";
import { manifestOf, type SkillManifest } from "./manifest.ts";
import {
  hasBlockingFindings,
  type SkillScanFinding,
  scanSkillTree,
  summarizeFindings,
} from "./scanner.ts";
import {
  LESSONS_FILE,
  type SkillTree,
  safeRelPath,
  TreeBuilder,
  textOf,
  treeHash,
} from "./tree.ts";

/**
 * Skills the agent writes itself: `skill_create`, `skill_update`, `skill_delete` (self-extension,
 * security §11). The tool call IS the proposal: the permission engine classifies it as a
 * `skill_install` (device-only, `once` only, destructive: a tainted turn offers nothing else)
 * and the card shows `describeCall`'s details, the full content and, on an update, the diff.
 * Nothing is written before the owner approves; after that the tool installs the exact tree the
 * card described (the binding covers every parameter) through the loader, which pins its hash in
 * the lock file with `author: "agent"`. Trust stays `unknown`. A skill never grants permissions:
 * its manifest is checked against the install policy first, and the scanner's high findings
 * refuse the call before any card exists.
 */

export const AUTHOR_LIMITS = {
  maxBody: 20_000,
  maxResources: 10,
  maxResourceBytes: 20_000,
  maxTotalBytes: 100_000,
} as const;

export type SkillAuthorOp = "create" | "update" | "delete";

export interface AuthorReview {
  op: SkillAuthorOp;
  name: string;
  /** Tree hash the call will leave behind; for a delete a hash over the removal. */
  hash: string;
  /** The tree to install; absent for a delete. */
  tree?: SkillTree;
  manifest: SkillManifest;
  findings: SkillScanFinding[];
  /** Full SKILL.md, then each resource, for the card. */
  text: string;
  /** Unified diff against the approved version (update) or the removed files (delete). */
  diff: string;
  files: string[];
  fromHash?: string;
}

interface Resource {
  path: string;
  content: string;
}

const bad = (message: string) => new PsycheError("invalid_params", message);

function str(p: Record<string, unknown>, key: string, max: number, required: boolean) {
  const v = p[key];
  if (v === undefined || v === null) {
    if (required) throw bad(`${key} is required`);
    return undefined;
  }
  if (typeof v !== "string") throw bad(`${key} must be a string`);
  if (required && v.trim() === "") throw bad(`${key} is required`);
  if (v.length > max) throw bad(`${key} is longer than ${max} characters`);
  if (v.includes("\0")) throw bad(`${key} contains a NUL byte`);
  return v;
}

function list(p: Record<string, unknown>, key: string): string[] | undefined {
  const v = p[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && x.length <= 128))
    throw bad(`${key} must be a list of short strings`);
  if (v.length > 32) throw bad(`${key} has more than 32 entries`);
  return v as string[];
}

function resourcesOf(p: Record<string, unknown>): Resource[] | undefined {
  const v = p.resources;
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw bad("resources must be a list of {path, content}");
  if (v.length > AUTHOR_LIMITS.maxResources)
    throw bad(`more than ${AUTHOR_LIMITS.maxResources} resources`);
  return v.map((r) => {
    const o = r as Record<string, unknown>;
    if (
      typeof o !== "object" ||
      o === null ||
      typeof o.path !== "string" ||
      typeof o.content !== "string"
    )
      throw bad("each resource needs a path and content (strings)");
    return { path: o.path, content: o.content };
  });
}

function skillMdText(f: {
  name: string;
  description: string;
  body: string;
  tools: string[];
  permissions: string[];
}): string {
  const fm = stringify(
    {
      name: f.name,
      description: f.description,
      "user-invocable": true,
      ...(f.tools.length === 0 ? {} : { "allowed-tools": f.tools }),
      ...(f.permissions.length === 0 ? {} : { permissions: f.permissions }),
      metadata: { psyche: { madeBy: "agent" } },
    },
    { lineWidth: 0 },
  );
  return `---\n${fm.trimEnd()}\n---\n\n${f.body.trim()}\n`;
}

const enc = new TextEncoder();

function buildTree(skillMd: string, resources: Resource[]): SkillTree {
  const b = new TreeBuilder({
    maxFiles: AUTHOR_LIMITS.maxResources + 1,
    maxFileBytes: AUTHOR_LIMITS.maxResourceBytes + 4_000,
    maxTotalBytes: AUTHOR_LIMITS.maxTotalBytes,
  });
  b.add("SKILL.md", enc.encode(skillMd));
  const seen = new Set<string>(["skill.md"]);
  for (const r of resources) {
    const rel = safeRelPath(r.path);
    if (rel === undefined || rel !== r.path)
      throw bad(
        `resource path "${r.path.slice(0, 80)}" must be a relative path inside the skill folder`,
      );
    if (rel.split("/").some((seg) => seg.startsWith(".")))
      throw bad(`resource path "${rel}" may not contain hidden files or folders`);
    if (rel === LESSONS_FILE || rel.toLowerCase() === "skill.md") throw bad(`${rel} is reserved`);
    if (seen.has(rel.toLowerCase())) throw bad(`resource ${rel} appears twice`);
    seen.add(rel.toLowerCase());
    if (r.content.length > AUTHOR_LIMITS.maxResourceBytes)
      throw bad(`resource ${rel} is larger than ${AUTHOR_LIMITS.maxResourceBytes} characters`);
    b.add(rel, enc.encode(r.content), false);
  }
  return b.tree;
}

const sha = (s: string) => `sha256:${createHash("sha256").update(s).digest("hex")}`;

/** Pure review of one call: validation, policy, scan and diff. Throws before any card exists. */
export function reviewAuthorCall(
  loader: FsSkillLoader,
  op: SkillAuthorOp,
  params: unknown,
): AuthorReview {
  if (typeof params !== "object" || params === null || Array.isArray(params))
    throw bad("parameters must be an object");
  const p = params as Record<string, unknown>;
  const name = str(p, "name", MAX_NAME, true) as string;
  if (!NAME_PATTERN.test(name)) throw bad("name must be lowercase words joined by single hyphens");

  if (op === "delete") {
    const owned = loader.agentOwned(name);
    if (owned === undefined)
      throw new PsycheError("not_found", `no skill made by Psyche named ${name}`);
    const text =
      textOf(owned.tree.get("SKILL.md") ?? { bytes: new Uint8Array(), executable: false }) ?? "";
    const parsed = parseSkill(text);
    const manifest = parsed.ok ? manifestOf(parsed.skill.meta, owned.tree) : undefined;
    return {
      op,
      name,
      hash: sha(`psyche.skill-delete.v1|${owned.lock.treeHash}`),
      manifest: manifest?.ok ? manifest.manifest : { tools: [], permissions: [], prompts: [] },
      findings: [],
      text,
      diff: treeDiff(owned.tree, new Map()),
      files: [...owned.tree.keys()].sort(),
      fromHash: owned.lock.treeHash,
    };
  }

  const owned = loader.agentOwned(name);
  if (op === "create") {
    if (loader.names().includes(name) || owned !== undefined)
      throw new PsycheError(
        "conflict",
        `a skill named ${name} already exists; pick another name (use skill_update only for skills you made)`,
      );
  } else {
    if (owned === undefined)
      throw new PsycheError(
        "not_found",
        `no skill made by Psyche named ${name}; only skills you created can be changed with skill_update`,
      );
    if (!owned.intact)
      throw new PsycheError(
        "conflict",
        `${name} changed on disk since the owner approved it (hash mismatch); the owner must review it first`,
      );
  }

  let current:
    | { description: string; body: string; tools: string[]; permissions: string[] }
    | undefined;
  if (owned !== undefined) {
    const text = textOf(
      owned.tree.get("SKILL.md") ?? { bytes: new Uint8Array(), executable: false },
    );
    const parsed = text === undefined ? undefined : parseSkill(text, name);
    if (parsed === undefined || !parsed.ok) throw bad(`the approved ${name} cannot be read`);
    current = {
      description: parsed.skill.meta.description,
      body: parsed.skill.body,
      tools: parsed.skill.meta.allowedTools,
      permissions: parsed.skill.meta.permissions,
    };
  }
  const description =
    str(p, "description", MAX_DESCRIPTION, op === "create") ?? current?.description ?? "";
  const body = str(p, "body", AUTHOR_LIMITS.maxBody, op === "create") ?? current?.body ?? "";
  const tools = list(p, "tools") ?? current?.tools ?? [];
  const permissions = list(p, "permissions") ?? current?.permissions ?? [];
  const given = resourcesOf(p);
  const kept: Resource[] =
    given ??
    (owned === undefined
      ? []
      : [...owned.tree.entries()]
          .filter(([path]) => path !== "SKILL.md")
          .map(([path, f]) => ({ path, content: textOf(f) ?? "" })));

  const skillMd = skillMdText({ name, description, body, tools, permissions });
  const tree = buildTree(skillMd, kept);
  const parsed = parseSkill(skillMd, name);
  if (!parsed.ok) throw bad(`not a valid skill: ${parsed.errors.join("; ")}`);
  const declared = manifestOf(parsed.skill.meta, tree);
  if (!declared.ok) throw bad(`invalid skill manifest: ${declared.errors.join("; ")}`);
  const violations = loader.policyViolations(declared.manifest);
  if (violations.length > 0)
    throw new PsycheError(
      "policy_denied",
      `skill ${name} asks for more than the policy allows: ${violations.join("; ")}`,
      { details: { name, violations } },
    );
  const findings = scanSkillTree(tree, name);
  if (hasBlockingFindings(findings)) {
    const high = findings.filter((f) => f.severity === "high").map((f) => f.message);
    throw new PsycheError(
      "policy_denied",
      `the scan found high-severity problems: ${high.join("; ")}`,
    );
  }
  const hash = treeHash(tree);
  if (owned !== undefined && hash === owned.lock.treeHash)
    throw new PsycheError("conflict", `${name} would not change`);
  const resourcesText = [...tree.entries()]
    .filter(([path]) => path !== "SKILL.md")
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([path, f]) => `\n--- ${path} ---\n${textOf(f) ?? ""}`)
    .join("");
  return {
    op,
    name,
    hash,
    tree,
    manifest: declared.manifest,
    findings,
    text: skillMd + resourcesText,
    diff: owned === undefined ? "" : treeDiff(owned.tree, tree),
    files: [...tree.keys()].sort(),
    ...(owned === undefined ? {} : { fromHash: owned.lock.treeHash }),
  };
}

const VERB: Record<SkillAuthorOp, string> = {
  create: "Create skill",
  update: "Update skill",
  delete: "Delete skill",
};

/** The card's facts and the binding fields for a reviewed call. */
function describe(r: AuthorReview): ToolCallDescription {
  const counts = summarizeFindings(r.findings);
  return {
    sideEffect: "destructive" as SideEffect,
    kind: "skill_install",
    summary: `${VERB[r.op]} "${r.name}" (made by Psyche)`,
    bindingFields: {
      name: r.name,
      scope: "home",
      source: { kind: "path", path: `agent/${r.name}` },
      treeHash: r.hash,
      tools: r.manifest.tools,
      permissions: r.manifest.permissions,
      prompts: r.manifest.prompts,
    },
    details: {
      action: r.op,
      madeBy: "agent",
      name: r.name,
      hash: r.hash,
      ...(r.fromHash === undefined ? {} : { fromHash: r.fromHash }),
      scope: "home",
      source: `agent/${r.name}`,
      permissions: r.manifest.permissions,
      tools: r.manifest.tools,
      prompts: r.manifest.prompts,
      findings: counts,
      files: r.files,
      text: r.text,
      ...(r.diff === "" ? {} : { diff: r.diff }),
    },
  };
}

export interface SkillAuthorDeps {
  /** What authorized a running call (the Gateway's `CallContexts.authorityFor`). */
  authorityFor: (callId: string) => ToolCallAuthority | undefined;
  /** Called after a skill is created, updated or deleted. */
  onAuthored?: (event: { op: SkillAuthorOp; name: string }) => void;
}

const errorResult = (message: string): ToolResult => ({
  output: { error: message },
  isError: true,
  provenance: "trusted",
});

const RESOURCE_SCHEMA = {
  type: "array",
  maxItems: AUTHOR_LIMITS.maxResources,
  description:
    "Optional text files that ship with the skill (templates, checklists). Relative paths like references/notes.md; no scripts are needed.",
  items: {
    type: "object",
    properties: {
      path: { type: "string", minLength: 1, maxLength: 200 },
      content: { type: "string", maxLength: AUTHOR_LIMITS.maxResourceBytes },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
} as const;

const NAME_SCHEMA = {
  type: "string",
  pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
  maxLength: 64,
} as const;

/**
 * The three tools. Each call is one `skill_install` approval on the owner's device; the skill
 * stays inert until it is approved, loads at the lowest trust tier and never grants permissions.
 */
export function createSkillAuthorTools(
  loader: FsSkillLoader,
  deps: SkillAuthorDeps,
): ToolRegistration[] {
  const make = (op: SkillAuthorOp, description: string, properties: Record<string, unknown>) => {
    const reg: ToolRegistration = {
      spec: {
        name: `skill_${op}`,
        description,
        inputSchema: {
          type: "object",
          properties,
          required: op === "create" ? ["name", "description", "body"] : ["name"],
          additionalProperties: false,
        },
        sideEffect: "destructive",
        provenanceOut: "trusted",
      },
      // Throws (invalid params) before any card exists when the call is not allowed.
      describeCall: (params) => describe(reviewAuthorCall(loader, op, params)),
      async execute(callId, params) {
        const authority = deps.authorityFor(callId);
        // No silent enabling: the owner's card is the only way in, whatever the permission mode.
        if (authority?.approvalId === undefined)
          return errorResult("the owner has not approved this change on a device");
        try {
          const review = reviewAuthorCall(loader, op, params);
          if (op === "delete") {
            await loader.removeAgentSkill(review.name);
          } else {
            await loader.installAgentTree({
              name: review.name,
              tree: review.tree as SkillTree,
              approvalId: authority.approvalId,
              update: op === "update",
            });
          }
          deps.onAuthored?.({ op, name: review.name });
          return {
            output: {
              ok: true,
              name: review.name,
              hash: review.hash,
              note:
                op === "delete"
                  ? "Deleted; the previous version is kept in the skill history."
                  : "Saved and approved. It loads like any other skill at the lowest trust tier; it grants no permissions.",
            },
            provenance: "trusted",
          };
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    };
    return reg;
  };

  const common = {
    description: {
      type: "string",
      maxLength: MAX_DESCRIPTION,
      description:
        "One or two sentences saying when to use the skill; it is how the skill gets picked.",
    },
    body: {
      type: "string",
      maxLength: AUTHOR_LIMITS.maxBody,
      description: "The instructions in Markdown (no frontmatter): steps, checks, what to avoid.",
    },
    tools: {
      type: "array",
      items: { type: "string", maxLength: 128 },
      maxItems: 32,
      description:
        "Tools the steps use (informational). Declaring a tool never grants it; every call still asks as usual.",
    },
    permissions: {
      type: "array",
      items: { type: "string", maxLength: 64 },
      maxItems: 32,
      description:
        "Approval kinds the steps expect to request (informational; exec_host, skill_install, policy_change, pairing and memory_protected_write are refused).",
    },
    resources: RESOURCE_SCHEMA,
  };

  return [
    make(
      "create",
      "Write a new skill (a reusable procedure) after you have done a multi-step job the owner is likely to repeat. The owner reviews the full text on their device and must approve it; until then it does nothing. It is written at the lowest trust tier and cannot grant itself any permission. The name must be new.",
      { name: NAME_SCHEMA, ...common },
    ),
    make(
      "update",
      "Change a skill you created earlier. Send only what changes (resources, when given, replace the old set). The owner sees a diff against the approved version and must approve it; the old version is kept in the skill's history.",
      { name: NAME_SCHEMA, ...common },
    ),
    make(
      "delete",
      "Delete a skill you created. The owner is asked first; the last approved version is kept in the skill's history.",
      { name: NAME_SCHEMA },
    ),
  ];
}
