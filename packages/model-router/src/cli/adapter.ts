import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  EMPTY_USAGE,
  type ModelCapabilities,
  type ModelEvent,
  type ModelProvider,
  type ModelRef,
  type ModelRequest,
  type Usage,
} from "@psyche/protocol";
import type { AdapterCallOptions, CallOutcome } from "../adapter.ts";
import { normalizeToolSchema, toolSchemaProblem } from "../compat.ts";
import type { ProviderConfig } from "../config.ts";
import { ModelCallError } from "../errors.ts";
import { parseModelRef } from "../refs.ts";
import { ToolNameMap, type ToolNameRule } from "../tool-names.ts";
import { BRIDGE_SCRIPT, type BridgeTool, type McpToolResult, ToolBridge } from "./bridge.ts";
import { type CliPrompt, type CliSessionEnvelope, cliPrompt } from "./prompt.ts";
import {
  cliChildPath,
  executable,
  knownCliDirs,
  type ResolveCliOptions,
  type ResolvedCli,
  resolveCli,
} from "./resolve.ts";
import { type CliItem, type CliLine, CliRun } from "./run.ts";

/** Where we looked, for the "not installed" message. */
export function notInstalled(dialect: CliDialect, command: string | undefined): string {
  const name = dialect.defaultCommand;
  if (command?.includes("/")) {
    return `${dialect.label} is not installed at ${command}`;
  }
  return `${dialect.label} is not installed: \`${name}\` was not found in PSYCHE_${name.toUpperCase()}_PATH, PATH, ${knownCliDirs("~").slice(0, 5).join(", ")} or the login shell's PATH`;
}

/**
 * `ModelProvider` over a subscription CLI (Claude Code `claude -p`, Codex `codex exec`): the
 * owner's own login and plan, no API key. One CLI process serves one agent turn; the CLI runs
 * its own model loop, and Psyche's tools reach it only through the MCP bridge, so every tool
 * call still goes through Psyche's agent loop and Permission Broker. A model call ends at the
 * CLI's tool calls (`finish{tool_calls}`, process kept alive); the next call with their results
 * resumes it. Each turn stores the CLI session id as an opaque `reasoning` envelope, and the
 * next turn resumes that session.
 */

/** What a dialect makes of one CLI output line. */
export interface ParseStep {
  events?: ModelEvent[];
  /** Psyche tool calls the model made (bridge tool names). */
  calls?: { id: string; name: string; input: unknown }[];
  usage?: Partial<Usage>;
  sessionId?: string;
  /** Codex: the session's new running usage totals. */
  totals?: CliSessionEnvelope["totals"];
  /** The model call ends here. */
  end?: "tool_calls" | "stop" | "length";
  error?: ModelCallError;
}

export interface CliParser {
  push(line: CliLine): ParseStep;
  /** Codex: tool calls are batched until the CLI is quiet for this long (ms). */
  readonly settleMs?: number;
  /** Calls seen but not yet ended into a segment. */
  pendingCalls(): boolean;
}

export interface StartSpec {
  args: string[];
  stdin: string[];
  /** Close stdin right after writing (Codex reads its prompt to EOF). */
  closeStdin: boolean;
  /** Files to write (0600) before the run and remove after it (Codex image attachments). */
  files?: { path: string; data: Uint8Array }[];
}

export interface CliDialect {
  readonly label: string;
  /** Executable looked up on PATH unless `config.command` is set. */
  readonly defaultCommand: string;
  /** Env vars removed from the CLI's environment so the subscription login is used. */
  readonly stripEnv: readonly string[];
  /** Extra env for the CLI process. */
  env(): Record<string, string>;
  start(input: {
    model: string | undefined;
    system: string | undefined;
    prompt: CliPrompt;
    /** The stdio MCP server to register as `psyche` (the relay and its 0600 config file). */
    bridge: { command: string; args: string[]; env: Record<string, string> };
    workdir: string;
  }): StartSpec;
  parser(toolPrefix: string, prompt: CliPrompt): CliParser;
  /** Map a non-zero exit (or spawn failure) to an error kind. */
  exitError(item: Extract<CliItem, { type: "exit" }>, command: string): ModelCallError;
}

/** Model-visible MCP tool names are `mcp__psyche__<name>`; keep the whole under 64. */
const CLI_TOOL_NAMES: ToolNameRule = { maxLength: 48, letterFirst: true };

export interface CliAdapterDeps {
  bridge?: ToolBridge;
  /** Base env for the CLI (default `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** How the CLI is found (tests: a home without the owner's bins, no login shell). */
  resolve?: Omit<ResolveCliOptions, "command" | "env">;
}

