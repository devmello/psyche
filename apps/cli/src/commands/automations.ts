import type { CommandSpec } from "../command.ts";
import { str } from "../command.ts";
import { table } from "../output.ts";
import { callOrUnavailable } from "./util.ts";

export const automationsCommands: CommandSpec[] = [
  {
    path: ["automations", "list"],
    summary: "List automations with their schedule and next run",
    options: {
      kind: {
        type: "string",
        description: "cron | interval | watch | heartbeat | briefing | reminder",
      },
    },
    async run(ctx, { opts }) {
      const kind = str(opts, "kind");
      const res = (await callOrUnavailable(
        await ctx.gateway(),
        "automations.list",
        kind ? { kind } : {},
      )) as {
        automations: Record<string, unknown>[];
      };
      return {
        data: res,
        human: table(res.automations, {
          id: "id",
          title: "title",
          kind: "kind",
          schedule: "schedule",
          enabled: "enabled",
          next: "nextRunAt",
          last: "lastStatus",
        }),
      };
    },
  },
  {
    path: ["automations", "run"],
    summary: "Run an automation now",
    args: [{ name: "id", description: "Automation id", required: true }],
    async run(ctx, { args }) {
      const res = (await callOrUnavailable(await ctx.gateway(), "automations.run", {
        automationId: args[0] as string,
      })) as { runId: string | null; taskId: string | null };
      return { data: res, human: `Started run ${res.runId ?? "-"} (task ${res.taskId ?? "-"})` };
    },
  },
  {
    path: ["automations", "pause"],
    summary: "Pause an automation (it stops firing until resumed)",
    args: [{ name: "id", description: "Automation id", required: true }],
    async run(ctx, { args }) {
      const res = await callOrUnavailable(await ctx.gateway(), "automations.update", {
        automationId: args[0] as string,
        enabled: false,
      });
      return { data: res, human: `Paused ${args[0]}` };
    },
  },
  {
    path: ["automations", "resume"],
    summary: "Resume a paused automation",
    args: [{ name: "id", description: "Automation id", required: true }],
    async run(ctx, { args }) {
      const res = await callOrUnavailable(await ctx.gateway(), "automations.update", {
        automationId: args[0] as string,
        enabled: true,
      });
      return { data: res, human: `Resumed ${args[0]}` };
    },
  },
];
