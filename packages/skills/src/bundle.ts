import { createHash, createPublicKey, verify } from "node:crypto";
import { PsycheError, type SkillManifestDecl } from "@psyche/protocol";
import { parseSkill } from "./frontmatter.ts";
import { manifestOf } from "./manifest.ts";
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
const SIGNING_PREFIX = "psyche-bundle-v1\n";
/** Characters an author name may not contain: controls and bidirectional overrides. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: this is the check for them
const BAD_NAME_CHARS = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/;
const IGNORED_SEGMENTS = new Set([".DS_Store", ".git", "Thumbs.db", "__MACOSX"]);

export interface BundleAuthor {
  /** The author's own claim; never trusted on its own. */
  name: string;
  /** `sha256:<hex>` of the raw 32-byte public key. */
  keyId: string;
  /** base64url raw Ed25519 public key. */
  publicKey: string;
}

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
  bytes: number;
}

/** Signs canonical manifest bytes (the owner's author key). */
export interface BundleSigningKey {
  author: BundleAuthor;
  sign(data: Uint8Array): string;
}

const bad = (msg: string): never => {
  throw new PsycheError("invalid_params", `not a valid bundle: ${msg}`);
};

/** `sha256:<hex>` of a raw public key given as base64url: the key id everywhere. */
export function keyIdOf(publicKeyB64url: string): string {
  return `sha256:${createHash("sha256").update(Buffer.from(publicKeyB64url, "base64url")).digest("hex")}`;
}

/** JSON with sorted keys and no whitespace. Strings, finite numbers, booleans, null, arrays, objects. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonicalJson: only finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  throw new Error("canonicalJson: unsupported value");
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
    files,
  });
  if (text.length > MAX_BUNDLE_BYTES) bad("the skill is too large to export");
  return text;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function exactKeys(
  o: Record<string, unknown>,
  required: string[],
  optional: string[],
  what: string,
) {
  const allowed = new Set([...required, ...optional]);
  for (const k of Object.keys(o))
    if (!allowed.has(k)) bad(`${what} has an unknown field "${k.slice(0, 40)}"`);
  for (const k of required) if (!(k in o)) bad(`${what} is missing "${k}"`);
}

const str = (v: unknown, what: string, max: number): string => {
  if (typeof v !== "string" || v.length > max)
    return bad(`${what} must be a string of at most ${max} characters`);
  return v;
};

function strList(v: unknown, what: string): string[] {
  if (!Array.isArray(v) || v.length > 64) return bad(`${what} must be a list of at most 64`);
  return v.map((x) => str(x, what, 200));
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
  exactKeys(raw, ["psyche-bundle", "manifest", "files"], ["signature"], "the file");
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
  if (!isObj(m.payload)) return bad("payload is not an object");
  exactKeys(m.payload, ["treeHash", "files"], [], "payload");
  const treeHashDecl = str(m.payload.treeHash, "payload.treeHash", 80);
  if (!Array.isArray(m.payload.files) || m.payload.files.length > limits.maxFiles)
    bad(`more than ${limits.maxFiles} files`);
  const declared = new Map<string, { size: number; sha256: string; executable: boolean }>();
  for (const f of m.payload.files as unknown[]) {
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
  let author: BundleAuthor | undefined;
  if (m.author !== undefined) {
    if (!isObj(m.author)) return bad("author is not an object");
    exactKeys(m.author, ["name", "keyId", "publicKey"], [], "author");
    const aname = str(m.author.name, "author.name", 64);
    if (aname.trim() === "" || BAD_NAME_CHARS.test(aname))
      bad("author.name has control characters");
    author = {
      name: aname,
      keyId: str(m.author.keyId, "author.keyId", 80),
      publicKey: str(m.author.publicKey, "author.publicKey", 64),
    };
  }
  if ((raw.signature === undefined) !== (author === undefined))
    bad("a bundle with an author must be signed, and a signed one must name its author");

  // Payload files: paths are taken as written, never normalized into safety.
  if (!Array.isArray(raw.files) || raw.files.length !== declared.size)
    bad("the payload does not list the files the manifest names");
  const b = new TreeBuilder(limits);
  const seen = new Set<string>();
  for (const f of raw.files as unknown[]) {
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
  if (author !== undefined) {
    const sig = str(raw.signature, "signature", 200);
    if (
      !/^[A-Za-z0-9_-]{86}$/.test(sig) ||
      Buffer.from(sig, "base64url").toString("base64url") !== sig
    )
      bad("malformed signature");
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(author.publicKey) ||
      Buffer.from(author.publicKey, "base64url").toString("base64url") !== author.publicKey
    )
      bad("malformed public key");
    if (keyIdOf(author.publicKey) !== author.keyId) bad("the key id is not the key's fingerprint");
    let ok = false;
    try {
      ok = verify(
        null,
        signingBytes(manifest),
        createPublicKey({
          key: { kty: "OKP", crv: "Ed25519", x: author.publicKey },
          format: "jwk",
        }),
        Buffer.from(sig, "base64url"),
      );
    } catch {
      ok = false;
    }
    if (!ok) bad("the signature does not verify; the file was changed or is not from this author");
    signer = author;
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

  return { manifest, tree, ...(signer === undefined ? {} : { signer }), bytes };
}
