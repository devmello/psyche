// Raw-HTTP quirk probes, outside the AI SDK, so we see what each server actually does.
// Usage: tsx src/quirks.ts --model qwen3.5:9b [--endpoints ollama-native,ollama-openai,ollama-anthropic,llama-server]
// Appends to results/quirks.jsonl.
import { appendFileSync, mkdirSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { anthropic } from '@ai-sdk/anthropic';
import { isStepCount, streamText } from 'ai';
import { LLAMA_SERVER, LMSTUDIO, makeModel, OLLAMA } from './endpoints.ts';

const { values } = parseArgs({
  options: {
    model: { type: 'string' },
    label: { type: 'string' },
    endpoints: { type: 'string', default: 'ollama-native,ollama-openai,ollama-anthropic' },
  },
});
const model = values.model!;
const label = values.label ?? model;
const endpoints = values.endpoints!.split(',');
mkdirSync('results', { recursive: true });
const log = (endpoint: string, probe: string, row: object) => {
  appendFileSync('results/quirks.jsonl', JSON.stringify({ at: new Date().toISOString(), model: label, endpoint, probe, ...row }) + '\n');
  console.log(endpoint, probe, JSON.stringify(row).slice(0, 300));
};

const weather = {
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' }, unit: { type: 'string', enum: ['celsius', 'fahrenheit'] } },
    required: ['city', 'unit'],
  },
};
const NO_TOOL_PROMPT = 'Say hello in one short sentence.';
const TWO_CALLS = 'Get the weather in Paris and in Berlin, both in celsius. Call the tool once per city, in parallel.';

async function post(url: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const t0 = performance.now();
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ max_tokens: 1024, ...body }),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await r.text();
    return { status: r.status, text, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    // -1 = timed out or connection failed; logged as such rather than aborting the remaining probes
    return { status: -1, text: String((e as Error).message), ms: Math.round(performance.now() - t0) };
  }
}

// Count SSE / NDJSON chunks that carry tool-call argument fragments.
function countToolChunks(raw: string, kind: 'openai' | 'anthropic' | 'ndjson') {
  let chunks = 0;
  let reasoningField = new Set<string>();
  for (const line of raw.split('\n')) {
    const json = kind === 'ndjson' ? line : line.startsWith('data: ') ? line.slice(6) : '';
    if (!json || json === '[DONE]') continue;
    try {
      const d = JSON.parse(json);
      if (kind === 'openai') {
        const delta = d.choices?.[0]?.delta ?? {};
        if (delta.tool_calls?.some((t: { function?: { arguments?: string } }) => t.function?.arguments)) chunks++;
        for (const k of ['reasoning', 'reasoning_content', 'thinking']) if (delta[k]) reasoningField.add(k);
      } else if (kind === 'anthropic') {
        if (d.delta?.type === 'input_json_delta') chunks++;
        if (d.delta?.type === 'thinking_delta') reasoningField.add('thinking_delta');
      } else {
        if (d.message?.tool_calls?.length) chunks++;
        if (d.message?.thinking) reasoningField.add('message.thinking');
      }
    } catch {}
  }
  return { toolArgChunks: chunks, reasoningFields: [...reasoningField] };
}

const openaiBase = (e: string) => (e === 'llama-server' ? LLAMA_SERVER : e === 'lmstudio' ? LMSTUDIO : OLLAMA) + '/v1';
const short = (s: string) => s.slice(0, 400);

