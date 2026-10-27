// The six-case capability probe (B4) plus a throughput bench.
// Every case streams through streamText so we see the same parts the agent loop would.
import { isStepCount, Output, streamText, tool, type LanguageModel, type ToolSet } from 'ai';
import { z } from 'zod';

export const SYSTEM =
  'You are Psyche, a personal agent running on the user\'s Mac. Use the provided tools when they help. ' +
  'Call tools by their exact names with arguments that match their schemas. ' +
  'If no provided tool can do what the user asks, say so plainly instead of pretending. Today is 2026-10-19.';

export type ToolCallRecord = { step: number; name: string; input: unknown };

export type Trace = {
  ms: number;
  ttftMs: number | null; // first text or reasoning delta, or first tool-input part
  firstTextMs: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  inputTokens: number | null;
  tps: number | null; // output tokens / (end - first token)
  steps: number;
  calls: ToolCallRecord[];
  toolErrors: string[];
  text: string;
  reasoningChars: number;
  partCounts: Record<string, number>;
  finishReasons: string[];
  streamErrors: string[];
};

export type CaseOutcome = { pass: boolean; reason: string; trace: Trace; extra?: unknown };

type DriveOpts = {
  prompt: string;
  tools?: ToolSet;
  steps?: number;
  output?: ReturnType<typeof Output.object>;
  maxOutputTokens?: number;
  timeoutMs: number;
  system?: string;
};

// 'none' turns thinking off, 'medium' turns it on, undefined leaves the provider default.
// The default differs per provider: ollama-ai-provider-v2 sends think:false, the OpenAI- and
// Anthropic-compatible providers send nothing and the model's template decides.
export type Reasoning = 'none' | 'medium' | undefined;
let reasoning: Reasoning;
export const setReasoning = (r: Reasoning) => (reasoning = r);

export async function drive(model: LanguageModel, o: DriveOpts) {
  const t0 = performance.now();
  const trace: Trace = {
    ms: 0, ttftMs: null, firstTextMs: null, outputTokens: null, reasoningTokens: null, inputTokens: null,
    tps: null, steps: 0, calls: [], toolErrors: [], text: '', reasoningChars: 0, partCounts: {},
    finishReasons: [], streamErrors: [],
  };
  const abort = AbortSignal.timeout(o.timeoutMs);
  const result = streamText({
    model,
    system: o.system ?? SYSTEM,
    prompt: o.prompt,
    tools: o.tools,
    stopWhen: isStepCount(o.steps ?? 1),
    output: o.output,
    maxOutputTokens: o.maxOutputTokens ?? 4096,
    maxRetries: 0,
    reasoning,
    abortSignal: abort,
  });
  let step = 0;
  for await (const p of result.fullStream) {
    trace.partCounts[p.type] = (trace.partCounts[p.type] ?? 0) + 1;
    const now = performance.now() - t0;
    if (
      trace.ttftMs === null &&
      (p.type === 'text-delta' || p.type === 'reasoning-delta' || p.type === 'tool-input-start' || p.type === 'tool-call')
    )
      trace.ttftMs = now;
    switch (p.type) {
      case 'text-delta':
        if (trace.firstTextMs === null) trace.firstTextMs = now;
        trace.text += p.text;
        break;
      case 'reasoning-delta':
        trace.reasoningChars += p.text.length;
        break;
      case 'tool-call':
        trace.calls.push({ step, name: p.toolName, input: p.input });
        break;
      case 'tool-error':
        trace.toolErrors.push(`${p.toolName}: ${String((p.error as Error)?.message ?? p.error).slice(0, 300)}`);
        break;
      case 'finish-step':
        trace.finishReasons.push(p.finishReason);
        step++;
        break;
      case 'error':
        trace.streamErrors.push(String((p.error as Error)?.message ?? p.error).slice(0, 500));
        break;
    }
  }
  trace.ms = performance.now() - t0;
  trace.steps = step;
  const usage = await Promise.resolve(result.totalUsage).catch(() => undefined);
  if (usage) {
    trace.outputTokens = usage.outputTokens ?? null;
    trace.inputTokens = usage.inputTokens ?? null;
    trace.reasoningTokens = usage.outputTokenDetails?.reasoningTokens ?? null;
    if (trace.outputTokens && trace.ttftMs !== null && trace.ms > trace.ttftMs)
      trace.tps = trace.outputTokens / ((trace.ms - trace.ttftMs) / 1000);
  }
  return { trace, result };
}

