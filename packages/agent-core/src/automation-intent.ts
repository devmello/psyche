import type { TurnContextProvider } from "./turn-context.ts";

/**
 * Task → automation, step 1: does the owner's request describe a repeatable workflow (a schedule,
 * "every", "each morning", a multi-step job to run again) or a one-off? A cheap lexical hint, not
 * a gate: it nudges the model through `AUTOMATION_HINT` and the prompt's guidance decides. It
 * leans to `one_off`; a missed workflow costs one sentence from the owner, a false one costs a
 * detour into planning. Words only, no model call.
 */

export interface AutomationIntent {
  kind: "workflow" | "one_off";
  /** The cues that fired, for tests and traces. */
  signals: string[];
}

const RECURRENCE: [string, RegExp][] = [
  [
    "every",
    /\bevery\s+(?:day|morning|evening|night|week|weekday|weekend|hour|\d+|mon|tue|wed|thu|fri|sat|sun)/i,
  ],
  ["each", /\beach\s+(?:day|morning|evening|night|week|weekday)\b/i],
  ["cadence", /\b(?:daily|nightly|weekly|hourly|monthly|on weekdays|on a schedule|recurring)\b/i],
  ["automation", /\b(?:automat(?:e|ion|ically)|set up a routine)\b/i],
  ["again", /\b(?:check|run|look)s?\s+(?:it\s+|them\s+)?again\b/i],
  ["whenever", /\bwhenever\b/i],
];
const CLOCK = /\b(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\bat\s+\d{1,2}:\d{2}\b/gi;
const SEQUENCE = /\b(?:and then|then|after that|afterwards|later)\b/i;
const QUESTION = /^\s*(?:how|what|why|when|which|who|can you explain|explain)\b/i;

export function classifyAutomationIntent(text: string): AutomationIntent {
  const signals: string[] = [];
  for (const [name, re] of RECURRENCE) if (re.test(text)) signals.push(name);
  const clocks = text.match(CLOCK)?.length ?? 0;
  if (clocks >= 2) signals.push("several_times");
  if (signals.length > 0 && SEQUENCE.test(text)) signals.push("multi_step");
  // A question about scheduling is not a request to build one.
  if (QUESTION.test(text)) return { kind: "one_off", signals: [] };
  return { kind: signals.length > 0 ? "workflow" : "one_off", signals };
}

/** Added to an owner turn that reads as a workflow. Trusted: it is our own text. */
export const AUTOMATION_HINT =
  "This request looks like a repeatable workflow, not a one-off. Follow the automation steps: plan it with update_plan, trial-run it with the owner, then offer to schedule it with propose_automation. If the owner only wants it done once, just do it.";

/** The turn-context provider for the hint; owner turns in attended runs only. */
export function automationIntentProvider(): TurnContextProvider {
  return {
    name: "automation-intent",
    async provide(input) {
      if (input.mode !== "attended") return undefined;
      if (classifyAutomationIntent(input.text).kind !== "workflow") return undefined;
      return {
        sections: [{ title: "Automation", text: AUTOMATION_HINT }],
        source: { sourceKind: "automation_intent" },
        trusted: true,
      };
    },
  };
}
