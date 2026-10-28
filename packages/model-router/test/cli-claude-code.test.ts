import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ModelEvent, ModelMessage, ModelRequest, ToolSpec } from "@psyche/protocol";
import { collect, FakeClock } from "@psyche/testing";
import { describeModelProviderConformance } from "@psyche/testing/conformance";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  accumulate,
  type CallOutcome,
  CliAdapter,
  claudeCodeDialect,
  createModelRouter,
  isCliSessionEnvelope,
  type ProviderConfig,
} from "../src/index.ts";
import { weatherTool } from "./helpers/adapters.ts";

/**
 * `claude-code` provider against a fake `claude` (test/fake-cli/fake-cli.mjs): it replays
 * recorded stream-json and, like the real CLI, starts the configured `psyche` MCP server (the
 * real relay) and calls Psyche's tools through it. No real CLI and no model call.
 */

const FAKE = resolve(import.meta.dirname, "fake-cli/fake-cli.mjs");
const FIXTURES = resolve(import.meta.dirname, "fixtures/claude-code");
const REF = "claude-code/sonnet";
const notesRead: ToolSpec = { ...weatherTool, name: "notes.read", description: "Read a note" };

let dir: string;
const adapters: CliAdapter[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "psyche-claude-code-test-"));
});
afterEach(async () => {
  for (const a of adapters.splice(0)) await a.close();
  rmSync(dir, { recursive: true, force: true });
});

function setup(scripts: string[], config: Partial<ProviderConfig> = {}) {
  const log = join(dir, "log.jsonl");
  const cfg: ProviderConfig = {
    id: "claude-code",
    kind: "claude-code",
    command: FAKE,
    workdir: join(dir, "work"),
    ...config,
  };
  const adapter = new CliAdapter(cfg, claudeCodeDialect(cfg.id), {
    env: {
      ...process.env,
      // Present in the Gateway's env; must not reach the CLI (the subscription login runs).
      ANTHROPIC_API_KEY: "fx-not-a-real-key",
      FAKE_CLI_SCRIPTS: JSON.stringify(scripts.map((s) => join(FIXTURES, `${s}.json`))),
      FAKE_CLI_STATE: join(dir, "state"),
      FAKE_CLI_LOG: log,
    },
  });
  adapters.push(adapter);
  const seen = () =>
    readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { kind: string } & Record<string, unknown>);
  return { adapter, seen };
}

async function run(adapter: CliAdapter, request: ModelRequest) {
  let outcome: CallOutcome | undefined;
  const events = await collect(
    adapter.stream(request, {
      onOutcome: (o) => {
        outcome = o;
      },
    }),
  );
  return { events, outcome };
}

const ask = (text: string, extra: Partial<ModelRequest> = {}): ModelRequest => ({
  model: REF,
  system: "You are Wren.",
  messages: [{ role: "user", parts: [{ type: "text", text }] }],
  ...extra,
});

const argvOf = (seen: () => ({ kind: string } & Record<string, unknown>)[], n = 0) =>
  seen().filter((e) => e.kind === "argv")[n]?.argv as string[];

