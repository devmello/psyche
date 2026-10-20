import { join } from "node:path";
import type { Usage } from "@psyche/protocol";
import { ModelCallError } from "../errors.ts";
import type { CliDialect, CliParser, ParseStep } from "./adapter.ts";
import { BRIDGE_SERVER_NAME } from "./bridge.ts";
import type { CliPrompt, CliSessionEnvelope } from "./prompt.ts";
import type { CliItem, CliLine } from "./run.ts";

/**
 * The OpenAI Codex CLI on the owner's ChatGPT subscription: `codex exec --json` (resumed with
 * `codex exec resume <thread>`), prompt on stdin, images as `-i` files. Codex's own tools are
 * switched off (shell, browser, computer use, apps, plugins, web search, image tools…), the run
 * is sandboxed read-only in an empty working directory, and the user's `config.toml` is not
 * loaded; only the `psyche` MCP server is configured, with its tools pre-approved because
 * Psyche's broker decides. Codex has no switch for its `apply_patch` tool; the read-only
 * sandbox and the empty working directory leave it nothing to change. `OPENAI_API_KEY` is
 * removed so the ChatGPT login is what runs.
 *
 * `codex exec --json` streams no text deltas: each agent message arrives whole.
 */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

type Totals = NonNullable<CliSessionEnvelope["totals"]>;

const AUTH = /not logged in|codex login|401|unauthori[sz]ed|authenticat|token (?:has )?expired/i;
const RATE = /usage limit|rate limit|429|too many requests|limit reached/i;
const CONTEXT = /context (?:window|length)|too many tokens|maximum context/i;

export function codexError(
  text: string,
  fallback: ModelCallError["kind"] = "server_error",
): ModelCallError {
  const t = text.slice(0, 400);
  if (AUTH.test(t))
    return new ModelCallError(
      "auth",
      `Codex is not signed in or its login expired (run \`codex login\`): ${t}`,
    );
  if (RATE.test(t)) return new ModelCallError("rate_limited", `ChatGPT subscription limit: ${t}`);
  if (CONTEXT.test(t)) return new ModelCallError("context_overflow", t);
  return new ModelCallError(fallback, t.length > 0 ? t : "Codex failed");
}

/** Codex's own tools, off for Psyche runs (feature keys as of codex-cli 0.162). */
const DISABLED_FEATURES = [
  "shell_tool",
  "unified_exec",
  "view_image",
  "apps",
  "plugins",
  "browser_use",
  "in_app_browser",
  "computer_use",
  "image_generation",
  "multi_agent",
  "tool_suggest",
  "hooks",
  "goals",
  "skill_search",
  "memories",
];

/** One tool call may wait on an approval. */
const TOOL_TIMEOUT_SEC = 4 * 60 * 60;

const toml = (v: unknown): string => JSON.stringify(v);

class CodexParser implements CliParser {
  readonly settleMs = 250;
  readonly #provider: string;
  readonly #baseline: Totals;
  #pending = false;

  constructor(provider: string, baseline: Totals | undefined) {
    this.#provider = provider;
    this.#baseline = baseline ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  }

  pendingCalls(): boolean {
    return this.#pending;
  }

  push(line: CliLine): ParseStep {
    switch (line.type) {
      case "thread.started":
        return typeof line.thread_id === "string" ? { sessionId: line.thread_id } : {};
      case "item.started":
      case "item.completed":
        return this.#item(line.type, isObj(line.item) ? line.item : {});
      case "turn.completed":
        return this.#completed(isObj(line.usage) ? line.usage : {});
      case "turn.failed": {
        const err = isObj(line.error) ? line.error : {};
        return { error: codexError(String(err.message ?? "the turn failed")) };
      }
      default:
        // `error` lines are non-fatal notices; a failure ends with `turn.failed`.
        return {};
    }
  }

  #item(phase: string, item: Obj): ParseStep {
    switch (item.type) {
      case "agent_message":
        if (phase !== "item.completed" || typeof item.text !== "string" || item.text.length === 0)
          return {};
        return { events: [{ type: "text_delta", text: item.text }] };
      case "reasoning":
        if (phase !== "item.completed" || typeof item.text !== "string" || item.text.length === 0)
          return {};
        return {
          events: [
            { type: "reasoning", provider: this.#provider, data: null, textDelta: item.text },
          ],
        };
      case "mcp_tool_call": {
        if (phase !== "item.started" || item.server !== BRIDGE_SERVER_NAME) return {};
        if (typeof item.id !== "string" || typeof item.tool !== "string") return {};
        let input: unknown = item.arguments ?? {};
        if (typeof input === "string") {
          try {
            input = JSON.parse(input);
          } catch {
            input = {};
          }
        }
        this.#pending = true;
        return { calls: [{ id: item.id, name: item.tool, input }] };
      }
      case "command_execution":
      case "file_change":
      case "web_search":
        // Codex's own tools are off; if one runs anyway, stop the run rather than let it act.
        if (phase !== "item.started") return {};
        return {
          error: new ModelCallError(
            "bad_request",
            `Codex started its own ${String(item.type)} tool; Psyche stopped the run (only Psyche's tools may act)`,
          ),
        };
      default:
        return {};
    }
  }

  #completed(u: Obj): ParseStep {
    // Totals are the thread's running sum; this turn is the difference from the last one.
    const cached = num(u.cached_input_tokens);
    const totals: Totals = {
      input: Math.max(0, num(u.input_tokens) - cached),
      cacheRead: cached,
      cacheWrite: num(u.cache_write_input_tokens),
      output: num(u.output_tokens) + num(u.reasoning_output_tokens),
      reasoning: num(u.reasoning_output_tokens),
    };
    const b = this.#baseline;
    const usage: Partial<Usage> = {
      input: Math.max(0, totals.input - b.input),
      cacheRead: Math.max(0, totals.cacheRead - b.cacheRead),
      cacheWrite: Math.max(0, totals.cacheWrite - b.cacheWrite),
      output: Math.max(0, totals.output - b.output),
      reasoning: Math.max(0, totals.reasoning - b.reasoning),
    };
    return { usage, totals, end: "stop" };
  }
}

