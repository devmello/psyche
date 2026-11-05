import { execFile } from "node:child_process";
import { hostLaunch } from "@psyche/hostfs";

/**
 * The environment an owner-installed password-manager CLI (`bw`, `op`) gets: PATH and HOME,
 * nothing else inherited. Windows keeps a CLI's data under the profile, not HOME, so there its
 * profile folders come too (no secrets; the CLI reads the owner's own files either way).
 */
export function cliBaseEnv(): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? "",
  };
  if (process.platform === "win32") {
    for (const k of ["USERPROFILE", "APPDATA", "LOCALAPPDATA", "SystemRoot"]) {
      const v = process.env[k];
      if (v !== undefined) env[k] = v;
    }
  }
  return env;
}

/**
 * `execFile` without a shell, started the way the host can run `cli` (`hostLaunch`: on Windows an
 * npm `.cmd` shim runs its Node target, never `cmd.exe`). Rejects with `err` from execFile, or a
 * plain error when Windows cannot start the file.
 */
export function execCli(
  cli: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const launch = hostLaunch(cli, env);
    if (launch === undefined) {
      reject(Object.assign(new Error(`${cli} cannot be started`), { stderr: "" }));
      return;
    }
    execFile(
      launch.command,
      [...launch.args, ...args],
      { env: { ...env, ...launch.env }, shell: false, timeout: timeoutMs, maxBuffer: 1 << 20 },
      (err, stdout, stderr) =>
        err === null
          ? resolve({ stdout, stderr })
          : reject(Object.assign(err, { stderr: String(stderr) })),
    );
  });
}
