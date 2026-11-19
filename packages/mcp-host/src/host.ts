import type { Client, FetchLike, Implementation, Tool } from "@modelcontextprotocol/client";
import {
  type Clock,
  type McpCallOptions,
  type McpHost,
  type McpServerConfig,
  type McpServerInfo,
  type McpToolList,
  type McpToolResult,
  type McpTrustTier,
  PsycheError,
  type Sha256,
  type ToolSpec,
} from "@psyche/protocol";
import { diffTools, type ToolChange, toolsListHash } from "./hash.ts";
import { inspectTool, type ToolWarning } from "./inspect.ts";
import type { McpSandboxPolicy, StdioLauncher, StdioLaunchSpec } from "./launcher.ts";
import { startLoopbackReceiver } from "./loopback.ts";
import { isValidServerId, MAX_TOOL_NAME_LENGTH, mcpToolName } from "./naming.ts";
import { blockRegistration, type McpOAuthOptions, PsycheOAuthProvider } from "./oauth.ts";
import { provenanceFor, requiresUserInteraction, sideEffectFor } from "./policy.ts";
import { reResolvesOnLaunch } from "./runner.ts";
import { loadedMcpSdk, loadMcpSdk, loadMcpStdioSdk } from "./sdk.ts";
import { assertNoPlaceholders, resolveEnv, type SecretInjection } from "./secrets.ts";

/** Optional per-server settings beyond the `McpServerConfig` contract. */
export interface PsycheMcpServerConfig extends McpServerConfig {
  /** Working directory of a stdio server. */
  cwd?: string;
  /** Remote server authentication. Default `oauth` when the host has OAuth configured. */
  auth?:
    | { kind: "none" }
    | { kind: "oauth"; clientId?: string; scopes?: string[] }
    /** A vault item bound to the server's origin, sent as `Authorization: Bearer`. */
    | { kind: "bearer"; credential: string };
  /** srt policy for stdio servers; defaults to no network and no writes. */
  sandbox?: Partial<McpSandboxPolicy>;
  /**
   * The owner turned the server off (`false`): it stays configured but is not started. The host
   * itself ignores it; the Gateway's reconcile does not add a disabled server.
   */
  enabled?: boolean;
  /**
   * Written by Psyche itself (`connector_*` tools), not picked by the owner: the code lives in
   * `$PSYCHE_HOME/agent-connectors/<id>`. Always tier `unknown`; it starts only while that code
   * still hashes to `filesHash`, the tree the owner approved.
   */
  madeBy?: "psyche";
  /**
   * Installed from a shared `.psyche-connector` file: someone else's command, so its tier is
   * always `unknown` whatever the command looks like, and it starts only while its record in
   * `connectors/bundles.json` is intact and its author's key and bundle are not revoked.
   */
  bundle?: { hash: string };
  /** The manifest's version (a counter the agent bumps on update). */
  version?: string;
  /** Hash of the approved code tree (`treeHash` of the files); checked before every start. */
  filesHash?: string;
  /**
   * The owner's word on whether this server moves money (payments, orders, transfers). `true`:
   * every one of its tools is `financial`, so each call asks with the owner's presence. `false`:
   * none is (the name and description guess is off for it). Unset: the guess decides. Only the
   * owner sets it (`mcp.handlesMoney.set`, or the admin-only `mcp.servers` setting); lowering it
   * needs a fresh approval.
   */
  handlesMoney?: boolean;
  /** The server's own names of tools the owner withholds from the agent (`registerMcpServerTools`'s `offer`). */
  disabledTools?: string[];
  /**
   * `true`: a stdio server that is never stopped for being idle (it pushes notifications or
   * subscriptions, or holds state that is costly to rebuild). Default: it stops after
   * `idleStopMs` without a call and starts again on the next one. Config only (the
   * `mcp.servers` setting); Settings has no switch for it.
   */
  keepAlive?: boolean;
}

/** An MRTR (2026-07-28) or legacy elicitation request, surfaced to the owner. */
export interface McpInputRequest {
  serverId: string;
  mode: "form" | "url";
  /** Server-authored text: untrusted, render as data. */
  message: string;
  requestedSchema?: Record<string, unknown>;
  url?: string;
  provenance: "untrusted";
}

export interface McpInputResponse {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, string | number | boolean | string[]>;
}

export type InputRequester = (request: McpInputRequest) => Promise<McpInputResponse>;

export type McpHostEvent =
  | {
      type: "tools_changed";
      serverId: string;
      previousHash: Sha256 | undefined;
      hash: Sha256;
      changes: ToolChange[];
      warnings: ToolWarning[];
    }
  | { type: "status"; serverId: string; status: McpServerInfo["status"]; error?: string }
  | { type: "auth_required"; serverId: string; authorizationUrl: string };

export interface McpHostOptions {
  clientInfo?: Implementation;
  clock?: Clock;
  /**
   * Replaces every known vault value (and its URL / base64 forms) in server output before it
   * reaches the loop, as `exec` results are (security §4.7; #284 TM-17). Default: the
   * Credential Broker's `redact` from `secrets`, so a server that echoes its own injected env
   * secret returns `•••`.
   */
  redact?: (text: string) => string;
  /**
   * Server ids that ship with Psyche. `trust: "bundled"` is accepted only for these, so an API
   * caller cannot self-declare a server bundled to get its annotations honored.
   */
  bundledServerIds?: Iterable<string>;
  /** Required for every non-bundled stdio server (srt now, container launcher in M3). */
  launcher?: StdioLauncher;
  /** Launcher for bundled servers; defaults to `launcher`. */
  bundledLauncher?: StdioLauncher;
  secrets?: SecretInjection;
  oauth?: McpOAuthOptions;
  /** Handles elicitation (form / URL). Without it the host declares no elicitation capability. */
  inputRequester?: InputRequester;
  requestTimeoutMs?: number;
  /**
   * Stop a stdio server that has had no call for this long (default 10 minutes; `0` turns it off)
   * to give its memory back. Its approved tool list stays pinned; the next call starts it again
   * and re-lists, and a listing that differs revokes exactly as a live change does. Servers the
   * host never restarts by itself (`neverAutoStart`, an unpinned package runner such as
   * `npx -y pkg`) and `keepAlive` servers are never stopped.
   */
  idleStopMs?: number;
  /**
   * Restart policy after a crash or a failed restart: the wait doubles from `baseMs` up to
   * `maxMs`; after `maxAttempts` in a row the server stays down for `cooldownMs` (default 10
   * minutes), then the next call may try once more. Editing or re-adding it starts it at once.
   */
  restart?: { baseMs?: number; maxMs?: number; maxAttempts?: number; cooldownMs?: number };
  /**
   * Servers the Gateway checks before every start, beyond the host's own rules: the host never
   * stops them for being idle and never restarts them by itself, so no restart skips a check.
   */
  neverAutoStart?: (config: PsycheMcpServerConfig) => boolean;
  /** Serialized size cap of one tool result returned to the agent. Default 256 KiB. */
  maxResultBytes?: number;
  fetch?: FetchLike;
  onEvent?: (event: McpHostEvent) => void;
}

