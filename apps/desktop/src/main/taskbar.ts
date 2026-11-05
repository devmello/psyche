import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type LaunchCommandOptions, windowsLaunchCommand } from "./login-item.ts";
import { quoteWindowsArg } from "./supervisor-windows.ts";

/**
 * Windows taskbar counterparts of the macOS Dock menu and accessory mode:
 *
 * - **Jump list** (right-click on the taskbar button or the Start entry): "New side chat" and
 *   "Ask about my screen", like the Dock menu. Each starts Psyche with `--psyche-task=<task>`;
 *   the running copy gets it as a second instance (`taskFromArgv`).
 * - **Closing to the tray**: with every window closed Psyche keeps running in the notification
 *   area (the menu-bar app on macOS); the first time, one notification says so.
 */

export const TASK_ARG_PREFIX = "--psyche-task=";

export type TaskbarTask = "new-side-chat" | "ask-screen";

const TASKS: readonly TaskbarTask[] = ["new-side-chat", "ask-screen"];

/** The jump-list task a launch carries, if any. */
export function taskFromArgv(argv: readonly string[]): TaskbarTask | undefined {
  const raw = argv.find((a) => a.startsWith(TASK_ARG_PREFIX))?.slice(TASK_ARG_PREFIX.length);
  return TASKS.find((t) => t === raw);
}

/** Electron's `Task` (app.setUserTasks). */
export interface JumpTask {
  program: string;
  arguments: string;
  title: string;
  description: string;
  iconPath: string;
  iconIndex: number;
}

export function jumpListTasks(
  execPath: string,
  o: LaunchCommandOptions & { askScreen: boolean },
): JumpTask[] {
  const task = (id: TaskbarTask, title: string, description: string): JumpTask => {
    const cmd = windowsLaunchCommand(execPath, [`${TASK_ARG_PREFIX}${id}`], o);
    return {
      program: cmd.path,
      arguments: cmd.args.map(quoteWindowsArg).join(" "),
      title,
      description,
      // The app's own icon, from the running exe (not Update.exe's).
      iconPath: execPath,
      iconIndex: 0,
    };
  };
  return [
    task("new-side-chat", "New side chat", "Start a side chat in Psyche"),
    ...(o.askScreen
      ? [task("ask-screen", "Ask about my screen", "Ask Psyche about what is on your screen")]
      : []),
  ];
}

/**
 * Whether to say "Psyche is still running" now: once per user data folder, the first time the
 * last window closes. Marks it said.
 */
export function firstCloseToTray(markerFile: string): boolean {
  if (existsSync(markerFile)) return false;
  try {
    mkdirSync(dirname(markerFile), { recursive: true });
    writeFileSync(markerFile, `${new Date().toISOString()}\n`, { mode: 0o600 });
  } catch {
    // Unwritable: say it this once anyway; it may repeat next launch.
  }
  return true;
}
