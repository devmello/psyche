import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { type CliDriver, nodeCliDriver, runCli } from "./cli.ts";

/**
 * Where `srt` (Anthropic's sandbox-runtime, `@anthropic-ai/sandbox-runtime`: Seatbelt on macOS)
 * is on this Mac. Commands run under it as ordinary processes with Psyche's deny-read profile
 * (security §5.3), no VM. Order: `PSYCHE_SRT_PATH` (an override, never fallen through when
 * broken), the saved `exec.srtPath` setting, then `srt` on PATH and the usual install folders.
 * Only an absolute, executable file counts; nothing is installed or run besides the version probe.
 */

export const SRT_ENV = "PSYCHE_SRT_PATH";
/** An `exec.*` key: writing it needs `operator.admin` and fresh presence (security §10). */
export const SRT_SETTING = "exec.srtPath";

export type SrtSource = "env" | "setting" | "detected";
export type SrtProblem = "not_found" | "not_absolute" | "not_executable";

export interface SrtStatus {
  available: boolean;
  path: string | null;
  source: SrtSource | null;
  /** `srt --version`, or `null` when it gave none (srt still counts). */
  version: string | null;
  /** Why the override or setting in use is unusable, or `not_found`. */
  problem: SrtProblem | null;
}

export interface SrtDeps {
  isExecutable(path: string): Promise<boolean>;
  /** Folders searched for a bare `srt`, in order. */
  searchDirs(): string[];
  /** `srt --version`'s trimmed stdout, or `null`. */
  version(path: string): Promise<string | null>;
}

export interface SrtInputs {
  /** `PSYCHE_SRT_PATH`. */
  env?: string | undefined;
  /** The `exec.srtPath` setting's value (anything; only a non-empty string counts). */
  setting?: unknown;
}

async function check(deps: SrtDeps, path: string, source: SrtSource): Promise<SrtStatus> {
  const none = { available: false, path, source, version: null } as const;
  if (!isAbsolute(path)) return { ...none, problem: "not_absolute" };
  if (!(await deps.isExecutable(path))) return { ...none, problem: "not_executable" };
  return { available: true, path, source, version: await deps.version(path), problem: null };
}

export async function resolveSrt(deps: SrtDeps, inputs: SrtInputs): Promise<SrtStatus> {
  if (inputs.env !== undefined && inputs.env !== "") return check(deps, inputs.env, "env");
  if (typeof inputs.setting === "string" && inputs.setting !== "") {
    return check(deps, inputs.setting, "setting");
  }
  for (const dir of deps.searchDirs()) {
    if (dir === "" || !isAbsolute(dir)) continue;
    const candidate = join(dir, "srt");
    if (await deps.isExecutable(candidate)) return check(deps, candidate, "detected");
  }
  return { available: false, path: null, source: null, version: null, problem: "not_found" };
}

/** PATH, then where npm, Homebrew and the Gateway's own Node put global binaries. */
export function srtSearchDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = homedir();
  return [
    ...new Set([
      ...(env.PATH ?? "").split(delimiter),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      dirname(process.execPath),
      join(home, ".npm-global", "bin"),
      join(home, ".local", "bin"),
      join(home, ".volta", "bin"),
    ]),
  ];
}

export function systemSrtDeps(driver: CliDriver = nodeCliDriver): SrtDeps {
  return {
    async isExecutable(path) {
      try {
        await access(path, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    searchDirs: () => srtSearchDirs(),
    async version(path) {
      try {
        const r = await runCli(driver, path, ["--version"], { timeoutMs: 5_000, maxBytes: 4096 });
        const out = r.stdout.toString("utf8").trim();
        return r.exitCode === 0 && out !== "" ? (out.split("\n")[0]?.slice(0, 64) ?? null) : null;
      } catch {
        return null;
      }
    },
  };
}