// ---------- tools ----------

const weatherInput = z.object({
  city: z.string().describe('City name, e.g. "Paris"'),
  unit: z.enum(['celsius', 'fahrenheit']),
});
const timeInput = z.object({ timezone: z.string().describe('IANA time zone, e.g. "Europe/Paris"') });

// Tools always execute; single-step cases stop after the first step anyway.
const weatherTools = () => ({
  get_weather: tool({
    description: 'Get the current weather for a city.',
    inputSchema: weatherInput,
    execute: async ({ city }) => ({ city, temperature: 18, conditions: 'sunny' }),
  }),
  get_time: tool({
    description: 'Get the current local time in an IANA time zone.',
    inputSchema: timeInput,
    execute: async ({ timezone }) => ({ timezone, time: '2026-10-19T21:04:00' }),
  }),
});

const TRACKING = '1Z9X4E770312345678';

const orderTools = {
  lookup_order: tool({
    description: 'Look up an order by its id. Returns status, carrier and tracking number.',
    inputSchema: z.object({ order_id: z.string() }),
    execute: async ({ order_id }) =>
      order_id.includes('4471')
        ? { order_id, status: 'shipped', carrier: 'UPS', tracking_number: TRACKING }
        : { error: `no order ${order_id}` },
  }),
  track_package: tool({
    description: 'Track a package with a carrier and tracking number.',
    inputSchema: z.object({
      carrier: z.enum(['UPS', 'FedEx', 'USPS', 'DHL']),
      tracking_number: z.string(),
    }),
    execute: async ({ tracking_number }) =>
      tracking_number === TRACKING
        ? { status: 'in transit', location: 'Reno, NV', eta: '2026-10-22' }
        : { error: 'unknown tracking number' },
  }),
};

const checklistItem = z.object({
  id: z.number().int(),
  text: z.string(),
  status: z.enum(['pending', 'in_progress', 'done']),
});

function planTools() {
  const state = { checklist: [] as z.infer<typeof checklistItem>[] };
  const ok = (what: string) => async () => ({ ok: true, did: what });
  return {
    state,
    tools: {
      update_checklist: tool({
        description:
          'Replace the task checklist. Send the full list every time with each item\'s current status.',
        inputSchema: z.object({ items: z.array(checklistItem) }),
        execute: async ({ items }) => {
          state.checklist = items;
          return { ok: true, items: items.length };
        },
      }),
      make_dir: tool({
        description: 'Create a directory (and parents).',
        inputSchema: z.object({ path: z.string() }),
        execute: ok('make_dir'),
      }),
      write_file: tool({
        description: 'Write a text file, replacing it if it exists.',
        inputSchema: z.object({ path: z.string(), content: z.string() }),
        execute: ok('write_file'),
      }),
      schedule_cron: tool({
        description: 'Add a crontab entry. schedule is a standard 5-field cron expression.',
        inputSchema: z.object({ schedule: z.string(), command: z.string() }),
        execute: ok('schedule_cron'),
      }),
      run_command: tool({
        description: 'Run a shell command and return its output.',
        inputSchema: z.object({ command: z.string() }),
        execute: async () => ({ exit_code: 0, stdout: 'sending incremental file list\n(dry run) 42 files' }),
      }),
    },
  };
}

// ---------- cases ----------

export type CaseId = 'single_tool' | 'parallel_tools' | 'tool_result_followup' | 'strict_json' | 'plan_checklist' | 'no_hallucination';
export const CASES: CaseId[] = ['single_tool', 'parallel_tools', 'tool_result_followup', 'strict_json', 'plan_checklist', 'no_hallucination'];

const FAKE_CALL_IN_TEXT = /<tool_call>|<\|channel\|>|<\|call\|>|"name"\s*:\s*"(get_|book|reserve)|\bbook_table\b|<function[=>]/i;
const REASONING_IN_TEXT = /<think>|<\/think>|<\|channel\|>analysis|<\|start\|>/;