/** What `callTool` returns as `content`. */
export interface McpCallContent {
  blocks: unknown[];
  structured?: unknown;
  /** Set when the result exceeded `maxResultBytes` and blocks were dropped. */
  truncated?: true;
}

export interface McpServerDetails extends McpServerInfo {
  era?: "modern" | "legacy";
  error?: string;
  tools: Tool[];
  warnings: ToolWarning[];
  /** `error` can carry server-authored text; render it as data. */
  errorProvenance?: "untrusted";
  isolation?: StdioLauncher["isolation"];
  stderrTail: string;
}

interface ServerState {
  config: PsycheMcpServerConfig;
  status: McpServerInfo["status"];
  client?: Client;
  launch?: { cleanup?: () => Promise<void> };
  /** Callable tools: the listing minus names that are invalid or collide after sanitizing. */
  tools: Tool[];
  /** The listing exactly as the server sent it (hashed and diffed). */
  rawTools: Tool[];
  hash?: Sha256;
  protocolVersion?: string;
  era?: "modern" | "legacy";
  error?: string;
  warnings: ToolWarning[];
  stderr: string;
  /** Bumped by every connect / remove; a connect that finishes under an older value is dropped. */
  generation: number;
  /** Bumped by every listing request and list_changed pin; only the latest listing is pinned. */
  listSeq: number;
  removed?: true;
  /** Calls (and listings) running now: a server is never idle-stopped under one. */
  inFlight: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  /** The stdio process is down (idle stop or crash) and the next call may start it again. */
  restartable: boolean;
  /** Single-flight restart. */
  waking?: Promise<void>;
  /** Consecutive failed restarts and connections that died soon after starting. */
  restartFailures: number;
  /** Connections that died on their own (`onclose`): a start compares it to count a death once. */
  deaths: number;
  nextRestartAt: number;
  connectedAt: number;
  /** Aborted by `close()` and `removeServer`: a start in flight gives up instead of being waited for. */
  stop: AbortController;
  /** Launcher steps (`prepare`, `open`) still running, each with the cleanup of a late result. */
  launching: Set<Promise<void>>;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_INPUT_ROUNDS = 4;
const DEFAULT_MAX_RESULT_BYTES = 256 * 1024;
/** What an image block counts against the result cap (the model reads it as an image part). */
const IMAGE_BLOCK_BYTES = 4 * 1024;
/** Images one result may carry, and their base64 characters in all. */
const MAX_IMAGE_BLOCKS = 4;
const MAX_IMAGE_BLOCK_CHARS = 8_000_000;

/**
 * True when the text blocks are only the JSON of `structuredContent` (the MCP spec has servers
 * send both): the model then gets the structured form once.
 */
export function repeatsStructured(content: unknown, structured: unknown): boolean {
  if (!Array.isArray(content)) return false;
  const texts = content.filter((b) => (b as { type?: unknown } | null)?.type === "text");
  if (texts.length === 0) return false;
  const want = JSON.stringify(structured);
  return texts.every((b) => {
    try {
      return JSON.stringify(JSON.parse(String((b as { text?: unknown }).text))) === want;
    } catch {
      return false;
    }
  });
}
const STDERR_TAIL = 8 * 1024;
const DEFAULT_IDLE_STOP_MS = 10 * 60_000;
const DEFAULT_RESTART_BASE_MS = 1_000;
const DEFAULT_RESTART_MAX_MS = 60_000;
const DEFAULT_RESTART_ATTEMPTS = 5;
const DEFAULT_RESTART_COOLDOWN_MS = 10 * 60_000;
/** A connection that dies sooner than this after starting counts as a crash-loop step. */
const HEALTHY_RUN_MS = 30_000;

/**
 * MCP host (architecture §4.9, security §11) on TypeScript SDK v2. Each server gets one `Client`
 * negotiating 2026-07-28 via `server/discover` with the 2025-11-25 `initialize` fallback. Calls
 * are bound to the `tools/list` hash their approval saw; any change to the listing changes the
 * hash, emits `tools_changed` and makes old-hash calls fail with `conflict`.
 */
export class PsycheMcpHost implements McpHost {
  readonly #servers = new Map<string, ServerState>();
  readonly #options: McpHostOptions;
  readonly #redact: (text: string) => string;
  readonly #bundled: Set<string>;
  /** The launch each client was started with, so a superseded connect cleans up its own. */
  readonly #launchOf = new WeakMap<Client, { cleanup?: () => Promise<void> }>();
  #closed = false;

  constructor(options: McpHostOptions = {}) {
    this.#options = options;
    const credentials = options.secrets?.credentials;
    this.#redact =
      options.redact ??
      (credentials === undefined ? (text: string) => text : (text) => credentials.redact(text));
    this.#bundled = new Set(options.bundledServerIds ?? []);
    const cimd = options.oauth?.clientMetadataUrl;
    if (cimd !== undefined) {
      const u = new URL(cimd);
      if (u.protocol !== "https:" || u.pathname === "/") {
        throw new PsycheError(
          "invalid_params",
          "clientMetadataUrl must be an HTTPS URL with a path",
        );
      }
    }
  }