interface LiveRun {
  run: CliRun;
  names: ToolNameMap;
  parser: CliParser;
  channelId: string;
  configFile: string;
  modelId: string;
  tempFiles: string[];
  totals?: CliSessionEnvelope["totals"];
  idle?: ReturnType<typeof setTimeout>;
}

const DEFAULT_IDLE_MS = 300_000;
/** A run waiting on tool results (an approval can take a while) is killed after this. */
const DEFAULT_SUSPEND_MS = 4 * 60 * 60_000;

function toMcpResult(part: { output: unknown; isError?: boolean }): McpToolResult {
  const content: McpToolResult["content"] = [];
  const out = part.output;
  if (typeof out === "string") content.push({ type: "text", text: out });
  else if (
    Array.isArray(out) &&
    out.every(
      (p) =>
        typeof p === "object" &&
        p !== null &&
        ((p as { type?: unknown }).type === "text" || (p as { type?: unknown }).type === "image"),
    )
  ) {
    for (const p of out as { type: string; text?: string; mime?: string; data?: string }[]) {
      if (p.type === "text" && typeof p.text === "string")
        content.push({ type: "text", text: p.text });
      else if (p.type === "image" && typeof p.data === "string" && typeof p.mime === "string")
        content.push({ type: "image", data: p.data, mimeType: p.mime });
    }
  } else content.push({ type: "text", text: JSON.stringify(out ?? null) });
  if (content.length === 0) content.push({ type: "text", text: "" });
  return { content, ...(part.isError === true ? { isError: true } : {}) };
}

export class CliAdapter implements ModelProvider {
  readonly id: string;
  readonly config: ProviderConfig;
  readonly dialect: CliDialect;
  readonly #bridge: ToolBridge;
  readonly #env: NodeJS.ProcessEnv;
  readonly #resolveOpts: Omit<ResolveCliOptions, "command" | "env">;
  #resolved: ResolvedCli | undefined;
  /** Suspended runs by the CLI's tool-call id. */
  readonly #live = new Map<string, LiveRun>();

  constructor(config: ProviderConfig, dialect: CliDialect, deps: CliAdapterDeps = {}) {
    this.id = config.id;
    this.config = config;
    this.dialect = dialect;
    this.#bridge = deps.bridge ?? new ToolBridge();
    this.#env = deps.env ?? process.env;
    this.#resolveOpts = deps.resolve ?? {};
  }

  get command(): string {
    return this.#resolved?.path ?? this.config.command ?? this.dialect.defaultCommand;
  }

