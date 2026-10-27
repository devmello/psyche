// Aggregate results/results.jsonl into markdown tables for the write-up.
// Usage: tsx src/report.ts [results/results.jsonl] > results/matrix.md
import { readFileSync } from 'node:fs';
import { CASES } from './cases.ts';

type Row = {
  endpoint: string; model: string; reasoning: string; case: string; pass?: boolean; reason?: string; error?: string;
  trace?: { ms: number; ttftMs: number | null; tps: number | null; outputTokens: number | null; reasoningChars: number; partCounts: Record<string, number> };
};

const file = process.argv[2] ?? 'results/results.jsonl';
const rows: Row[] = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
// Re-score strict_json rows recorded before the due-date check accepted a date-time prefix.
for (const r of rows) {
  if (r.case !== 'strict_json' || r.pass || !r.reason) continue;
  const rest = r.reason.split('; ').filter((m) => !/^due=2027-03-03/.test(m));
  if (rest.length === 0) { r.pass = true; r.reason = 'ok (date-time accepted)'; } else r.reason = rest.join('; ');
}
const key = (r: Row) => `${r.model}|${r.endpoint}|${r.reasoning}`;
const groups = new Map<string, Row[]>();
for (const r of rows) groups.set(key(r), [...(groups.get(key(r)) ?? []), r]);

const SHORT: Record<string, string> = {
  single_tool: 'single', parallel_tools: 'parallel', tool_result_followup: 'follow-up',
  strict_json: 'json', plan_checklist: 'plan', no_hallucination: 'refuse',
};
const median = (xs: number[]) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : NaN;
};
const f0 = (x: number) => (Number.isFinite(x) ? x.toFixed(0) : '–');
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '–');

console.log(`| model | endpoint | think | ${CASES.map((c) => SHORT[c]).join(' | ')} | score | verdict | tok/s | TTFT ms | median case s |`);
console.log(`|---|---|---|${CASES.map(() => '---').join('|')}|---|---|---|---|---|`);
const sorted = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
for (const [k, rs] of sorted) {
  const [model, endpoint, think] = k.split('|');
  let passedCases = 0;
  const cells = CASES.map((c) => {
    const runs = rs.filter((r) => r.case === c);
    if (!runs.length) return '·';
    const p = runs.filter((r) => r.pass).length;
    if (p === runs.length) passedCases++;
    return `${p}/${runs.length}`;
  });
  const b = rs.filter((r) => r.case === 'bench' && r.trace).at(-1)?.trace;
  const caseMs = median(rs.filter((r) => r.case !== 'bench' && r.trace).map((r) => r.trace!.ms));
  // agent-capable = every case passed on every run (see B4 probe definition in the write-up)
  const complete = CASES.every((c) => rs.some((r) => r.case === c));
  const verdict = !complete ? 'incomplete' : passedCases === CASES.length ? '**agent-capable**' : 'chat-only';
  console.log(
    `| ${model} | ${endpoint} | ${think} | ${cells.join(' | ')} | ${passedCases}/${CASES.length} | ${verdict} | ${f1(b?.tps ?? NaN)} | ${f0(b?.ttftMs ?? NaN)} | ${f1(caseMs / 1000)} |`,
  );
}

console.log('\n### Failure reasons\n');
for (const [k, rs] of sorted) {
  const fails = rs.filter((r) => r.case !== 'bench' && !r.pass);
  if (!fails.length) continue;
  console.log(`- **${k.replaceAll('|', ' · ')}**`);
  const seen = new Map<string, number>();
  for (const f of fails) {
    const m = `${SHORT[f.case] ?? f.case}: ${(f.reason ?? f.error ?? '').slice(0, 160)}`;
    seen.set(m, (seen.get(m) ?? 0) + 1);
  }
  for (const [m, n] of seen) console.log(`  - ${m}${n > 1 ? ` (×${n})` : ''}`);
}