  async listServers(): Promise<McpServerInfo[]> {
    return [...this.#servers.values()].map((s) => this.#info(s));
  }

  /** Server info plus tools, warnings and diagnostics (for the directory and settings UI). */
  describe(serverId: string): McpServerDetails {
    const s = this.#get(serverId);
    const d: McpServerDetails = {
      ...this.#info(s),
      tools: structuredClone(s.tools),
      warnings: [...s.warnings],
      stderrTail: this.#redact(s.stderr),
    };
    if (s.era !== undefined) d.era = s.era;
    if (s.error !== undefined) {
      d.error = this.#redact(s.error);
      d.errorProvenance = "untrusted";
    }
    if (s.launch !== undefined || s.config.transport.kind === "stdio") {
      const l = this.#launcherFor(s.config.trust);
      if (l !== undefined) d.isolation = l.isolation;
    }
    return d;
  }

  async addServer(config: McpServerConfig): Promise<McpServerInfo> {
    const cfg = structuredClone(config) as PsycheMcpServerConfig;
    this.#validate(cfg);
    if (this.#servers.has(cfg.id)) throw new PsycheError("conflict", `server ${cfg.id} exists`);
    const state: ServerState = {
      config: cfg,
      status: "disconnected",
      tools: [],
      rawTools: [],
      warnings: [],
      stderr: "",
      generation: 0,
      listSeq: 0,
      inFlight: 0,
      restartable: false,
      restartFailures: 0,
      stop: new AbortController(),
      launching: new Set(),
      deaths: 0,
      nextRestartAt: 0,
      connectedAt: 0,
    };
    this.#servers.set(cfg.id, state);
    await this.connect(cfg.id);
    return this.#info(state);
  }

  /** (Re)connect a configured server. Failures leave it in `error` with a message. */
  async connect(serverId: string, signal?: AbortSignal): Promise<McpServerInfo> {
    const s = this.#get(serverId);
    // An explicit reconnect clears the crash-loop state.
    s.restartFailures = 0;
    s.nextRestartAt = 0;
    return this.#connect(s, signal);
  }

  async #connect(s: ServerState, callerSignal?: AbortSignal): Promise<McpServerInfo> {
    const serverId = s.config.id;
    // The caller's cancel, or the host's own when the server is removed or the host closes.
    const signal =
      callerSignal === undefined ? s.stop.signal : AbortSignal.any([callerSignal, s.stop.signal]);
    this.#clearIdle(s);
    s.restartable = false;
    s.generation += 1;
    const generation = s.generation;
    // A newer connect, a removal or the host's close drops this start's result.
    const superseded = () => s.removed === true || this.#closed || s.generation !== generation;
    await this.#disconnect(s);
    try {
      const client =
        s.config.transport.kind === "stdio"
          ? await this.#connectStdio(s, signal)
          : await this.#connectHttp(s, signal);
      if (superseded()) {
        // A newer connect or a removal superseded this one: do not leak the client / process.
        await client.close().catch(() => undefined);
        const own = this.#launchOf.get(client);
        if (own !== undefined) {
          if (s.launch === own) delete s.launch;
          await own.cleanup?.().catch(() => undefined);
        }
        return this.#info(s);
      }
      client.onclose = () => {
        if (s.client !== client) return;
        delete s.client;
        this.#clearIdle(s);
        if (s.config.transport.kind === "stdio" && s.removed !== true && !this.#closed) {
          // The process died on its own: the next call may start it again, within the bounds.
          s.deaths += 1;
          if (Date.now() - s.connectedAt >= HEALTHY_RUN_MS) s.restartFailures = 0;
          else s.restartFailures += 1;
          this.#armRestart(s);
        }
        s.status = "disconnected";
        this.#emit({ type: "status", serverId, status: "disconnected" });
      };
      s.client = client;
      s.era = client.getProtocolEra();
      const version = client.getNegotiatedProtocolVersion();
      if (version !== undefined) s.protocolVersion = version;
      s.status = "connected";
      s.connectedAt = Date.now();
      delete s.error;
      this.#emit({ type: "status", serverId, status: "connected" });
      await this.#refresh(s, signal);
      this.#touch(s);
    } catch (err) {
      if (superseded()) return this.#info(s);
      await this.#disconnect(s);
      s.status = "error";
      s.error = untrustedText(errorMessage(err));
      this.#emit({ type: "status", serverId, status: "error", error: s.error });
    }
    return this.#info(s);
  }

  async removeServer(serverId: string): Promise<void> {
    const s = this.#servers.get(serverId);
    if (s === undefined) return;
    this.#servers.delete(serverId);
    s.removed = true;
    // Nothing may start it again, not even a call already waiting on the wake below.
    s.restartable = false;
    s.generation += 1;
    this.#clearIdle(s);
    // A start still running gives up (its connect is aborted) and is cleaned up as superseded.
    s.stop.abort();
    await s.waking?.catch(() => undefined);
    await this.#disconnect(s);
    // `forget` comes after the launcher's own steps have settled, or a late one could recreate
    // the egress allowlist / volume that `forget` drops (TM-18).
    await Promise.all([...s.launching]);
    if (s.config.transport.kind === "http") {
      await this.#options.oauth?.tokenStore.clear(tokenKey(s.config.id, s.config.transport.url));
    } else {
      // A replacement config with the same id must not inherit this server's sandbox state
      // (its /workspace volume, its egress allowlist; #284 TM-18).
      await this.#launcherFor(s.config.trust)
        ?.forget?.(serverId)
        .catch(() => undefined);
    }
  }

  /** Fetches `tools/list` from the server (never a cache) and pins it. */
  async listTools(serverId: string): Promise<McpToolList> {
    const s = await this.#ready(serverId);
    await this.#track(s, () => this.#refresh(s));
    return { tools: this.#specs(s), toolsListHash: s.hash as Sha256 };
  }

  /** The pinned listing as ToolSpecs, without a round trip (also while the server is stopped). */
  pinnedTools(serverId: string): McpToolList {
    const s = this.#get(serverId);
    if (s.hash === undefined || !(s.restartable || this.#isUp(s))) this.#connected(serverId);
    return { tools: this.#specs(s), toolsListHash: s.hash as Sha256 };
  }

  async callTool(
    serverId: string,
    tool: string,
    args: unknown,
    options: McpCallOptions,
  ): Promise<McpToolResult> {
    if (options.signal?.aborted === true) throw new PsycheError("cancelled", "call aborted");
    const s = await this.#ready(serverId, options.signal);
    if (options.toolsListHash !== s.hash) {
      throw new PsycheError("conflict", "tools/list changed since approval (rug pull defense)", {
        details: { expected: options.toolsListHash, current: s.hash },
      });
    }
    const def = s.tools.find((t) => t.name === tool);
    if (def === undefined)
      throw new PsycheError("not_found", `tool ${tool} not found on ${serverId}`);
    if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
      throw new PsycheError("invalid_params", "MCP tool arguments must be an object");
    }
    const provenance = provenanceFor(s.config.trust);
    s.inFlight += 1;
    try {
      const result = await (s.client as Client).callTool(
        { name: tool, arguments: (args ?? {}) as Record<string, unknown> },
        {
          toolDefinition: def,
          timeout: this.#options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
      );
      // Redact before capping, so truncation cannot cut a secret into unmatchable halves.
      return {
        content: this.#cap(
          redactDeep(
            {
              blocks: Array.isArray(result.content) ? result.content : [],
              ...(result.structuredContent === undefined ||
              repeatsStructured(result.content, result.structuredContent)
                ? {}
                : { structured: result.structuredContent }),
            },
            this.#redact,
          ),
        ),
        isError: result.isError === true,
        provenance,
      };
    } catch (err) {
      // A JSON-RPC error is server-authored text: hand it back as a tool error carrying the
      // server's provenance (never as a PsycheError message), so it stays data. Invalid input
      // (SEP-1303, -32602) is thereby a tool error the model can correct.
      const sdk = loadedMcpSdk();
      if (sdk !== undefined && err instanceof sdk.ProtocolError) {
        return {
          content: {
            blocks: [
              {
                type: "text",
                text: `MCP error ${err.code}: ${this.#redact(untrustedText(err.message))}`,
              },
            ],
          },
          isError: true,
          provenance,
        };
      }
      if (err instanceof PsycheError && err.code === "unauthorized") {
        s.status = "error";
        s.error = "re-authorization required; reconnect the server";
        this.#emit({ type: "status", serverId, status: "error", error: s.error });
      }
      throw toPsycheError(err);
    } finally {
      s.inFlight -= 1;
      this.#touch(s);
    }
  }

  /** `ui://` resources declared by tools (MCP Apps), for the UI's sandboxed frame. */
  appResources(serverId: string): { tool: string; resourceUri: string }[] {
    const s = this.#get(serverId);
    const out: { tool: string; resourceUri: string }[] = [];
    for (const t of s.tools) {
      const uri = appResourceUri(t);
      if (uri !== undefined) out.push({ tool: t.name, resourceUri: uri });
    }
    return out;
  }

  /**
   * Read an MCP App resource. Only `ui://` URIs declared by a pinned tool are served; the HTML is
   * untrusted and must render in a sandboxed frame with the declared CSP (the UI owns that).
   */
  async readAppResource(
    serverId: string,
    uri: string,
    signal?: AbortSignal,
  ): Promise<McpAppResource> {
    const s = await this.#ready(serverId, signal);
    if (!uri.startsWith("ui://") || !s.tools.some((t) => appResourceUri(t) === uri)) {
      throw new PsycheError("forbidden", "not a ui:// resource declared by this server's tools");
    }
    s.inFlight += 1;
    try {
      const res = await (s.client as Client).readResource(
        { uri },
        { cacheMode: "bypass", ...(signal === undefined ? {} : { signal }) },
      );
      const item = res.contents.find((c) => c.uri === uri && "text" in c);
      if (item === undefined || !("text" in item)) {
        throw new PsycheError("not_found", "app resource has no HTML text");
      }
      if (item.text.length > MAX_APP_HTML_CHARS) {
        throw new PsycheError("invalid_params", "app resource is too large");
      }
      const ui = ((item._meta as Record<string, unknown> | undefined)?.ui ?? {}) as Record<
        string,
        unknown
      >;
      return {
        serverId,
        uri,
        mimeType: item.mimeType ?? APP_MIME,
        html: this.#redact(item.text),
        csp: (ui.csp as Record<string, unknown> | undefined) ?? {},
        permissions: (ui.permissions as Record<string, unknown> | undefined) ?? {},
        toolsListHash: s.hash as Sha256,
        provenance: "untrusted",
      };
    } catch (err) {
      throw toPsycheError(err);
    } finally {
      s.inFlight -= 1;
      this.#touch(s);
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    const all = [...this.#servers.values()];
    for (const s of all) {
      // A start in flight is superseded: it closes its own client and cleans up its own launch.
      s.generation += 1;
      s.restartable = false;
      this.#clearIdle(s);
      // A start in flight gives up now rather than holding the Gateway's shutdown; a launcher
      // step that cannot be aborted is cleaned up when it settles (`#launchStep`).
      s.stop.abort();
    }
    await Promise.all(
      all.map(async (s) => {
        await s.waking?.catch(() => undefined);
        await this.#disconnect(s);
      }),
    );
  }

  // --- internals ------------------------------------------------------------------------------

  #validate(cfg: PsycheMcpServerConfig): void {
    if (!isValidServerId(cfg.id)) {
      throw new PsycheError("invalid_params", "server id must match [a-z0-9][a-z0-9_-]* (no '__')");
    }
    if (!["bundled", "verified", "unknown"].includes(cfg.trust)) {
      throw new PsycheError("invalid_params", "unknown trust tier");
    }
    if (cfg.trust === "bundled" && !this.#bundled.has(cfg.id)) {
      throw new PsycheError("policy_denied", `${cfg.id} is not a bundled server`);
    }
    if (cfg.transport.kind === "stdio") {
      if (cfg.transport.command.length === 0)
        throw new PsycheError("invalid_params", "empty command");
      for (const a of cfg.transport.command) assertNoPlaceholders(a, "the command line");
      if (cfg.cwd !== undefined) assertNoPlaceholders(cfg.cwd, "cwd");
    } else {
      assertNoPlaceholders(cfg.transport.url, "the server URL");
      const url = new URL(cfg.transport.url);
      const loopback =
        url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
      if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
        throw new PsycheError("invalid_params", "remote MCP servers must use https");
      }
      if (url.username !== "" || url.password !== "") {
        throw new PsycheError("invalid_params", "credentials in the server URL are not allowed");
      }
    }
  }

  #launcherFor(trust: McpTrustTier): StdioLauncher | undefined {
    if (trust === "bundled") return this.#options.bundledLauncher ?? this.#options.launcher;
    return this.#options.launcher;
  }

  /** After `loadMcpSdk()`: both connect paths load it first. */
  #newClient(s: ServerState): Client {
    const sdk = loadedMcpSdk();
    if (sdk === undefined) throw new PsycheError("internal", "MCP SDK not loaded");
    const elicit = this.#options.inputRequester;
    const client = new sdk.Client(
      this.#options.clientInfo ?? { name: "psyche", version: "0.0.0" },
      {
        versionNegotiation: { mode: "auto" },
        // A server that keeps asking cannot stall a turn.
        inputRequired: { maxRounds: MAX_INPUT_ROUNDS },
        // No roots, sampling or logging (deprecated in 2026-07-28); elicitation only when the owner
        // can be asked.
        capabilities: elicit === undefined ? {} : { elicitation: { form: {}, url: {} } },
        listChanged: {
          tools: {
            onChanged: (error, tools) => {
              if (error === null && tools !== null) {
                s.listSeq += 1;
                this.#pin(s, tools);
              } else void this.#refresh(s).catch(() => undefined);
            },
          },
        },
      },
    );
    if (elicit !== undefined) {
      client.setRequestHandler("elicitation/create", async (request) => {
        const p = request.params as Record<string, unknown>;
        const mode = p.mode === "url" ? "url" : "form";
        const req: McpInputRequest = {
          serverId: s.config.id,
          mode,
          message: String(p.message ?? ""),
          provenance: "untrusted",
        };
        if (mode === "url" && typeof p.url === "string") req.url = p.url;
        if (
          mode === "form" &&
          typeof p.requestedSchema === "object" &&
          p.requestedSchema !== null
        ) {
          req.requestedSchema = p.requestedSchema as Record<string, unknown>;
        }
        const answer = await elicit(req);
        return answer.content === undefined
          ? { action: answer.action }
          : { action: answer.action, content: answer.content };
      });
    }
    return client;
  }

  async #connectStdio(s: ServerState, signal?: AbortSignal): Promise<Client> {
    await loadMcpSdk();
    const { getDefaultEnvironment, StdioClientTransport } = await loadMcpStdioSdk();
    const t = s.config.transport;
    if (t.kind !== "stdio") throw new PsycheError("internal", "not stdio");
    const launcher = this.#launcherFor(s.config.trust);
    if (launcher === undefined || (launcher.isolation === "none" && s.config.trust !== "bundled")) {
      throw new PsycheError(
        "unavailable",
        "no sandbox launcher for stdio MCP servers (srt or the sandbox container is required)",
      );
    }
    const env = await resolveEnv(s.config.id, t.env ?? {}, this.#options.secrets, signal);
    const spec: StdioLaunchSpec = {
      serverId: s.config.id,
      trust: s.config.trust,
      command: t.command,
      env: { ...getDefaultEnvironment(), ...env },
      serverEnv: env,
      ...(s.config.cwd === undefined ? {} : { cwd: s.config.cwd }),
      sandbox: {
        allowedDomains: s.config.sandbox?.allowedDomains ?? [],
        ...(s.config.sandbox?.allowRead === undefined
          ? {}
          : { allowRead: s.config.sandbox.allowRead }),
        allowWrite: s.config.sandbox?.allowWrite ?? [],
        denyRead: s.config.sandbox?.denyRead ?? [],
      },
    };
    if (launcher.open !== undefined) {
      // The launcher starts the process itself (sandbox container) and hands over its pipes.
      const opened = await this.#launchStep(s, launcher.open(spec, signal), signal, async (o) => {
        await o.transport.close().catch(() => undefined);
        await o.cleanup?.();
      });
      const launch: { cleanup?: () => Promise<void> } =
        opened.cleanup === undefined ? {} : { cleanup: opened.cleanup };
      s.launch = launch;
      opened.stderr?.on("data", (chunk: Buffer) => {
        s.stderr = (s.stderr + chunk.toString("utf8")).slice(-STDERR_TAIL);
      });
      return this.#startClient(s, launch, () => opened.transport, signal);
    }
    if (launcher.prepare === undefined) {
      throw new PsycheError("internal", "launcher has neither prepare nor open");
    }
    const launch = await this.#launchStep(s, launcher.prepare(spec), signal, async (l) => {
      await l.cleanup?.();
    });
    s.launch = launch;
    return this.#startClient(
      s,
      launch,
      () => {
        const transport = new StdioClientTransport({
          command: launch.command,
          args: launch.args,
          env: launch.env,
          stderr: "pipe",
          ...(launch.cwd === undefined ? {} : { cwd: launch.cwd }),
        });
        transport.stderr?.on("data", (chunk: Buffer) => {
          s.stderr = (s.stderr + chunk.toString("utf8")).slice(-STDERR_TAIL);
        });
        return transport;
      },
      signal,
    );
  }

  /**
   * A launcher step (`prepare`, `open`), which launchers may not abort themselves. On an abort the
   * start gives up at once; the step's late result is then cleaned up when it arrives. Each step
   * stays in `s.launching` until it has settled and been cleaned up, so `removeServer` can wait
   * for it before `forget`.
   */
  #launchStep<T>(
    s: ServerState,
    step: Promise<T>,
    signal: AbortSignal | undefined,
    cleanup: (late: T) => Promise<void>,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let abandoned = false;
      const onAbort = () => {
        abandoned = true;
        reject(new PsycheError("cancelled", "launch aborted"));
      };
      const settled = step.then(
        async (value) => {
          signal?.removeEventListener("abort", onAbort);
          if (abandoned) await cleanup(value).catch(() => undefined);
          else resolve(value);
        },
        (err: unknown) => {
          signal?.removeEventListener("abort", onAbort);
          reject(err);
        },
      );
      s.launching.add(settled);
      void settled.then(() => s.launching.delete(settled));
      if (signal?.aborted === true) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * Connects a client over a launch's transport. A failed connect closes the client and cleans
   * up its own launch: the caller may have been superseded meanwhile and no longer owns it.
   */
  async #startClient(
    s: ServerState,
    launch: { cleanup?: () => Promise<void> },
    transport: () => Parameters<Client["connect"]>[0],
    signal?: AbortSignal,
  ): Promise<Client> {
    let client: Client | undefined;
    let t: Parameters<Client["connect"]>[0] | undefined;
    try {
      client = this.#newClient(s);
      this.#launchOf.set(client, launch);
      t = transport();
      await client.connect(t, this.#requestOptions(signal));
      return client;
    } catch (err) {
      await client?.close().catch(() => undefined);
      await t?.close().catch(() => undefined);
      if (s.launch === launch) delete s.launch;
      await launch.cleanup?.().catch(() => undefined);
      throw err;
    }
  }

  async #connectHttp(s: ServerState, signal?: AbortSignal): Promise<Client> {
    const { StreamableHTTPClientTransport, UnauthorizedError } = await loadMcpSdk();
    const t = s.config.transport;
    if (t.kind !== "http") throw new PsycheError("internal", "not http");
    const url = new URL(t.url);
    const baseFetch: FetchLike = this.#options.fetch ?? ((u, init) => fetch(u, init));
    const auth =
      s.config.auth ?? (this.#options.oauth === undefined ? { kind: "none" } : { kind: "oauth" });

    if (auth.kind === "bearer") {
      // An origin-bound vault item, sent like a connector's Authorization header (security
      // §4.6, §11): `#validate` already limits remote servers to https (loopback excepted).
      const injection = this.#options.secrets;
      if (injection === undefined)
        throw new PsycheError("unavailable", "no credential broker configured");
      const target = { kind: "origin" as const, value: url.origin };
      const approvalId = await injection.approve({
        serverId: s.config.id,
        placeholder: auth.credential,
        envName: "Authorization",
        target,
      });
      // The vault binding pins the token to this origin; it lives only in this connection.
      const handle = await injection.credentials.resolve(auth.credential, target, approvalId, {
        executor: "connector",
      });
      const token = handle.use((v) => v);
      const client = this.#newClient(s);
      await client.connect(
        new StreamableHTTPClientTransport(url, {
          fetch: baseFetch,
          authProvider: { token: async () => token },
        }),
        this.#requestOptions(signal),
      );
      return client;
    }

    if (auth.kind === "none") {
      const client = this.#newClient(s);
      await client.connect(
        new StreamableHTTPClientTransport(url, { fetch: baseFetch }),
        this.#requestOptions(signal),
      );
      return client;
    }

    const oauth = this.#options.oauth;
    if (oauth === undefined)
      throw new PsycheError("unavailable", "OAuth is not configured on this host");
    const provider = new PsycheOAuthProvider(tokenKey(s.config.id, t.url), oauth, {
      ...(auth.clientId === undefined ? {} : { clientId: auth.clientId }),
      ...(auth.scopes === undefined ? {} : { scopes: auth.scopes }),
    });
    const loopback = await startLoopbackReceiver(() => provider.expectedState);
    provider.setRedirectUrl(loopback.redirectUrl);
    provider.armed = true;
    const fetchFn = blockRegistration(baseFetch, provider);
    const transportFor = () =>
      new StreamableHTTPClientTransport(url, { fetch: fetchFn, authProvider: provider });
    try {
      const first = transportFor();
      try {
        const client = this.#newClient(s);
        await client.connect(first, this.#requestOptions(signal));
        return client;
      } catch (err) {
        if (!(err instanceof UnauthorizedError) || provider.authorizationUrl === undefined)
          throw err;
      }
      this.#emit({
        type: "auth_required",
        serverId: s.config.id,
        authorizationUrl: provider.authorizationUrl.href,
      });
      const params = await loopback.wait(provider.timeoutMs, signal);
      await first.finishAuth(params);
      const client = this.#newClient(s);
      await client.connect(transportFor(), this.#requestOptions(signal));
      return client;
    } finally {
      // Later re-authorization (a refresh that fails mid-call) has no receiver: the provider
      // refuses to open the browser and the call fails `unauthorized` instead of hanging.
      provider.armed = false;
      await loopback.close();
    }
  }

  #requestOptions(signal?: AbortSignal) {
    return {
      timeout: this.#options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...(signal === undefined ? {} : { signal }),
    };
  }

  async #refresh(s: ServerState, signal?: AbortSignal): Promise<void> {
    const client = s.client;
    if (client === undefined)
      throw new PsycheError("unavailable", `server ${s.config.id} is not connected`);
    try {
      s.listSeq += 1;
      const seq = s.listSeq;
      const { tools } = await client.listTools(undefined, {
        cacheMode: "refresh",
        ...this.#requestOptions(signal),
      });
      // A slower, older response must not re-pin over a newer listing.
      if (seq === s.listSeq && s.client === client) this.#pin(s, tools);
    } catch (err) {
      throw toPsycheError(err);
    }
  }

  #pin(s: ServerState, tools: Tool[]): void {
    // The hash covers the raw listing, so any change (including to dropped tools) revokes.
    const hash = toolsListHash(tools);
    if (hash === s.hash) return;
    const previous = s.rawTools;
    const previousHash = s.hash;
    const { usable, rejected } = usableTools(s.config.id, tools);
    s.rawTools = structuredClone(tools);
    s.tools = structuredClone(usable);
    s.hash = hash;
    s.warnings = [...rejected, ...usable.flatMap(inspectTool)];
    this.#emit({
      type: "tools_changed",
      serverId: s.config.id,
      previousHash,
      hash,
      changes: diffTools(previous, tools),
      warnings: s.warnings,
    });
  }

  #specs(s: ServerState): ToolSpec[] {
    return s.tools.map((t) => ({
      name: mcpToolName(s.config.id, t.name),
      description: [t.title, t.description].filter((x) => x !== undefined && x !== "").join(": "),
      inputSchema: (t.inputSchema ?? { type: "object" }) as Record<string, unknown>,
      sideEffect: sideEffectFor(t, s.config.trust, {
        ...(s.config.handlesMoney === undefined ? {} : { handlesMoney: s.config.handlesMoney }),
      }),
      provenanceOut: provenanceFor(s.config.trust),
      // The description and schema text are the server's words: untrusted unless the server
      // ships with Psyche (security §11, #281).
      descriptionProvenance: provenanceFor(s.config.trust),
    }));
  }

  /** Tools whose `_meta` demands a prompt on every call (never a standing grant). */
  requiresUserInteraction(serverId: string, tool: string): boolean {
    const t = this.#get(serverId).tools.find((x) => x.name === tool);
    return t !== undefined && requiresUserInteraction(t);
  }

  #cap(input: McpCallContent): McpCallContent {
    let content = input;
    const max = this.#options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;
    // A picture is sent as an image part, not as text: it costs the model a few thousand tokens,
    // whatever its bytes, so it counts a flat amount here.
    const sizeOf = (b: unknown): number => {
      const isImage = (b as { type?: unknown } | null)?.type === "image";
      return isImage ? IMAGE_BLOCK_BYTES : Buffer.byteLength(JSON.stringify(b));
    };
    // Images get their own budget: a count and a total of base64 characters (the loop re-checks).
    let images = 0;
    let imageChars = 0;
    let droppedImages = 0;
    const kept = content.blocks.filter((b) => {
      if ((b as { type?: unknown } | null)?.type !== "image") return true;
      const len = String((b as { data?: unknown }).data ?? "").length;
      if (images >= MAX_IMAGE_BLOCKS || imageChars + len > MAX_IMAGE_BLOCK_CHARS) {
        droppedImages++;
        return false;
      }
      images++;
      imageChars += len;
      return true;
    });
    if (droppedImages > 0) {
      content = {
        ...content,
        blocks: [
          ...kept,
          {
            type: "text",
            text: `[${droppedImages} image(s) omitted: over the per-result image limit]`,
          },
        ],
      };
    }
    const rest = Buffer.byteLength(JSON.stringify({ ...content, blocks: [] }));
    if (content.blocks.reduce((n: number, b: unknown) => n + sizeOf(b), rest) <= max)
      return content;
    const out: McpCallContent = { blocks: [], truncated: true };
    let used = 0;
    for (const b of content.blocks) {
      const size = sizeOf(b);
      if (used + size > max) break;
      out.blocks.push(b);
      used += size;
    }
    out.blocks.push({ type: "text", text: `[result truncated at ${max} bytes]` });
    return out;
  }

  async #disconnect(s: ServerState): Promise<void> {
    // Take both before awaiting: a restart that begins meanwhile sets its own, which this stop
    // must not touch.
    const generation = s.generation;
    const client = s.client;
    const launch = s.launch;
    delete s.client;
    delete s.launch;
    if (client !== undefined) await client.close().catch(() => undefined);
    await launch?.cleanup?.().catch(() => undefined);
    // A slow stop (the SDK waits up to 4s for a process that ignores EOF) must not mark a
    // connection that started meanwhile as disconnected.
    if (s.generation !== generation && s.client !== undefined) return;
    if (s.status === "connected") {
      s.status = "disconnected";
      this.#emit({ type: "status", serverId: s.config.id, status: "disconnected" });
    }
  }

  #isUp(s: ServerState): boolean {
    return s.status === "connected" && s.client !== undefined && s.hash !== undefined;
  }

  /** Runs `fn` as activity: the server is not idle-stopped while it runs. */
  async #track<T>(s: ServerState, fn: () => Promise<T>): Promise<T> {
    s.inFlight += 1;
    try {
      return await fn();
    } finally {
      s.inFlight -= 1;
      this.#touch(s);
    }
  }

  #clearIdle(s: ServerState): void {
    if (s.idleTimer !== undefined) clearTimeout(s.idleTimer);
    delete s.idleTimer;
  }

  /** Re-arms the idle timer after activity. Only a connected stdio server without `keepAlive` has one. */
  #touch(s: ServerState): void {
    this.#clearIdle(s);
    const ms = this.#options.idleStopMs ?? DEFAULT_IDLE_STOP_MS;
    if (ms <= 0 || this.#closed || s.removed === true || this.#neverIdleStop(s.config)) return;
    if (s.config.transport.kind !== "stdio" || !this.#isUp(s)) return;
    const timer = setTimeout(() => {
      delete s.idleTimer;
      void this.#idleStop(s);
    }, ms);
    timer.unref?.();
    s.idleTimer = timer;
  }

  async #idleStop(s: ServerState): Promise<void> {
    if (s.removed === true || this.#closed || !this.#isUp(s)) return;
    // The Gateway's view can change after the start (a bundle record appears): look again.
    if (this.#neverIdleStop(s.config)) return;
    // Never under a running call: look again once it has finished.
    if (s.inFlight > 0 || s.waking !== undefined) {
      this.#touch(s);
      return;
    }
    // The pinned listing and hash stay; only the process goes.
    s.restartable = true;
    s.restartFailures = 0;
    s.nextRestartAt = 0;
    s.generation += 1;
    await this.#disconnect(s);
  }

  /** After a crash or a failed restart: allow another start after a backoff, or give up. */
  #armRestart(s: ServerState): void {
    if (s.removed === true || this.#closed || this.#neverAutoStart(s.config)) {
      s.restartable = false;
      return;
    }
    const max = this.#options.restart?.maxAttempts ?? DEFAULT_RESTART_ATTEMPTS;
    if (s.restartFailures >= max) {
      // A crash loop: down for the cool-down, then the next call may try once more (one more
      // failure starts another cool-down). Editing or re-adding the server starts it at once.
      const cooldown = this.#options.restart?.cooldownMs ?? DEFAULT_RESTART_COOLDOWN_MS;
      s.restartable = true;
      s.restartFailures = max - 1;
      s.nextRestartAt = Date.now() + cooldown;
      s.error = untrustedText(
        `failed to start ${max} times in a row; it tries again in ${waitText(cooldown)}, or edit or re-add the server to start it now`,
      );
      return;
    }
    const base = this.#options.restart?.baseMs ?? DEFAULT_RESTART_BASE_MS;
    const cap = this.#options.restart?.maxMs ?? DEFAULT_RESTART_MAX_MS;
    s.restartable = true;
    s.nextRestartAt =
      s.restartFailures === 0 ? 0 : Date.now() + Math.min(cap, base * 2 ** (s.restartFailures - 1));
  }

  /**
   * A connected server for a call. A stdio server that was idle-stopped (or died) is started
   * again first, and its listing is fetched and compared with the pinned one in `#connect`: a
   * change emits `tools_changed` (grants revoked) and the caller's old hash then fails `conflict`.
   */
  async #ready(serverId: string, signal?: AbortSignal): Promise<ServerState> {
    if (this.#closed) throw new PsycheError("unavailable", "the MCP host is closed");
    const s = this.#get(serverId);
    // A restart in flight has set `client` already but has not compared the listing yet: no
    // call runs until it has.
    if (s.waking !== undefined) {
      await s.waking;
      // Removed or closed while this call waited: it must not start the server again.
      this.#assertLive(s);
    }
    if (!this.#isUp(s) && s.restartable && s.config.transport.kind === "stdio") {
      await this.#wake(s, signal);
      this.#assertLive(s);
    }
    // This server, not a replacement added under the same id meanwhile.
    return this.#connectedState(s);
  }

  /** Throws once the server was removed or the host closed. */
  #assertLive(s: ServerState): void {
    if (this.#closed) throw new PsycheError("unavailable", "the MCP host is closed");
    if (s.removed === true) throw new PsycheError("not_found", `server ${s.config.id} not found`);
  }

  async #wake(s: ServerState, signal?: AbortSignal): Promise<void> {
    if (s.waking !== undefined) return s.waking;
    this.#assertLive(s);
    // The Gateway's view can change while the server is stopped (a bundle record appears under
    // its id): a server it must check before every start is not started here. `restartable` stays
    // as it is, so a check that fails only for a moment (an unreadable ledger) strands nothing.
    if (this.#neverAutoStart(s.config)) {
      throw new PsycheError(
        "unavailable",
        `server ${s.config.id} is stopped and starts again only through Psyche's checks; edit or re-add it`,
      );
    }
    if (Date.now() < s.nextRestartAt) {
      throw new PsycheError(
        "unavailable",
        `server ${s.config.id} keeps failing to start; it tries again in ${waitText(s.nextRestartAt - Date.now())}, or edit or re-add the server to start it now`,
        { retryable: true },
      );
    }
    const run = (async () => {
      const deaths = s.deaths;
      try {
        await this.#connect(s, signal);
        if (s.removed === true || this.#closed) {
          s.restartable = false;
          return;
        }
        if (this.#isUp(s)) return;
        // A death after connecting was counted (and the restart armed) by `onclose`, which may
        // also have given up: neither a cancel nor this start may count it again or undo that.
        if (s.deaths !== deaths) return;
        if (signal?.aborted === true) {
          // A cancelled turn is not a crash: leave the server startable.
          s.restartable = !this.#neverAutoStart(s.config);
          return;
        }
        if (s.status === "error") s.restartFailures += 1;
        this.#armRestart(s);
      } finally {
        delete s.waking;
      }
    })();
    s.waking = run;
    return run;
  }

  #get(serverId: string): ServerState {
    const s = this.#servers.get(serverId);
    if (s === undefined) throw new PsycheError("not_found", `server ${serverId} not found`);
    return s;
  }

  #connected(serverId: string): ServerState {
    return this.#connectedState(this.#get(serverId));
  }

  #connectedState(s: ServerState): ServerState {
    if (!this.#isUp(s)) {
      throw new PsycheError("unavailable", `server ${s.config.id} is not connected`, {
        retryable: true,
      });
    }
    return s;
  }

  /**
   * Servers the host never restarts by itself (idle stop or crash). A Psyche-made or shared-bundle
   * server starts only after the Gateway re-checks its code (`filesHash`, the bundle record), which
   * a restart here would skip; the Gateway's `neverAutoStart` adds whatever else its start path
   * checks. A server with `{{cred:` env asks the owner for each secret at every start, so a
   * restart would raise those cards again. An unpinned package runner (`npx -y pkg`) could fetch
   * a newly published release on every restart.
   */
  #neverAutoStart(config: PsycheMcpServerConfig): boolean {
    if (config.madeBy !== undefined || config.bundle !== undefined) return true;
    const t = config.transport;
    if (t.kind === "stdio") {
      if (Object.values(t.env ?? {}).some((v) => v.includes("{{cred:"))) return true;
      if (reResolvesOnLaunch(t.command)) return true;
    }
    try {
      return this.#options.neverAutoStart?.(config) === true;
    } catch {
      // A check that cannot answer keeps the server running rather than restarting it unchecked.
      return true;
    }
  }

  /** Never idle-stopped: the above, and servers the owner marked `keepAlive`. */
  #neverIdleStop(config: PsycheMcpServerConfig): boolean {
    return config.keepAlive === true || this.#neverAutoStart(config);
  }

  #info(s: ServerState): McpServerInfo {
    const info: McpServerInfo = {
      id: s.config.id,
      name: s.config.name,
      trust: s.config.trust,
      status: s.status,
    };
    if (s.protocolVersion !== undefined) info.protocolVersion = s.protocolVersion;
    if (s.hash !== undefined) info.toolsListHash = s.hash;
    return info;
  }

  #emit(event: McpHostEvent): void {
    try {
      this.#options.onEvent?.(event);
    } catch {
      // listeners never break the host
    }
  }
}