  /**
   * The CLI's path (#530): `config.command`, `PSYCHE_<NAME>_PATH`, PATH, the installers'
   * directories, then the login shell. Cached while the file is still there.
   */
  async resolveCommand(): Promise<ResolvedCli | undefined> {
    const cached = this.#resolved;
    if (cached !== undefined && executable(cached.path)) return cached;
    const command = this.config.command;
    this.#resolved = await resolveCli(this.dialect.defaultCommand, {
      ...this.#resolveOpts,
      env: this.#env,
      ...(command === undefined ? {} : { command }),
    });
    return this.#resolved;
  }

  workdir(): string {
    return this.config.workdir ?? join(tmpdir(), "psyche-cli", this.id);
  }

  async capabilities(model?: ModelRef): Promise<ModelCapabilities> {
    const modelId = model === undefined ? undefined : parseModelRef(model).model;
    const caps: ModelCapabilities = {
      toolCalling: true,
      vision: true,
      reasoning: true,
      embeddings: false,
      promptCaching: true,
    };
    const override = modelId === undefined ? undefined : this.config.models?.[modelId];
    return { ...caps, ...override };
  }

  /** Kill every suspended run and stop the bridge. */
  async close(): Promise<void> {
    for (const live of new Set(this.#live.values())) this.#finishRun(live);
    this.#live.clear();
    await this.#bridge.stop();
  }

  #finishRun(live: LiveRun, kill = true): void {
    clearTimeout(live.idle);
    for (const [id, l] of this.#live) if (l === live) this.#live.delete(id);
    this.#bridge.close(live.channelId);
    rmSync(live.configFile, { force: true });
    for (const f of live.tempFiles) rmSync(f, { force: true });
    live.run.endStdin();
    if (kill) live.run.kill();
  }

  /** The suspended run whose tool calls this request answers, if any. */
  #continuation(
    request: ModelRequest,
  ): { live: LiveRun; results: Map<string, McpToolResult> } | undefined {
    const results = new Map<string, McpToolResult>();
    let live: LiveRun | undefined;
    for (let i = request.messages.length - 1; i >= 0; i -= 1) {
      const m = request.messages[i];
      if (m?.role !== "tool") break;
      for (const p of m.parts) {
        if (p.type !== "tool_result") continue;
        const l = this.#live.get(p.callId);
        if (l === undefined) continue;
        if (live !== undefined && l !== live) continue;
        live = l;
        results.set(p.callId, toMcpResult(p));
      }
    }
    return live === undefined ? undefined : { live, results };
  }

  async #start(request: ModelRequest, modelId: string): Promise<LiveRun> {
    const workdir = this.workdir();
    mkdirSync(workdir, { recursive: true, mode: 0o700 });
    const names = ToolNameMap.for(request, CLI_TOOL_NAMES);
    const tools: BridgeTool[] = [];
    for (const t of request.tools ?? []) {
      const inputSchema = normalizeToolSchema(t.inputSchema);
      const problem = toolSchemaProblem({ name: t.name, inputSchema });
      if (problem !== undefined) throw new ModelCallError("bad_request", problem);
      tools.push({ name: names.toProvider(t.name), description: t.description, inputSchema });
    }
    let run: CliRun | undefined;
    const channel = await this.#bridge.open({
      tools,
      call: (name, args) => {
        if (run === undefined) return Promise.reject(new Error("the run has not started"));
        return run.mcpCall(name, args);
      },
    });
    const configFile = join(workdir, `.psyche-mcp-${channel.id}.json`);
    writeFileSync(configFile, JSON.stringify({ url: channel.url, token: channel.token }), {
      mode: 0o600,
    });
    const prompt = cliPrompt(request.messages, this.id);
    const model = modelId === "default" ? undefined : modelId;
    const spec = this.dialect.start({
      model,
      system: request.system,
      prompt,
      // The Gateway's own runtime runs the relay (Electron needs ELECTRON_RUN_AS_NODE).
      bridge: {
        command: process.execPath,
        args: [BRIDGE_SCRIPT, configFile],
        env: { ELECTRON_RUN_AS_NODE: "1" },
      },
      workdir,
    });
    for (const f of spec.files ?? []) writeFileSync(f.path, f.data, { mode: 0o600 });
    const resolved = await this.resolveCommand();
    if (resolved === undefined) {
      this.#bridge.close(channel.id);
      rmSync(configFile, { force: true });
      throw new ModelCallError("model_not_found", notInstalled(this.dialect, this.config.command));
    }
    const env: NodeJS.ProcessEnv = { ...this.#env, ...this.dialect.env() };
    for (const k of this.dialect.stripEnv) delete env[k];
    env.PATH = cliChildPath(
      resolved.path,
      this.#env,
      this.#resolveOpts.home ?? this.#env.HOME ?? homedir(),
    );
    run = new CliRun({
      command: resolved.path,
      args: spec.args,
      cwd: workdir,
      env,
      stdin: spec.stdin,
    });
    if (spec.closeStdin) run.endStdin();
    return {
      run,
      names,
      parser: this.dialect.parser("mcp__psyche__", prompt),
      channelId: channel.id,
      configFile,
      modelId,
      tempFiles: (spec.files ?? []).map((f) => f.path),
    };
  }

  async *stream(
    request: ModelRequest,
    options: AdapterCallOptions = {},
  ): AsyncIterable<ModelEvent> {
    const outcome: CallOutcome = {
      ref: request.model,
      profileId: undefined,
      usage: undefined,
      providerCost: false,
      unpriced: false,
      error: undefined,
      contentStarted: false,
    };
    const report = () => options.onOutcome?.(outcome);
    const fail = (e: ModelCallError): ModelEvent => {
      outcome.error = e;
      report();
      return e.kind === "cancelled"
        ? { type: "finish", reason: "cancelled" }
        : { type: "finish", reason: "error", error: e.toFinishError() };
    };
    const signal = options.signal;
    if (signal?.aborted === true) {
      yield fail(new ModelCallError("cancelled", "cancelled"));
      return;
    }
    let live: LiveRun;
    try {
      const { provider, model } = parseModelRef(request.model);
      if (provider !== this.id) {
        throw new ModelCallError(
          "bad_request",
          `ref ${request.model} is not for provider ${this.id}`,
        );
      }
      const cont = this.#continuation(request);
      if (cont !== undefined) {
        live = cont.live;
        clearTimeout(live.idle);
        // Calls the loop did not answer (a denied or skipped tool) still need a result.
        for (const id of live.run.unanswered()) {
          live.run.resolve(
            id,
            cont.results.get(id) ?? {
              content: [{ type: "text", text: "The tool was not run." }],
              isError: true,
            },
          );
          this.#live.delete(id);
        }
      } else {
        live = await this.#start(request, model);
      }
    } catch (err) {
      yield fail(
        err instanceof ModelCallError
          ? err
          : new ModelCallError("bad_request", String((err as Error).message)),
      );
      return;
    }

    const usage: Usage = { ...EMPTY_USAGE };
    const addUsage = (u: Partial<Usage>) => {
      usage.input += u.input ?? 0;
      usage.output += u.output ?? 0;
      usage.cacheRead += u.cacheRead ?? 0;
      usage.cacheWrite += u.cacheWrite ?? 0;
      usage.reasoning += u.reasoning ?? 0;
    };
    const envelope = (): ModelEvent | undefined =>
      live.run.sessionId === undefined
        ? undefined
        : {
            type: "reasoning",
            provider: this.id,
            data: {
              v: 1,
              kind: "cli-session",
              model: live.modelId,
              sessionId: live.run.sessionId,
              ...(live.totals === undefined ? {} : { totals: live.totals }),
            } satisfies CliSessionEnvelope,
          };
    const idleMs = this.config.timeouts?.idleMs ?? DEFAULT_IDLE_MS;
    const calls: { id: string; name: string; input: unknown }[] = [];

    let ended: ParseStep["end"];
    let error: ModelCallError | undefined;
    const aborted = new Promise<"abort">((r) => {
      if (signal === undefined) return;
      signal.addEventListener("abort", () => r("abort"), { once: true });
    });
    try {
      while (ended === undefined && error === undefined) {
        if (isAborted(signal)) {
          this.#finishRun(live);
          yield fail(new ModelCallError("cancelled", "cancelled"));
          return;
        }
        const settle = live.parser.settleMs !== undefined && live.parser.pendingCalls();
        const wait = settle ? (live.parser.settleMs as number) : idleMs;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<"timeout">((r) => {
          timer = setTimeout(() => r("timeout"), wait);
        });
        const next = await Promise.race([live.run.items.next(), timeout, aborted]);
        clearTimeout(timer);
        if (next === "abort") {
          this.#finishRun(live);
          yield fail(new ModelCallError("cancelled", "cancelled"));
          return;
        }
        if (next === "timeout") {
          if (settle) {
            ended = "tool_calls";
            break;
          }
          error = new ModelCallError(
            "timeout",
            `${this.dialect.label} sent nothing for ${Math.round(idleMs / 1000)} s`,
          );
          break;
        }
        if (next.done === true) {
          error = new ModelCallError(
            "server_error",
            `${this.dialect.label} ended without a result`,
          );
          break;
        }
        const item = next.value;
        if (item.type === "exit") {
          error = this.dialect.exitError(item, this.command);
          break;
        }
        const step = live.parser.push(item.value);
        if (step.sessionId !== undefined) live.run.sessionId = step.sessionId;
        if (step.totals !== undefined) live.totals = step.totals;
        if (step.usage !== undefined) addUsage(step.usage);
        for (const e of step.events ?? []) {
          if (e.type === "text_delta" || e.type === "reasoning") outcome.contentStarted = true;
          yield e;
          if (isAborted(signal)) break;
        }
        for (const c of step.calls ?? []) {
          live.run.register(c.id, c.name, c.input);
          calls.push(c);
        }
        if (step.error !== undefined) error = step.error;
        if (step.end !== undefined) ended = step.end;
      }
    } catch (err) {
      error =
        err instanceof ModelCallError
          ? err
          : new ModelCallError("unknown", String((err as Error).message));
    }

    outcome.usage = usage;
    if (error !== undefined) {
      this.#finishRun(live);
      if (usage.input + usage.output > 0) yield { type: "usage", usage };
      yield fail(error);
      return;
    }
    const env = envelope();
    if (ended === "tool_calls" && calls.length > 0) {
      for (const c of calls) {
        outcome.contentStarted = true;
        yield {
          type: "tool_call",
          id: c.id,
          name: live.names.toOurs(c.name),
          input: c.input,
        };
        this.#live.set(c.id, live);
      }
      const suspendMs = this.config.cliSuspendMs ?? DEFAULT_SUSPEND_MS;
      live.idle = setTimeout(() => this.#finishRun(live), suspendMs);
      live.idle.unref?.();
      if (env !== undefined) yield env;
      report();
      yield { type: "usage", usage };
      yield { type: "finish", reason: "tool_calls" };
      return;
    }
    // The turn is over: the CLI exits once its input is closed.
    this.#finishRun(live, false);
    if (env !== undefined) yield env;
    report();
    yield { type: "usage", usage };
    yield { type: "finish", reason: ended === "length" ? "length" : "stop" };
  }
}

/** Read through a function so TypeScript does not narrow `aborted` across awaits. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
