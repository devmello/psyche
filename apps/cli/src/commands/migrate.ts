import { existsSync } from "node:fs";
import { join } from "node:path";
import { listBackups } from "@psyche/backup";
import type { CommandSpec } from "../command.ts";
import { readConfig, validateConfig } from "../config-file.ts";
import type { Check } from "../doctor.ts";
import { toReport } from "../errors.ts";
import {
  appliedMigrations,
  knownMigrations,
  type MigrationPlan,
  planMigrations,
} from "../migrate.ts";
import { statusLine } from "../output.ts";
import { CLI_VERSION } from "../version.ts";

const DAY = 86_400_000;

export const migrateCommands: CommandSpec[] = [
  {
    path: ["migrate"],
    summary: "Check that this version can take over your data (run before starting an upgrade)",
    description:
      "The Gateway applies database migrations itself when it starts. This lists what it will apply and refuses a downgrade (data from a newer version) or an edited migration. Read-only: it never writes the database. Exit 1 on a blocker.",
    options: {
      check: {
        type: "boolean",
        description: "Only check (the default; migrations apply at Gateway start)",
      },
    },
    async run(ctx) {
      const checks: Check[] = [];
      const dbPath = ctx.env.PSYCHE_DB ?? join(ctx.home, "state", "psyche.sqlite");
      const known = knownMigrations();
      let plan: MigrationPlan | null = null;

      if (!existsSync(dbPath)) {
        checks.push({
          id: "database",
          status: "ok",
          message: `no database at ${dbPath} yet: a new install${known ? `; ${known.length} migrations apply at first start` : ""}`,
        });
      } else if (!known) {
        checks.push({
          id: "database",
          status: "warn",
          message: "this build cannot list its migrations; skipping the database check",
        });
      } else {
        try {
          plan = planMigrations(await appliedMigrations(dbPath), known);
          if (plan.unknown.length) {
            checks.push({
              id: "database",
              status: "fail",
              message: `the data is from a newer Psyche (${plan.unknown.length} migration(s) this version does not know: ${plan.unknown.slice(0, 3).join(", ")}). The Gateway would refuse to start.`,
              hint: "Install the newer version again, or restore a backup made with this version (docs/guides/upgrade.md)",
            });
          } else if (plan.modified.length) {
            checks.push({
              id: "database",
              status: "fail",
              message: `applied migration(s) differ from this build: ${plan.modified.join(", ")}`,
              hint: "Report it; do not start this build on this data",
            });
          } else {
            checks.push({
              id: "database",
              status: "ok",
              message: plan.pending.length
                ? `${plan.applied} migration(s) applied; ${plan.pending.length} will apply at the next Gateway start: ${plan.pending.join(", ")}`
                : `up to date (${plan.applied} migrations applied)`,
            });
          }
        } catch (err) {
          checks.push({
            id: "database",
            status: "fail",
            message: `cannot read ${dbPath}: ${toReport(err).message}`,
            hint: "Stop the Gateway and try again",
          });
        }
      }

      let configProblems: string[] = [];
      try {
        configProblems = validateConfig(readConfig(ctx.home).config);
      } catch (err) {
        configProblems = [toReport(err).message];
      }
      checks.push(
        configProblems.length
          ? {
              id: "config",
              status: "fail",
              message: `config.json: ${configProblems.join("; ")}`,
              hint: "Fix it with `psyche config set`",
            }
          : { id: "config", status: "ok", message: "config.json is valid for this version" },
      );

      const latest = listBackups(ctx.home)[0] ?? null;
      const age = latest
        ? ctx.deps.now().getTime() - Date.parse(latest.createdAt)
        : Number.POSITIVE_INFINITY;
      checks.push(
        age <= DAY
          ? {
              id: "backup",
              status: "ok",
              message: `latest backup ${latest?.file} is less than a day old`,
            }
          : {
              id: "backup",
              status: "warn",
              message: latest
                ? `latest backup ${latest.file} is ${Math.floor(age / DAY)} day(s) old`
                : "no backup in $PSYCHE_HOME/backups",
              hint: "psyche backup create (downgrading later means restoring it)",
            },
      );

      const probe = await ctx.probe().catch(() => null);
      const running = probe?.reachable ? (probe.version?.version ?? "unknown") : null;
      if (running) {
        checks.push({
          id: "gateway",
          status: running === CLI_VERSION ? "ok" : "warn",
          message:
            running === CLI_VERSION
              ? `the running Gateway is already ${running}`
              : `a Gateway ${running} is running; this CLI is ${CLI_VERSION}. Restart it after installing the new version (psyche restart)`,
        });
      }

      const blockers = checks.filter((c) => c.status === "fail").length;
      return {
        data: {
          ok: blockers === 0,
          cliVersion: CLI_VERSION,
          gatewayVersion: running,
          database: { path: dbPath, exists: existsSync(dbPath), ...(plan ?? {}) },
          configProblems,
          latestBackup: latest,
          checks,
        },
        human: [
          ...checks.map((c) =>
            statusLine(
              c.status,
              `${c.id}: ${c.message}${c.hint && c.status !== "ok" ? `\n       → ${c.hint}` : ""}`,
            ),
          ),
          "",
          blockers
            ? "Do not start this version on this data yet."
            : `Safe to start Psyche ${CLI_VERSION} on this data.`,
        ].join("\n"),
        exitCode: blockers ? 1 : 0,
      };
    },
  },
];
