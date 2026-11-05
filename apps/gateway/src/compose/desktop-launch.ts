import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { windowsDesktopExe } from "../platform.ts";

/**
 * Starts the Psyche desktop app without a window or focus, for an unattended run that needs the
 * built-in browser while the app is not running (quit, or never opened since login). `--background`
 * makes the app create its main window hidden, so the agent browser host and its bridge come up
 * and nothing appears on screen. Resolves once the launch was accepted (LaunchServices on macOS,
 * the process spawned on Windows); the caller waits for the bridge itself.
 */
export type DesktopLauncher = () => Promise<void>;

export const DESKTOP_APP_NAME = "Psyche";

export interface LaunchOptions {
  platform?: NodeJS.Platform;
  /** Test seam for `execFile("open", args)` (macOS) and the detached spawn (Windows). */
  run?: (file: string, args: string[]) => Promise<void>;
  appName?: string;
  /** Windows: the installed app (`platform.ts` `windowsDesktopExe`). */
  windowsExe?: string;
}

const runFile = (file: string, args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 15_000 }, (err, _out, stderr) => {
      if (err === null) resolve();
      else reject(new Error(stderr.trim() === "" ? err.message : stderr.trim()));
    });
  });

/** Windows: start the app detached from psyched, no console, no shell. */
const spawnDetached = (file: string, args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });

/**
 * macOS: `open -g -j -a Psyche --args --background` (not frontmost, hidden). Windows: the
 * per-user install's `Psyche.exe --background`. `undefined` elsewhere (no desktop app on Linux).
 */
export function createDesktopLauncher(o: LaunchOptions = {}): DesktopLauncher | undefined {
  const platform = o.platform ?? process.platform;
  if (platform === "win32") {
    const run = o.run ?? spawnDetached;
    const exe = o.windowsExe ?? windowsDesktopExe(process.env, o.appName ?? DESKTOP_APP_NAME);
    return () => run(exe, ["--background"]);
  }
  if (platform !== "darwin") return undefined;
  const run = o.run ?? runFile;
  return () =>
    run("open", ["-g", "-j", "-a", o.appName ?? DESKTOP_APP_NAME, "--args", "--background"]);
}

/**
 * Whether the desktop app is installed where it is launched from (read-only check): Psyche.app in
 * `/Applications` or `~/Applications` on macOS, the Squirrel per-user install on Windows.
 */
export function desktopInstalled(
  exists: (p: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === "win32") return exists(windowsDesktopExe(process.env, DESKTOP_APP_NAME));
  return [
    `/Applications/${DESKTOP_APP_NAME}.app`,
    join(homedir(), "Applications", `${DESKTOP_APP_NAME}.app`),
  ].some(exists);
}
