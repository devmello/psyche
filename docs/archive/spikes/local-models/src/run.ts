// Usage: tsx src/run.ts --endpoint ollama-native --model qwen3.5:9b [--cases a,b] [--repeat 3] [--timeout 300]
// Appends one JSON line per case run (and one per bench) to results/results.jsonl.
import { appendFileSync, mkdirSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { bench, CASES, runCase, setReasoning, type CaseId, type Reasoning } from './cases.ts';
import { makeModel, type EndpointId } from './endpoints.ts';

const { values } = parseArgs({
  options: {
    endpoint: { type: 'string' },
    model: { type: 'string' },
    label: { type: 'string' }, // model label for the report when the endpoint's id differs (llama-server)
    cases: { type: 'string' },
    repeat: { type: 'string', default: '3' },
    timeout: { type: 'string', default: '300' },
    'no-bench': { type: 'boolean', default: false },
    out: { type: 'string', default: 'results/results.jsonl' },
    reasoning: { type: 'string' }, // none | medium | (omit for provider default)
  },
});
const endpoint = values.endpoint as EndpointId;
const modelId = values.model!;
const label = values.label ?? modelId;
const cases = (values.cases?.split(',') as CaseId[] | undefined) ?? CASES;
const repeat = Number(values.repeat);
const timeoutMs = Number(values.timeout) * 1000;
mkdirSync('results', { recursive: true });
const model = makeModel(endpoint, modelId);
const think = (values.reasoning as Reasoning) ?? undefined;
setReasoning(think);
const write = (row: object) => appendFileSync(values.out!, JSON.stringify({ at: new Date().toISOString(), endpoint, model: label, reasoning: think ?? 'default', ...row }) + '\n');

async function safe<T>(f: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await f();
  } catch (e) {
    return { error: String((e as Error).message ?? e).slice(0, 500) };
  }
}

// Warm-up load (not recorded), then one measured bench.
if (!values['no-bench']) {
  await safe(() => bench(model, timeoutMs));
  const b = await safe(() => bench(model, timeoutMs));
  write({ case: 'bench', ...('error' in b ? b : { trace: b }) });
  if (!('error' in b))
    console.log(`bench ${label}@${endpoint}: ttft ${b.ttftMs?.toFixed(0)}ms, ${b.tps?.toFixed(1)} tok/s, ${b.outputTokens} tok`);
}

for (let r = 0; r < repeat; r++) {
  for (const id of cases) {
    const o = await safe(() => runCase(id, model, timeoutMs));
    if ('error' in o) {
      write({ case: id, run: r, pass: false, reason: `error: ${o.error}` });
      console.log(`FAIL ${id}#${r} error: ${o.error.slice(0, 160)}`);
    } else {
      write({ case: id, run: r, ...o });
      console.log(`${o.pass ? 'PASS' : 'FAIL'} ${id}#${r} ${(o.trace.ms / 1000).toFixed(1)}s ${o.pass ? '' : o.reason}`);
    }
  }
}
