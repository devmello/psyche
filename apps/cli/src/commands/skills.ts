import { bool, type CommandSpec } from "../command.ts";
import { table } from "../output.ts";
import { callOrUnavailable } from "./util.ts";

/**
 * `skills.*` has no protocol methods yet (S16 owns skills; requested in docs/status/s22.md). The
 * CLI calls them by name so it works as soon as the Gateway registers them; until then it
 * reports "not available on this Gateway" (exit 1, `{"available": false}`).
 *
 * Installing is never silent: the Gateway shows the full SKILL.md, runs the static scan and asks
 * for approval (security §11); the CLI only starts that flow.
 */
export const skillsCommands: CommandSpec[] = [
  {
    path: ["skills", "list"],
    summary: "List installed skills with provenance and verification state",
    async run(ctx) {
      const res = (await callOrUnavailable(await ctx.gateway(), "skills.list", {})) as {
        skills: Record<string, unknown>[];
      };
      return {
        data: res,
        human: table(res.skills ?? [], {
          name: "name",
          version: "version",
          provenance: "provenance",
          verified: "verified",
          eligible: "eligible",
        }),
      };
    },
  },
  {
    path: ["skills", "install"],
    summary: "Start installing a skill (review and approval happen in the app)",
    args: [{ name: "source", description: "Registry name, git URL or local path", required: true }],
    async run(ctx, { args }) {
      const res = (await callOrUnavailable(await ctx.gateway(), "skills.install", {
        source: args[0],
      })) as {
        approvalId?: string;
        status?: string;
      };
      return {
        data: res,
        human: res.approvalId
          ? `Install requested. Review the skill and approve it in the app (approval ${res.approvalId}).`
          : `Install: ${res.status ?? "requested"}`,
      };
    },
  },
  {
    path: ["skills", "verify"],
    summary: "Check installed skills against the lock file (source, version, content hash)",
    args: [{ name: "name", description: "One skill (default: all)" }],
    options: {
      strict: { type: "boolean", description: "Exit 1 on unverified or unpinned skills too" },
    },
    async run(ctx, { args, opts }) {
      const res = (await callOrUnavailable(
        await ctx.gateway(),
        "skills.verify",
        args[0] ? { name: args[0] } : {},
      )) as { results: { name: string; status: string; detail?: string }[] };
      const results = res.results ?? [];
      const bad = results.filter((r) =>
        bool(opts, "strict")
          ? r.status !== "ok"
          : r.status === "mismatch" || r.status === "missing",
      );
      return {
        data: res,
        human: table(results, { name: "name", status: "status", detail: "detail" }),
        exitCode: bad.length ? 1 : 0,
      };
    },
  },
];
