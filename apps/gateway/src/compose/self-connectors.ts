import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { type AgentToolRegistration, defineTool, type ToolRunContext } from "@psyche/agent-core";
import { getSetting } from "@psyche/db";
import type { PsycheMcpServerConfig } from "@psyche/mcp-host";
import {
  type McpServerInput,
  type McpServerStatus,
  officialRemoteHost,
  PsycheError,
  type SelfConnectorFile,
  type ToolResult,
} from "@psyche/protocol";
import { Type } from "@sinclair/typebox";
import type { HandlerDef } from "../context.ts";
import { type McpAdder, type ProposeExtra, serverConfig } from "./mcp-add.ts";
import type { ComposeServices } from "./services.ts";

/**
 * Connectors Psyche writes for itself (self-extension, connectors workstream).
 *
 * The agent writes a small MCP server into `$PSYCHE_HOME/agent-connectors/<id>/` (not under
 * `workspace/`, which `memory.reset` wipes) with `connector_*` tools. Nothing runs until the owner
 * approves the same device-only `skill_install` trust card Settings → Connectors uses, now listing
 * every file, the exact command, the network it asks for and (on an update) the diff:
 *
 * - the command is derived here from the manifest (`node <entry>` / `uv run --script <entry>`),
 *   never taken from the agent; it runs under srt only (read access to its own directory,
 *   writes only to scratch, network only for the domains the card showed);
 * - the entry is `madeBy: "psyche"`, tier `unknown` always (`trustOf` ignores the command), and
 *   carries `filesHash`, the hash of the approved tree. The server starts only while the code on
 *   disk still hashes to it (`verifyMadeBy`, checked on every reconcile); a changed file stops it
 *   until a new card is approved, and a changed `tools/list` revokes its grants as for any server;
 * - a tainted turn's card offers `once` only (as every card of this kind), `connector_test` and
 *   `connector_remove` ask through the permission engine (destructive floor);
 * - servers start with the host like the others (no on-demand start in the host yet).
 */

export const SELF_CONNECTORS_DIR = "agent-connectors";
const APPROVED_DIR = ".approved";
const MANIFEST = "manifest.json";
/** The dependency-free MCP helper Psyche puts in every Node server's directory. */
export const LITE = "mcp-lite.mjs";

export const MAX_FILES = 24;
export const MAX_FILE_BYTES = 100_000;
export const MAX_TOTAL_BYTES = 400_000;
const MAX_DEPTH = 4;

const ID = /^[a-z][a-z0-9-]{1,40}$/;
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const EXTENSION = /\.(mjs|cjs|js|json|py|md|txt)$/;
const DOMAIN = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export interface Manifest {
  madeBy: "psyche";
  name: string;
  description: string;
  runtime: "node" | "python";
  entry: string;
  version: string;
  createdAt: number;
  allowedDomains: string[];
}

const bad = (message: string, details?: Record<string, unknown>): never => {
  throw new PsycheError("invalid_params", message, details === undefined ? {} : { details });
};

const sha = (text: string) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;

// --- the helper ------------------------------------------------------------------------------

/** Zero-dependency stdio MCP server helper: the SDK cannot be resolved from the server's directory. */
export const LITE_SOURCE = `// Psyche's minimal MCP server helper (newline-delimited JSON-RPC 2.0 over stdio, no dependencies).
// Provided by Psyche as part of the approved code; it is rewritten on every save, so do not edit it.
//
//   import { serve } from "./mcp-lite.mjs";
//   serve({ name: "my-server", tools: [{
//     name: "hello", description: "Say hello",
//     inputSchema: { type: "object", properties: { who: { type: "string" } } },
//     annotations: { readOnlyHint: true },
//     handler: async ({ who }) => "hello " + who,
//   }] });
import { createInterface } from "node:readline";

export function serve({ name, version = "1.0.0", tools, input = process.stdin, output = process.stdout }) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const send = (m) => output.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
  const reply = (id, result) => send({ id, result });
  const fail = (id, code, message) => send({ id, error: { code, message } });
  async function handle(msg) {
    const { id, method, params } = msg ?? {};
    if (id === undefined || typeof method !== "string") return;
    if (method === "initialize") {
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name, version },
      });
    }
    if (method === "ping") return reply(id, {});
    if (method === "tools/list") {
      return reply(id, {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description ?? "",
          inputSchema: t.inputSchema ?? { type: "object", properties: {} },
          ...(t.annotations ? { annotations: t.annotations } : {}),
        })),
      });
    }
    if (method === "tools/call") {
      const tool = byName.get(params?.name);
      if (!tool) return fail(id, -32602, "unknown tool " + params?.name);
      try {
        const out = await tool.handler(params.arguments ?? {});
        return reply(id, { content: [{ type: "text", text: typeof out === "string" ? out : JSON.stringify(out) }] });
      } catch (e) {
        return reply(id, { content: [{ type: "text", text: String(e?.message ?? e) }], isError: true });
      }
    }
    return fail(id, -32601, "method not found: " + method);
  }
  createInterface({ input }).on("line", (line) => {
    try {
      void handle(JSON.parse(line));
    } catch {
      /* not JSON-RPC: ignored */
    }
  });
  return { handle };
}
`;