export const codexDialect = (provider: string): CliDialect => ({
  label: "Codex",
  defaultCommand: "codex",
  stripEnv: ["OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY"],
  env: () => ({}),
  start({
    model,
    system,
    prompt,
    bridge,
    workdir,
  }: {
    model: string | undefined;
    system: string | undefined;
    prompt: CliPrompt;
    bridge: { command: string; args: string[]; env: Record<string, string> };
    workdir: string;
  }) {
    const args = [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--cd",
      workdir,
      "--sandbox",
      "read-only",
      "--ignore-user-config",
    ];
    for (const f of DISABLED_FEATURES) args.push("--disable", f);
    const config: [string, unknown][] = [
      ["web_search", "disabled"],
      ["project_doc_max_bytes", 0],
      ["include_environment_context", false],
      ["include_apps_instructions", false],
      [`mcp_servers.${BRIDGE_SERVER_NAME}.command`, bridge.command],
      [`mcp_servers.${BRIDGE_SERVER_NAME}.args`, bridge.args],
      [`mcp_servers.${BRIDGE_SERVER_NAME}.required`, true],
      [`mcp_servers.${BRIDGE_SERVER_NAME}.startup_timeout_sec`, 30],
      [`mcp_servers.${BRIDGE_SERVER_NAME}.tool_timeout_sec`, TOOL_TIMEOUT_SEC],
      [`mcp_servers.${BRIDGE_SERVER_NAME}.default_tools_approval_mode`, "approve"],
    ];
    if (system !== undefined && system.length > 0) config.push(["developer_instructions", system]);
    for (const [k, v] of config) args.push("-c", `${k}=${toml(v)}`);
    const envEntries = Object.entries(bridge.env)
      .map(([k, v]) => `${k}=${toml(v)}`)
      .join(", ");
    args.push("-c", `mcp_servers.${BRIDGE_SERVER_NAME}.env={${envEntries}}`);
    if (model !== undefined) args.push("--model", model);
    const files = prompt.images.map((img, i) => ({
      path: join(
        workdir,
        `.psyche-image-${process.pid}-${Date.now()}-${i}.${img.mime.split("/")[1] ?? "png"}`,
      ),
      data: Buffer.from(img.data, "base64"),
    }));
    if (prompt.resume !== undefined) args.push("resume", prompt.resume);
    // `--image` takes several values; the `=` form keeps it from swallowing the `-` below.
    for (const f of files) args.push(`--image=${f.path}`);
    // The prompt comes on stdin.
    args.push("-");
    return {
      args,
      stdin: [prompt.text.length > 0 ? prompt.text : "Continue."],
      closeStdin: true,
      files,
    };
  },
  parser: (_prefix, prompt) => new CodexParser(provider, prompt.resumeTotals),
  exitError(item: Extract<CliItem, { type: "exit" }>, command: string): ModelCallError {
    if ((item.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return new ModelCallError(
        "model_not_found",
        `Codex is not installed (\`${command}\` was not found on PATH)`,
      );
    }
    const text = item.stderr.trim();
    return codexError(text.length > 0 ? text : `Codex exited (${item.code ?? item.signal ?? "?"})`);
  },
});
