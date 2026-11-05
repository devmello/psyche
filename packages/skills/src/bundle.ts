import type { SkillManifestDecl } from "@psyche/protocol";
import {
  type BundleAuthor,
  type BundleSigningKey,
  bad,
  canonicalJson,
  checkSignature,
  exactKeys,
  isObj,
  parseAuthor,
  str,
  strList,
} from "./bundle-core.ts";
import { parseSkill } from "./frontmatter.ts";
import { manifestOf } from "./manifest.ts";
import { parseRotationChain, type RotationStatement, verifyRotationChain } from "./rotation.ts";
import { parseSpecialist } from "./specialists.ts";
import {
  DEFAULT_LIMITS,
  foldConflict,
  LESSONS_FILE,
  type SkillTree,
  safeRelPath,
  sha256Hex,
  TreeBuilder,
  type TreeLimits,
  textOf,
  treeHash,
} from "./tree.ts";

/**
 * The `.psyche-skill` bundle (docs/design/shared-bundles-2026.md section 3): one UTF-8 JSON file
 * holding a manifest, the payload tree and, when signed, an Ed25519 signature over the manifest.
 *
 *     { "psyche-bundle": 1, "manifest": {...}, "signature": "<base64url>", "files": [...] }
 *
 * The manifest names every file with its size, executable bit and SHA-256, plus the whole-tree
 * hash and what the skill requests (tools, approval kinds, prompt files). The signature covers the
 * canonical manifest, so it covers the payload through those hashes. Everything here is checked
 * before any file is written: a bundle that does not verify is refused, never downgraded to
 * "unsigned". A bundle is data; nothing in it runs and no text in it is an instruction.
 */
export const BUNDLE_VERSION = 1;
export const BUNDLE_EXTENSION = ".psyche-skill";
/** Whole file, JSON included: the 5 MiB tree limit as base64 plus the manifest. */
export const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;
export {
  type BundleAuthor,
  type BundleSigningKey,
  bad,
  bundleHashOf,
  canonicalJson,
  checkSignature,
  exactKeys,
  isObj,
  keyIdOf,
  parseAuthor,
  str,
  strList,
} from "./bundle-core.ts";

const SIGNING_PREFIX = "psyche-bundle-v1\n";
const IGNORED_SEGMENTS = new Set([".DS_Store", ".git", "Thumbs.db", "__MACOSX"]);

export type BundleOrigin = "workspace" | "agent";

export interface BundleManifest {
  format: "psyche-skill";
  kind: "skill";
  name: string;
  version?: string;
  description: string;
  /** ISO time, the author's claim. */
  createdAt: string;
  /**
   * Where the exporter's copy came from, signed: `workspace` (the owner's own, approved) or
   * `agent` (written by Psyche). A bundle never installs as `local` whatever it says; this
   * only lowers trust further (agent-written text stays `unknown`).
   */
  origin: BundleOrigin;
  requests: SkillManifestDecl;
  payload: {
    treeHash: string;
    files: { path: string; size: number; sha256: string; executable: boolean }[];
  };
  author?: BundleAuthor;
}

export interface VerifiedBundle {
  manifest: BundleManifest;
  tree: SkillTree;
  /** Present when a signature was present and verified. */
  signer?: BundleAuthor;
  /**
   * Earlier keys of the signer named by a verified rotation chain the file carries (nearest
   * first); empty when it carries none. Evidence of lineage, never of trust.
   */
  ancestors: string[];
  bytes: number;
}

/** The bytes the signature covers: a domain prefix, then the canonical manifest. */
export function signingBytes(manifest: BundleManifest): Uint8Array {
  return new TextEncoder().encode(`${SIGNING_PREFIX}${canonicalJson(manifest)}`);
}

/** Builds the manifest for a tree (the SKILL.md must be valid; its requests are copied in). */
export function manifestForTree(
  tree: SkillTree,
  author: BundleAuthor | undefined,
  createdAt: string,
  origin: BundleOrigin,
): BundleManifest {
  const md = tree.get("SKILL.md");
  const text = md === undefined ? undefined : textOf(md);
  const parsed = text === undefined ? undefined : parseSkill(text);
  if (parsed === undefined || !parsed.ok) return bad("SKILL.md is missing, not text or invalid");
  const meta = parsed.skill.meta;
  const declared = manifestOf(meta, tree, parsed.skill.frontmatter);
  if (!declared.ok) return bad(`manifest: ${declared.errors.join("; ")}`);
  return {
    format: "psyche-skill",
    kind: "skill",
    name: meta.name,
    ...(meta.version === undefined ? {} : { version: meta.version }),
    description: meta.description.slice(0, 1000),
    createdAt,
    origin,
    requests: declared.manifest,
    payload: {
      treeHash: treeHash(tree),
      files: [...tree.keys()].sort().map((path) => {
        const f = tree.get(path) as { bytes: Uint8Array; executable: boolean };
        return {
          path,
          size: f.bytes.byteLength,
          sha256: sha256Hex(f.bytes),
          executable: f.executable,
        };
      }),
    },
    ...(author === undefined ? {} : { author }),
  };
}