// --- paths and files ---------------------------------------------------------------------------

export function assertId(id: string): void {
  if (!ID.test(id)) bad("id must be a lowercase slug (a-z, 0-9, -), 2 to 41 characters");
}

/** A relative, `/`-separated path of a plain file name; never `..`, hidden, absolute or odd. */
export function safeRel(path: string): string {
  if (path.length === 0 || path.length > 200 || /[\\\0]/.test(path) || path.startsWith("/")) {
    return bad(`bad path ${JSON.stringify(path.slice(0, 80))}`);
  }
  const parts = path.split("/");
  if (parts.length > MAX_DEPTH || !parts.every((p) => SEGMENT.test(p))) {
    return bad(`bad path ${JSON.stringify(path.slice(0, 80))}`);
  }
  if (!EXTENSION.test(path)) bad("files may be .mjs .cjs .js .json .py .md or .txt");
  return path;
}

export type Tree = Map<string, string>;

export function treeHash(files: Tree): string {
  const rows = [...files].sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, c]) => [p, sha(c)]);
  return sha(JSON.stringify(rows));
}

export function parseManifest(text: string | undefined): Manifest {
  let m: Partial<Manifest>;
  try {
    m = JSON.parse(text ?? "") as Partial<Manifest>;
  } catch {
    return bad("manifest.json is missing or not JSON");
  }
  if (
    m.madeBy !== "psyche" ||
    typeof m.name !== "string" ||
    m.name.length === 0 ||
    m.name.length > 100 ||
    (m.runtime !== "node" && m.runtime !== "python") ||
    typeof m.entry !== "string" ||
    typeof m.version !== "string" ||
    !/^[0-9]{1,6}$/.test(m.version) ||
    typeof m.createdAt !== "number"
  ) {
    return bad("manifest.json is not a valid connector manifest");
  }
  const domains = m.allowedDomains ?? [];
  if (
    !Array.isArray(domains) ||
    domains.length > 20 ||
    !domains.every((d) => typeof d === "string" && DOMAIN.test(d))
  ) {
    return bad("allowedDomains must be up to 20 domain names");
  }
  safeRel(m.entry);
  return {
    madeBy: "psyche",
    name: m.name,
    description: typeof m.description === "string" ? m.description.slice(0, 500) : "",
    runtime: m.runtime,
    entry: m.entry,
    version: m.version,
    createdAt: m.createdAt,
    allowedDomains: [...domains],
  };
}

/** The command line, derived from the manifest alone. */
export function commandFor(m: Manifest): string[] {
  return m.runtime === "node" ? ["node", m.entry] : ["uv", "run", "--script", m.entry];
}

export function configFor(
  id: string,
  m: Manifest,
  dir: string,
  filesHash: string,
): PsycheMcpServerConfig {
  return {
    id,
    name: m.name,
    trust: "unknown",
    transport: { kind: "stdio", command: commandFor(m) },
    cwd: dir,
    sandbox: { allowedDomains: [...m.allowedDomains], allowRead: [dir] },
    madeBy: "psyche",
    version: m.version,
    filesHash,
  };
}

const manifestText = (m: Manifest) => `${JSON.stringify(m, null, 2)}\n`;

// --- the store -------------------------------------------------------------------------------

