import { spawn } from "node:child_process";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a program without a shell (arguments are never interpolated into a command line). */
export type Exec = (
  cmd: string,
  args: readonly string[],
  opts?: { input?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
) => Promise<ExecResult>;

export const nodeExec: Exec = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: opts.env ?? process.env,
      timeout: opts.timeoutMs ?? 30_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", (err) => resolve({ code: 127, stdout, stderr: stderr + err.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    // A child that exits before reading stdin (`command -v`, launchctl) makes this write fail
    // with EPIPE; that is not an error of the command.
    child.stdin.on("error", () => {});
    child.stdin.end(opts.input ?? "");
  });

/** `true` when `cmd` is on PATH (`where.exe` on Windows, which has no /bin/sh). */
export async function which(
  exec: Exec,
  cmd: string,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  if (platform === "win32") return (await whereExe(exec, cmd)) !== null;
  const r = await exec("/bin/sh", ["-c", 'command -v "$1" >/dev/null 2>&1', "sh", cmd]);
  return r.code === 0;
}

/**
 * Windows: the absolute path `cmd` resolves to on PATH, or null. `where.exe` lists every match,
 * extensionless sh shims (npm, pnpm) included; the first one Windows can start (.exe, .cmd, .bat,
 * .com) wins.
 */
export async function whereExe(exec: Exec, cmd: string): Promise<string | null> {
  const r = await exec("where.exe", [cmd]);
  if (r.code !== 0) return null;
  const found = r.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return found.find((p) => /\.(exe|cmd|bat|com)$/i.test(p)) ?? null;
}
