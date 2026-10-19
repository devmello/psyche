import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
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
  /**
   * Paths the server may write. Must be empty under `srt`: security §5.3 allows writes only to
   * the per-process scratch directory the launcher creates.
   */
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
  /** Absolute path of the `srt` executable (`@anthropic-ai/sandbox-runtime`). */
  srtPath: string;
  /** Directory for per-launch settings files and scratch directories (mode 0700). */
  settingsDir: string;
  /** Psyche home (vault, state, audit, browser profiles); always read- and write-denied. */
  psycheHome?: string;
}

/** Read-denied for every MCP server regardless of its policy (security §5.3, plus common token files). */
export function defaultDenyRead(psycheHome: string): string[] {
  const home = homedir();
  const h = (...p: string[]) => join(home, ...p);
  return [
    psycheHome,
    h(".ssh"),
    h(".aws"),
    h(".gnupg"),
    h(".netrc"),
    h(".git-credentials"),
    h(".npmrc"),
    h(".docker"),
    h(".kube"),
    h(".config", "gh"),
    h(".config", "gcloud"),
    h("Library", "Keychains"),
    h("Library", "Cookies"),
    h("Library", "Application Support", "Google", "Chrome"),
    h("Library", "Application Support", "Firefox"),
    h("Library", "Safari"),
  ];
}

/**
 * srt settings for one server (security §5.3): deny-read list, writes only to the per-process
 * scratch directory, network only through srt's proxies with the server's allowlist, and the
 * documented escape hatches (`allowLocalBinding`, `allowAppleEvents`,
 * `enableWeakerNetworkIsolation`, weaker nested sandboxes) pinned off.
 */
export function srtSettings(
  spec: StdioLaunchSpec,
  psycheHome: string,
  scratchDir: string,
): Record<string, unknown> {
  return {
    filesystem: {
      denyRead: [...new Set([...defaultDenyRead(psycheHome), ...spec.sandbox.denyRead])],
      allowRead: [],
      allowWrite: [scratchDir],
      denyWrite: [psycheHome],
    },
    network: {
      allowedDomains: [...spec.sandbox.allowedDomains],
      deniedDomains: [],
      allowUnixSockets: [],
      allowLocalBinding: false,
    },
    enableWeakerNestedSandbox: false,
    allowNestedUserNamespaces: false,
    enableWeakerNetworkIsolation: false,
    allowAppleEvents: false,
  };
}

export function srtLauncher(options: SrtLauncherOptions): StdioLauncher {
  if (!isAbsolute(options.srtPath)) {
    throw new PsycheError("invalid_params", "srtPath must be absolute (no PATH lookup)");
  }
  const psycheHome = options.psycheHome ?? join(homedir(), ".psyche");
  return {
    isolation: "srt",
    async prepare(spec) {
      if (spec.command.length === 0) throw new PsycheError("invalid_params", "empty command");
      if (spec.sandbox.allowWrite.length > 0) {
        throw new PsycheError(
          "policy_denied",
          "stdio MCP servers may write only to their scratch directory (security §5.3)",
        );
      }
      await mkdir(options.settingsDir, { recursive: true, mode: 0o700 });
      const id = `${spec.serverId}-${randomUUID()}`;
      const scratch = join(options.settingsDir, `scratch-${id}`);
      await mkdir(scratch, { mode: 0o700 });
      const file = join(options.settingsDir, `srt-${id}.json`);
      await writeFile(file, JSON.stringify(srtSettings(spec, psycheHome, scratch)), {
        mode: 0o600,
      });
      return {
        command: options.srtPath,
        args: ["--settings", file, "--", ...spec.command],
        env: { ...spec.env, TMPDIR: scratch },
        cwd: spec.cwd ?? scratch,
        cleanup: async () => {
          await rm(file, { force: true });
          await rm(scratch, { recursive: true, force: true });
        },
      };
    },
  };
}