export interface SelfConnectorStore {
  root: string;
  dirOf(id: string): string;
  exists(id: string): Promise<boolean>;
  load(id: string): Promise<Tree>;
  manifestOf(tree: Tree): Manifest;
  create(id: string, m: Manifest): Promise<void>;
  write(id: string, path: string, content: string, opts?: { owner?: boolean }): Promise<Tree>;
  /** Puts the canonical helper and a rewritten manifest in place; returns the tree to hash. */
  settle(id: string, patch?: Partial<Pick<Manifest, "version" | "allowedDomains">>): Promise<Tree>;
  approved(id: string): Promise<{ hash: string; version: string; files: Tree } | undefined>;
  saveApproved(id: string, version: string, files: Tree): Promise<void>;
  purge(id: string): Promise<void>;
}

export function selfConnectorStore(home: string): SelfConnectorStore {
  const root = join(home, SELF_CONNECTORS_DIR);
  const dirOf = (id: string) => {
    assertId(id);
    return join(root, id);
  };
  const walk = async (
    base: string,
    rel: string,
    depth: number,
    out: Tree,
    sizes: { n: number },
  ) => {
    if (depth > MAX_DEPTH) bad("directory nesting is too deep");
    for (const e of await readdir(join(base, rel), { withFileTypes: true })) {
      const r = rel === "" ? e.name : `${rel}/${e.name}`;
      const full = join(base, r);
      const st = await lstat(full);
      if (st.isSymbolicLink()) bad(`${r} is a symlink`);
      if (st.isDirectory()) {
        if (!SEGMENT.test(e.name)) bad(`bad directory name ${e.name}`);
        await walk(base, r, depth + 1, out, sizes);
      } else if (st.isFile()) {
        safeRel(r);
        if (st.size > MAX_FILE_BYTES) bad(`${r} is larger than ${MAX_FILE_BYTES} bytes`);
        sizes.n += st.size;
        if (out.size + 1 > MAX_FILES) bad(`more than ${MAX_FILES} files`);
        if (sizes.n > MAX_TOTAL_BYTES) bad(`more than ${MAX_TOTAL_BYTES} bytes in total`);
        out.set(r, await readFile(full, "utf8"));
      } else {
        bad(`${r} is not a regular file`);
      }
    }
  };
  const store: SelfConnectorStore = {
    root,
    dirOf,
    async exists(id) {
      return lstat(dirOf(id)).then(
        () => true,
        () => false,
      );
    },
    async load(id) {
      const dir = dirOf(id);
      const st = await lstat(dir).catch(() => undefined);
      if (st === undefined) throw new PsycheError("not_found", `no connector ${id}`);
      if (!st.isDirectory()) bad("not a directory");
      const out: Tree = new Map();
      await walk(dir, "", 0, out, { n: 0 });
      return new Map([...out].sort(([a], [b]) => (a < b ? -1 : 1)));
    },
    manifestOf: (tree) => parseManifest(tree.get(MANIFEST)),
    async create(id, m) {
      const dir = dirOf(id);
      await mkdir(root, { recursive: true, mode: 0o700 });
      await mkdir(dir, { mode: 0o700 });
      await writeFile(join(dir, MANIFEST), manifestText(m), { mode: 0o600 });
      if (m.runtime === "node") await writeFile(join(dir, LITE), LITE_SOURCE, { mode: 0o600 });
    },
    async write(id, path, content, opts = {}) {
      const rel = safeRel(path);
      if (rel === LITE) bad(`${LITE} is provided by Psyche`);
      if (rel === MANIFEST) {
        if (opts.owner !== true) bad("manifest.json is managed by the connector tools");
        parseManifest(content);
      }
      if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
        bad(`${rel} is larger than ${MAX_FILE_BYTES} bytes`);
      }
      const tree = await store.load(id);
      const next = new Map(tree).set(rel, content);
      if (next.size > MAX_FILES) bad(`more than ${MAX_FILES} files`);
      let total = 0;
      for (const c of next.values()) total += Buffer.byteLength(c, "utf8");
      if (total > MAX_TOTAL_BYTES) bad(`more than ${MAX_TOTAL_BYTES} bytes in total`);
      const dir = dirOf(id);
      const target = join(dir, ...rel.split("/"));
      if (!target.startsWith(dir + sep)) bad("path escapes the connector directory");
      // `load` rejected symlinks; a directory is made only for a path that has none above it.
      await mkdir(join(target, ".."), { recursive: true, mode: 0o700 });
      const existing = await lstat(target).catch(() => undefined);
      if (existing !== undefined && !existing.isFile()) bad(`${rel} is not a regular file`);
      await writeFile(target, content, { mode: 0o600 });
      return next;
    },
    async settle(id, patch = {}) {
      let tree = await store.load(id);
      const m = { ...store.manifestOf(tree), ...patch };
      const dir = dirOf(id);
      await writeFile(join(dir, MANIFEST), manifestText(m), { mode: 0o600 });
      if (m.runtime === "node") await writeFile(join(dir, LITE), LITE_SOURCE, { mode: 0o600 });
      tree = await store.load(id);
      if (!tree.has(m.entry)) bad(`the entry file ${m.entry} does not exist; write it first`);
      return tree;
    },
    async approved(id) {
      try {
        const v = JSON.parse(await readFile(join(root, APPROVED_DIR, `${id}.json`), "utf8")) as {
          hash: string;
          version: string;
          files: Record<string, string>;
        };
        return { hash: v.hash, version: v.version, files: new Map(Object.entries(v.files)) };
      } catch {
        return undefined;
      }
    },
    async saveApproved(id, version, files) {
      await mkdir(join(root, APPROVED_DIR), { recursive: true, mode: 0o700 });
      await writeFile(
        join(root, APPROVED_DIR, `${id}.json`),
        JSON.stringify({ hash: treeHash(files), version, files: Object.fromEntries(files) }),
        { mode: 0o600 },
      );
    },
    async purge(id) {
      await rm(dirOf(id), { recursive: true, force: true });
      await rm(join(root, APPROVED_DIR, `${id}.json`), { force: true });
    },
  };
  return store;
}