describe("claude-code provider (fake CLI, recorded stream-json)", () => {
  it("streams thinking and text, reports usage, and stores the session for the next turn", async () => {
    const { adapter, seen } = setup(["text"]);
    const { events, outcome } = await run(adapter, ask("Say hello."));
    expect(events.filter((e) => e.type === "text_delta").map((e) => e.text)).toEqual([
      "Hello",
      ", world.",
    ]);
    expect(
      events
        .filter((e) => e.type === "reasoning" && e.data === null)
        .map((e) => e.type === "reasoning" && e.textDelta),
    ).toEqual(["Greet briefly."]);
    const env = events.find((e) => e.type === "reasoning" && isCliSessionEnvelope(e.data));
    expect(env?.type === "reasoning" && env.data).toEqual({
      v: 1,
      kind: "cli-session",
      model: "sonnet",
      sessionId: "2f0c9a1e-7b7e-4c1d-9c55-0f1e2d3c4b5a",
    });
    expect(events.find((e) => e.type === "usage")).toEqual({
      type: "usage",
      usage: { input: 40, output: 12, cacheRead: 100, cacheWrite: 20, reasoning: 0, costUsd: 0 },
    });
    expect(events.at(-1)).toEqual({ type: "finish", reason: "stop" });
    expect(outcome?.error).toBeUndefined();

    const argv = argvOf(seen);
    expect(argv.slice(0, 8)).toEqual([
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--strict-mcp-config",
    ]);
    // Claude Code's own tools are off; only Psyche's bridge is allowed.
    expect(argv[argv.indexOf("--tools") + 1]).toBe("");
    expect(argv[argv.indexOf("--allowedTools") + 1]).toBe("mcp__psyche");
    expect(argv[argv.indexOf("--system-prompt") + 1]).toBe("You are Wren.");
    expect(argv[argv.indexOf("--model") + 1]).toBe("sonnet");
    expect(argv).not.toContain("--resume");
    // The bridge token is in neither argv nor the MCP config.
    const mcp = JSON.parse(argv[argv.indexOf("--mcp-config") + 1] as string);
    expect(JSON.stringify(mcp)).not.toMatch(/token|PSYCHE_MCP/i);
    const env0 = seen().find((e) => e.kind === "env")?.env as Record<string, unknown>;
    expect(env0.ANTHROPIC_API_KEY).toBeNull();
    expect(env0.DISABLE_TELEMETRY).toBe("1");
    expect(env0.MCP_TOOL_TIMEOUT).toBe(String(4 * 60 * 60_000));
    const stdin = seen().find((e) => e.kind === "stdin")?.line as string;
    expect(JSON.parse(stdin)).toEqual({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "Say hello." }] },
      parent_tool_use_id: null,
    });
  });

  it("bridges Psyche's tools over MCP: ends at the tool calls, resumes the same process with the results", async () => {
    const { adapter, seen } = setup(["tools"]);
    const first = ask("Weather in Paris and my Tokyo note?", { tools: [weatherTool, notesRead] });
    const turn = await accumulate(adapter.stream(first));
    expect(turn.text()).toBe("Checking both.");
    expect(turn.toolCalls()).toEqual([
      { type: "tool_call", id: "toolu_fxA", name: "weather", input: { city: "Paris" } },
      { type: "tool_call", id: "toolu_fxB", name: "notes.read", input: { city: "Tokyo" } },
    ]);
    expect(turn.finish).toEqual({ type: "finish", reason: "tool_calls" });
    // The CLI listed Psyche's tools (provider-safe names, object schemas) from the bridge.
    const tools = seen().find((e) => e.kind === "tools")?.tools as {
      name: string;
      inputSchema: { type: string };
    }[];
    expect(tools.map((t) => t.name)).toEqual(["weather", "notes_read"]);
    expect(tools.every((t) => t.inputSchema.type === "object")).toBe(true);

    const messages: ModelMessage[] = [
      ...first.messages,
      turn.message(),
      {
        role: "tool",
        parts: [
          { type: "tool_result", callId: "toolu_fxA", output: { tempC: 18 } },
          { type: "tool_result", callId: "toolu_fxB", output: "notes", isError: false },
        ],
      },
    ];
    const second = await run(adapter, { ...first, messages });
    expect(second.events.filter((e) => e.type === "text_delta").map((e) => e.text)).toEqual([
      "Paris is 18°C.",
    ]);
    expect(second.events.at(-1)).toEqual({ type: "finish", reason: "stop" });
    // One CLI process for the whole turn; the loop's results reached it through MCP.
    expect(seen().filter((e) => e.kind === "argv")).toHaveLength(1);
    const results = seen().filter((e) => e.kind === "result");
    expect(results).toEqual([
      { kind: "result", id: "A", result: { content: [{ type: "text", text: '{"tempC":18}' }] } },
      { kind: "result", id: "B", result: { content: [{ type: "text", text: "notes" }] } },
    ]);
  });

  it("restarts the run when a continuation brings tools the CLI never listed (load_tools mid-turn)", async () => {
    const { adapter, seen } = setup(["tools", "text"]);
    const first = ask("Weather in Paris?", { tools: [weatherTool] });
    const turn = await accumulate(adapter.stream(first));
    expect(turn.finish).toEqual({ type: "finish", reason: "tool_calls" });
    const messages: ModelMessage[] = [
      ...first.messages,
      turn.message(),
      {
        role: "tool",
        parts: [{ type: "tool_result", callId: "toolu_fxA", output: { tempC: 18 } }],
      },
    ];
    // The model loaded notes.read after the CLI started: its schema is in the next request.
    const second = await run(adapter, { ...first, messages, tools: [weatherTool, notesRead] });
    expect(second.events.at(-1)).toEqual({ type: "finish", reason: "stop" });
    const argvs = seen().filter((e) => e.kind === "argv");
    expect(argvs).toHaveLength(2);
    const argv = argvOf(seen, 1);
    expect(argv).toContain("--resume");
    const lists = seen().filter((e) => e.kind === "tools") as unknown as {
      tools: { name: string }[];
    }[];
    expect(lists.at(-1)?.tools.map((t) => t.name)).toEqual(["weather", "notes_read"]);
  });

  it("hands a refused call back to the CLI as an MCP error and never re-emits it (#500)", async () => {
    const { adapter, seen } = setup(["tool-refused"]);
    const gmailSend: ToolSpec = { ...weatherTool, name: "gmail.send", description: "Send mail" };
    const first = ask("Send Lena's reply.", { tools: [gmailSend] });
    const turn = await accumulate(adapter.stream(first));
    expect(turn.toolCalls().map((c) => c.id)).toEqual(["toolu_fxSend"]);
    const refused = { error: "arguments changed after approval", errorCode: "binding_mismatch" };
    const second = await run(adapter, {
      ...first,
      messages: [
        ...first.messages,
        turn.message(),
        {
          role: "tool",
          parts: [{ type: "tool_result", callId: "toolu_fxSend", output: refused, isError: true }],
        },
      ],
    });
    // Whatever the model does next is its own call; the old one is never sent again.
    expect(second.events.filter((e) => e.type === "tool_call")).toEqual([]);
    expect(second.events.at(-1)).toEqual({ type: "finish", reason: "stop" });
    expect(seen().filter((e) => e.kind === "result")).toEqual([
      {
        kind: "result",
        id: "S",
        result: { content: [{ type: "text", text: JSON.stringify(refused) }], isError: true },
      },
    ]);
  });

  it("resumes the CLI session on the next turn and sends only what is new", async () => {
    const { adapter, seen } = setup(["text", "text"]);
    const first = ask("Say hello.");
    const turn = await accumulate(adapter.stream(first));
    await run(adapter, {
      ...first,
      messages: [
        ...first.messages,
        turn.message(),
        { role: "user", parts: [{ type: "text", text: "Again." }] },
      ],
    });
    const argv = argvOf(seen, 1);
    expect(argv[argv.indexOf("--resume") + 1]).toBe("2f0c9a1e-7b7e-4c1d-9c55-0f1e2d3c4b5a");
    const stdin = seen().filter((e) => e.kind === "stdin")[1]?.line as string;
    expect(JSON.parse(stdin).message.content).toEqual([{ type: "text", text: "Again." }]);
  });

  it("renders an earlier history from another model as a transcript and sends images", async () => {
    const { adapter, seen } = setup(["text"]);
    await run(adapter, {
      model: REF,
      messages: [
        { role: "user", parts: [{ type: "text", text: "Hi" }] },
        { role: "assistant", parts: [{ type: "text", text: "Hello from another model." }] },
        {
          role: "user",
          parts: [
            { type: "text", text: "What is this?" },
            { type: "image", mime: "image/png", data: "iVBORw0KGgo=" },
          ],
        },
      ],
    });
    const content = JSON.parse(seen().find((e) => e.kind === "stdin")?.line as string).message
      .content;
    expect(content[0].text).toContain(
      "<transcript>\nuser: Hi\n\nassistant: Hello from another model.\n</transcript>",
    );
    expect(content[0].text).toMatch(/What is this\?$/);
    expect(content[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
    });
  });

  it.each([
    ["not-logged-in", "auth", /claude auth login/],
    ["usage-limit", "rate_limited", /subscription limit/],
    ["crash", "server_error", /unexpected failure/],
    ["bridge-failed", "server_error", /tool bridge/],
  ])("maps %s to %s", async (script, kind, text) => {
    const { adapter } = setup([script]);
    const { events, outcome } = await run(adapter, ask("hi"));
    expect(events.at(-1)).toMatchObject({ type: "finish", reason: "error" });
    expect(outcome?.error?.kind).toBe(kind);
    expect(outcome?.error?.message).toMatch(text);
  });

  it("reports a missing CLI as model_not_found", async () => {
    const { adapter } = setup(["text"], { command: join(dir, "no-such-claude") });
    const { outcome } = await run(adapter, ask("hi"));
    expect(outcome?.error?.kind).toBe("model_not_found");
    expect(outcome?.error?.message).toContain("not installed");
  });

  it("refuses a tool without an object schema before starting the CLI", async () => {
    const { adapter } = setup(["text"]);
    const { outcome } = await run(
      adapter,
      ask("hi", { tools: [{ ...weatherTool, inputSchema: { type: "string" } }] }),
    );
    expect(outcome?.error?.kind).toBe("bad_request");
  });

  it("ends with finish{cancelled} and stops the CLI when aborted mid-stream", async () => {
    const { adapter } = setup(["hang"]);
    const ac = new AbortController();
    const events: ModelEvent[] = [];
    for await (const e of adapter.stream(ask("hi"), { signal: ac.signal })) {
      events.push(e);
      if (e.type === "text_delta") ac.abort();
    }
    expect(events.filter((e) => e.type === "text_delta")).toEqual([
      { type: "text_delta", text: "Partial" },
    ]);
    expect(events.at(-1)).toEqual({ type: "finish", reason: "cancelled" });
  });

  it("reports the catalog's context window, the [1m] variants and the owner's override (#558)", async () => {
    const { adapter } = setup(["text"], { models: { opus: { contextWindow: 500_000 } } });
    expect((await adapter.capabilities("claude-code/sonnet")).contextWindow).toBe(200_000);
    expect((await adapter.capabilities("claude-code/default")).contextWindow).toBe(200_000);
    expect((await adapter.capabilities("claude-code/sonnet[1m]")).contextWindow).toBe(1_000_000);
    expect((await adapter.capabilities("claude-code/opus")).contextWindow).toBe(500_000);
  });

  it("runs behind the router as `claude-code/<model>`", async () => {
    const log = join(dir, "router.jsonl");
    const router = createModelRouter(
      {
        providers: [
          { id: "claude-code", kind: "claude-code", command: FAKE, workdir: join(dir, "w") },
        ],
        roles: { primary: { model: "claude-code/default" } },
      },
      {
        clock: new FakeClock(),
        cli: {
          env: {
            ...process.env,
            FAKE_CLI_SCRIPTS: JSON.stringify([join(FIXTURES, "text.json")]),
            FAKE_CLI_STATE: join(dir, "rstate"),
            FAKE_CLI_LOG: log,
          },
        },
      },
    );
    const turn = await accumulate(
      router.stream({ model: "router/primary", messages: ask("hi").messages }),
    );
    expect(turn.text()).toBe("Hello, world.");
    const argv = JSON.parse(readFileSync(log, "utf8").split("\n")[0] as string).argv as string[];
    // `default` leaves the model to the CLI.
    expect(argv).not.toContain("--model");
    await (router.provider("claude-code") as CliAdapter).close();
  });
});

describeModelProviderConformance(
  "claude-code (fake CLI)",
  () => {
    const { adapter } = setup(["text"]);
    return adapter;
  },
  { request: () => ask("Say hello.") },
);
