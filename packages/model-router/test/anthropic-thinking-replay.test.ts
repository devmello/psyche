import type { ModelMessage, ModelRequest, ToolSpec } from "@psyche/protocol";
import { collect } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import {
  accumulate,
  type CallOutcome,
  isEnvelope,
  type ProviderConfig,
  THINKING_BINDING_BETA,
} from "../src/index.ts";
import { fakeKey, makeAdapter, weatherTool } from "./helpers/adapters.ts";
import { loadFixture, replayFetch } from "./helpers/replay.ts";

/**
 * #306: Anthropic binds a signed thinking block to the request prefix (system prompt and tools)
 * it was produced under. A resumed thread whose prefix changed must not replay the stale block;
 * one whose prefix did not change replays it exactly as received.
 */

const REF = "anthropic/claude-haiku-5-5";
const SIGNATURE = "EqQBCkYIBRgCKkBsig-fixture-0001";
const SYSTEM = "You are Wren.";
const KEY = { secret: fakeKey("anthropic-replay"), origin: "https://api.anthropic.com" };
const CONFIG: ProviderConfig = { id: "anthropic", kind: "anthropic" };

const tool = (name: string): ToolSpec => ({
  ...weatherTool,
  name,
  description: `The ${name} tool`,
});
const ASK = tool("ask_user");
const NOTES = [tool("notes.list"), tool("notes.read")];

function adapter(fixture = "text", config: ProviderConfig = CONFIG) {
  const replay = replayFetch(loadFixture(`anthropic/${fixture}.json`));
  return { replay, adapter: makeAdapter(config, replay.fetch, KEY).adapter };
}

const user = (text: string): ModelMessage => ({ role: "user", parts: [{ type: "text", text }] });

/** Turn 1 of the issue's repro: one signed thinking block and text, under `tools`. */
async function firstTurn(tools: ToolSpec[], system = SYSTEM): Promise<ModelMessage> {
  const turn = await accumulate(
    adapter().adapter.stream({
      model: REF,
      system,
      messages: [user("Is 391 prime? Reason it out first.")],
      tools,
    }),
  );
  return turn.message();
}

type Body = {
  thinking?: Record<string, unknown>;
  messages: { role: string; content: Record<string, unknown>[] }[];
};

async function resume(
  request: Omit<ModelRequest, "model">,
  config: ProviderConfig = CONFIG,
): Promise<{ body: Body; headers: Record<string, string>; outcome: CallOutcome | undefined }> {
  const { adapter: a, replay } = adapter("text", config);
  let outcome: CallOutcome | undefined;
  await collect(
    a.stream(
      { model: REF, ...request },
      {
        onOutcome: (o) => {
          outcome = o;
        },
      },
    ),
  );
  const sent = replay.requests[0];
  return { body: sent?.body as Body, headers: sent?.headers ?? {}, outcome };
}

const thinkingBlocks = (body: Body) =>
  body.messages.flatMap((m) => m.content.filter((c) => c.type === "thinking"));

