import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ModelEvent, ModelMessage, ModelRequest, ToolSpec } from "@psyche/protocol";
import { collect } from "@psyche/testing";
import { describeModelProviderConformance } from "@psyche/testing/conformance";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  accumulate,
  type CallOutcome,
  CliAdapter,
  codexDialect,
  isCliSessionEnvelope,
  type ProviderConfig,
} from "../src/index.ts";
import { weatherTool } from "./helpers/adapters.ts";

/**
 * `codex` provider against a fake `codex` (test/fake-cli/fake-cli.mjs) replaying recorded
 * `codex exec --json` JSONL; Psyche's tools go through the real MCP relay. No real CLI.
 */

const FAKE = resolve(import.meta.dirname, "fake-cli/fake-cli.mjs");
const FIXTURES = resolve(import.meta.dirname, "fixtures/codex");
const REF = "codex/default";
const THREAD = "019a0f3c-5e7d-7c11-9b2a-4f1e2d3c4b5a";
const notesRead: ToolSpec = { ...weatherTool, name: "notes.read", description: "Read a note" };

type Seen = { kind: string } & Record<string, unknown>;

let dir: string;
const adapters: CliAdapter[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "psyche-codex-test-"));
});
afterEach(async () => {
  for (const a of adapters.splice(0)) await a.close();
  rmSync(dir, { recursive: true, force: true });
});

function setup(scripts: string[], config: Partial<ProviderConfig> = {}) {
  const log = join(dir, "log.jsonl");
  const cfg: ProviderConfig = {
    id: "codex",
    kind: "codex",
    command: FAKE,
    workdir: join(dir, "work"),
    ...config,
  };
  const adapter = new CliAdapter(cfg, codexDialect(cfg.id), {
    env: {
      ...process.env,
      OPENAI_API_KEY: "fx-not-a-real-key",
      FAKE_CLI_SCRIPTS: JSON.stringify(scripts.map((s) => join(FIXTURES, `${s}.json`))),
      FAKE_CLI_STATE: join(dir, "state"),
      FAKE_CLI_LOG: log,
    },
  });
  adapters.push(adapter);
  const seen = (): Seen[] =>
    readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Seen);
  const argv = (n = 0) => seen().filter((e) => e.kind === "argv")[n]?.argv as string[];
  return { adapter, seen, argv };
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

