import { spawn } from "node:child_process";
import { join } from "node:path";

/**
 * Running one program elevated (one UAC prompt), for turning the sandbox PC on and off:
 * `psyche-vm-svc.exe install --owner-sid <SID> --home <PSYCHE_HOME>` / `uninstall`.
 *
 * The PowerShell command line is a constant. The program and its arguments travel in the
 * environment (`PSYCHE_ELEV_EXE`, `PSYCHE_ELEV_ARGS` as a JSON array) and are quoted inside
 * PowerShell, so nothing the owner or a page can influence is ever parsed as PowerShell code. The
 * callers pass only what the app itself computed: the bundled exe path, the account's SID and
 * `$PSYCHE_HOME`.
 *
 * Exit codes: the elevated program's own; `1223` (ERROR_CANCELLED) when the prompt was dismissed
 * or the account may not elevate.
 */

export const ELEVATION_CANCELLED = 1223;

/** The whole command text: never built from arguments. */
export const ELEVATE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "try {",
  "  $items = @(ConvertFrom-Json -InputObject $env:PSYCHE_ELEV_ARGS)",
  "  $line = ($items | ForEach-Object { '\"' + $_ + '\"' }) -join ' '",
  "  $p = Start-Process -FilePath $env:PSYCHE_ELEV_EXE -ArgumentList $line -Verb RunAs -Wait -PassThru -WindowStyle Hidden",
  "  exit $p.ExitCode",
  "} catch { exit 1223 }",
].join("\n");

export type ElevatedResult =
  | { ok: true }
  | { ok: false; cancelled: boolean; code: number | null; message: string };

export interface ElevateOptions {
  systemRoot?: string;
  env?: NodeJS.ProcessEnv;
  /** Test seam: starts the PowerShell host. */
  start?: (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<number | null>;
  /** Give up waiting (the prompt left open) after this long. Default 10 minutes. */
  timeoutMs?: number;
}

/** Arguments that survive being quoted for a Windows command line without escaping rules. */
export function checkElevatedArg(arg: string): string {
  const bad = [...arg].some((c) => c === '"' || c.charCodeAt(0) < 0x20);
  if (arg === "" || bad || arg.endsWith("\\")) {
    throw new Error("an argument cannot be passed to an elevated program safely");
  }
  return arg;
}

function startPowerShell(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { env, windowsHide: true, stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, timeoutMs);
    child.once("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

/**
 * The same elevated start, but not waited for: the Squirrel uninstall hook has 15 seconds and a
 * UAC prompt can take longer. The elevated program outlives the hook.
 */
export function startElevatedDetached(
  exe: string,
  args: readonly string[],
  opts: { systemRoot?: string; env?: NodeJS.ProcessEnv } = {},
): boolean {
  const checked = args.map(checkElevatedArg);
  const systemRoot = opts.systemRoot ?? process.env.SystemRoot ?? "C:\\Windows";
  const ps = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  try {
    const child = spawn(ps, ["-NoProfile", "-NonInteractive", "-Command", ELEVATE_SCRIPT], {
      env: {
        ...(opts.env ?? process.env),
        PSYCHE_ELEV_EXE: exe,
        PSYCHE_ELEV_ARGS: JSON.stringify(checked),
      },
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    });
    child.on("error", () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export async function runElevated(
  exe: string,
  args: readonly string[],
  opts: ElevateOptions = {},
): Promise<ElevatedResult> {
  const checked = args.map(checkElevatedArg);
  const systemRoot = opts.systemRoot ?? process.env.SystemRoot ?? "C:\\Windows";
  const ps = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const env = {
    ...(opts.env ?? process.env),
    PSYCHE_ELEV_EXE: exe,
    PSYCHE_ELEV_ARGS: JSON.stringify(checked),
  };
  const psArgs = ["-NoProfile", "-NonInteractive", "-Command", ELEVATE_SCRIPT];
  const code = await (
    opts.start ?? ((f, a, e) => startPowerShell(f, a, e, opts.timeoutMs ?? 600_000))
  )(ps, psArgs, env);
  if (code === 0) return { ok: true };
  const cancelled = code === ELEVATION_CANCELLED;
  return {
    ok: false,
    cancelled,
    code,
    message: cancelled
      ? "The administrator prompt was dismissed"
      : code === null
        ? "The administrator prompt did not finish"
        : `The sandbox PC service setup exited with code ${code}`,
  };
}
