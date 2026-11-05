import { isIP } from "node:net";
import type { ScanFinding } from "@psyche/protocol";
import { MAX_BUNDLE_BYTES, parsePayloadDecl, readPayload } from "./bundle.ts";
import {
  type BundleAuthor,
  type BundleSigningKey,
  bad,
  bundleHashOf,
  canonicalJson,
  checkSignature,
  exactKeys,
  isObj,
  parseAuthor,
  str,
} from "./bundle-core.ts";
import { parseRotationChain, type RotationStatement, verifyRotationChain } from "./rotation.ts";
import { scanText } from "./scanner.ts";
import {
  DEFAULT_LIMITS,
  type SkillTree,
  sha256Hex,
  type TreeLimits,
  textOf,
  treeHash,
} from "./tree.ts";

/**
 * The `.psyche-connector` bundle (docs/design/shared-bundles-2026.md section 8): one UTF-8 JSON
 * file in the same envelope as a skill bundle, with `kind: "connector"`. It describes an MCP
 * server the author set up: the command as an argv, the names of the environment variables and
 * of the secrets it needs (never a value), the network domains it asks for, the tools it says it
 * lists, and an optional payload of script files with the same caps and path rules as a skill.
 * The signature covers all of it under its own domain prefix, so it cannot be replayed as a
 * skill bundle or the other way round. Nothing here runs: installing goes through the existing
 * `mcp.probe` / `mcp.add` card, and the declared tools are claims the probe is compared with.
 */
export const CONNECTOR_EXTENSION = ".psyche-connector";
const CONNECTOR_PREFIX = "psyche-connector-v1\n";
const BUNDLE_VERSION = 1;

export type ToolSideEffect = "read" | "write" | "destructive";

export interface ConnectorRequests {
  /** The program (argv[0]); never a shell string. */
  command: string;
  /** The arguments (argv[1..]), in order. */
  args: string[];
  /** Environment variable names the server reads and that are not secret; sorted, no values. */
  env: string[];
  /** Secrets it needs, by name with a one-line purpose; sorted by name, never a value. */
  secrets: { name: string; purpose: string }[];
  /** Domains it asks to reach through the sandbox (advisory: only the sandbox enforces it). */
  network: string[];
  /** The tools it says it lists; sorted by name. The probe is the check. */
  tools: { name: string; sideEffect: ToolSideEffect }[];
}

export interface ConnectorManifest {
  format: "psyche-connector";
  kind: "connector";
  /** The server id it installs as (`mcp__<name>__<tool>`). */
  name: string;
  /** What the author calls it (a claim, shown as data). */
  title: string;
  version?: string;
  description: string;
  createdAt: string;
  requests: ConnectorRequests;
  payload: {
    treeHash: string;
    files: { path: string; size: number; sha256: string; executable: boolean }[];
  };
  author?: BundleAuthor;
}

export interface VerifiedConnectorBundle {
  manifest: ConnectorManifest;
  tree: SkillTree;
  signer?: BundleAuthor;
  /** Earlier keys of the signer named by a verified rotation chain (nearest first). */
  ancestors: string[];
  /** `sha256:` of the exact bytes signed: the id a revocation notice uses. */
  bundleHash: string;
  bytes: number;
}

/** Hard limits on the lists, so a card stays readable and a file stays small. */
export const CONNECTOR_LIMITS = {
  args: 62,
  argChars: 1_000,
  env: 32,
  secrets: 16,
  network: 50,
  tools: 100,
} as const;

const SERVER_ID = /^[a-z][a-z0-9-]{1,40}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const DOMAIN = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: this is the check for them
const CONTROL = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/;
const EFFECTS: readonly string[] = ["read", "write", "destructive"];

/** A name that looks like it holds a secret, whatever the author called it. */
export const SECRET_SHAPED_NAME =
  /(KEY|TOKEN|SECRET|PASS(WORD|WD)?|CREDENTIAL|AUTH|COOKIE|BEARER)/i;

export function connectorSigningBytes(manifest: ConnectorManifest): Uint8Array {
  return new TextEncoder().encode(`${CONNECTOR_PREFIX}${canonicalJson(manifest)}`);
}

/** Argv text a secret scan and the placeholder rule apply to. */