/** A wait as words for a diagnostic: "45 seconds", "10 minutes". */
function waitText(ms: number): string {
  if (ms < 60_000) {
    const sec = Math.max(1, Math.ceil(ms / 1000));
    return sec === 1 ? "1 second" : `${sec} seconds`;
  }
  const min = Math.ceil(ms / 60_000);
  return min === 1 ? "1 minute" : `${min} minutes`;
}

export const APP_MIME = "text/html;profile=mcp-app";
const MAX_APP_HTML_CHARS = 2 * 1024 * 1024;

export interface McpAppResource {
  serverId: string;
  uri: string;
  mimeType: string;
  html: string;
  /** `_meta.ui.csp` as declared (connect / resource domains); the frame enforces it. */
  csp: Record<string, unknown>;
  permissions: Record<string, unknown>;
  toolsListHash: Sha256;
  provenance: "untrusted";
}

function appResourceUri(tool: Tool): string | undefined {
  const ui = (tool._meta as Record<string, unknown> | undefined)?.ui as
    | Record<string, unknown>
    | undefined;
  const uri = ui?.resourceUri;
  return typeof uri === "string" && uri.startsWith("ui://") ? uri : undefined;
}

/**
 * Tools whose registry name would be ambiguous are not callable: duplicates, names that collide
 * after `mcp__` sanitizing (`a.b` vs `a_b`), and names over 64 characters (SEP-986).
 */
