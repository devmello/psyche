import { auditExitCode, auditRules, parseSeverity } from "../audit.ts";
import { bool, type CommandSpec, str } from "../command.ts";
import { doctorChecks, doctorExitCode } from "../doctor.ts";
import { CliError } from "../errors.ts";
import { statusLine, table } from "../output.ts";
import { gatherSnapshot } from "../snapshot.ts";
import { callOrUnavailable } from "./util.ts";

interface AuditVerifyResult {
  ok: boolean;
  count?: number;
  anchors?: number;
  signedAnchors?: number;
  anchorKeyIds?: string[];
  signingSinceSeq?: number;
  brokenAtSeq?: number;
  reason?: string;
  file?: string;
  line?: number;
}

/** `psyche audit verify`'s report: the chain, then the anchors and who signed them. */
export function auditVerifyLines(r: AuditVerifyResult): string[] {
  if (!r.ok) {
    const where =
      r.file === undefined ? "" : ` (${r.file}${r.line === undefined ? "" : `:${r.line}`})`;
    return [statusLine("fail", `Audit log broken at entry ${r.brokenAtSeq}: ${r.reason}${where}`)];
  }
  const lines = [statusLine("ok", `Hash chain intact: ${r.count ?? 0} entries`)];
  if (r.signedAnchors === undefined) {
    lines.push(
      statusLine("warn", `${r.anchors ?? 0} anchors, signatures not checked (no anchor key)`),
    );
  } else {
    const keys = r.anchorKeyIds?.length ? r.anchorKeyIds.join(", ") : "none yet";
    lines.push(
      statusLine(
        "ok",
        `${r.signedAnchors} of ${r.anchors ?? 0} anchors signed and verified (keys: ${keys}); signing since entry ${r.signingSinceSeq ?? 0}`,
      ),
    );
  }
  return lines;
}

export const diagnosticsCommands: CommandSpec[] = [
  {
    path: ["audit", "verify"],
    summary: "Verify the audit log: hash chain, anchors and their signatures",
    description:
      "Exits 1 when the chain is broken, an anchor is missing, forged or does not match, or the log is shorter than the last signed anchor.",
    async run(ctx) {
      const client = await ctx.gateway();
      const r = (await callOrUnavailable(client, "audit.verify", {})) as AuditVerifyResult;
      return { data: r, human: auditVerifyLines(r).join("\n"), exitCode: r.ok ? 0 : 1 };
    },
  },
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
