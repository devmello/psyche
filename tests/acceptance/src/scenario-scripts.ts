import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ResumabilityScript,
  ResumabilityTool,
  ScriptStep,
} from "../../../packages/testing/src/resumability/index.ts";
import type { PolicyConfig } from "../../../packages/testing/src/resumability/stack.ts";
import type { Scenario, ScriptCall } from "../../../packages/testing/src/scenarios/types.ts";
import { ROOT } from "./report.ts";

/**
 * The three acceptance scenarios as resumability scripts (tests/scenarios/README.md
 * "Resumability": INT-3 kills at `randomKills` random points per scenario on the real stack).
 *
 * S18's harness runs one Task per script with a compliant model and an owner who approves every
 * card, so a script holds the scenario's happy path: every scripted tool call the owner lets
 * through, in order. Calls the scenario expects to be denied, blocked, expired or to fail, the
 * hijacked probes and the retries after a tampered argument are left to the scripted runner; they
 * are not resumability material (nothing to duplicate).
 */

export const SCENARIOS_DIR = join(ROOT, "tests/scenarios");
export const SCENARIO_IDS = [
  "v1-inbox-triage",
  "v2-calendar-planning",
  "v3-shopping",
  "v4-travel",
  "v7-research-brief",
] as const;
export type ScenarioId = (typeof SCENARIO_IDS)[number];

/** Milestone 2 scenarios (INT-3, tests/acceptance/scenarios-m2), same format. */
export const M2_SCENARIOS_DIR = join(ROOT, "tests/acceptance/scenarios-m2");
export const M2_SCENARIO_IDS = [
  "v5-permission-slip",
  "v6-messages-voice-note",
  "v8-subscription-audit",
  "v9-weekly-review",
] as const;
export type M2ScenarioId = (typeof M2_SCENARIO_IDS)[number];

/** Calls on the happy path by `expect`, but excluded by hand, with the reason. */
const EXCLUDED: Record<string, Record<string, string>> = {
  "v1-inbox-triage": {
    c_v1_send_lena_2: "the retry after the tampered send (fault step s8); the first send stands",
  },
};

interface ToolInfo {
  name: string;
  sideEffect: "none" | "read" | "write" | "destructive" | "financial";
  targetKind: string | null;
  approvalKind?: string;
  receiptKind?: string;
}

export interface ScenarioScript {
  id: ScenarioId | M2ScenarioId;
  script: ResumabilityScript;
  tools: ResumabilityTool[];
  policy: PolicyConfig;
  /** The scenario's `resumability.randomKills`. */
  randomKills: number;
  /** Scripted call ids that were left out, with the reason. */
  excluded: Record<string, string>;
}

const UNSAFE = new Set(["write", "destructive", "financial"]);

function targetOf(info: ToolInfo, input: Record<string, unknown>): string | undefined {
  switch (info.targetKind) {
    case "account":
      return typeof input.account === "string" ? input.account : undefined;
    case "recipient": {
      const to = input.to;
      return Array.isArray(to) && typeof to[0] === "string" ? to[0] : undefined;
    }
    case "origin": {
      if (info.name === "search.web") return "https://api.search.brave.com";
      try {
        // Shopping tools name the store (`merchant`), travel tools the airline.
        return new URL(String(input.url ?? input.merchant ?? input.airline)).origin;
      } catch {
        return undefined;
      }
    }
    default:
      return undefined;
  }
}

function toolFor(info: ToolInfo): ResumabilityTool {
  const unsafe = UNSAFE.has(info.sideEffect);
  const describe =
    info.approvalKind === undefined
      ? {}
      : {
          describe: (input: Record<string, unknown>) => {
            const value = targetOf(info, input);
            return {
              kind: info.approvalKind as never,
              ...(value === undefined || info.targetKind === null
                ? {}
                : { target: { kind: info.targetKind as never, value } }),
              summary: `${info.name}${value === undefined ? "" : ` ${value}`}`,
            };
          },
        };
  return {
    name: info.name,
    sideEffect: info.sideEffect,
    ...describe,
    call: unsafe
      ? (input, ctx) => ({ id: ctx.ledger.apply(info.name, input, ctx).providerId })
      : () => ({ ok: true, tool: info.name }),
  };
}

function onHappyPath(call: ScriptCall): boolean {
  const e = call.expect ?? {};
  if (e.decision === "deny") return false;
  return e.status === undefined || e.status === "ok";
}

/** Loads a scenario and derives its happy-path script, tools and policy. */
export function scenarioScript(id: ScenarioId | M2ScenarioId): ScenarioScript {
  const m2 = (M2_SCENARIO_IDS as readonly string[]).includes(id);
  const dir = join(m2 ? M2_SCENARIOS_DIR : SCENARIOS_DIR, id);
  const sc = JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8")) as Scenario & {
    resumability: { randomKills: number };
  };
  const infos = (JSON.parse(readFileSync(join(dir, sc.tools), "utf8")) as { tools: ToolInfo[] })
    .tools;
  const byName = new Map(infos.map((t) => [t.name, t]));
  const excluded = EXCLUDED[id] ?? {};
  const steps: ScriptStep[] = [];
  const used = new Set<string>();
  const claims: string[] = [];
  for (const step of sc.steps) {
    if (step.script === undefined || step.script.hijacked === true) continue;
    for (const turn of step.script.turns) {
      for (const call of turn.toolCalls ?? []) {
        if (!onHappyPath(call) || excluded[call.id] !== undefined) continue;
        const info = byName.get(call.tool);
        if (info === undefined) throw new Error(`${id}: ${call.tool} is not in ${sc.tools}`);
        used.add(call.tool);
        steps.push({ id: call.id, tool: call.tool, input: call.args });
        if (UNSAFE.has(info.sideEffect)) claims.push(call.id);
      }
    }
  }
  const first = sc.steps.find((s) => s.kind === "owner_message");
  steps.push({ id: "answer", text: `Done: ${sc.title}.`, claims });
  const tools = [...used].map((name) => toolFor(byName.get(name) as ToolInfo));
  const policy: PolicyConfig = {
    // Reads of a new origin ask (`new_origin`), as in V7; every other read is a standing allow.
    ask: tools.filter((t) => UNSAFE.has(t.sideEffect) || t.name === "fetch").map((t) => t.name),
    allow: tools.filter((t) => !UNSAFE.has(t.sideEffect) && t.name !== "fetch").map((t) => t.name),
  };
  return {
    id,
    script: { title: sc.title, goal: first?.text ?? sc.title, steps },
    tools,
    policy,
    randomKills: sc.resumability.randomKills,
    excluded,
  };
}