for (const e of endpoints) {
  try {
    if (e === 'ollama-native') {
      // No tool_choice on /api/chat; check streaming granularity and parallel calls.
      const r = await post(`${OLLAMA}/api/chat`, {
        model, stream: true, think: false,
        messages: [{ role: 'user', content: TWO_CALLS }],
        tools: [{ type: 'function', function: weather }],
      });
      const calls = r.text.split('\n').filter(Boolean).flatMap((l) => JSON.parse(l).message?.tool_calls ?? []);
      log(e, 'stream_parallel', { status: r.status, calls: calls.length, ...countToolChunks(r.text, 'ndjson') });
    }
    if (e === 'ollama-openai' || e === 'llama-server' || e === 'lmstudio') {
      const base = openaiBase(e);
      for (const [probe, tool_choice] of [
        ['tool_choice_required', 'required'],
        ['tool_choice_named', { type: 'function', function: { name: 'get_weather' } }],
        ['tool_choice_none', 'none'],
      ] as const) {
        const r = await post(`${base}/chat/completions`, {
          model, messages: [{ role: 'user', content: probe === 'tool_choice_none' ? 'What is the weather in Paris in celsius?' : NO_TOOL_PROMPT }],
          tools: [{ type: 'function', function: weather }], tool_choice, reasoning_effort: 'none',
        });
        const d = r.status === 200 ? JSON.parse(r.text) : undefined;
        const called = !!d?.choices?.[0]?.message?.tool_calls?.length;
        const honored = probe === 'tool_choice_none' ? !called : called;
        log(e, probe, { status: r.status, called, honored, err: r.status === 200 ? undefined : short(r.text) });
      }
      const s = await post(`${base}/chat/completions`, {
        model, stream: true, messages: [{ role: 'user', content: TWO_CALLS }],
        tools: [{ type: 'function', function: weather }],
      });
      log(e, 'stream_parallel', { status: s.status, ...countToolChunks(s.text, 'openai') });
      const p = await post(`${base}/chat/completions`, {
        model, messages: [{ role: 'user', content: TWO_CALLS }], tools: [{ type: 'function', function: weather }],
        parallel_tool_calls: false, reasoning_effort: 'none',
      });
      const pc = p.status === 200 ? JSON.parse(p.text).choices?.[0]?.message?.tool_calls?.length ?? 0 : -1;
      log(e, 'parallel_tool_calls_false', { status: p.status, calls: pc, honored: pc === 1 });
      const n = await post(`${base}/chat/completions`, {
        model, messages: [{ role: 'user', content: 'What is 17*23? Answer with the number only.' }], reasoning_effort: 'none',
      });
      const nm = n.status === 200 ? JSON.parse(n.text).choices?.[0]?.message ?? {} : {};
      log(e, 'reasoning_effort_none', {
        status: n.status, content: short(String(nm.content ?? '')),
        reasoningPresent: !!(nm.reasoning || nm.reasoning_content), err: n.status === 200 ? undefined : short(n.text),
      });
    }
    if (e === 'ollama-anthropic') {
      const url = `${OLLAMA}/v1/messages`;
      const h = { 'x-api-key': 'ollama', 'anthropic-version': '2023-06-01' };
      const tools = [{ name: weather.name, description: weather.description, input_schema: weather.parameters }];
      for (const [probe, tool_choice] of [
        ['tool_choice_any', { type: 'any' }],
        ['tool_choice_named', { type: 'tool', name: 'get_weather' }],
      ] as const) {
        const r = await post(url, { model, max_tokens: 512, messages: [{ role: 'user', content: NO_TOOL_PROMPT }], tools, tool_choice }, h);
        const d = r.status === 200 ? JSON.parse(r.text) : undefined;
        const called = !!d?.content?.some((b: { type: string }) => b.type === 'tool_use');
        log(e, probe, { status: r.status, called, honored: called, err: r.status === 200 ? undefined : short(r.text) });
      }
      const s = await post(url, { model, max_tokens: 1024, stream: true, messages: [{ role: 'user', content: TWO_CALLS }], tools }, h);
      log(e, 'stream_parallel', { status: s.status, ...countToolChunks(s.text, 'anthropic') });
      // Raw memory_20250818 definition, as Claude Code / the Anthropic provider would send it.
      const m = await post(
        url,
        {
          model, max_tokens: 1024,
          messages: [{ role: 'user', content: 'Please remember for later that my favourite colour is teal. Save it to your memory directory.' }],
          tools: [{ type: 'memory_20250818', name: 'memory' }],
        },
        { ...h, 'anthropic-beta': 'context-management-2025-06-27' },
      );
      const md = m.status === 200 ? JSON.parse(m.text) : undefined;
      const use = md?.content?.find((b: { type: string }) => b.type === 'tool_use');
      log(e, 'memory_20250818_raw', { status: m.status, toolUse: use ? { name: use.name, input: use.input } : null, err: m.status === 200 ? undefined : short(m.text) });
      // Same through @ai-sdk/anthropic's provider-defined tool.
      const mem = makeModel('ollama-anthropic', model);
      const calls: unknown[] = [];
      const res = streamText({
        model: mem,
        prompt: 'Please remember for later that my favourite colour is teal. Save it to your memory directory.',
        tools: {
          memory: anthropic.tools.memory_20250818({
            execute: async (input) => {
              calls.push(input);
              return 'File created successfully';
            },
          }),
        },
        stopWhen: isStepCount(2),
        maxRetries: 0,
      });
      const errs: string[] = [];
      const seen: unknown[] = [];
      for await (const p of res.fullStream) {
        if (p.type === 'error') errs.push(String((p.error as Error).message).slice(0, 300));
        if (p.type === 'tool-call') seen.push({ name: p.toolName, input: p.input });
        if (p.type === 'tool-error') errs.push(`tool-error ${p.toolName}: ${String((p.error as Error)?.message ?? p.error).slice(0, 300)}`);
      }
      const warnings = (await Promise.resolve(res.warnings).catch(() => [])) ?? [];
      log(e, 'memory_20250818_sdk', { executed: calls, toolCalls: seen, errs, warnings });
    }
  } catch (err) {
    log(e, 'crash', { err: String((err as Error).message).slice(0, 300) });
  }
}
