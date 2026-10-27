import type { ModelProvider, ModelRef, ModelRequest, ToolSpec } from "@psyche/protocol";
import { accumulate, type TurnAccumulator } from "./envelope.ts";

/** B4: a model that fails the suite is `chat-only` and cannot be an agent primary. */
export type ProbeStatus = "agent-capable" | "chat-only";

export interface ProbeCaseResult {
  id: ProbeCaseId;
  passed: boolean;
  detail: string;
}

export interface ProbeResult {
  ref: ModelRef;
  status: ProbeStatus;
  passed: number;
  total: number;
  /** Some case could not reach the model (server down, cancelled): the verdict is not stored. */
  inconclusive: boolean;
  cases: ProbeCaseResult[];
  /** ISO-8601 UTC. */
  probedAt: string;
}

export const PROBE_CASES = [
  "single_tool_call",
  "typed_arguments",
  "parallel_calls",
  "no_tool_needed",
  "uses_tool_result",
  "json_only",
] as const;
export type ProbeCaseId = (typeof PROBE_CASES)[number];

/** Cases an agent cannot work without. */
export const REQUIRED_CASES: readonly ProbeCaseId[] = [
  "single_tool_call",
  "typed_arguments",
  "uses_tool_result",
];
/** Minimum passes out of six. */
export const PASS_MARK = 5;

const weather: ToolSpec = {
  name: "get_weather",
  description: "Get the current weather for one city.",
  inputSchema: {
    type: "object",
    properties: { city: { type: "string", description: "City name" } },
    required: ["city"],
    additionalProperties: false,
  },
  sideEffect: "read",
  provenanceOut: "untrusted",
};

const timer: ToolSpec = {
  name: "set_timer",
  description: "Start a countdown timer.",
  inputSchema: {
    type: "object",
    properties: {
      minutes: { type: "integer", description: "Length in whole minutes" },
      label: { type: "string" },
    },
    required: ["minutes", "label"],
    additionalProperties: false,
  },
  sideEffect: "write",
  provenanceOut: "trusted",
};

const SYSTEM =
  "You are a test harness assistant. Follow the instructions exactly. Use tools when asked.";

interface ProbeCase {
  id: ProbeCaseId;
  request(ref: ModelRef): ModelRequest;
  check(turn: TurnAccumulator): { passed: boolean; detail: string };
}

const user = (text: string) => ({
  role: "user" as const,
  parts: [{ type: "text" as const, text }],
});

function inputOf(call: { input: unknown }): Record<string, unknown> {
  return typeof call.input === "object" && call.input !== null
    ? (call.input as Record<string, unknown>)
    : {};
}

/** Strip ```json fences and surrounding prose, then parse the first JSON object. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced?.[1] ?? text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

const CASES: ProbeCase[] = [
  {
    id: "single_tool_call",
    request: (ref) => ({
      model: ref,
      system: SYSTEM,
      tools: [weather],
      messages: [user("What is the weather in Paris right now? Use the get_weather tool.")],
    }),
    check: (t) => {
      const calls = t.toolCalls().filter((c) => c.name === "get_weather");
      const ok =
        calls.length >= 1 && /paris/i.test(String(inputOf(calls[0] ?? { input: {} }).city ?? ""));
      return {
        passed: ok,
        detail: ok ? "called get_weather(Paris)" : `calls: ${JSON.stringify(t.toolCalls())}`,
      };
    },
  },
  {
    id: "typed_arguments",
    request: (ref) => ({
      model: ref,
      system: SYSTEM,
      tools: [timer],
      messages: [user('Set a 15 minute timer labelled "tea" using the set_timer tool.')],
    }),
    check: (t) => {
      const call = t.toolCalls().find((c) => c.name === "set_timer");
      const input = call === undefined ? {} : inputOf(call);
      const ok =
        input.minutes === 15 && typeof input.label === "string" && /tea/i.test(input.label);
      return {
        passed: ok,
        detail: ok ? "integer and string arguments" : `input: ${JSON.stringify(input)}`,
      };
    },
  },
  {
    id: "parallel_calls",
    request: (ref) => ({
      model: ref,
      system: SYSTEM,
      tools: [weather],
      messages: [
        user(
          "Get the current weather in both Paris and Tokyo. Call get_weather once per city, both in this turn.",
        ),
      ],
    }),
    check: (t) => {
      const cities = t
        .toolCalls()
        .filter((c) => c.name === "get_weather")
        .map((c) => String(inputOf(c).city ?? "").toLowerCase());
      const ok = cities.some((c) => c.includes("paris")) && cities.some((c) => c.includes("tokyo"));
      return {
        passed: ok,
        detail: ok ? "two calls in one turn" : `cities: ${JSON.stringify(cities)}`,
      };
    },
  },
  {
    id: "no_tool_needed",
    request: (ref) => ({
      model: ref,
      system: SYSTEM,
      tools: [weather],
      messages: [user("Reply with the single word OK. Do not call any tool.")],
    }),
    check: (t) => {
      const ok = t.toolCalls().length === 0 && /\bok\b/i.test(t.text());
      return {
        passed: ok,
        detail: ok
          ? "answered without tools"
          : `tool calls: ${t.toolCalls().length}, text: ${t.text().slice(0, 80)}`,
      };
    },
  },
  {
    id: "uses_tool_result",
    request: (ref) => ({
      model: ref,
      system: SYSTEM,
      tools: [weather],
      messages: [
        user("What is the weather in Oslo?"),
        {
          role: "assistant",
          parts: [
            { type: "tool_call", id: "call_probe_1", name: "get_weather", input: { city: "Oslo" } },
          ],
        },
        {
          role: "tool",
          parts: [
            {
              type: "tool_result",
              callId: "call_probe_1",
              name: "get_weather",
              output: { city: "Oslo", tempC: 7, condition: "sleet" },
            },
          ],
        },
      ],
    }),
    check: (t) => {
      const text = t.text();
      const ok = /\b7\b/.test(text) && /sleet/i.test(text);
      return {
        passed: ok,
        detail: ok ? "answer used the tool result" : `text: ${text.slice(0, 80)}`,
      };
    },
  },
  {
    id: "json_only",
    request: (ref) => ({
      model: ref,
      system: SYSTEM,
      messages: [
        user(
          'Return only a JSON object of the form {"fruit": string, "count": integer} describing: "three apples". No other text.',
        ),
      ],
    }),
    check: (t) => {
      const v = extractJson(t.text()) as { fruit?: unknown; count?: unknown } | undefined;
      const ok =
        v !== undefined && v.count === 3 && typeof v.fruit === "string" && /apple/i.test(v.fruit);
      return { passed: ok, detail: ok ? "valid JSON" : `text: ${t.text().slice(0, 80)}` };
    },
  },
];

export interface ProbeOptions {
  /** Per-case time limit (local models may load on the first case). Default 120 s. */
  caseTimeoutMs?: number;
  signal?: AbortSignal;
  now?: () => number;
}