function lint(t: Trace): string[] {
  const issues: string[] = [];
  if (t.streamErrors.length) issues.push(`stream error: ${t.streamErrors[0]}`);
  if (t.toolErrors.length) issues.push(`tool error: ${t.toolErrors[0]}`);
  if (REASONING_IN_TEXT.test(t.text)) issues.push('reasoning tags leaked into text');
  return issues;
}

function verdict(trace: Trace, checks: [boolean, string][], extra?: unknown): CaseOutcome {
  const failed = [...lint(trace).map((m) => [false, m] as [boolean, string]), ...checks].filter(([ok]) => !ok);
  return { pass: failed.length === 0, reason: failed.map(([, m]) => m).join('; ') || 'ok', trace, extra };
}

export async function runCase(id: CaseId, model: LanguageModel, timeoutMs: number): Promise<CaseOutcome> {
  switch (id) {
    case 'single_tool': {
      const { trace } = await drive(model, {
        prompt: 'What is the weather in Lisbon right now? Use celsius.',
        tools: weatherTools(),
        timeoutMs,
      });
      const c = trace.calls;
      const w = c[0]?.input as z.infer<typeof weatherInput> | undefined;
      return verdict(trace, [
        [c.length === 1, `expected 1 call, got ${c.length}`],
        [c[0]?.name === 'get_weather', `wrong tool ${c[0]?.name}`],
        [/lisbon|lisboa/i.test(w?.city ?? ''), `city=${w?.city}`],
        [w?.unit === 'celsius', `unit=${w?.unit}`],
      ]);
    }
    case 'parallel_tools': {
      const { trace } = await drive(model, {
        prompt:
          'I need two things at once: the current weather in Paris in celsius, and the current time in Tokyo. ' +
          'Call both tools in this same turn, in parallel.',
        tools: weatherTools(),
        timeoutMs,
      });
      const first = trace.calls.filter((c) => c.step === 0);
      const w = first.find((c) => c.name === 'get_weather')?.input as z.infer<typeof weatherInput> | undefined;
      const t = first.find((c) => c.name === 'get_time')?.input as z.infer<typeof timeInput> | undefined;
      return verdict(trace, [
        [first.length === 2, `expected 2 calls in step 1, got ${first.length}`],
        [/paris/i.test(w?.city ?? ''), `weather city=${w?.city}`],
        [/tokyo/i.test(t?.timezone ?? ''), `timezone=${t?.timezone}`],
      ]);
    }
    case 'tool_result_followup': {
      const { trace } = await drive(model, {
        prompt: 'Where is my order 4471 right now? Look up the order, then track its package.',
        tools: orderTools,
        steps: 4,
        timeoutMs,
      });
      const look = trace.calls.find((c) => c.name === 'lookup_order');
      const track = trace.calls.find((c) => c.name === 'track_package');
      const ti = track?.input as { carrier?: string; tracking_number?: string } | undefined;
      return verdict(trace, [
        [!!look && String((look.input as { order_id?: string }).order_id).includes('4471'), 'lookup_order(4471) missing'],
        [!!track && !!look && track.step > look.step, 'track_package not called after lookup result'],
        [ti?.tracking_number === TRACKING, `tracking_number=${ti?.tracking_number}`],
        [ti?.carrier === 'UPS', `carrier=${ti?.carrier}`],
        [/reno/i.test(trace.text), 'final answer does not mention Reno'],
      ]);
    }
    case 'strict_json': {
      const schema = z.object({
        title: z.string(),
        priority: z.enum(['low', 'medium', 'high']),
        due: z.string().describe('ISO date YYYY-MM-DD'),
        tags: z.array(z.string()),
      });
      const { trace, result } = await drive(model, {
        prompt:
          'Extract a task from this note: "remind me to renew my passport by March 3rd 2027, it\'s urgent, tag it travel and admin". ' +
          'Use priority high for urgent things.',
        output: Output.object({ schema }),
        timeoutMs,
      });
      let obj: z.infer<typeof schema> | undefined;
      let parseErr = '';
      try {
        obj = (await result.output) as z.infer<typeof schema>;
      } catch (e) {
        parseErr = String((e as Error).message).slice(0, 200);
      }
      const tags = (obj?.tags ?? []).map((s) => s.toLowerCase());
      return verdict(
        trace,
        [
          [!!obj, `no valid object: ${parseErr}`],
          [/passport/i.test(obj?.title ?? ''), `title=${obj?.title}`],
          [obj?.priority === 'high', `priority=${obj?.priority}`],
          // A date-time on the right day is accepted; the probe tests schema adherence, not date style.
          [/^2027-03-03/.test(obj?.due ?? ''), `due=${obj?.due}`],
          [tags.includes('travel') && tags.includes('admin'), `tags=${tags.join(',')}`],
          [!/^\s*```/.test(trace.text), 'wrapped in a code fence'],
        ],
        obj,
      );
    }
    case 'plan_checklist': {
      const { state, tools } = planTools();
      const { trace } = await drive(model, {
        prompt:
          'Set up a weekly backup of ~/Documents. Steps: (1) create the directory /Volumes/Backup/docs; ' +
          '(2) write ~/bin/backup.sh, a script that rsyncs ~/Documents/ into /Volumes/Backup/docs/; ' +
          '(3) schedule ~/bin/backup.sh with cron for every Sunday at 02:00; (4) do a dry run with `sh ~/bin/backup.sh --dry-run`. ' +
          'Before doing anything, record the four steps with update_checklist (all pending). ' +
          'Then do the steps in order, and after each one call update_checklist again marking it done. ' +
          'Finish with a one-line summary.',
        tools,
        steps: 16,
        timeoutMs,
      });
      const names = trace.calls.map((c) => c.name);
      const work = ['make_dir', 'write_file', 'schedule_cron', 'run_command'];
      const firstIdx = work.map((w) => names.indexOf(w));
      const inOrder = firstIdx.every((v, i) => v >= 0 && (i === 0 || v > firstIdx[i - 1]!));
      const firstCall = trace.calls[0];
      const rawItems = (firstCall?.input as { items?: unknown } | undefined)?.items;
      const initial = Array.isArray(rawItems) ? (rawItems as { status?: string }[]) : [];
      const cron = trace.calls.find((c) => c.name === 'schedule_cron')?.input as { schedule?: string } | undefined;
      const script = trace.calls.find((c) => c.name === 'write_file')?.input as { content?: string } | undefined;
      const updates = names.filter((n) => n === 'update_checklist').length;
      return verdict(
        trace,
        [
          [firstCall?.name === 'update_checklist', `first call was ${firstCall?.name}`],
          [initial.length >= 4 && initial.every((i) => i.status !== 'done'), `initial checklist ${initial.length} items`],
          [inOrder, `work order ${names.filter((n) => work.includes(n)).join('>')}`],
          [updates >= 3, `only ${updates} checklist updates`],
          [state.checklist.length >= 4 && state.checklist.every((i) => i.status === 'done'), 'final checklist not all done'],
          [/^0 2 \* \* (0|7|sun)$/i.test((cron?.schedule ?? '').trim()), `cron=${cron?.schedule}`],
          [/rsync/.test(script?.content ?? ''), 'script lacks rsync'],
          [trace.text.trim().length > 0, 'no final summary'],
        ],
        { calls: names },
      );
    }
    case 'no_hallucination': {
      const { trace } = await drive(model, {
        prompt: 'Book me a table for two at Nopa in San Francisco tonight at 8pm.',
        tools: weatherTools(),
        steps: 3,
        timeoutMs,
      });
      return verdict(trace, [
        [trace.calls.length === 0, `made calls: ${trace.calls.map((c) => c.name).join(',')}`],
        [!FAKE_CALL_IN_TEXT.test(trace.text), 'fake tool call in text'],
        [trace.text.trim().length > 0, 'no answer'],
        [!/\b(i('ve| have) (booked|reserved)|is (booked|confirmed)|reservation (is )?confirmed)\b/i.test(trace.text), 'claims it booked'],
      ]);
    }
  }
}

export async function bench(model: LanguageModel, timeoutMs: number) {
  const { trace } = await drive(model, {
    prompt: 'Write exactly five sentences about the history of the bicycle.',
    maxOutputTokens: 1024,
    timeoutMs,
  });
  return trace;
}
