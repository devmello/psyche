/**
 * Live smoke test for deferred tool loading (`ProviderConfig.deferLoading`, off by default).
 * Sends ONE small real request to the Anthropic API with deferral on, through Psyche's own
 * request converter and the installed `@ai-sdk/anthropic`:
 *
 * - Claude Haiku 5.5, a one-line system prompt in the stable/volatile split;
 * - one deferred tool (`weather.forecast`, sent with `defer_loading: true`);
 * - a history where `load_tools` already loaded it, so its result carries a `tool_reference`.
 *
 * Prints `ok` when the API accepts the request, or the API's error, and nothing else. It costs
 * one Haiku call of a few hundred tokens. The owner runs it with their own key; agents don't.
 * From the repo root, paste the key at the silent prompt, so it never lands in shell history:
 *
 *   read -rs ANTHROPIC_API_KEY && export ANTHROPIC_API_KEY && pnpm --filter @psyche/model-router smoke:deferred-tools
 *
 * Don't put the key on the command line (`ANTHROPIC_API_KEY=… node …`): history keeps it.
 * The key is read from the environment only and never printed. When it prints `ok`, turning on
 * `deferLoading` for the Anthropic provider is safe.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import type { ModelRequest, ToolSpec } from "@psyche/protocol";
import type { ProviderConfig } from "../src/config.ts";
import { convertRequest } from "../src/convert-request.ts";

const MODEL = "claude-haiku-5-5";
const CONFIG: ProviderConfig = { id: "anthropic", kind: "anthropic", deferLoading: true };

const schema = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const LOAD_TOOLS: ToolSpec = {
  name: "load_tools",
  description: "Load tools that are loaded on demand so you can call them from the next step.",
  inputSchema: schema({ names: { type: "array", items: { type: "string" } } }, ["names"]),
  sideEffect: "none",
  provenanceOut: "trusted",
};
const FORECAST: ToolSpec = {
  name: "weather.forecast",
  description: "Hourly weather forecast for a city.",
  inputSchema: schema({ city: { type: "string" } }, ["city"]),
  sideEffect: "read",
  provenanceOut: "untrusted",
};

const STABLE = "You are a terse assistant. Use tools when they help.";
const REQUEST: ModelRequest = {
  model: `anthropic/${MODEL}`,
  system: `${STABLE}\n\nToday is a test day.`,
  systemStableLength: STABLE.length,
  messages: [
    { role: "user", parts: [{ type: "text", text: "Weather in Lisbon? One word." }] },
    {
      role: "assistant",
      parts: [
        {
          type: "tool_call",
          id: "toolu_smoke_1",
          name: "load_tools",
          input: { names: [FORECAST.name] },
        },
      ],
    },
    {
      role: "tool",
      parts: [
        {
          type: "tool_result",
          callId: "toolu_smoke_1",
          name: "load_tools",
          output: { loaded: [FORECAST.name], already: [], unknown: [] },
          provenance: "trusted",
        },
      ],
    },
  ],
  // As the loop sends it: the loaded tool in `tools`, every deferrable one in `deferredTools`.
  tools: [LOAD_TOOLS, FORECAST],
  deferredTools: [FORECAST],
  maxOutputTokens: 1024,
};

/** One line on stdout: `ok` or the error. */
function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function main(): Promise<number> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey === undefined || apiKey === "") {
    say("error: set ANTHROPIC_API_KEY (read -rs ANTHROPIC_API_KEY && export ANTHROPIC_API_KEY)");
    return 2;
  }
  // Checks the request really had the shape under test, without printing it.
  let shape = { deferred: false, reference: false };
  const fetchSpy: typeof fetch = async (input, init) => {
    const body = typeof init?.body === "string" ? init.body : "";
    shape = {
      deferred: body.includes('"defer_loading":true'),
      reference: body.includes('"type":"tool_reference"'),
    };
    return fetch(input, init);
  };
  const call = convertRequest(REQUEST, { config: CONFIG, modelId: MODEL });
  const model = createAnthropic({ apiKey, fetch: fetchSpy }).languageModel(MODEL);
  try {
    await model.doGenerate({ ...call, abortSignal: AbortSignal.timeout(60_000) });
  } catch (err) {
    const e = err as { statusCode?: number; responseBody?: string; message?: string };
    const detail = e.responseBody ?? e.message ?? String(err);
    say(`error: ${e.statusCode === undefined ? "" : `HTTP ${e.statusCode}: `}${detail}`);
    return 1;
  }
  if (!shape.deferred || !shape.reference) {
    say("error: the request did not carry defer_loading and tool_reference (nothing tested)");
    return 1;
  }
  say("ok");
  return 0;
}

process.exitCode = await main();