// --- diff --------------------------------------------------------------------------------------

type Op = { t: " " | "+" | "-"; s: string };

function lineDiff(a: string[], b: string[]): Op[] {
  if (a.length * b.length > 4_000_000) {
    return [...a.map((s) => ({ t: "-" as const, s })), ...b.map((s) => ({ t: "+" as const, s }))];
  }
  const w = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * w + j] =
        a[i] === b[j]
          ? (lcs[(i + 1) * w + j + 1] ?? 0) + 1
          : Math.max(lcs[(i + 1) * w + j] ?? 0, lcs[i * w + j + 1] ?? 0);
    }
  }
  const out: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ t: " ", s: a[i] as string });
      i++;
      j++;
    } else if ((lcs[(i + 1) * w + j] ?? 0) >= (lcs[i * w + j + 1] ?? 0)) {
      out.push({ t: "-", s: a[i++] as string });
    } else {
      out.push({ t: "+", s: b[j++] as string });
    }
  }
  while (i < a.length) out.push({ t: "-", s: a[i++] as string });
  while (j < b.length) out.push({ t: "+", s: b[j++] as string });
  return out;
}

/** A unified-style diff of two trees as display lines (the lite helper never differs). */
export function treeDiff(before: Tree, after: Tree, context = 2): string[] {
  const out: string[] = [];
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  for (const p of paths) {
    const x = before.get(p);
    const y = after.get(p);
    if (x === y) continue;
    out.push(
      `--- ${x === undefined ? "/dev/null" : `a/${p}`}`,
      `+++ ${y === undefined ? "/dev/null" : `b/${p}`}`,
    );
    const ops = lineDiff(
      x === undefined ? [] : x.split("\n"),
      y === undefined ? [] : y.split("\n"),
    );
    const keep = new Set<number>();
    ops.forEach((o, k) => {
      if (o.t === " ") return;
      for (let d = -context; d <= context; d++) keep.add(k + d);
    });
    let last = -2;
    ops.forEach((o, k) => {
      if (!keep.has(k)) return;
      if (k !== last + 1) out.push("@@");
      out.push(`${o.t}${o.s}`);
      last = k;
    });
  }
  return out;
}

// --- the card ----------------------------------------------------------------------------------

function fileViews(tree: Tree): Record<string, unknown>[] {
  return [...tree].map(([path, content]) => ({
    path,
    bytes: Buffer.byteLength(content, "utf8"),
    // The helper is the gateway's own constant, rewritten on every save: not shown line by line.
    ...(path === LITE ? { provided: true, lines: [] } : { lines: content.split("\n") }),
  }));
}