describe("Anthropic thinking replay on a resumed thread (#306)", () => {
  it("stamps the stored block with the prefix it is bound to", async () => {
    const turn = await firstTurn([ASK, ...NOTES]);
    const block = turn.parts.find((p) => p.type === "reasoning");
    expect(isEnvelope(block?.type === "reasoning" ? block.data : undefined)).toBe(true);
    expect(block?.type === "reasoning" && block.data).toMatchObject({
      kind: "reasoning",
      prefix: expect.stringMatching(/^sha256:[0-9a-f]{32}$/),
    });
  });

  it("replays the block exactly, with its signature, when the prefix is unchanged", async () => {
    const turn1 = await firstTurn([ASK, ...NOTES]);
    const { body, headers, outcome } = await resume({
      system: SYSTEM,
      messages: [user("Is 391 prime? Reason it out first."), turn1, user("And 397?")],
      tools: [ASK, ...NOTES],
    });
    expect(outcome?.error).toBeUndefined();
    expect(thinkingBlocks(body)).toEqual([
      { type: "thinking", thinking: "The user wants a greeting.", signature: SIGNATURE },
    ]);
    // The API drops a block whose binding it still rejects, instead of failing the turn.
    expect(body.thinking).toMatchObject({
      type: "adaptive",
      block_binding: { prefix_mismatch_behavior: "drop_block" },
    });
    expect(headers["anthropic-beta"]).toContain(THINKING_BINDING_BETA);
  });

  it("drops the stale block when a tool was withheld (the issue's case 3)", async () => {
    const turn1 = await firstTurn([ASK, ...NOTES]);
    const { body, headers } = await resume({
      system: SYSTEM,
      messages: [user("Is 391 prime? Reason it out first."), turn1, user("And 397?")],
      tools: NOTES,
    });
    expect(thinkingBlocks(body)).toEqual([]);
    expect(JSON.stringify(body)).not.toContain(SIGNATURE);
    // The rest of the turn is kept.
    const assistant = body.messages.find((m) => m.role === "assistant");
    expect(assistant?.content).toEqual([
      expect.objectContaining({ type: "text", text: "Hello, world." }),
    ]);
    // Nothing left to bind: no beta, no block_binding.
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(headers["anthropic-beta"] ?? "").not.toContain(THINKING_BINDING_BETA);
  });

  it("drops the stale block when the system prompt changed", async () => {
    const turn1 = await firstTurn(NOTES);
    const { body } = await resume({
      system: `${SYSTEM} Today is Tuesday.`,
      messages: [user("Is 391 prime?"), turn1, user("And 397?")],
      tools: NOTES,
    });
    expect(thinkingBlocks(body)).toEqual([]);
  });

  it("keeps the block of the tool loop in flight and lets the API binding decide", async () => {
    const turn1 = await firstTurn([ASK, ...NOTES]);
    const inFlight: ModelMessage = {
      role: "assistant",
      parts: [
        ...turn1.parts,
        { type: "tool_call", id: "toolu_01A", name: "notes.list", input: { city: "x" } },
      ],
    };
    const { body } = await resume({
      system: SYSTEM,
      messages: [
        user("Is 391 prime?"),
        inFlight,
        { role: "tool", parts: [{ type: "tool_result", callId: "toolu_01A", output: [] }] },
      ],
      tools: NOTES,
    });
    expect(thinkingBlocks(body)).toHaveLength(1);
    expect(body.thinking).toMatchObject({
      block_binding: { prefix_mismatch_behavior: "drop_block" },
    });
  });

  it("sends no earlier thinking when thinking is off for the request", async () => {
    const turn1 = await firstTurn(NOTES);
    const { body } = await resume({
      system: SYSTEM,
      messages: [user("Is 391 prime?"), turn1, user("And 397?")],
      tools: NOTES,
      providerOptions: { anthropic: { thinking: { type: "disabled" } } },
    });
    expect(thinkingBlocks(body)).toEqual([]);
    expect(body.thinking).toEqual({ type: "disabled" });
  });

  it("keeps a block stored before the fingerprint existed, under the API binding", async () => {
    const turn1 = await firstTurn(NOTES);
    const legacy: ModelMessage = {
      role: "assistant",
      parts: turn1.parts.map((p) => {
        if (p.type !== "reasoning" || !isEnvelope(p.data) || p.data.kind !== "reasoning") return p;
        const { prefix: _prefix, ...rest } = p.data;
        return { ...p, data: rest };
      }),
    };
    const { body } = await resume({
      system: SYSTEM,
      messages: [user("Is 391 prime?"), legacy, user("And 397?")],
      tools: [ASK, ...NOTES],
    });
    expect(thinkingBlocks(body)).toHaveLength(1);
    expect(body.thinking).toMatchObject({
      block_binding: { prefix_mismatch_behavior: "drop_block" },
    });
  });

  it("leaves the binding off when the provider config says so", async () => {
    const turn1 = await firstTurn(NOTES);
    const { body, headers } = await resume(
      { system: SYSTEM, messages: [user("Is 391 prime?"), turn1, user("And 397?")], tools: NOTES },
      { ...CONFIG, thinkingBlockBinding: false },
    );
    expect(thinkingBlocks(body)).toHaveLength(1);
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(headers["anthropic-beta"] ?? "").not.toContain(THINKING_BINDING_BETA);
  });

  it("reports the API's binding refusal as a visible bad_request", async () => {
    const { adapter: a } = adapter("error-400-thinking-binding");
    let outcome: CallOutcome | undefined;
    const events = await collect(
      a.stream(
        { model: REF, system: SYSTEM, messages: [user("hi")] },
        {
          onOutcome: (o) => {
            outcome = o;
          },
        },
      ),
    );
    expect(events.at(-1)).toMatchObject({ type: "finish", reason: "error" });
    expect(outcome?.error?.kind).toBe("bad_request");
    expect(outcome?.error?.message).toContain("bound to a different conversation");
  });
});