/** The plain-text rules for what a connector asks for; throws `invalid_params` on the first break. */
export function checkRequests(r: ConnectorRequests): void {
  if (r.command.length === 0 || r.command.length > CONNECTOR_LIMITS.argChars)
    bad("the command must be 1-1000 characters");
  if (r.args.length > CONNECTOR_LIMITS.args) bad(`more than ${CONNECTOR_LIMITS.args} arguments`);
  for (const a of [r.command, ...r.args]) {
    if (a.length > CONNECTOR_LIMITS.argChars || a.includes("\u0000"))
      bad("an argument is too long or has a NUL");
    // A placeholder in argv would be read by `ps`, and a bundle must never reference the vault.
    if (a.includes("{{cred:")) bad("a credential placeholder cannot be part of a command");
  }
  if (r.env.length > CONNECTOR_LIMITS.env) bad(`more than ${CONNECTOR_LIMITS.env} env names`);
  if (r.secrets.length > CONNECTOR_LIMITS.secrets)
    bad(`more than ${CONNECTOR_LIMITS.secrets} secrets`);
  for (const n of r.env) if (!ENV_NAME.test(n)) bad(`"${n.slice(0, 40)}" is not an env name`);
  for (const s of r.secrets) {
    if (!ENV_NAME.test(s.name)) bad(`"${s.name.slice(0, 40)}" is not a secret name`);
    if (s.purpose.length > 120 || CONTROL.test(s.purpose))
      bad("a secret's purpose must be plain text of at most 120 characters");
  }
  const names = [...r.env, ...r.secrets.map((s) => s.name)];
  if (new Set(names).size !== names.length) bad("an env or secret name is listed twice");
  // A secret-shaped name belongs in `secrets`, where the owner is asked for it by name.
  for (const n of r.env)
    if (SECRET_SHAPED_NAME.test(n)) bad(`${n} looks like a secret; list it as one`);
  if (r.network.length > CONNECTOR_LIMITS.network)
    bad(`more than ${CONNECTOR_LIMITS.network} domains`);
  for (const d of r.network) {
    if (d.length > 253 || !DOMAIN.test(d) || isIP(d) !== 0)
      bad(`"${d.slice(0, 60)}" is not a domain`);
  }
  if (r.tools.length > CONNECTOR_LIMITS.tools) bad(`more than ${CONNECTOR_LIMITS.tools} tools`);
  for (const t of r.tools)
    if (!TOOL_NAME.test(t.name)) bad(`"${t.name.slice(0, 60)}" is not a tool name`);
  const sorted = <T>(xs: readonly T[], key: (x: T) => string, what: string) => {
    for (let i = 1; i < xs.length; i++)
      if (key(xs[i - 1] as T) >= key(xs[i] as T)) bad(`${what} must be sorted and without repeats`);
  };
  sorted(r.env, (x) => x, "env names");
  sorted(r.secrets, (x) => x.name, "secrets");
  sorted(r.network, (x) => x, "network domains");
  sorted(r.tools, (x) => x.name, "tools");
}

/** Normalizes author input into the canonical (sorted, unique) requests. */
export function normalizeRequests(input: {
  command: string;
  args?: readonly string[];
  env?: readonly string[];
  secrets?: readonly { name: string; purpose?: string }[];
  network?: readonly string[];
  tools?: readonly { name: string; sideEffect: ToolSideEffect }[];
}): ConnectorRequests {
  const uniq = <T>(xs: readonly T[], key: (x: T) => string) =>
    [...new Map(xs.map((x) => [key(x), x])).values()].sort((a, b) =>
      key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0,
    );
  return {
    command: input.command,
    args: [...(input.args ?? [])],
    env: uniq(input.env ?? [], (x) => x),
    secrets: uniq(
      (input.secrets ?? []).map((s) => ({ name: s.name, purpose: s.purpose ?? "" })),
      (x) => x.name,
    ),
    network: uniq(input.network ?? [], (x) => x),
    tools: uniq(input.tools ?? [], (x) => x.name),
  };
}

export interface ConnectorModel {
  name: string;
  title: string;
  version?: string;
  description: string;
  requests: ConnectorRequests;
}

