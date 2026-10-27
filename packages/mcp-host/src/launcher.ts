import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { Transport } from "@modelcontextprotocol/client";
import type { McpTrustTier, SandboxInstance, SandboxNetwork, SandboxScope } from "@psyche/protocol";
import { PsycheError } from "@psyche/protocol";
import { PipeTransport } from "./pipe-transport.ts";

/**
 * How a stdio MCP server process is started (security §11, §5.3): under `srt` (Seatbelt on macOS,
 * bubblewrap on Linux), or inside the sandbox container through the runner (M3,
 * `containerLauncher`). There is no silent fallback: a non-`bundled` server with no sandboxing
 * launcher is refused.
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
  /** Environment for a host-spawned process: the host's safe defaults plus `serverEnv`. */
  env: Record<string, string>;
  /** Only the server's own configured env, vault placeholders resolved. */
  serverEnv: Record<string, string>;
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

/** A server the launcher started itself and hands over as a connected transport. */
export interface OpenedLaunch {
  transport: Transport;
  stderr?: Readable;
  cleanup?: () => Promise<void>;
}

/**
 * Either `prepare` (the host spawns the returned command) or `open` (the launcher starts the
 * process, e.g. inside a container, and returns a transport over its pipes).
 */
export interface StdioLauncher {
  /** `none` launchers run the command as is and are accepted for `bundled` servers only. */
  readonly isolation: "srt" | "container" | "none";
  prepare?(spec: StdioLaunchSpec): Promise<PreparedLaunch>;
  open?(spec: StdioLaunchSpec, signal?: AbortSignal): Promise<OpenedLaunch>;
  /** The server was removed: drop any state kept for it (sandbox volume, egress allowlist). */
  forget?(serverId: string): Promise<void>;
  /** Whether it can launch now (a resolving launcher whose sandbox may not be installed yet). */
  ready?(): Promise<boolean>;
}

/** A launcher whose command the host spawns (`srt`, direct). */
export interface SpawnLauncher extends StdioLauncher {
  prepare(spec: StdioLaunchSpec): Promise<PreparedLaunch>;
}