// --- tools and handlers ----------------------------------------------------------------------

export interface SelfConnectorsDeps {
  services: ComposeServices;
  settingKey: string;
  adder: McpAdder;
  store: SelfConnectorStore;
  /** Re-applies `mcp.servers` so a running server whose code changed stops. */
  reconcile(): Promise<void>;
}

export interface SelfConnectors {
  tools: AgentToolRegistration[];
  handlers: Record<string, HandlerDef>;
  /** Why a stored agent-made entry must not start, or undefined when it may. */
  verifyMadeBy(entry: PsycheMcpServerConfig): Promise<string | undefined>;
  /** `mcp.remove` of an agent-made entry: its directory goes with it. */
  removed(entry: PsycheMcpServerConfig): Promise<void>;
}

function readEntries(services: ComposeServices, key: string): PsycheMcpServerConfig[] {
  const v = getSetting(services.db, key)?.value;
  return Array.isArray(v) ? (v as PsycheMcpServerConfig[]) : [];
}

function asOwner(ctx: ToolRunContext): void {
  if (ctx.requester !== undefined && ctx.requester.role !== "owner") {
    throw new PsycheError("forbidden", "only the owner's own turns can change connectors");
  }
}

function mutating(ctx: ToolRunContext): void {
  asOwner(ctx);
  if (ctx.permissionMode === "plan") {
    throw new PsycheError("policy_denied", "plan mode runs only side-effect-free tools");
  }
}

const trusted = (output: unknown): ToolResult => ({
  output: output as never,
  provenance: "trusted",
});
const untrusted = (output: unknown): ToolResult => ({
  output: output as never,
  provenance: "untrusted",
});

const Id = Type.String({
  minLength: 2,
  maxLength: 41,
  description: "Lowercase slug, e.g. weather-notes",
});
const Domains = Type.Array(Type.String({ maxLength: 253 }), {
  maxItems: 20,
  description: "Domains the server may reach (default none). The owner sees them on the card.",
});