/** Builds the manifest for a connector and its (possibly empty) payload tree. */
export function manifestForConnector(
  model: ConnectorModel,
  tree: SkillTree,
  author: BundleAuthor | undefined,
  createdAt: string,
): ConnectorManifest {
  if (!SERVER_ID.test(model.name)) bad("the connector name must be a lowercase slug");
  checkRequests(model.requests);
  return {
    format: "psyche-connector",
    kind: "connector",
    name: model.name,
    title: model.title.slice(0, 100),
    ...(model.version === undefined ? {} : { version: model.version }),
    description: model.description.slice(0, 1000),
    createdAt,
    requests: model.requests,
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

/** Serializes a connector as a bundle file, signed when a signer is given. */
export function buildConnectorBundle(
  model: ConnectorModel,
  tree: SkillTree,
  signer: BundleSigningKey | undefined,
  now: Date,
  rotation: readonly RotationStatement[] = [],
): string {
  const manifest = manifestForConnector(model, tree, signer?.author, now.toISOString());
  const files = [...tree.keys()].sort().map((path) => ({
    path,
    data: Buffer.from((tree.get(path) as { bytes: Uint8Array }).bytes).toString("base64"),
  }));
  const text = JSON.stringify({
    "psyche-bundle": BUNDLE_VERSION,
    manifest,
    ...(signer === undefined ? {} : { signature: signer.sign(connectorSigningBytes(manifest)) }),
    ...(signer === undefined || rotation.length === 0 ? {} : { rotation }),
    files,
  });
  if (text.length > MAX_BUNDLE_BYTES) bad("the connector is too large to export");
  return text;
}

function strings(v: unknown, what: string, max: number, itemMax: number): string[] {
  if (!Array.isArray(v) || v.length > max) return bad(`${what} must be a list of at most ${max}`);
  return v.map((x) => str(x, what, itemMax));
}

function parseRequests(r: unknown): ConnectorRequests {
  if (!isObj(r)) return bad("requests is not an object");
  exactKeys(r, ["command", "args", "env", "secrets", "network", "tools"], [], "requests");
  const secretsRaw = r.secrets;
  if (!Array.isArray(secretsRaw) || secretsRaw.length > CONNECTOR_LIMITS.secrets)
    bad("secrets must be a short list");
  const toolsRaw = r.tools;
  if (!Array.isArray(toolsRaw) || toolsRaw.length > CONNECTOR_LIMITS.tools)
    bad("tools must be a short list");
  const out: ConnectorRequests = {
    command: str(r.command, "command", CONNECTOR_LIMITS.argChars),
    args: strings(r.args, "args", CONNECTOR_LIMITS.args, CONNECTOR_LIMITS.argChars),
    env: strings(r.env, "env", CONNECTOR_LIMITS.env, 64),
    secrets: (secretsRaw as unknown[]).map((s) => {
      if (!isObj(s)) return bad("a secret is not an object");
      exactKeys(s, ["name", "purpose"], [], "a secret");
      return { name: str(s.name, "secret name", 64), purpose: str(s.purpose, "purpose", 120) };
    }),
    network: strings(r.network, "network", CONNECTOR_LIMITS.network, 253),
    tools: (toolsRaw as unknown[]).map((t) => {
      if (!isObj(t)) return bad("a tool is not an object");
      exactKeys(t, ["name", "sideEffect"], [], "a tool");
      const sideEffect = str(t.sideEffect, "sideEffect", 12);
      if (!EFFECTS.includes(sideEffect))
        bad("a tool's sideEffect is not read, write or destructive");
      return { name: str(t.name, "tool name", 128), sideEffect: sideEffect as ToolSideEffect };
    }),
  };
  checkRequests(out);
  return out;
}

/**
 * Parses and verifies a connector bundle: structure and exact fields, the lists and their rules,
 * path safety, size and count caps, per-file and tree hashes, the signature, and a rotation chain
 * when present. Throws `invalid_params` on any failure; never downgrades a bad signature to
 * "unsigned".
 */
export function verifyConnectorBundle(
  text: string,
  limits: TreeLimits = DEFAULT_LIMITS,
): VerifiedConnectorBundle {
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
    ["format", "kind", "name", "title", "description", "createdAt", "requests", "payload"],
    ["version", "author"],
    "manifest",
  );
  if (m.format !== "psyche-connector" || m.kind !== "connector")
    bad("this is not a connector bundle");
  const name = str(m.name, "name", 41);
  if (!SERVER_ID.test(name)) bad("the connector name must be a lowercase slug");
  const title = str(m.title, "title", 100);
  if (title.trim() === "" || CONTROL.test(title)) bad("the title must be plain text");
  const description = str(m.description, "description", 1000);
  const createdAt = str(m.createdAt, "createdAt", 40);
  const version = m.version === undefined ? undefined : str(m.version, "version", 64);
  const requests = parseRequests(m.requests);
  const { treeHashDecl, declared } = parsePayloadDecl(m.payload, limits);
  const author = parseAuthor(m.author);
  if ((raw.signature === undefined) !== (author === undefined))
    bad("a bundle with an author must be signed, and a signed one must name its author");
  const tree = readPayload(raw.files, declared, treeHashDecl, limits);
  const manifest: ConnectorManifest = {
    format: "psyche-connector",
    kind: "connector",
    name,
    title,
    ...(version === undefined ? {} : { version }),
    description,
    createdAt,
    requests,
    payload: {
      treeHash: treeHashDecl,
      files: [...declared.entries()].map(([path, d]) => ({ path, ...d })),
    },
    ...(author === undefined ? {} : { author }),
  };
  const signed = connectorSigningBytes(manifest);
  let ancestors: string[] = [];
  if (author !== undefined) {
    checkSignature(author, raw.signature, signed);
    if (raw.rotation !== undefined)
      ancestors = verifyRotationChain(parseRotationChain(raw.rotation), author);
  } else if (raw.rotation !== undefined) {
    bad("a rotation statement needs a signed bundle");
  }
  return {
    manifest,
    tree,
    ...(author === undefined ? {} : { signer: author }),
    ancestors,
    bundleHash: bundleHashOf(signed),
    bytes,
  };
}

/** The id a revocation notice names a connector bundle by. */
export function connectorBundleHash(manifest: ConnectorManifest): string {
  return bundleHashOf(connectorSigningBytes(manifest));
}

// --- what it asks for, compared with what is installed ------------------------------------------

/** What a new version asks for that the installed one did not (all empty: nothing). */
export interface ConnectorWidened {
  /** The program or the arguments differ: any change is a different command to approve. */
  command: boolean;
  env: string[];
  secrets: string[];
  network: string[];
  tools: string[];
  /** Different bundled scripts under the same command. */
  payload: boolean;
}

/**
 * What `after` asks for that `before` did not. A changed command line or changed script payload
 * always counts (it cannot be compared for being "narrower"); added env names, secrets, network
 * domains and tools count; removed ones are quiet. `undefined` when nothing widened.
 */
export function connectorWidenedBy(
  before: { requests: ConnectorRequests; treeHash: string } | undefined,
  after: { requests: ConnectorRequests; treeHash: string },
): ConnectorWidened | undefined {
  const added = (x: readonly string[], y: readonly string[]) => x.filter((v) => !y.includes(v));
  const b = before?.requests;
  const out: ConnectorWidened = {
    command:
      b === undefined ||
      b.command !== after.requests.command ||
      JSON.stringify(b.args) !== JSON.stringify(after.requests.args),
    env: added(after.requests.env, b?.env ?? []),
    secrets: added(
      after.requests.secrets.map((s) => s.name),
      (b?.secrets ?? []).map((s) => s.name),
    ),
    network: added(after.requests.network, b?.network ?? []),
    // A tool that appears, or one whose effect grows (read to write to destructive), is wider.
    tools: after.requests.tools
      .filter((t) => {
        const was = b?.tools.find((x) => x.name === t.name);
        return was === undefined || EFFECTS.indexOf(t.sideEffect) > EFFECTS.indexOf(was.sideEffect);
      })
      .map((t) => t.name),
    payload: before !== undefined && before.treeHash !== after.treeHash,
  };
  return out.command ||
    out.payload ||
    out.env.length + out.secrets.length + out.network.length + out.tools.length > 0
    ? out
    : undefined;
}

// --- credentials and risks in the command line ---------------------------------------------------

const URL_USERINFO = /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+(?::[^/\s@]*)?@/i;
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/;
/** A flag that names a secret but only points at where it is (`--token-file`) is not a leak. */
const POINTER_FLAG = /(file|path|env|name|url|dir|var|id)$/i;

function entropy(text: string): number {
  const counts = new Map<string, number>();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / text.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Why an argument could be carrying a credential; `undefined` when it looks like plain config. */
function argLeak(arg: string, previous: string | undefined): string | undefined {
  if (URL_USERINFO.test(arg)) return "a web address with a user name or password in it";
  if (JWT.test(arg)) return "a signed token";
  const kv = /^-{0,2}([A-Za-z][\w.-]*)=(.+)$/s.exec(arg);
  if (
    kv !== null &&
    SECRET_SHAPED_NAME.test(kv[1] as string) &&
    !POINTER_FLAG.test(kv[1] as string)
  )
    return `a value given to ${(kv[1] as string).slice(0, 40)}`;
  if (
    previous !== undefined &&
    /^-{1,2}[A-Za-z][\w.-]*$/.test(previous) &&
    SECRET_SHAPED_NAME.test(previous) &&
    !POINTER_FLAG.test(previous) &&
    !arg.startsWith("-")
  )
    return `the value after ${previous.slice(0, 40)}`;
  // A long, random-looking word that is not a path or a package spec.
  if (
    arg.length >= 24 &&
    /^[A-Za-z0-9_\-+/=]+$/.test(arg) &&
    !arg.startsWith("/") &&
    !arg.startsWith(".") &&
    !(arg.includes("/") && arg.includes(".")) &&
    entropy(arg) >= 4.3 &&
    /\d/.test(arg) &&
    /[A-Za-z]/.test(arg)
  )
    return "a long random-looking value";
  return undefined;
}

/** Arguments (never the program) that look like they carry a credential, in plain words. */
export function argvCredentialLeaks(args: readonly string[]): string[] {
  const out: string[] = [];
  args.forEach((a, i) => {
    const why = argLeak(a, args[i - 1]);
    if (why !== undefined) out.push(`argument ${i + 1} looks like ${why}`);
  });
  return out;
}

const RUNNERS = new Set(["npx", "bunx", "uvx", "pipx", "pnpx"]);
const basename = (p: string) => (p.split("/").pop() ?? p).toLowerCase();

/** Whether the command downloads its package when it starts (needs the network). */
export function downloadsPackage(r: Pick<ConnectorRequests, "command" | "args">): boolean {
  const c = basename(r.command);
  return RUNNERS.has(c) || ((c === "pnpm" || c === "yarn") && r.args[0] === "dlx");
}

/** The package spec an `npx` / `uvx` style command runs when it is not pinned to a version. */
export function unpinnedPackage(
  r: Pick<ConnectorRequests, "command" | "args">,
): string | undefined {
  if (!downloadsPackage(r)) return undefined;
  const skip = new Set(["dlx", "run", "exec"]);
  const spec = r.args.find((a) => !a.startsWith("-") && !skip.has(a));
  if (spec === undefined) return undefined;
  const pinned = spec.startsWith("@")
    ? spec.indexOf("@", 1) > 0
    : spec.includes("@") || spec.includes("==");
  return pinned ? undefined : spec;
}

/** Domains that anyone can publish on, or wildcards: a grant of them reaches more than one site. */
const SHARED_HOSTS =
  /(^|\.)(github\.io|githubusercontent\.com|pages\.dev|workers\.dev|vercel\.app|netlify\.app|herokuapp\.com|amazonaws\.com|appspot\.com|firebaseapp\.com|web\.app|onrender\.com|fly\.dev|glitch\.me|repl\.co|ngrok\.(io|app|dev)|trycloudflare\.com|r2\.dev|blob\.core\.windows\.net)$/i;
export function riskyDomains(network: readonly string[]): string[] {
  return network.filter((d) => d.startsWith("*.") || SHARED_HOSTS.test(d));
}

/** Scan findings for what a connector bundle ships: its command line and its script files. */
export function scanConnector(r: ConnectorRequests, tree: SkillTree): ScanFinding[] {
  const out: ScanFinding[] = [];
  // `npx -y pkg` is the command itself, not an instruction to install something.
  const runner = downloadsPackage(r);
  for (const f of scanText("command", [r.command, ...r.args].join(" "))) {
    if (runner && f.rule === "install-instructions") continue;
    out.push({ rule: f.rule, severity: f.severity, message: f.message });
  }
  for (const why of argvCredentialLeaks(r.args))
    out.push({
      rule: "credential-in-argv",
      severity: "high",
      message: `${why}; a command line is visible to every process, so a credential does not belong in it`,
    });
  const unpinned = unpinnedPackage(r);
  if (unpinned !== undefined)
    out.push({
      rule: "unpinned-package",
      severity: "warn",
      message: "the package it runs is not pinned to a version, so what runs can change under you",
    });
  if (downloadsPackage(r))
    out.push({
      rule: "downloads-at-start",
      severity: "warn",
      message:
        "it downloads its package when it starts, and the first run has no network, so the check may not be able to start it",
    });
  const risky = riskyDomains(r.network);
  if (risky.length > 0)
    out.push({
      rule: "broad-domain",
      severity: "warn",
      message: "a wildcard or shared-hosting domain reaches more than one site",
    });
  for (const [path, file] of tree) {
    const body = textOf(file);
    if (body === undefined) {
      out.push({
        rule: "binary-file",
        severity: "warn",
        message: `${path} is not text and cannot be read here`,
      });
      continue;
    }
    for (const f of scanText(path, body)) {
      out.push({
        rule: f.rule,
        severity: f.severity,
        message: f.message,
        ...(f.line === undefined ? {} : { line: f.line }),
        ...(f.file === undefined ? {} : { file: f.file }),
      });
    }
  }
  return out;
}
