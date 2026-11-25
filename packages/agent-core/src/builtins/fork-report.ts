import { ForkReport, PsycheError } from "@psyche/protocol";
import { defineTool, markBuiltinRegistration, type ToolRunContext } from "../registry.ts";
import type { TurnToolContext } from "./turn.ts";

/**
 * `fork_report` (fork-a-plan-2026.md §4.1): the one tool a plan-fork branch ends with. It is
 * `FORK_ONLY` (hidden outside a fork run, refused again by `readVerdict` outside a `fork` origin)
 * and `sideEffect: none`: it writes nothing itself. The loop hands the report to the Gateway's
 * `ForkReportHost`, which checks the citations and stores it (F2/F3); this module only enforces
 * the shape and the one-report rule.
 */

/** What the loop lends `fork_report`: file the branch's one report. */
export interface ForkReportTurnApi {
  file(report: ForkReport): Promise<{ filed: true }>;
}

/** The Gateway's host for filed reports (`AgentLoopOptions.forkReports`). */
export interface ForkReportHost {
  /**
   * Store the report of one branch. `report` is the model's text, unchecked: its `source` and
   * `unsourced` fields are already stripped (only the Gateway sets them).
   */
  file(input: {
    forkId: string;
    branchId: string;
    runId: string;
    toolCallId: string;
    report: ForkReport;
  }): Promise<void>;
}

function apiOf(ctx: ToolRunContext): ForkReportTurnApi {
  const api = (ctx as Partial<TurnToolContext>).turn?.forkReport;
  if (api === undefined) throw new PsycheError("forbidden", "fork_report is only for plan forks");
  return api;
}

const LISTS = ["steps", "costs", "dates", "people", "tradeoffs", "risks", "openQuestions"] as const;

/**
 * The first duplicate item id of a report (ids are unique across the whole report, §4.1), or
 * `undefined`. Exported for the tool's own tests.
 */
export function duplicateReportId(report: ForkReport): string | undefined {
  const seen = new Set<string>();
  for (const list of LISTS) {
    for (const item of report[list] as { id: string }[]) {
      if (seen.has(item.id)) return item.id;
      seen.add(item.id);
    }
  }
  return undefined;
}

/**
 * A copy of the report without the fields only the Gateway may set: `source` on a cite and
 * `unsourced` on an item. A model that sends them gets them dropped, never trusted.
 */
export function stripGatewayFields(report: ForkReport): ForkReport {
  const out = structuredClone(report) as unknown as Record<string, unknown>;
  for (const list of LISTS) {
    for (const item of out[list] as Record<string, unknown>[]) {
      delete item.unsourced;
      const cites = item.cites;
      if (Array.isArray(cites)) {
        for (const c of cites as Record<string, unknown>[]) delete c.source;
      }
    }
  }
  return out as unknown as ForkReport;
}

export const forkReportTool = markBuiltinRegistration(
  defineTool({
    name: "fork_report",
    description:
      "Plan forks only: file your branch's one report when your research is done. A summary, the steps (who does each: psyche or you), costs, dates, people affected, trade-offs, risks and open questions. Every cost, date, person, trade-off and risk cites the tool call and the id, message, event or URL it came from; an item you cannot cite is shown as an estimate. List anything you could not check as an open question. A second call is refused.",
    input: ForkReport,
    sideEffect: "none",
    describeCall: () => ({ summary: "Filed the branch report" }),
    run: async (report, ctx) => {
      const dup = duplicateReportId(report);
      if (dup !== undefined) {
        throw new PsycheError("invalid_params", `the report repeats the item id ${dup}`);
      }
      await apiOf(ctx).file(stripGatewayFields(report));
      return { output: { filed: true }, provenance: "trusted" };
    },
  }),
);