/** Run the six-case suite against `provider` for `ref`. */
export async function runCapabilityProbe(
  provider: ModelProvider,
  ref: ModelRef,
  options: ProbeOptions = {},
): Promise<ProbeResult> {
  const results: ProbeCaseResult[] = [];
  let inconclusive = false;
  for (const c of CASES) {
    const signals = [AbortSignal.timeout(options.caseTimeoutMs ?? 120_000)];
    if (options.signal !== undefined) signals.push(options.signal);
    const request: ModelRequest = { ...c.request(ref), maxOutputTokens: 1024, temperature: 0 };
    const turn = await accumulate(provider.stream(request, { signal: AbortSignal.any(signals) }));
    if (turn.finish?.reason === "error" || turn.finish?.reason === "cancelled") {
      inconclusive = true;
      results.push({
        id: c.id,
        passed: false,
        detail: `call failed: ${turn.finish.error ?? turn.finish.reason}`,
      });
      if (options.signal?.aborted === true) break;
      continue;
    }
    results.push({ id: c.id, ...c.check(turn) });
  }
  const passed = results.filter((r) => r.passed).length;
  const required = REQUIRED_CASES.every((id) => results.find((r) => r.id === id)?.passed === true);
  return {
    ref,
    status: required && passed >= PASS_MARK ? "agent-capable" : "chat-only",
    passed,
    total: CASES.length,
    inconclusive: inconclusive || results.length < CASES.length,
    cases: results,
    probedAt: new Date(options.now?.() ?? Date.now()).toISOString(),
  };
}

/** Where probe results persist (`model_profiles.probe_result`). */
export interface ProbeStore {
  get(ref: ModelRef): ProbeResult | undefined | Promise<ProbeResult | undefined>;
  set(result: ProbeResult): void | Promise<void>;
}

export class InMemoryProbeStore implements ProbeStore {
  readonly #m = new Map<ModelRef, ProbeResult>();
  get(ref: ModelRef): ProbeResult | undefined {
    return this.#m.get(ref);
  }
  set(result: ProbeResult): void {
    this.#m.set(result.ref, structuredClone(result));
  }
}

/** Key-value storage the Gateway backs with the `settings` table (`getSetting` / `setSetting`). */
export interface KeyValueStore {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

export const PROBE_SETTING_PREFIX = "models.probe.";

/**
 * Probe verdicts as settings rows (`models.probe.<ref>`). Data model §10 puts them in
 * `model_profiles.probe_result`; that table is not in schema v0 yet (see docs/archive/status/s03.md),
 * and moving there later only changes this store.
 */
export class KeyValueProbeStore implements ProbeStore {
  readonly #kv: KeyValueStore;

  constructor(kv: KeyValueStore) {
    this.#kv = kv;
  }

  get(ref: ModelRef): ProbeResult | undefined {
    const v = this.#kv.get(PROBE_SETTING_PREFIX + ref);
    if (typeof v !== "object" || v === null) return undefined;
    const r = v as Partial<ProbeResult>;
    return r.ref === ref && (r.status === "agent-capable" || r.status === "chat-only")
      ? (structuredClone(v) as ProbeResult)
      : undefined;
  }

  set(result: ProbeResult): void {
    this.#kv.set(PROBE_SETTING_PREFIX + result.ref, structuredClone(result));
  }
}
