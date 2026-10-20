import type { ModelRequest, ToolSpec } from "@psyche/protocol";
import { collect, FakeClock } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import {
  type CallOutcome,
  createModelRouter,
  normalizeToolSchema,
  type ProviderConfig,
  toolSchemaProblem,
} from "../src/index.ts";
import { fakeKey, makeAdapter } from "./helpers/adapters.ts";
import { loadFixture, replayFetch } from "./helpers/replay.ts";

/**
 * #414: a tool whose input schema is a top-level union (`code.git`'s `GitInput`,
 * `Type.Union([...])` → `{"anyOf": [...]}`) made Anthropic refuse every request offering it
 * (`tools.0.custom.input_schema.type: Field required`). The router sends one object instead and
 * refuses, naming the tool, what it cannot turn into one.
 */

const str = { type: "string" } as const;
/** The shape of agent-core's GitInput: a union of object variants keyed by `op`. */
const GIT_INPUT = {
  anyOf: [
    {
      type: "object",
      properties: { op: { const: "status", type: "string" }, root: str },
      required: ["op", "root"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        op: { const: "commit", type: "string" },
        root: str,
        message: str,
        paths: { type: "array", items: str },
      },
      required: ["op", "root", "message"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { op: { const: "push", type: "string" }, root: str, remote: str, branch: str },
      required: ["op", "root"],
      additionalProperties: false,
    },
  ],
};

const gitTool: ToolSpec = {
  name: "code.git",
  description: "Run a git operation in a project.",
  inputSchema: GIT_INPUT,
  sideEffect: "write",
  provenanceOut: "trusted",
};

describe("normalizeToolSchema", () => {
  it("turns a top-level anyOf of objects into one object", () => {
    const out = normalizeToolSchema(GIT_INPUT) as Record<string, unknown>;
    expect(out.type).toBe("object");
    expect(out.properties).toEqual({
      op: { type: "string", enum: ["status", "commit", "push"] },
      root: str,
      message: str,
      paths: { type: "array", items: str },
      remote: str,
      branch: str,
    });
    expect(out.required).toEqual(["op", "root"]);
    expect(out.additionalProperties).toBe(false);
    expect(out.anyOf).toBeUndefined();
    // The model still sees the variants.
    expect(out.description).toBe(
      'Accepts exactly one of these shapes (leave out fields a shape does not list): {op: "status", root}; {op: "commit", root, message, paths?}; {op: "push", root, remote?, branch?}.',
    );
    expect(toolSchemaProblem({ name: "code.git", inputSchema: out })).toBeUndefined();
  });

  it("handles oneOf, allOf, variants without type and properties that disagree", () => {
    const one = normalizeToolSchema({
      description: "Pick a target.",
      oneOf: [
        { properties: { id: str }, required: ["id"] },
        { properties: { id: { type: "integer" } }, required: ["id"] },
      ],
    }) as Record<string, unknown>;
    expect(one).toMatchObject({
      type: "object",
      properties: { id: { anyOf: [str, { type: "integer" }] } },
      required: ["id"],
    });
    expect(String(one.description)).toMatch(/^Pick a target\. Accepts exactly one/);
    expect(one.additionalProperties).toBeUndefined();

    const all = normalizeToolSchema({
      allOf: [
        { type: "object", properties: { a: str }, required: ["a"] },
        { type: "object", properties: { b: str }, required: ["b"] },
      ],
    });
    expect(all).toEqual({ type: "object", properties: { a: str, b: str }, required: ["a", "b"] });

    expect(normalizeToolSchema({ properties: { q: str } })).toEqual({
      type: "object",
      properties: { q: str },
    });
  });

  it("leaves object schemas alone and cannot fix non-object unions", () => {
    const obj = { type: "object", properties: {} };
    expect(normalizeToolSchema(obj)).toBe(obj);
    const scalar = { anyOf: [str, { type: "number" }] };
    expect(normalizeToolSchema(scalar)).toBe(scalar);
    expect(toolSchemaProblem({ name: "calc", inputSchema: scalar })).toBe(
      'tool "calc" input schema must be {"type": "object", …} at the top level (it has anyOf); providers refuse the whole request otherwise',
    );
    expect(toolSchemaProblem({ name: "echo", inputSchema: str })).toContain(
      'it has "type": "string"',
    );
    expect(toolSchemaProblem({ name: "none", inputSchema: undefined })).toBe(
      'tool "none" has no JSON Schema object as its input schema',
    );
  });
});

async function run(config: ProviderConfig, fixture: string, origin: string, request: ModelRequest) {
  const replay = replayFetch(loadFixture(fixture));
  const { adapter } = makeAdapter(config, replay.fetch, { secret: fakeKey(config.id), origin });
  let outcome: CallOutcome | undefined;
  const events = await collect(
    adapter.stream(request, {
      onOutcome: (o) => {
        outcome = o;
      },
    }),
  );
  return { events, outcome, body: replay.requests[0]?.body as Record<string, unknown> };
}

const ask = (model: string): ModelRequest => ({
  model,
  messages: [{ role: "user", parts: [{ type: "text", text: "What changed?" }] }],
  tools: [gitTool],
});

describe("union tool schemas on the wire (recorded fixtures)", () => {
  it("Anthropic gets input_schema.type object", async () => {
    const { events, body } = await run(
      { id: "anthropic", kind: "anthropic" },
      "anthropic/text.json",
      "https://api.anthropic.com",
      ask("anthropic/claude-haiku-5-5"),
    );
    expect(events.at(-1)).toEqual({ type: "finish", reason: "stop" });
    const tools = body.tools as { name: string; input_schema: Record<string, unknown> }[];
    expect(tools[0]?.name).toBe("code_git");
    expect(tools[0]?.input_schema).toMatchObject({
      type: "object",
      required: ["op", "root"],
      properties: { op: { type: "string", enum: ["status", "commit", "push"] } },
    });
    expect(tools[0]?.input_schema.anyOf).toBeUndefined();
  });

  it("OpenAI gets parameters.type object", async () => {
    const { events, body } = await run(
      { id: "openai", kind: "openai" },
      "openai/text.json",
      "https://api.openai.com",
      ask("openai/gpt-5.5"),
    );
    expect(events.at(-1)).toMatchObject({ type: "finish", reason: "stop" });
    const tools = body.tools as { name: string; parameters: Record<string, unknown> }[];
    expect(tools[0]?.name).toBe("code_git");
    expect(tools[0]?.parameters).toMatchObject({ type: "object", required: ["op", "root"] });
    expect(tools[0]?.parameters.anyOf).toBeUndefined();
  });
});

describe("router-level tool schema validation", () => {
  it("refuses a tool it cannot make an object, naming it, before anything is sent", async () => {
    const replay = replayFetch(loadFixture("anthropic/text.json"));
    const router = createModelRouter(
      {
        providers: [{ id: "anthropic", kind: "anthropic" }],
        roles: { primary: { model: "anthropic/claude-haiku-5-5" } },
      },
      { clock: new FakeClock(), fetch: replay.fetch },
    );
    const events = await collect(
      router.stream({
        model: "router/primary",
        messages: [{ role: "user", parts: [{ type: "text", text: "Echo hi." }] }],
        tools: [{ ...gitTool, name: "echo", inputSchema: { type: "string" } }],
      }),
    );
    const last = events.at(-1);
    expect(last).toMatchObject({ type: "finish", reason: "error" });
    expect(last?.type === "finish" && last.error).toMatch(
      /^bad_request: .*tool "echo" input schema must be \{"type": "object"/,
    );
    expect(replay.requests).toHaveLength(0);
  });
});