/** Runs the command unwrapped. Only for servers that ship with Psyche. */
export function directLauncher(): SpawnLauncher {
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

export function srtLauncher(options: SrtLauncherOptions): SpawnLauncher {
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

export interface ResolvingSrtLauncherOptions extends Omit<SrtLauncherOptions, "srtPath"> {
  /** Finds `srt` now: the owner may install it or pick it in Settings while the Gateway runs. */
  resolve(): Promise<{ path: string } | { missing: true; reason: string }>;
}

/**
 * `srtLauncher` with the path looked up at each launch, so a newly installed or chosen `srt`
 * is used without a restart. Without one, a launch is refused (`unavailable`), never run bare.
 */
export function resolvingSrtLauncher(options: ResolvingSrtLauncherOptions): SpawnLauncher {
  const { resolve, ...rest } = options;
  return {
    isolation: "srt",
    async ready() {
      return "path" in (await resolve());
    },
    async prepare(spec) {
      const found = await resolve();
      if (!("path" in found)) {
        throw new PsycheError("unavailable", `srt is not available (${found.reason})`, {
          details: { reason: "no_launcher" },
        });
      }
      return srtLauncher({ ...rest, srtPath: found.path }).prepare(spec);
    },
  };
}

// --- sandbox container (M3) ----------------------------------------------------------------------

/** A long-lived process with raw pipes inside a sandbox (S21 `openStdio`, issue #143). */
export interface SandboxStdioProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly exited: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
  kill(signal?: "TERM" | "KILL"): Promise<void>;
}

/**
 * The part of the sandbox runner the container launcher needs (`SandboxRunner.ensureSandbox`
 * plus `openStdio`). `ContainerSandboxRunner` from `@psyche/sandbox` satisfies it (#143; the
 * M3 acceptance test checks that at compile time); the Gateway passes it in.
 */
export interface SandboxStdioHost {
  ensureSandbox(
    scope: SandboxScope,
    options?: { network?: SandboxNetwork },
  ): Promise<SandboxInstance>;
  openStdio(
    sandboxId: string,
    options: { argv: string[]; cwd?: string; env?: Record<string, string> },
  ): Promise<SandboxStdioProcess>;
  /** Removes the scope's container and `/workspace` volume (`ContainerSandboxRunner`). */
  deleteWorkspace?(scope: SandboxScope): Promise<void>;
}

export interface ContainerLauncherOptions {
  sandbox: SandboxStdioHost;
  /**
   * Hands a server's domain allowlist to the egress proxy (security §5.2) before its sandbox
   * starts with `network: "proxy"`. Without it, servers that ask for network are refused.
   */
  egressAllowlist?: (scope: SandboxScope, domains: string[]) => void | Promise<void>;
  /** Clears a removed server's egress allowlist, so a new config with its id starts empty. */
  egressRevoke?: (scope: SandboxScope) => void | Promise<void>;
}

export const SANDBOX_WORKSPACE = "/workspace";

/** One sandbox per server: its own container and `/workspace` volume. */
export function mcpSandboxScope(serverId: string): SandboxScope {
  return { kind: "task", id: `mcp:${serverId}` };
}

/**
 * Runs each stdio server in its own sandbox container (security §5.1, §11; feature M3): no host
 * mounts besides the server's own `/workspace` volume, so Psyche's vault, `~/.ssh` and every
 * other host path are absent; `network: none` unless the config allowlists domains (then the
 * egress proxy); only the server's own env reaches it, with vault values delivered by the
 * runner inside the container (never in host argv). Host folders cannot be granted to a
 * containerized server (`allowWrite` and host `cwd` are refused).
 */
export function containerLauncher(options: ContainerLauncherOptions): StdioLauncher {
  return {
    isolation: "container",
    async forget(serverId) {
      const scope = mcpSandboxScope(serverId);
      await options.egressRevoke?.(scope);
      await options.sandbox.deleteWorkspace?.(scope);
    },
    async open(spec, signal) {
      if (spec.command.length === 0) throw new PsycheError("invalid_params", "empty command");
      if (spec.sandbox.allowWrite.length > 0) {
        throw new PsycheError(
          "policy_denied",
          "host folders cannot be mounted into an MCP server's sandbox; it writes only its /workspace",
        );
      }
      const cwd = spec.cwd ?? SANDBOX_WORKSPACE;
      if (cwd !== SANDBOX_WORKSPACE && !cwd.startsWith(`${SANDBOX_WORKSPACE}/`)) {
        throw new PsycheError(
          "invalid_params",
          "cwd must be inside /workspace: host paths are never visible in the sandbox",
        );
      }
      const scope = mcpSandboxScope(spec.serverId);
      const domains = [...new Set(spec.sandbox.allowedDomains)];
      const network: SandboxNetwork = domains.length > 0 ? "proxy" : "none";
      if (network === "proxy") {
        if (options.egressAllowlist === undefined) {
          throw new PsycheError(
            "policy_denied",
            "this server asks for network access, but no egress proxy is configured",
          );
        }
        await options.egressAllowlist(scope, domains);
      }
      const aborted = () => signal?.aborted === true;
      if (aborted()) throw new PsycheError("cancelled", "launch aborted");
      const instance = await options.sandbox.ensureSandbox(scope, { network });
      if (aborted()) throw new PsycheError("cancelled", "launch aborted");
      const proc = await options.sandbox.openStdio(instance.id, {
        argv: [...spec.command],
        cwd,
        env: { ...spec.serverEnv },
      });
      // Closing the transport and the host's cleanup both stop the process: kill once.
      let killing: Promise<void> | undefined;
      const kill = (sig: "TERM" | "KILL" = "TERM") => {
        killing ??= proc.kill(sig).catch(() => undefined);
        return killing;
      };
      return {
        transport: new PipeTransport({
          stdin: proc.stdin,
          stdout: proc.stdout,
          exited: proc.exited,
          kill,
        }),
        stderr: proc.stderr,
        cleanup: () => kill("TERM"),
      };
    },
  };
}
