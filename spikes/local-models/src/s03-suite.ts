// Port of the B4 suite merged in packages/model-router/src/probe.ts (S03, origin/main),
// re-expressed with AI SDK calls so we can check whether it separates the negative control.
// Same prompts, same checks, same verdict rule (required cases + >= 5/6), temperature 0.
// Usage: tsx src/s03-suite.ts --endpoint ollama-native --model qwen3.5:0.8b [--repeat 3] [--reasoning none]
import { appendFileSync, mkdirSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { jsonSchema, streamText, tool, type ModelMessage, type ToolSet } from 'ai';
import { makeModel, type EndpointId } from './endpoints.ts';

const { values } = parseArgs({
  options: {
    endpoint: { type: 'string' }, model: { type: 'string' }, label: { type: 'string' },
    repeat: { type: 'string', default: '3' }, reasoning: { type: 'string' },
  },
});
const endpoint = values.endpoint as EndpointId;
const model = makeModel(endpoint, values.model!);
const label = values.label ?? values.model!;
const reasoning = values.reasoning as 'none' | 'medium' | undefined;

const SYSTEM = 'You are a test harness assistant. Follow the instructions exactly. Use tools when asked.';
const weather = tool({
  description: 'Get the current weather for one city.',
  inputSchema: jsonSchema<{ city: string }>({
    type: 'object', properties: { city: { type: 'string', description: 'City name' } },
    required: ['city'], additionalProperties: false,
  }),
});
const timer = tool({
  description: 'Start a countdown timer.',
  inputSchema: jsonSchema<{ minutes: number; label: string }>({
    type: 'object',
    properties: { minutes: { type: 'integer', description: 'Length in whole minutes' }, label: { type: 'string' } },
    required: ['minutes', 'label'], additionalProperties: false,
  }),
});

function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced?.[1] ?? text;
  const s = body.indexOf('{');
  const e = body.lastIndexOf('}');
  if (s < 0 || e <= s) return undefined;
  try { return JSON.parse(body.slice(s, e + 1)); } catch { return undefined; }
}

type Turn = { calls: { name: string; input: Record<string, unknown> }[]; text: string };
async function turn(messages: ModelMessage[], tools?: ToolSet): Promise<Turn> {
  const r = streamText({
    model, system: SYSTEM, messages, tools, maxOutputTokens: 1024, temperature: 0, maxRetries: 0, reasoning,
    abortSignal: AbortSignal.timeout(120_000),
  });
  const t: Turn = { calls: [], text: '' };
  for await (const p of r.fullStream) {
    if (p.type === 'text-delta') t.text += p.text;
    if (p.type === 'tool-call') t.calls.push({ name: p.toolName, input: (p.input ?? {}) as Record<string, unknown> });
  }
  return t;
}
const u = (text: string): ModelMessage => ({ role: 'user', content: text });

const CASES: { id: string; run: () => Promise<boolean> }[] = [
  { id: 'single_tool_call', run: async () => {
    const t = await turn([u('What is the weather in Paris right now? Use the get_weather tool.')], { get_weather: weather });
    const c = t.calls.filter((c) => c.name === 'get_weather');
    return c.length >= 1 && /paris/i.test(String(c[0]!.input.city ?? ''));
  } },
  { id: 'typed_arguments', run: async () => {
    const t = await turn([u('Set a 15 minute timer labelled "tea" using the set_timer tool.')], { set_timer: timer });
    const i = t.calls.find((c) => c.name === 'set_timer')?.input ?? {};
    return i.minutes === 15 && typeof i.label === 'string' && /tea/i.test(i.label);
  } },
  { id: 'parallel_calls', run: async () => {
    const t = await turn([u('Get the current weather in both Paris and Tokyo. Call get_weather once per city, both in this turn.')], { get_weather: weather });
    const cities = t.calls.filter((c) => c.name === 'get_weather').map((c) => String(c.input.city ?? '').toLowerCase());
    return cities.some((c) => c.includes('paris')) && cities.some((c) => c.includes('tokyo'));
  } },
  { id: 'no_tool_needed', run: async () => {
    const t = await turn([u('Reply with the single word OK. Do not call any tool.')], { get_weather: weather });
    return t.calls.length === 0 && /\bok\b/i.test(t.text);
  } },
  { id: 'uses_tool_result', run: async () => {
    const t = await turn([
      u('What is the weather in Oslo?'),
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call_probe_1', toolName: 'get_weather', input: { city: 'Oslo' } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call_probe_1', toolName: 'get_weather', output: { type: 'json', value: { city: 'Oslo', tempC: 7, condition: 'sleet' } } }] },
    ], { get_weather: weather });
    return /\b7\b/.test(t.text) && /sleet/i.test(t.text);
  } },
  { id: 'json_only', run: async () => {
    const t = await turn([u('Return only a JSON object of the form {"fruit": string, "count": integer} describing: "three apples". No other text.')]);
    const v = extractJson(t.text) as { fruit?: unknown; count?: unknown } | undefined;
    return v !== undefined && v.count === 3 && typeof v.fruit === 'string' && /apple/i.test(v.fruit);
  } },
];
const REQUIRED = ['single_tool_call', 'typed_arguments', 'uses_tool_result'];

mkdirSync('results', { recursive: true });
for (let r = 0; r < Number(values.repeat); r++) {
  const res: Record<string, boolean> = {};
  for (const c of CASES) res[c.id] = await c.run().catch(() => false);
  const passed = Object.values(res).filter(Boolean).length;
  const status = REQUIRED.every((id) => res[id]) && passed >= 5 ? 'agent-capable' : 'chat-only';
  appendFileSync('results/s03-suite.jsonl', JSON.stringify({ at: new Date().toISOString(), endpoint, model: label, reasoning: reasoning ?? 'default', run: r, passed, status, cases: res }) + '\n');
  console.log(`${label}@${endpoint} run ${r}: ${passed}/6 ${status}`);
}