function usableTools(serverId: string, tools: Tool[]): { usable: Tool[]; rejected: ToolWarning[] } {
  const byKey = new Map<string, Tool[]>();
  for (const t of tools) {
    const key = mcpToolName(serverId, t.name);
    byKey.set(key, [...(byKey.get(key) ?? []), t]);
  }
  const usable: Tool[] = [];
  const rejected: ToolWarning[] = [];
  for (const group of byKey.values()) {
    const first = group[0] as Tool;
    if (group.length > 1) {
      for (const t of group) {
        rejected.push({
          tool: t.name,
          code: "invalid_name",
          detail: "tool name collides with another tool",
        });
      }
    } else if (first.name.length === 0 || first.name.length > MAX_TOOL_NAME_LENGTH) {
      rejected.push({
        tool: first.name,
        code: "invalid_name",
        detail: "tool name is empty or too long",
      });
    } else {
      usable.push(first);
    }
  }
  return { usable, rejected };
}

/** Tokens are bound to the server id and its exact resource URL (a changed URL re-authorizes). */
function tokenKey(serverId: string, url: string): string {
  const u = new URL(url);
  return `${serverId}|${u.origin}${u.pathname}`;
}

/** Server-authored text kept for diagnostics: control characters removed, length capped. */
function untrustedText(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").slice(0, 500);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toPsycheError(err: unknown): PsycheError {
  if (err instanceof PsycheError) return err;
  const sdk = loadedMcpSdk();
  if (sdk !== undefined && err instanceof sdk.SdkError) {
    const SdkErrorCode = sdk.SdkErrorCode;
    if (err.code === SdkErrorCode.InputRequiredRoundsExceeded) {
      return new PsycheError("conflict", "server kept requesting input", { cause: err });
    }
    if (err.code === SdkErrorCode.RequestTimeout)
      return new PsycheError("timeout", err.message, { cause: err });
    if (err.code === SdkErrorCode.NotConnected || err.code === SdkErrorCode.ConnectionClosed) {
      return new PsycheError("unavailable", err.message, { cause: err, retryable: true });
    }
  }
  if (sdk !== undefined && err instanceof sdk.UnauthorizedError)
    return new PsycheError("unauthorized", err.message, { cause: err });
  if (err instanceof Error && err.name === "AbortError")
    return new PsycheError("cancelled", err.message);
  return new PsycheError("internal", errorMessage(err), { cause: err });
}

/** Every string in a JSON-like value through `redact`; other values unchanged. */
export function redactDeep<T>(value: T, redact: (text: string) => string): T {
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") return redact(v);
    if (depth > 64 || v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return v;
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x, depth + 1)]),
    );
  };
  return walk(value, 0) as T;
}
