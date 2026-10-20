import type { ModelEvent, Usage } from "@psyche/protocol";
import { ModelCallError } from "../errors.ts";
import type { CliDialect, CliParser, ParseStep } from "./adapter.ts";
import { BRIDGE_SERVER_NAME } from "./bridge.ts";
import type { CliItem, CliLine } from "./run.ts";

/**
 * Claude Code in headless mode, on the owner's Claude subscription:
 * `claude -p --input-format stream-json --output-format stream-json --verbose
 * --include-partial-messages`. Claude Code's own tools are off (`--tools ""`); only the
 * `psyche` MCP server (`--strict-mcp-config`) is offered and allowed, nothing prompts
 * (`--permission-mode dontAsk`), and the owner's settings, hooks, plugins, CLAUDE.md and
 * auto-memory are not loaded. `--system-prompt`
 * replaces Claude Code's coding-agent prompt with Psyche's. `ANTHROPIC_API_KEY` and friends
 * are removed from its environment so the subscription login is what runs, and Claude Code's
 * telemetry and error reporting are turned off.
 */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function usageOf(u: unknown): Partial<Usage> {
  if (!isObj(u)) return {};
  return {
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cacheWrite: num(u.cache_creation_input_tokens),
  };
}

const AUTH =
  /not logged in|please run \/login|\/login|invalid api key|oauth token|authenticat|unauthori[sz]ed|401/i;
const RATE = /usage limit|rate limit|rate_limit|429|limit reached|too many requests/i;
const OVERLOADED = /overloaded|529/i;
const CONTEXT = /prompt is too long|context (?:window|length)|too many tokens/i;
const BILLING = /credit balance|billing|payment|quota/i;

/** Classify Claude Code's own error text (a `result` error or stderr). */
export function claudeError(
  text: string,
  fallback: ModelCallError["kind"] = "server_error",
): ModelCallError {
  const t = text.slice(0, 400);
  if (AUTH.test(t))
    return new ModelCallError(
      "auth",
      `Claude Code is not signed in or its login expired (run \`claude auth login\`): ${t}`,
    );
  if (RATE.test(t)) return new ModelCallError("rate_limited", `Claude subscription limit: ${t}`);
  if (OVERLOADED.test(t)) return new ModelCallError("overloaded", t);
  if (CONTEXT.test(t)) return new ModelCallError("context_overflow", t);
  if (BILLING.test(t)) return new ModelCallError("billing", t);
  return new ModelCallError(fallback, t.length > 0 ? t : "Claude Code failed");
}

interface Block {
  type: string;
  id?: string;
  name?: string;
  json: string;
}

class ClaudeParser implements CliParser {
  readonly #prefix: string;
  readonly #provider: string;
  #partials = false;
  #blocks = new Map<number, Block>();
  #messageCalls: ParseStep["calls"] = [];
  #msgUsage: Partial<Usage> = {};
  #seenAssistant = new Set<string>();
  #pending = false;

  constructor(prefix: string, provider: string) {
    this.#prefix = prefix;
    this.#provider = provider;
  }

  get settleMs(): number | undefined {
    return this.#partials ? undefined : 400;
  }

  pendingCalls(): boolean {
    return this.#pending;
  }

  #toolName(name: string | undefined): string | undefined {
    return name?.startsWith(this.#prefix) ? name.slice(this.#prefix.length) : undefined;
  }

  push(line: CliLine): ParseStep {
    // Subagent traffic (`parent_tool_use_id` set) is the CLI's business, not this turn's.
    if (line.parent_tool_use_id !== undefined && line.parent_tool_use_id !== null) return {};
    switch (line.type) {
      case "system": {
        if (line.subtype !== "init") return {};
        const step: ParseStep = {};
        if (typeof line.session_id === "string") step.sessionId = line.session_id;
        const servers = Array.isArray(line.mcp_servers) ? line.mcp_servers : [];
        const ours = servers.find((s) => isObj(s) && s.name === BRIDGE_SERVER_NAME) as
          | Obj
          | undefined;
        if (ours !== undefined && ours.status !== "connected") {
          step.error = new ModelCallError(
            "server_error",
            `Claude Code could not start Psyche's tool bridge (${String(ours.status)})`,
          );
        }
        return step;
      }
      case "stream_event":
        return this.#event(isObj(line.event) ? line.event : {});
      case "assistant":
        return this.#assistant(line);
      case "result":
        return this.#result(line);
      default:
        return {};
    }
  }

