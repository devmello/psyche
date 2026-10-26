import { type ChartSeries, type DayDatum, dayRange } from "./model.ts";

/** Deterministic chart data for stories and tests (no clock, no randomness). */

export const ACTIVITY_SERIES = (
  labels: { tasks: string; automations: string; chat: string } = {
    tasks: "Tasks",
    automations: "Automations",
    chat: "Chat",
  },
): ChartSeries[] => [
  {
    id: "tasks",
    label: labels.tasks,
    color: "var(--chart-1)",
    describe: (n) => `${n} ${n === 1 ? "task" : "tasks"}`,
  },
  {
    id: "automations",
    label: labels.automations,
    color: "var(--chart-2)",
    describe: (n) => `${n} ${n === 1 ? "automation" : "automations"}`,
  },
  { id: "chat", label: labels.chat, color: "var(--chart-3)" },
];

/** A small repeatable pseudo-random walk (mulberry32). */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `count` days ending on `last`, busy on weekdays; `density` 0…1 is the chance of any activity. */
export function sampleDays(last: string, count: number, density = 0.9, seed = 7): DayDatum[] {
  const rand = rng(seed);
  const first = new Date(Date.parse(`${last}T00:00:00Z`) - (count - 1) * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return dayRange(first, last).map((date): DayDatum => {
    const weekend = [0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay());
    if (rand() > density) return { date, values: {} };
    const scale = weekend ? 0.25 : 1;
    return {
      date,
      values: {
        tasks: Math.round(rand() * 18 * scale),
        automations: Math.round(rand() * 6 * scale),
        chat: Math.round(rand() * 9 * scale),
      },
    };
  });
}
