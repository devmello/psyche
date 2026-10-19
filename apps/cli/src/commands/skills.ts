import { resolve } from "node:path";
import { bool, type CommandSpec, str } from "../command.ts";
import { table } from "../output.ts";
import { callOrUnavailable } from "./util.ts";

/**
 * Skills (architecture §13; security §11; protocol `skills.*`, owner S16). Installing is never
 * silent: `skills.proposeInstall` fetches and scans the skill and opens a device-only
 * `skill_install` approval; the owner reviews the full SKILL.md and every file in the app, and
 * only then does `skills.install` run. The CLI starts that flow and prints the approval id.
 */

interface SkillRow {
  name: string;
  source: string;
  trust: string;
  status: string;
  enabled: boolean;
  version?: string;
  reasons?: string[];
}

/** Statuses that mean the installed files are not what was approved or cannot run. */
const BROKEN = new Set(["hash_mismatch", "invalid", "blocked"]);
/** With `--strict`, also anything not reviewed and pinned. */
const UNREVIEWED = new Set(["unlocked", "draft"]);

export type SkillInstallSource =
  | { kind: "path"; path: string }
  | { kind: "git"; url: string; ref: string }
  | { kind: "zip"; path: string };

/** `https://…`, `git@…` or `*.git` → git; `*.zip` → zip; anything else → a local folder. */
export function parseSkillSource(raw: string, ref = "HEAD"): SkillInstallSource {
  if (/^(https?:\/\/|ssh:\/\/|git@|git\+)/.test(raw) || raw.endsWith(".git")) {
    return { kind: "git", url: raw.replace(/^git\+/, ""), ref };
  }
  if (raw.toLowerCase().endsWith(".zip")) return { kind: "zip", path: resolve(raw) };
  return { kind: "path", path: resolve(raw) };
}

async function listSkills(ctx: Parameters<CommandSpec["run"]>[0]): Promise<SkillRow[]> {
  const res = (await callOrUnavailable(await ctx.gateway(), "skills.list", {})) as {
    skills: SkillRow[];
  };
  return res.skills ?? [];
}

export const skillsCommands: CommandSpec[] = [
  {
    path: ["skills", "list"],
    summary: "List skills with source, trust and status",
    async run(ctx) {
      const skills = await listSkills(ctx);
      return {
        data: { skills },
        human: table(skills as never, {
          name: "name",
          version: "version",
          source: "source",
          trust: "trust",
          status: "status",
          enabled: "enabled",
        }),
      };
    },
  },
  {
    path: ["skills", "install"],
    summary: "Propose installing a skill; you review and approve it in the app",
    description:
      "SOURCE is a local folder, a .zip, or a git URL (https://…, git@…; --ref picks the branch, tag or commit).",
    args: [{ name: "source", description: "Folder, .zip or git URL", required: true }],
    options: { ref: { type: "string", description: "git ref (default HEAD)" } },
    async run(ctx, { args, opts }) {
      const source = parseSkillSource(args[0] as string, str(opts, "ref"));
      const res = (await callOrUnavailable(await ctx.gateway(), "skills.proposeInstall", {
        source,
      })) as {
        proposal: { id: string; name: string; trust: string; findings: { severity: string }[] };
        approval: { id: string };
      };
      const high = res.proposal.findings.filter((f) => f.severity === "high").length;
      return {
        data: { ...res, approvalId: res.approval.id },
        human: [
          `Proposed ${res.proposal.name} (trust ${res.proposal.trust}, ${res.proposal.findings.length} scan finding(s)${high ? `, ${high} high` : ""}).`,
          `Review the full skill and approve it in the app (approval ${res.approval.id}); it installs after approval.`,
        ].join("\n"),
      };
    },
  },
  {
    path: ["skills", "verify"],
    summary: "Check installed skills: hash mismatches, invalid or blocked skills",
    description:
      "Exit 1 when a skill's files no longer match what was approved (hash_mismatch) or it is invalid or blocked; with --strict also when one is unreviewed (unlocked, draft) or of unknown trust.",
    args: [{ name: "name", description: "One skill (default: all)" }],
    options: {
      strict: { type: "boolean", description: "Also fail on unreviewed or unknown-trust skills" },
    },
    async run(ctx, { args, opts }) {
      const strict = bool(opts, "strict");
      const skills = (await listSkills(ctx)).filter((s) => !args[0] || s.name === args[0]);
      const results = skills.map((s) => {
        const broken = BROKEN.has(s.status);
        const unreviewed = UNREVIEWED.has(s.status) || s.trust === "unknown";
        return {
          name: s.name,
          source: s.source,
          trust: s.trust,
          status: s.status,
          ok: !broken && !(strict && unreviewed),
          detail: s.reasons?.join("; ") ?? "",
        };
      });
      return {
        data: { results },
        human: table(results as never, {
          name: "name",
          status: "status",
          trust: "trust",
          ok: "ok",
          detail: "detail",
        }),
        exitCode: results.some((r) => !r.ok) ? 1 : 0,
      };
    },
  },
];
