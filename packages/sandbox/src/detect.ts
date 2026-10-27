import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { CONTAINER_BACKENDS, type ContainerBackendKind, DEFAULT_CLI } from "./backends.ts";
import { type CliDriver, nodeCliDriver, runCli } from "./cli.ts";

/**
 * Backend detection. Preference order (ADR-008): Apple `container` on macOS 26+ on Apple
 * silicon, then Docker (Docker Desktop, Colima, OrbStack or Linux), then Podman. An explicit
 * override (option or `PSYCHE_SANDBOX_BACKEND`) restricts detection to that one backend. An
 * empty result means no sandbox at all: callers report an error, never a host-shell fallback.
 */

export interface DetectedBackend {
  kind: ContainerBackendKind;
  /** Absolute path of the CLI that will be executed. */
  cli: string;
  version: string;
}

export interface DetectDeps {
  platform: NodeJS.Platform;
  arch: string;
  env: NodeJS.ProcessEnv;
  /** Resolves a bare command to an absolute executable path, or `null`. */
  which(command: string): Promise<string | null>;
  /** macOS product version (`sw_vers -productVersion`), or `null` off macOS. */
  macosVersion(): Promise<string | null>;
  /** Runs a fixed probe; resolves the trimmed stdout, or `null` on failure/timeout. */
  probe(cli: string, args: readonly string[]): Promise<string | null>;
}

export interface DetectOptions {
  /** Restrict to one backend (also read from `PSYCHE_SANDBOX_BACKEND`). */
  backend?: ContainerBackendKind;
  /** Per-backend CLI override (absolute path or bare name). */
  cliPaths?: Partial<Record<ContainerBackendKind, string>>;
}

export const BACKEND_ENV = "PSYCHE_SANDBOX_BACKEND";

/** Order in which backends are preferred on this platform. */
export function preferenceOrder(platform: NodeJS.Platform): ContainerBackendKind[] {
  return platform === "darwin" ? ["apple-container", "docker", "podman"] : ["docker", "podman"];
}

export function parseBackendOverride(value: string | undefined): ContainerBackendKind | undefined {
  if (value === undefined || value === "") return undefined;
  if ((CONTAINER_BACKENDS as readonly string[]).includes(value)) {
    return value as ContainerBackendKind;
  }
  throw new Error(
    `${BACKEND_ENV}=${value} is not a sandbox backend (expected ${CONTAINER_BACKENDS.join(", ")})`,
  );
}

function majorVersion(version: string | null): number {
  const major = Number.parseInt(version?.split(".")[0] ?? "", 10);
  return Number.isFinite(major) ? major : 0;
}

/** Probe arguments per backend: each must fail when the daemon / service cannot be used. */
const PROBES: Record<ContainerBackendKind, readonly string[]> = {
  // The CLI alone; `ensureSandbox` starts the system service when it is stopped.
  "apple-container": ["--version"],
  // Fails fast when the daemon (Desktop VM, Colima, OrbStack) is not running.
  docker: ["version", "--format", "{{.Server.Version}}"],
  // `info` needs the service (a `podman machine` on macOS); `version` alone does not.
  podman: ["info", "--format", "{{.Version.Version}}"],
};

export async function detectBackends(
  deps: DetectDeps,
  options: DetectOptions = {},
): Promise<DetectedBackend[]> {
  const override = options.backend ?? parseBackendOverride(deps.env[BACKEND_ENV]);
  const order = preferenceOrder(deps.platform);
  const candidates = override === undefined ? order : [override];
  const found: DetectedBackend[] = [];
  for (const kind of candidates) {
    if (kind === "apple-container") {
      if (deps.platform !== "darwin" || deps.arch !== "arm64") continue;
      if (majorVersion(await deps.macosVersion()) < 26) continue;
    }
    const cli = await deps.which(options.cliPaths?.[kind] ?? DEFAULT_CLI[kind]);
    if (cli === null) continue;
    const version = await deps.probe(cli, PROBES[kind]);
    if (version === null) continue;
    found.push({ kind, cli, version });
  }
  return found;
}

/** What one backend looks like on this Mac, for the guided setup (Settings, onboarding). */
export interface BackendInspection {
  kind: ContainerBackendKind;
  /** This Mac can use it (Apple `container` needs macOS 26 on Apple silicon). */
  supported: boolean;
  /** Its CLI is on this Mac. */
  installed: boolean;
  /** The probe succeeded: the daemon (or, for Apple `container`, the CLI) answers. */
  running: boolean;
  version: string | null;
}

/** Every backend this platform knows, each with how far along it is; detection stops at the first failure. */
export async function inspectBackends(
  deps: DetectDeps,
  options: DetectOptions = {},
): Promise<BackendInspection[]> {
  const out: BackendInspection[] = [];
  for (const kind of preferenceOrder(deps.platform)) {
    const supported =
      kind !== "apple-container" ||
      (deps.platform === "darwin" &&
        deps.arch === "arm64" &&
        majorVersion(await deps.macosVersion()) >= 26);
    const cli = supported ? await deps.which(options.cliPaths?.[kind] ?? DEFAULT_CLI[kind]) : null;
    const version = cli === null ? null : await deps.probe(cli, PROBES[kind]);
    out.push({
      kind,
      supported,
      installed: cli !== null,
      running: version !== null,
      version,
    });
  }
  return out;
}

/**
 * Directories searched after `PATH`. A Gateway started by launchd gets a minimal PATH, so the
 * usual install locations of the three CLIs are listed explicitly.
 */
function extraPathDirs(): string[] {
  const home = homedir();
  return [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/Applications/Docker.app/Contents/Resources/bin",
    join(home, ".orbstack", "bin"),
    join(home, ".rd", "bin"),
    "/opt/podman/bin",
  ];
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function systemDetectDeps(driver: CliDriver = nodeCliDriver): DetectDeps {
  return {
    platform: process.platform,
    arch: process.arch,
    env: process.env,
    async which(command) {
      if (command.includes("/")) return (await isExecutable(command)) ? command : null;
      const dirs = [...(process.env.PATH ?? "").split(delimiter), ...extraPathDirs()];
      for (const dir of dirs) {
        if (dir === "") continue;
        const candidate = join(dir, command);
        if (await isExecutable(candidate)) return candidate;
      }
      return null;
    },
    async macosVersion() {
      if (process.platform !== "darwin") return null;
      try {
        const r = await runCli(driver, "/usr/bin/sw_vers", ["-productVersion"], {
          timeoutMs: 5_000,
        });
        return r.exitCode === 0 ? r.stdout.toString("utf8").trim() : null;
      } catch {
        return null;
      }
    },
    async probe(cli, args) {
      try {
        const r = await runCli(driver, cli, args, { timeoutMs: 10_000, maxBytes: 64 * 1024 });
        return r.exitCode === 0 ? r.stdout.toString("utf8").trim() : null;
      } catch {
        return null;
      }
    },
  };
}
