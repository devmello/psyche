import { execFile } from "node:child_process";
import { homedir } from "node:os";
import type { Clock } from "@psyche/protocol";
import type { CapabilityGuess } from "../capability-guess.ts";
import type { ProviderConfig } from "../config.ts";
import type { EndpointProbeResult, ProbedModel } from "../endpoint-probe.ts";
import { formatModelRef } from "../refs.ts";
import { type CliDialect, notInstalled } from "./adapter.ts";
import { cliChildPath, type ResolveCliOptions, resolveCli } from "./resolve.ts";

/**
 * Probe for a subscription CLI (B4): is it installed (`--version`), and is it signed in
 * (`claude auth status --json` / `codex login status`)? No model call, so no quota is spent.
 * Only the version, the sign-in method and the plan name are reported: never the account's
 * email, organisation or any token. The API-key variables are removed first, as for real
 * runs, so the answer describes the subscription login.
 */

export interface CliProbeDeps {
  env?: NodeJS.ProcessEnv;
  /** How the CLI is found (tests: a fake home, no login shell). */
  resolve?: Omit<ResolveCliOptions, "command" | "env">;
  clock?: Clock;
  timeoutMs?: number;
}

interface Exec {
  code: number | null;
  stdout: string;
  stderr: string;
  missing: boolean;
}

function exec(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<Exec> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { env, timeout: timeoutMs, maxBuffer: 256 * 1024 },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: string | number }) | null;
        resolve({
          code: e === null ? 0 : typeof e.code === "number" ? e.code : null,
          stdout: String(stdout),
          stderr: String(stderr),
          missing: e?.code === "ENOENT",
        });
      },
    );
  });
}

const CATALOG: Record<"claude-code" | "codex", { id: string; label: string }[]> = {
  "claude-code": [
    { id: "default", label: "Claude Code's default model" },
    { id: "opus", label: "Opus (latest)" },
    { id: "sonnet", label: "Sonnet (latest)" },
    { id: "haiku", label: "Haiku (latest)" },
  ],
  codex: [{ id: "default", label: "Codex's default model" }],
};

const CAPS: CapabilityGuess = {
  toolCalling: true,
  vision: true,
  reasoning: true,
  embeddings: false,
  source: "catalog",
};

export async function probeCli(
  config: ProviderConfig,
  dialect: CliDialect,
  deps: CliProbeDeps = {},
): Promise<EndpointProbeResult> {
  const clock = deps.clock ?? { now: () => Date.now() };
  const started = clock.now();
  const probedAt = new Date(started).toISOString();
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const base: NodeJS.ProcessEnv = { ...(deps.env ?? process.env) };
  const elapsed = () => Math.max(0, clock.now() - started);
  const resolved = await resolveCli(dialect.defaultCommand, {
    ...deps.resolve,
    env: base,
    ...(config.command === undefined ? {} : { command: config.command }),
  });
  if (resolved === undefined) {
    return {
      state: "unreachable",
      probedAt,
      latencyMs: elapsed(),
      models: [],
      error: notInstalled(dialect, config.command),
    };
  }
  const command = resolved.path;
  const env: NodeJS.ProcessEnv = { ...base };
  for (const k of dialect.stripEnv) delete env[k];
  env.PATH = cliChildPath(command, base, deps.resolve?.home ?? base.HOME ?? homedir());

  const version = await exec(command, ["--version"], env, timeoutMs);
  if (version.missing || version.code !== 0) {
    return {
      state: "unreachable",
      probedAt,
      latencyMs: elapsed(),
      models: [],
      error: `\`${command} --version\` failed`,
    };
  }
  const v = /\d+\.\d+\.\d+(?:[-.\w]*)?/.exec(version.stdout)?.[0];
  let signedIn = false;
  let detail = "";
  if (config.kind === "claude-code") {
    const status = await exec(command, ["auth", "status", "--json"], env, timeoutMs);
    try {
      const j = JSON.parse(status.stdout) as {
        loggedIn?: unknown;
        authMethod?: unknown;
        subscriptionType?: unknown;
      };
      signedIn = j.loggedIn === true;
      const parts = [
        typeof j.authMethod === "string" ? j.authMethod : undefined,
        typeof j.subscriptionType === "string" ? `${j.subscriptionType} plan` : undefined,
      ].filter((x): x is string => x !== undefined);
      detail = parts.join(", ");
    } catch {
      signedIn = false;
    }
  } else {
    const status = await exec(command, ["login", "status"], env, timeoutMs);
    const text = `${status.stdout}\n${status.stderr}`;
    signedIn = status.code === 0 && /logged in/i.test(text) && !/not logged in/i.test(text);
    const using = /logged in using ([\w -]+)/i.exec(text)?.[1]?.trim();
    detail = using ?? "";
  }
  // The resolved path is shown in Settings, so the owner sees which CLI runs (#530).
  const server = `${dialect.label}${v === undefined ? "" : ` ${v}`} · ${command}${detail.length > 0 ? ` (${detail})` : ""}`;
  if (!signedIn) {
    return {
      state: "auth_failed",
      probedAt,
      latencyMs: elapsed(),
      server,
      models: [],
      error:
        config.kind === "claude-code"
          ? "Claude Code is installed but not signed in: run `claude auth login`"
          : "Codex is installed but not signed in: run `codex login`",
    };
  }
  const kind = config.kind === "codex" ? "codex" : "claude-code";
  const ids = new Set([...CATALOG[kind].map((m) => m.id), ...Object.keys(config.models ?? {})]);
  const models: ProbedModel[] = [...ids].map((id) => {
    const label = CATALOG[kind].find((m) => m.id === id)?.label;
    return {
      ref: formatModelRef(config.id, id),
      id,
      ...(label === undefined ? {} : { label }),
      capabilities: { ...CAPS },
    };
  });
  return { state: "reachable", probedAt, latencyMs: elapsed(), server, models };
}