export function selfConnectors(deps: SelfConnectorsDeps): SelfConnectors {
  const { services, store, adder } = deps;
  const now = () => services.clock.now();

  const expected = (id: string, tree: Tree) => {
    const m = store.manifestOf(tree);
    return { m, config: configFor(id, m, store.dirOf(id), treeHash(tree)) };
  };

  const verifyMadeBy = async (entry: PsycheMcpServerConfig): Promise<string | undefined> => {
    if (entry.madeBy !== "psyche") return undefined;
    try {
      const tree = await store.load(entry.id);
      if (tree.get(LITE) !== undefined && tree.get(LITE) !== LITE_SOURCE) {
        return "the MCP helper file was changed";
      }
      const { config } = expected(entry.id, tree);
      if (config.filesHash !== entry.filesHash)
        return "its code changed since the owner approved it";
      const core = (c: PsycheMcpServerConfig) => JSON.stringify([c.transport, c.cwd, c.sandbox]);
      if (core(config) !== core(entry)) return "its command or sandbox differs from its manifest";
      return undefined;
    } catch (err) {
      return PsycheError.from(err).message;
    }
  };

  const requestedBy = (ctx: ToolRunContext) => ({
    runId: ctx.runId,
    taskId: ctx.taskId ?? null,
    threadId: ctx.threadId,
    toolCallId: ctx.callId,
  });
  const taintOf = (ctx: ToolRunContext) =>
    ctx.taint ? { sources: ctx.taintSources ?? [] } : undefined;

  /** Probe (no network), stage, card; then wait for the owner and add. */
  const proposeAndWait = async (
    ctx: ToolRunContext,
    input: McpServerInput,
    extra: Omit<ProposeExtra, "requestedBy" | "taint">,
  ) => {
    if (ctx.mode === "unattended") {
      throw new PsycheError(
        "approval_required",
        "a connector needs the owner's approval card; ask again in a chat turn",
      );
    }
    const taint = taintOf(ctx);
    const { proposal, approval } = await adder.propose(input, {
      ...extra,
      requestedBy: requestedBy(ctx),
      ...(taint === undefined ? {} : { taint }),
    });
    const done = await services.broker.awaitDecision(approval.id, ctx.signal);
    if (done.status !== "approved") {
      return trusted({ status: done.status, note: "the owner did not approve; do not ask again" });
    }
    const { server } = await adder.commit(proposal.id, approval.id);
    return trusted({
      status: "enabled",
      server: summary(server),
      tools: proposal.tools.map((t) => t.name),
    });
  };
  const summary = (s: McpServerStatus) => ({ id: s.id, connected: s.connected, trust: s.trust });

  /** The card for a create or update of the code in `id`'s directory. */
  const proposeCode = async (id: string, update: boolean, domains?: string[]) => {
    const entries = readEntries(services, deps.settingKey);
    const entry = entries.find((c) => c.id === id);
    if (update ? entry?.madeBy !== "psyche" : entry !== undefined) {
      throw new PsycheError(
        update ? "not_found" : "conflict",
        update
          ? `${id} is not registered; use connector_register`
          : `${id} is registered; use connector_update`,
      );
    }
    const before = await store.approved(id);
    let tree = await store.settle(id);
    const m0 = store.manifestOf(tree);
    const domainsChanged =
      domains !== undefined && JSON.stringify(domains) !== JSON.stringify(m0.allowedDomains);
    if (update && before !== undefined && treeHash(tree) === before.hash && !domainsChanged) {
      throw new PsycheError("conflict", "nothing changed since the approved version");
    }
    if (update || domainsChanged) {
      tree = await store.settle(id, {
        ...(update ? { version: String(Number(before?.version ?? m0.version) + 1) } : {}),
        ...(domains === undefined ? {} : { allowedDomains: domains }),
      });
    }
    const { m, config } = expected(id, tree);
    const input: McpServerInput = {
      id,
      name: m.name,
      transport: { kind: "stdio", command: commandFor(m) },
      allowedDomains: m.allowedDomains,
    };
    const common: ProposeExtra = {
      config,
      probeWithoutNetwork: true,
      replace: update,
      summary: `${update ? "Update" : "Add"} connector "${m.name}" written by Psyche (version ${m.version})`,
      details: {
        madeBy: "psyche",
        change: update ? "update" : "create",
        version: m.version,
        runtime: m.runtime,
        entry: m.entry,
        requestedNetwork: m.allowedDomains,
        files: fileViews(tree),
        ...(update && before !== undefined
          ? { previousVersion: before.version, diff: treeDiff(before.files, tree) }
          : {}),
      },
      // What was approved is what runs: refuse if the files moved between card and approval.
      async precommit() {
        const now0 = await store.load(id);
        if (treeHash(now0) !== config.filesHash) {
          throw new PsycheError(
            "conflict",
            "the connector's code changed since the card; review it again",
          );
        }
      },
      async committed() {
        await store.saveApproved(id, m.version, tree);
      },
    };
    return { input, common, config, m };
  };

  const tools: AgentToolRegistration[] = [
    defineTool({
      name: "connector_create",
      description:
        "Start a new connector of your own: a small MCP server you write as code, so you can give yourself a new tool (for example a wrapper around a public API or a local data format). Makes the directory and manifest; then add files with connector_write_file, try it with connector_test, and ask the owner to enable it with connector_register. Nothing runs until the owner approves the card. runtime `node` (default): write the entry (default server.mjs) with the provided ./mcp-lite.mjs helper (`serve({name, tools:[{name, description, inputSchema, handler}]})`); it has no npm packages. Network is none unless you list allowedDomains.",
      input: Type.Object({
        id: Id,
        name: Type.String({ minLength: 1, maxLength: 100 }),
        description: Type.Optional(Type.String({ maxLength: 500 })),
        runtime: Type.Optional(Type.Union([Type.Literal("node"), Type.Literal("python")])),
        entry: Type.Optional(Type.String({ maxLength: 100 })),
        allowedDomains: Type.Optional(Domains),
      }),
      sideEffect: "none",
      describeCall: (p) => ({ summary: `Started connector "${p.name}" (${p.id})` }),
      async run(p, ctx) {
        mutating(ctx);
        assertId(p.id);
        if (readEntries(services, deps.settingKey).some((c) => c.id === p.id)) {
          throw new PsycheError("conflict", `an MCP server with id ${p.id} exists`);
        }
        if (await store.exists(p.id)) throw new PsycheError("conflict", `connector ${p.id} exists`);
        const runtime = p.runtime ?? "node";
        const entry = safeRel(p.entry ?? (runtime === "node" ? "server.mjs" : "server.py"));
        if (entry === LITE || entry === MANIFEST) bad("pick another entry file");
        const manifest = parseManifest(
          JSON.stringify({
            madeBy: "psyche",
            name: p.name,
            description: p.description ?? "",
            runtime,
            entry,
            version: "1",
            createdAt: now(),
            allowedDomains: p.allowedDomains ?? [],
          }),
        );
        await store.create(p.id, manifest);
        return trusted({ id: p.id, entry, helper: runtime === "node" ? `./${LITE}` : undefined });
      },
    }),
    defineTool({
      name: "connector_write_file",
      description:
        "Write one file of your connector (create or replace). Plain files only (.mjs .js .json .py .md .txt), at most 24 files, 100 KB each, 400 KB in all. Files are inert until the owner approves the connector. After a change to an enabled connector, call connector_update.",
      input: Type.Object({
        id: Id,
        path: Type.String({ minLength: 1, maxLength: 200 }),
        content: Type.String({ maxLength: MAX_FILE_BYTES }),
      }),
      sideEffect: "none",
      describeCall: (p) => ({ summary: `Wrote ${p.id}/${p.path}` }),
      async run(p, ctx) {
        mutating(ctx);
        const tree = await store.write(p.id, p.path, p.content);
        await deps.reconcile();
        return trusted({ ok: true, path: p.path, files: tree.size });
      },
    }),
    defineTool({
      name: "connector_read",
      description: "List your connector's files (omit path), or read one file of it.",
      input: Type.Object({ id: Id, path: Type.Optional(Type.String({ maxLength: 200 })) }),
      sideEffect: "none",
      async run(p, ctx) {
        asOwner(ctx);
        const tree = await store.load(p.id);
        if (p.path === undefined) {
          return trusted({
            files: [...tree].map(([path, c]) => ({ path, bytes: Buffer.byteLength(c, "utf8") })),
          });
        }
        const content = tree.get(safeRel(p.path));
        if (content === undefined) throw new PsycheError("not_found", `no file ${p.path}`);
        return untrusted({ path: p.path, content });
      },
    }),
    defineTool({
      name: "connector_test",
      description:
        "Run your connector once in the sandbox (srt only, no network, no secrets) and list the tools it exposes. Use it before connector_register. Runs your code, so the owner is asked.",
      input: Type.Object({ id: Id }),
      sideEffect: "write",
      describeCall: (p) => ({ summary: `Tested connector ${p.id}` }),
      async run(p, ctx) {
        mutating(ctx);
        const tree = await store.settle(p.id);
        const { config } = expected(p.id, tree);
        const found = await adder.test({
          ...config,
          sandbox: { ...config.sandbox, allowedDomains: [] },
        });
        return untrusted({
          filesHash: config.filesHash,
          toolsListHash: found.toolsListHash,
          tools: found.tools.map((t) => ({
            name: t.name,
            description: t.description,
            sideEffect: t.sideEffect,
            blocked: t.blocked,
          })),
          ...(found.diagnostics === undefined ? {} : { diagnostics: found.diagnostics }),
        });
      },
    }),
    defineTool({
      name: "connector_register",
      description:
        "Ask the owner to enable your connector. Probes it in the sandbox (no network), opens a card on the owner's Mac showing every file, the exact command, the network it asks for and its tools, and waits for the answer in this turn. It runs only if approved, only in the sandbox, and always as an unknown-tier connector whose write tools ask each time. On a denial, tell the owner briefly and do not ask again.",
      input: Type.Object({ id: Id }),
      sideEffect: "none",
      describeCall: (p) => ({ summary: `Asked to enable connector ${p.id}` }),
      async run(p, ctx) {
        mutating(ctx);
        const { input, common } = await proposeCode(p.id, false);
        return proposeAndWait(ctx, input, common);
      },
    }),
    defineTool({
      name: "connector_update",
      description:
        "Ask the owner to approve changes to an enabled connector you wrote (after connector_write_file). The card shows a diff against the approved code. The connector stops as soon as its code changes and starts again only once the owner approves the card. You may also pass new allowedDomains.",
      input: Type.Object({ id: Id, allowedDomains: Type.Optional(Domains) }),
      sideEffect: "none",
      describeCall: (p) => ({ summary: `Asked to update connector ${p.id}` }),
      async run(p, ctx) {
        mutating(ctx);
        const { input, common } = await proposeCode(p.id, true, p.allowedDomains);
        return proposeAndWait(ctx, input, common);
      },
    }),
    defineTool({
      name: "connector_remove",
      description:
        "Delete one of your connectors: stops it, removes its entry, its code and its grants. The owner is asked.",
      input: Type.Object({ id: Id }),
      sideEffect: "destructive",
      describeCall: (p) => ({ summary: `Removed connector ${p.id}` }),
      async run(p, ctx) {
        mutating(ctx);
        assertId(p.id);
        const entry = readEntries(services, deps.settingKey).find((c) => c.id === p.id);
        if (entry !== undefined && entry.madeBy !== "psyche") {
          throw new PsycheError("forbidden", "only connectors you wrote can be removed here");
        }
        if (entry === undefined && !(await store.exists(p.id))) {
          throw new PsycheError("not_found", `no connector ${p.id}`);
        }
        if (entry !== undefined) await adder.remove(p.id);
        await store.purge(p.id);
        return trusted({ ok: true });
      },
    }),
    defineTool({
      name: "connector_propose_remote",
      description:
        "Suggest a vendor's hosted connector (for example Linear, Notion, Sentry) from the registry of official endpoints, by its https URL. Opens the same owner card as Settings → Connectors and waits for the answer. Only registry URLs are accepted; for anything else tell the owner to add it in Settings → Connectors.",
      input: Type.Object({
        url: Type.String({ pattern: "^https://", maxLength: 2_000 }),
        id: Type.Optional(Id),
      }),
      sideEffect: "none",
      describeCall: (p) => ({ summary: `Suggested connector ${p.url}` }),
      async run(p, ctx) {
        mutating(ctx);
        const host = officialRemoteHost(p.url);
        if (host === undefined) {
          bad("only official endpoints from the connector registry can be suggested", {
            reason: "not_in_registry",
          });
        }
        const label = (host as string).replace(/^(mcp|api|ai)\./, "").split(".")[0] ?? "remote";
        const id = p.id ?? label.replace(/[^a-z0-9-]/g, "-");
        assertId(id);
        const input: McpServerInput = {
          id,
          name: `${label.charAt(0).toUpperCase()}${label.slice(1)}`,
          transport: { kind: "http", url: p.url },
        };
        return proposeAndWait(ctx, input, {
          config: serverConfig(input),
          summary: `Psyche suggests connecting ${host}`,
          details: { proposedBy: "psyche" },
        });
      },
    }),
  ];

  const handlers: Record<string, HandlerDef> = {
    "mcp.files.read": {
      async run(_call, params: { serverId: string }) {
        const entry = readEntries(services, deps.settingKey).find((c) => c.id === params.serverId);
        if (entry?.madeBy !== "psyche") {
          throw new PsycheError("not_found", `${params.serverId} was not made by Psyche`);
        }
        const tree = await store.load(entry.id);
        const m = store.manifestOf(tree);
        const files: SelfConnectorFile[] = [...tree].map(([path, content]) => ({
          path,
          content,
          bytes: Buffer.byteLength(content, "utf8"),
        }));
        return {
          files,
          version: m.version,
          runtime: m.runtime,
          entry: m.entry,
          modified: (await verifyMadeBy(entry)) !== undefined,
        };
      },
    },
    "mcp.files.write": {
      async run(_call, params: { serverId: string; path: string; content: string }) {
        const entry = readEntries(services, deps.settingKey).find((c) => c.id === params.serverId);
        if (entry?.madeBy !== "psyche") {
          throw new PsycheError("not_found", `${params.serverId} was not made by Psyche`);
        }
        await store.write(entry.id, params.path, params.content, { owner: true });
        // The code no longer matches what was approved: it stops until the new card is approved.
        await deps.reconcile();
        const { input, common } = await proposeCode(entry.id, true);
        return adder.propose(input, common);
      },
    },
  };

  return {
    tools,
    handlers,
    verifyMadeBy,
    async removed(entry) {
      if (entry.madeBy === "psyche") await store.purge(entry.id);
    },
  };
}
