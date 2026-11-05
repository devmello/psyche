import { spawn } from "node:child_process";
import { basename, dirname, join } from "node:path";

/**
 * Squirrel.Windows runs the app with one of these when it installs, updates or removes it, and
 * expects it to do its part and exit within seconds (no window, no single-instance lock):
 *
 * - `--squirrel-install`, `--squirrel-updated`: (re)create the Start menu and desktop shortcuts
 *   (`Update.exe --createShortcut`).
 * - `--squirrel-uninstall`: remove them, and run `onUninstall` first (the Gateway's scheduled
 *   task and the login item are this app's to remove; nothing in Squirrel knows of them).
 * - `--squirrel-obsolete`: an older version being replaced: just exit.
 *
 * `--squirrel-firstrun` is a normal launch (the first after install) and is not handled here.
 * This is what `electron-squirrel-startup` does, without the dependency, and has to run before
 * anything else in main.ts.
 */

export type SquirrelEvent = "install" | "updated" | "uninstall" | "obsolete";

export function squirrelEvent(argv: readonly string[]): SquirrelEvent | undefined {
  const m = /^--squirrel-(install|updated|uninstall|obsolete)$/.exec(argv[1] ?? "");
  return m ? (m[1] as SquirrelEvent) : undefined;
}

/** `Update.exe` argv for the event's shortcuts (none for `obsolete`). */
export function squirrelShortcutArgs(event: SquirrelEvent, execPath: string): string[] | undefined {
  const exe = basename(execPath);
  if (event === "install" || event === "updated") return [`--createShortcut=${exe}`];
  if (event === "uninstall") return [`--removeShortcut=${exe}`];
  return undefined;
}

/**
 * Handles a Squirrel event when the app was started for one; true means quit now. Waits for
 * `onUninstall` (bounded by the caller) and for Update.exe to have started.
 */
export async function handleSquirrelEvent(o: {
  platform: NodeJS.Platform;
  argv: readonly string[];
  execPath: string;
  onUninstall?: () => Promise<void>;
  run?: (file: string, args: string[]) => Promise<void>;
}): Promise<boolean> {
  if (o.platform !== "win32") return false;
  const event = squirrelEvent(o.argv);
  if (event === undefined) return false;
  if (event === "uninstall") await o.onUninstall?.().catch(() => undefined);
  const args = squirrelShortcutArgs(event, o.execPath);
  if (args !== undefined) {
    const updateExe = join(dirname(dirname(o.execPath)), "Update.exe");
    await (o.run ?? spawnDetached)(updateExe, args).catch(() => undefined);
  }
  return true;
}

function spawnDetached(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