/** Serializes a tree as a bundle file, signed when a signer is given. */
export function buildBundle(
  tree: SkillTree,
  signer: BundleSigningKey | undefined,
  now: Date,
  origin: BundleOrigin = "workspace",
  rotation: readonly RotationStatement[] = [],
): string {
  const manifest = manifestForTree(tree, signer?.author, now.toISOString(), origin);
  const files = [...tree.keys()].sort().map((path) => ({
    path,
    data: Buffer.from((tree.get(path) as { bytes: Uint8Array }).bytes).toString("base64"),
  }));
  const text = JSON.stringify({
    "psyche-bundle": BUNDLE_VERSION,
    manifest,
    ...(signer === undefined ? {} : { signature: signer.sign(signingBytes(manifest)) }),
    ...(signer === undefined || rotation.length === 0 ? {} : { rotation }),
    files,
  });
  if (text.length > MAX_BUNDLE_BYTES) bad("the skill is too large to export");
  return text;
}

/** The payload block of a manifest: the tree hash and every declared file (size, hash, flag). */
export function parsePayloadDecl(
  payload: unknown,
  limits: TreeLimits,
): {
  treeHashDecl: string;
  declared: Map<string, { size: number; sha256: string; executable: boolean }>;
} {
  if (!isObj(payload)) return bad("payload is not an object");
  exactKeys(payload, ["treeHash", "files"], [], "payload");
  const treeHashDecl = str(payload.treeHash, "payload.treeHash", 80);
  if (!Array.isArray(payload.files) || payload.files.length > limits.maxFiles)
    bad(`more than ${limits.maxFiles} files`);
  const declared = new Map<string, { size: number; sha256: string; executable: boolean }>();
  for (const f of payload.files as unknown[]) {
    if (!isObj(f)) return bad("a file entry is not an object");
    exactKeys(f, ["path", "size", "sha256", "executable"], [], "a file entry");
    const path = str(f.path, "path", 500);
    if (declared.has(path)) bad(`duplicate path ${path.slice(0, 80)}`);
    if (
      typeof f.size !== "number" ||
      !Number.isSafeInteger(f.size) ||
      f.size < 0 ||
      f.size > limits.maxFileBytes
    )
      bad(`${path.slice(0, 80)} is larger than ${limits.maxFileBytes} bytes`);
    if (typeof f.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(f.sha256)) bad("bad file hash");
    if (typeof f.executable !== "boolean") bad("bad executable flag");
    declared.set(path, {
      size: f.size as number,
      sha256: f.sha256 as string,
      executable: f.executable as boolean,
    });
  }
  return { treeHashDecl, declared };
}

/**
 * The payload files, checked against the manifest: paths as written and already normal, caps,
 * canonical base64, size and SHA-256 per file, case and normalization folding, the tree hash.
 */
export function readPayload(
  files: unknown,
  declared: Map<string, { size: number; sha256: string; executable: boolean }>,
  treeHashDecl: string,
  limits: TreeLimits,
): SkillTree {
  if (!Array.isArray(files) || files.length !== declared.size)
    bad("the payload does not list the files the manifest names");
  const b = new TreeBuilder(limits);
  const seen = new Set<string>();
  for (const f of files as unknown[]) {
    if (!isObj(f)) return bad("a payload entry is not an object");
    // Only `path` and `data`: no `type`, `link`, `target` or mode fields can smuggle a symlink.
    exactKeys(f, ["path", "data"], [], "a payload entry");
    const path = str(f.path, "path", 500);
    const rel = safeRelPath(path);
    if (rel === undefined || rel !== path || path.startsWith("/"))
      bad(`unsafe path ${JSON.stringify(path.slice(0, 80))}`);
    if (path.split("/").some((seg) => IGNORED_SEGMENTS.has(seg)) || path === LESSONS_FILE)
      bad(`${path} cannot be part of a skill`);
    if (seen.has(path)) bad(`duplicate path ${path}`);
    seen.add(path);
    const d = declared.get(path);
    if (d === undefined) return bad(`${path} is not in the manifest`);
    const data = str(f.data, "data", Math.ceil((limits.maxFileBytes * 4) / 3) + 8);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 !== 0) bad(`${path} is not base64`);
    const content = new Uint8Array(Buffer.from(data, "base64"));
    // Canonical only: the same bytes must not have two spellings.
    if (Buffer.from(content).toString("base64") !== data) bad(`${path} is not canonical base64`);
    if (content.byteLength !== d.size || sha256Hex(content) !== d.sha256)
      bad(`${path} does not match its hash in the manifest`);
    b.add(path, content, d.executable);
  }
  const tree = b.tree;
  // Case and normalization folding over every path and directory prefix (APFS).
  const clash = foldConflict(seen);
  if (clash !== undefined) bad(`paths differ only in case or form: ${clash.slice(0, 80)}`);
  if (tree.size !== declared.size) bad("the payload does not list the files the manifest names");
  if (treeHash(tree) !== treeHashDecl) bad("the tree hash does not match the files");
  return tree;
}