  #event(e: Obj): ParseStep {
    this.#partials = true;
    switch (e.type) {
      case "message_start": {
        this.#blocks.clear();
        this.#messageCalls = [];
        const msg = isObj(e.message) ? e.message : {};
        this.#msgUsage = usageOf(msg.usage);
        return {};
      }
      case "content_block_start": {
        const b = isObj(e.content_block) ? e.content_block : {};
        const block: Block = { type: String(b.type ?? ""), json: "" };
        if (typeof b.id === "string") block.id = b.id;
        if (typeof b.name === "string") block.name = b.name;
        this.#blocks.set(num(e.index), block);
        return {};
      }
      case "content_block_delta": {
        const d = isObj(e.delta) ? e.delta : {};
        const block = this.#blocks.get(num(e.index));
        if (d.type === "text_delta" && typeof d.text === "string" && d.text.length > 0)
          return { events: [{ type: "text_delta", text: d.text }] };
        if (d.type === "thinking_delta" && typeof d.thinking === "string" && d.thinking.length > 0)
          return {
            events: [
              { type: "reasoning", provider: this.#provider, data: null, textDelta: d.thinking },
            ],
          };
        if (
          d.type === "input_json_delta" &&
          block !== undefined &&
          typeof d.partial_json === "string"
        )
          block.json += d.partial_json;
        return {};
      }
      case "content_block_stop": {
        const block = this.#blocks.get(num(e.index));
        const name = this.#toolName(block?.name);
        if (block?.type === "tool_use" && block.id !== undefined && name !== undefined) {
          let input: unknown = {};
          try {
            input = block.json.trim().length === 0 ? {} : JSON.parse(block.json);
          } catch {
            input = {};
          }
          this.#messageCalls?.push({ id: block.id, name, input });
        }
        return {};
      }
      case "message_delta": {
        const u = isObj(e.usage) ? e.usage : {};
        if (typeof u.output_tokens === "number") this.#msgUsage.output = u.output_tokens;
        return {};
      }
      case "message_stop": {
        const calls = this.#messageCalls ?? [];
        const step: ParseStep = { usage: this.#msgUsage };
        this.#msgUsage = {};
        if (calls.length > 0) {
          step.calls = calls;
          step.end = "tool_calls";
        }
        this.#messageCalls = [];
        return step;
      }
      default:
        return {};
    }
  }

  /** Without partial messages (older CLIs): text and tool calls from the whole message. */
  #assistant(line: CliLine): ParseStep {
    if (this.#partials) return {};
    const msg = isObj(line.message) ? line.message : {};
    const content = Array.isArray(msg.content) ? msg.content : [];
    const events: ModelEvent[] = [];
    const calls: NonNullable<ParseStep["calls"]> = [];
    for (const b of content) {
      if (!isObj(b)) continue;
      if (b.type === "text" && typeof b.text === "string" && b.text.length > 0)
        events.push({ type: "text_delta", text: b.text });
      const name = this.#toolName(typeof b.name === "string" ? b.name : undefined);
      if (b.type === "tool_use" && typeof b.id === "string" && name !== undefined)
        calls.push({ id: b.id, name, input: b.input ?? {} });
    }
    const id = typeof msg.id === "string" ? msg.id : "";
    const step: ParseStep = { events, calls };
    // One message may arrive as several events (one per block); count its usage once.
    if (!this.#seenAssistant.has(id)) {
      this.#seenAssistant.add(id);
      step.usage = usageOf(msg.usage);
    }
    if (calls.length > 0) this.#pending = true;
    return step;
  }

  #result(line: CliLine): ParseStep {
    const step: ParseStep = {};
    if (typeof line.session_id === "string") step.sessionId = line.session_id;
    if (
      line.is_error === true ||
      (typeof line.subtype === "string" && line.subtype !== "success")
    ) {
      const text = typeof line.result === "string" ? line.result : String(line.subtype ?? "error");
      step.error = claudeError(text);
      return step;
    }
    step.end = line.stop_reason === "max_tokens" ? "length" : "stop";
    return step;
  }
}

/** Claude Code tells the model to wait this long for one MCP tool call (an approval may take a while). */
const MCP_TOOL_TIMEOUT_MS = String(4 * 60 * 60_000);

export const claudeCodeDialect = (provider: string): CliDialect => ({
  label: "Claude Code",
  defaultCommand: "claude",
  stripEnv: [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
  ],
  env: () => ({
    MCP_TOOL_TIMEOUT: MCP_TOOL_TIMEOUT_MS,
    CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: MCP_TOOL_TIMEOUT_MS,
    MCP_TIMEOUT: "30000",
    // Psyche's own memory and instructions, not the owner's Claude Code ones.
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    // No telemetry (security rules): Claude Code's own reporting is off too.
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  }),
  start({ model, system, prompt, bridge }) {
    const mcp = {
      mcpServers: {
        [BRIDGE_SERVER_NAME]: {
          type: "stdio",
          command: bridge.command,
          args: bridge.args,
          env: bridge.env,
          // Listed up front (not behind tool search), and a tool call may wait on an approval.
          alwaysLoad: true,
          timeout: Number(MCP_TOOL_TIMEOUT_MS),
        },
      },
    };
    const args = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--strict-mcp-config",
      "--mcp-config",
      JSON.stringify(mcp),
      "--tools",
      "",
      "--allowedTools",
      `mcp__${BRIDGE_SERVER_NAME}`,
      // Nothing waits on a permission prompt: Psyche's broker already decided.
      "--permission-mode",
      "dontAsk",
      // No user / project / local settings, hooks or plugins.
      "--setting-sources",
      "",
      "--disable-slash-commands",
    ];
    if (system !== undefined && system.length > 0) args.push("--system-prompt", system);
    if (model !== undefined) args.push("--model", model);
    if (prompt.resume !== undefined) args.push("--resume", prompt.resume);
    const content: Obj[] = [];
    if (prompt.text.length > 0) content.push({ type: "text", text: prompt.text });
    for (const img of prompt.images) {
      content.push({
        type: "image",
        source: { type: "base64", media_type: img.mime, data: img.data },
      });
    }
    if (content.length === 0) content.push({ type: "text", text: "Continue." });
    const message = { type: "user", message: { role: "user", content }, parent_tool_use_id: null };
    return { args, stdin: [JSON.stringify(message)], closeStdin: false };
  },
  parser: (prefix) => new ClaudeParser(prefix, provider),
  exitError(item: Extract<CliItem, { type: "exit" }>, command: string): ModelCallError {
    if ((item.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return new ModelCallError(
        "model_not_found",
        `Claude Code is not installed (\`${command}\` was not found on PATH)`,
      );
    }
    const text = item.stderr.trim();
    return claudeError(
      text.length > 0 ? text : `Claude Code exited (${item.code ?? item.signal ?? "?"})`,
    );
  },
});
