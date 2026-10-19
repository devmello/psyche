import { auditExitCode, auditRules, parseSeverity } from "../audit.ts";
import { bool, type CommandSpec, str } from "../command.ts";
import { doctorChecks, doctorExitCode } from "../doctor.ts";
import { CliError } from "../errors.ts";
import { statusLine, table } from "../output.ts";
import { gatherSnapshot } from "../snapshot.ts";

export const diagnosticsCommands: CommandSpec[] = [
  {
    path: ["doctor"],
    summary: "Check config, bind address, auth, sandbox, models, helper permissions and disk",
    description: "Exits 1 when a check fails (and on warnings with --strict).",
    options: {
      strict: { type: "boolean", description: "Treat warnings as failures" },
      offline: {
        type: "boolean",
        description: "Do not connect to the Gateway (HTTP probe and local checks only)",
      },
    },
    async run(ctx, { opts }) {
      const snapshot = await gatherSnapshot(ctx, { connect: !bool(opts, "offline") });
      const checks = doctorChecks(snapshot);
      const exitCode = doctorExitCode(checks, bool(opts, "strict"));
      return {
        data: { ok: exitCode === 0, checks },
        human: checks
          .map((c) =>
            statusLine(
              c.status,
              `${c.id}: ${c.message}${c.hint && c.status !== "ok" ? `\n       → ${c.hint}` : ""}`,
            ),
          )
          .join("\n"),
        exitCode,
      };
    },
  },
  {
    path: ["security", "audit"],
    summary:
      "Flag risky configuration: open DMs, exposed binds, disabled sandbox, unverified skills, …",
    description:
      "Exits 1 when a finding at --fail-at or above exists (default low). Data the Gateway cannot provide yet is listed as not checked.",
    options: {
      "fail-at": {
        type: "string",
        description: "critical | high | medium | low | info (default low)",
        choices: ["critical", "high", "medium", "low", "info"],
      },
    },
    async run(ctx, { opts }) {
      let failAt: ReturnType<typeof parseSeverity>;
      try {
        failAt = parseSeverity(str(opts, "fail-at"));
      } catch (err) {
        throw new CliError("usage", (err as Error).message);
      }
      const snapshot = await gatherSnapshot(ctx, { connect: true });
      const report = auditRules(snapshot, ctx.deps.now());
      const exitCode = auditExitCode(report, failAt);
      const lines = [
        report.findings.length
          ? table(report.findings as never, {
              severity: "severity",
              id: "id",
              finding: "message",
              fix: "fix",
            })
          : "No findings.",
      ];
      if (report.notChecked.length) {
        lines.push("", "Not checked:", ...report.notChecked.map((n) => `  ${n.rule}: ${n.reason}`));
      }
      return { data: { ok: exitCode === 0, ...report }, human: lines.join("\n"), exitCode };
    },
  },
];