describe("codex provider (fake CLI, recorded exec --json)", () => {
  it("returns the agent message, reasoning summary, per-turn usage and the thread for resuming", async () => {
    const { adapter, argv, seen } = setup(["text"]);
    const { events, outcome } = await run(adapter, ask("Say hello."));
    expect(events.filter((e) => e.type === "text_delta")).toEqual([
      { type: "text_delta", text: "Hello, world." },
    ]);
    expect(events.find((e) => e.type === "reasoning" && e.data === null)).toMatchObject({
      textDelta: "**Greeting**",
    });
    const env = events.find((e) => e.type === "reasoning" && isCliSessionEnvelope(e.data));
    expect(env?.type === "reasoning" && env.data).toMatchObject({ sessionId: THREAD });
    expect(events.find((e) => e.type === "usage")).toEqual({
      type: "usage",
      usage: { input: 200, cacheRead: 1000, cacheWrite: 0, output: 28, reasoning: 8, costUsd: 0 },
    });
    expect(events.at(-1)).toEqual({ type: "finish", reason: "stop" });
    expect(outcome?.error).toBeUndefined();

    const a = argv();
    expect(a.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(a[a.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(a).toContain("--ignore-user-config");
    for (const f of ["shell_tool", "computer_use", "browser_use", "apps"]) {
      expect(
        a.some((x, i) => x === f && a[i - 1] === "--disable"),
        f,
      ).toBe(true);
    }
    expect(a).toContain('web_search="disabled"');
    expect(a).toContain('developer_instructions="You are Wren."');
    expect(a).toContain('mcp_servers.psyche.default_tools_approval_mode="approve"');
    expect(a).not.toContain("--model");
    expect(a.at(-1)).toBe("-");
    expect(JSON.stringify(a)).not.toMatch(/token/i);
    const env0 = seen().find((e) => e.kind === "env")?.env as Record<string, unknown>;
    expect(env0.OPENAI_API_KEY).toBeNull();
    expect(seen().find((e) => e.kind === "stdin")?.line).toBe("Say hello.");
  });

  it("ends at Psyche tool calls and hands the results back through MCP", async () => {
    const { adapter, seen, argv } = setup(["tools"]);
    const first = ask("Weather in Paris and my Tokyo note?", { tools: [weatherTool, notesRead] });
    const turn = await accumulate(adapter.stream(first));
    expect(turn.toolCalls()).toEqual([
      { type: "tool_call", id: "item_1", name: "weather", input: { city: "Paris" } },
      { type: "tool_call", id: "item_2", name: "notes.read", input: { city: "Tokyo" } },
    ]);
    expect(turn.finish).toEqual({ type: "finish", reason: "tool_calls" });
    const messages: ModelMessage[] = [
      ...first.messages,
      turn.message(),
      {
        role: "tool",
        parts: [
          { type: "tool_result", callId: "item_1", output: { tempC: 18 } },
          { type: "tool_result", callId: "item_2", output: "notes" },
        ],
      },
    ];
    const second = await run(adapter, { ...first, messages });
    expect(second.events.filter((e) => e.type === "text_delta").map((e) => e.text)).toEqual([
      "Paris is 18°C.",
    ]);
    expect(second.events.at(-1)).toEqual({ type: "finish", reason: "stop" });
    expect(
      seen()
        .filter((e) => e.kind === "result")
        .map((e) => e.result),
    ).toEqual([
      { content: [{ type: "text", text: '{"tempC":18}' }] },
      { content: [{ type: "text", text: "notes" }] },
    ]);
    expect(argv(1)).toBeUndefined();
  });

  it("resumes the thread and counts only this turn's usage", async () => {
    const { adapter, argv } = setup(["text", "resumed"]);
    const first = ask("Say hello.");
    const turn = await accumulate(adapter.stream(first));
    const { events } = await run(adapter, {
      ...first,
      messages: [
        ...first.messages,
        turn.message(),
        { role: "user", parts: [{ type: "text", text: "Again." }] },
      ],
    });
    const a = argv(1);
    expect(a.slice(a.indexOf("resume"), a.indexOf("resume") + 2)).toEqual(["resume", THREAD]);
    // Totals went from 200/1000/28 to 400/1600/40.
    expect(events.find((e) => e.type === "usage")).toMatchObject({
      usage: { input: 200, cacheRead: 600, output: 12, reasoning: 2 },
    });
  });

  it("attaches images as files and removes them afterwards", async () => {
    const { adapter, argv } = setup(["text"]);
    await run(adapter, {
      model: REF,
      messages: [
        {
          role: "user",
          parts: [
            { type: "text", text: "What is this?" },
            { type: "image", mime: "image/png", data: "iVBORw0KGgo=" },
          ],
        },
      ],
    });
    const image = argv()
      .find((x) => x.startsWith("--image="))
      ?.slice("--image=".length);
    expect(image).toMatch(/\.png$/);
    expect(existsSync(image as string)).toBe(false);
  });

  it.each([
    ["usage-limit", "rate_limited", /subscription limit/],
    ["not-logged-in", "auth", /codex login/],
    ["own-tool", "bad_request", /stopped the run/],
  ])("maps %s to %s", async (script, kind, text) => {
    const { adapter } = setup([script]);
    const { events, outcome } = await run(adapter, ask("hi"));
    expect(events.at(-1)).toMatchObject({ type: "finish", reason: "error" });
    expect(outcome?.error?.kind).toBe(kind);
    expect(outcome?.error?.message).toMatch(text);
  });

  it("ends with finish{cancelled} when aborted mid-stream", async () => {
    const { adapter } = setup(["hang"]);
    const ac = new AbortController();
    const events: ModelEvent[] = [];
    for await (const e of adapter.stream(ask("hi"), { signal: ac.signal })) {
      events.push(e);
      if (e.type === "text_delta") ac.abort();
    }
    expect(events.at(-1)).toEqual({ type: "finish", reason: "cancelled" });
  });
});

describeModelProviderConformance("codex (fake CLI)", () => setup(["text"]).adapter, {
  request: () => ask("Say hello."),
});
