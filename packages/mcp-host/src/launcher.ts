import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { McpTrustTier } from "@psyche/protocol";
import { PsycheError } from "@psyche/protocol";

/**
 * How a stdio MCP server process is started (security §11, §5.3). M1 ships the `srt` launcher
 * (Seatbelt on macOS, bubblewrap on Linux); the sandbox-container launcher is M3. There is no
 * silent fallback: a non-`bundled` server with no sandboxing launcher is refused.
 */
export interface McpSandboxPolicy {
  /** Domains the server may reach through srt's proxy; empty means no network. */
  allowedDomains: string[];
  /** Paths the server may write; empty means none. */
  allowWrite: string[];
  /** Extra read denials on top of the defaults (Psyche home, SSH / cloud credentials). */
  denyRead: string[];
}

export interface StdioLaunchSpec {
  serverId: string;
  trust: McpTrustTier;
  command: string[];
  env: Record<string, string>;
  cwd?: string;
  sandbox: McpSandboxPolicy;
}

export interface PreparedLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  /** Called after the process exits or the server is removed. */
  cleanup?: () => Promise<void>;
}

export interface StdioLauncher {
  /** `none` launchers run the command as is and are accepted for `bundled` servers only. */
  readonly isolation: "srt" | "container" | "none";
  prepare(spec: StdioLaunchSpec): Promise<PreparedLaunch>;
}

/** Runs the command unwrapped. Only for servers that ship with Psyche. */
export function directLauncher(): StdioLauncher {
  return {
    isolation: "none",
    async prepare(spec) {
      if (spec.trust !== "bundled") {
        throw new PsycheError(
          "policy_denied",
          "only bundled MCP servers may run without a sandbox",
        );
      }
      const [command, ...args] = spec.command;
      if (command === undefined) throw new PsycheError("invalid_params", "empty command");
      return { command, args, env: spec.env, ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }) };
    },
  };
}

export interface SrtLauncherOptions {
  /** Path of the `srt` executable (`@anthropic-ai/sandbox-runtime`). */
  srtPath: string;
  /** Directory for per-launch settings files (mode 0700). */
  settingsDir: string;
  /** Psyche home (vault, state); always read-denied. Default `~/.psyche`. */
  psycheHome?: string;
}

/** Read-denied for every MCP server regardless of its policy. */
export function defaultDenyRead(psycheHome: string): string[] {
  const home = homedir();
  return [
    psycheHome,
    join(home, ".ssh"),
    join(home, ".aws"),
    join(home, ".gnupg"),
    join(home, ".config", "gcloud"),
    join(home, ".kube"),
    join(home, "Library", "Keychains"),
  ];
}

/** srt settings file for one server (filesystem deny-read / allow-write, domain allowlist). */
export function srtSettings(spec: StdioLaunchSpec, psycheHome: string): Record<string, unknown> {
  return {
    filesystem: {
      denyRead: [...new Set([...defaultDenyRead(psycheHome), ...spec.sandbox.denyRead])],
      allowWrite: [...spec.sandbox.allowWrite],
      denyWrite: [psycheHome],
    },
    network: { allowedDomains: [...spec.sandbox.allowedDomains], deniedDomains: [] },
  };
}

export function srtLauncher(options: SrtLauncherOptions): StdioLauncher {
  const psycheHome = options.psycheHome ?? join(homedir(), ".psyche");
  return {
    isolation: "srt",
    async prepare(spec) {
      if (spec.command.length === 0) throw new PsycheError("invalid_params", "empty command");
      await mkdir(options.settingsDir, { recursive: true, mode: 0o700 });
      const file = join(options.settingsDir, `srt-${spec.serverId}-${randomUUID()}.json`);
      await writeFile(file, JSON.stringify(srtSettings(spec, psycheHome)), { mode: 0o600 });
      return {
        command: options.srtPath,
        args: ["--settings", file, "--", ...spec.command],
        env: spec.env,
        ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
        cleanup: () => rm(file, { force: true }),
      };
    },
  };
}