/**
 * Parses and verifies a bundle: structure, path safety, size and count caps, per-file and tree
 * hashes against the manifest, the signature, and that the declared requests equal what the
 * payload's `SKILL.md` actually requests. Throws `invalid_params` on any failure.
 */
export function verifyBundle(text: string, limits: TreeLimits = DEFAULT_LIMITS): VerifiedBundle {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_BUNDLE_BYTES) bad(`larger than ${MAX_BUNDLE_BYTES} bytes`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return bad("not JSON");
  }
  if (!isObj(raw)) return bad("not an object");
  exactKeys(raw, ["psyche-bundle", "manifest", "files"], ["signature", "rotation"], "the file");
  if (raw["psyche-bundle"] !== BUNDLE_VERSION) bad("unsupported bundle version");
  const m = raw.manifest;
  if (!isObj(m)) return bad("manifest is not an object");
  exactKeys(
    m,
    ["format", "kind", "name", "description", "createdAt", "origin", "requests", "payload"],
    ["version", "author"],
    "manifest",
  );
  if (m.format !== "psyche-skill") bad("format is not psyche-skill");
  if (m.kind !== "skill") bad("only skill bundles are supported");
  const name = str(m.name, "name", 64);
  const description = str(m.description, "description", 1000);
  const createdAt = str(m.createdAt, "createdAt", 40);
  const version = m.version === undefined ? undefined : str(m.version, "version", 64);
  if (m.origin !== "workspace" && m.origin !== "agent") bad("origin must be workspace or agent");
  const origin = m.origin as BundleOrigin;
  if (!isObj(m.requests)) return bad("requests is not an object");
  exactKeys(m.requests, ["tools", "permissions", "prompts"], ["specialist"], "requests");
  if (m.requests.specialist !== undefined && !isObj(m.requests.specialist))
    bad("requests.specialist is not an object");
  const requests: SkillManifestDecl = {
    tools: strList(m.requests.tools, "requests.tools"),
    permissions: strList(m.requests.permissions, "requests.permissions"),
    prompts: strList(m.requests.prompts, "requests.prompts"),
    // Compared field by field with what the skill's own frontmatter defines, below.
    ...(m.requests.specialist === undefined
      ? {}
      : {
          specialist: m.requests.specialist as unknown as NonNullable<
            SkillManifestDecl["specialist"]
          >,
        }),
  };
  const { treeHashDecl, declared } = parsePayloadDecl(m.payload, limits);
  const author = parseAuthor(m.author);
  if ((raw.signature === undefined) !== (author === undefined))
    bad("a bundle with an author must be signed, and a signed one must name its author");

  // Payload files: paths are taken as written, never normalized into safety.
  const tree = readPayload(raw.files, declared, treeHashDecl, limits);

  // The signature, over the canonical manifest exactly as parsed.
  const manifest: BundleManifest = {
    format: "psyche-skill",
    kind: "skill",
    name,
    ...(version === undefined ? {} : { version }),
    description,
    createdAt,
    origin,
    requests,
    payload: {
      treeHash: treeHashDecl,
      files: [...declared.entries()].map(([path, d]) => ({ path, ...d })),
    },
    ...(author === undefined ? {} : { author }),
  };
  let signer: BundleAuthor | undefined;
  let ancestors: string[] = [];
  if (author !== undefined) {
    checkSignature(author, raw.signature, signingBytes(manifest));
    signer = author;
    // A rotation chain is evidence that earlier keys named this one; a forged or broken chain
    // refuses the whole file instead of being ignored.
    if (raw.rotation !== undefined)
      ancestors = verifyRotationChain(parseRotationChain(raw.rotation), author);
  } else if (raw.rotation !== undefined) {
    bad("a rotation statement needs a signed bundle");
  }

  // What it says it asks for must be what its instructions ask for.
  const md = tree.get("SKILL.md");
  const skillText = md === undefined ? undefined : textOf(md);
  const parsed = skillText === undefined ? undefined : parseSkill(skillText);
  if (parsed === undefined || !parsed.ok) return bad("SKILL.md is missing, not text or invalid");
  const meta = parsed.skill.meta;
  const roleDef = parseSpecialist(parsed.skill.frontmatter as Record<string, unknown>);
  if (roleDef.present && !roleDef.ok)
    bad(`the background role is invalid: ${roleDef.errors.join("; ")}`);
  const actual = manifestOf(meta, tree, parsed.skill.frontmatter as Record<string, unknown>);
  if (!actual.ok) return bad(`the skill's own manifest is invalid: ${actual.errors.join("; ")}`);
  if (canonicalJson(actual.manifest) !== canonicalJson(requests))
    bad("the permissions the manifest declares are not what the skill requests");
  if (meta.name !== name) bad("the manifest name is not the skill's name");
  if (meta.version !== version) bad("the manifest version is not the skill's version");

  return { manifest, tree, ...(signer === undefined ? {} : { signer }), ancestors, bytes };
}
