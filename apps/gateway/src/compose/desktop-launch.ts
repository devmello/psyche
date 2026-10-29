import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Starts the Psyche desktop app without a window or focus, for an unattended run that needs the
 * built-in browser while the app is not running (quit, or never opened since login). `--background`
 * makes the app create its main window hidden, so the agent browser host and its bridge come up
 * and nothing appears on screen. Resolves once LaunchServices accepted the launch; the caller waits
 * for the bridge itself.
 */
export type DesktopLauncher = () => Promise<void>;

export const DESKTOP_APP_NAME = "Psyche";

export interface LaunchOptions {
  platform?: NodeJS.Platform;
  /** Test seam for `execFile("open", args)`. */
  run?: (file: string, args: string[]) => Promise<void>;
  appName?: string;
}

const runFile = (file: string, args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 15_000 }, (err, _out, stderr) => {
      if (err === null) resolve();
      else reject(new Error(stderr.trim() === "" ? err.message : stderr.trim()));
    });
  });

/** `open -g -j -a Psyche --args --background` (not frontmost, hidden). macOS only. */
export function createDesktopLauncher(o: LaunchOptions = {}): DesktopLauncher | undefined {
  if ((o.platform ?? process.platform) !== "darwin") return undefined;
  const run = o.run ?? runFile;
  return () =>
    run("open", ["-g", "-j", "-a", o.appName ?? DESKTOP_APP_NAME, "--args", "--background"]);
}

/** Whether Psyche.app is installed where LaunchServices looks first (read-only check). */
export function desktopInstalled(exists: (p: string) => boolean = existsSync): boolean {
  return [
    `/Applications/${DESKTOP_APP_NAME}.app`,
    join(homedir(), "Applications", `${DESKTOP_APP_NAME}.app`),
  ].some(exists);
}
