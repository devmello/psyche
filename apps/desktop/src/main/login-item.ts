import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { disableAutostart, enableAutostart } from "../platform/autostart.ts";
import { hostPlatform } from "../platform/index.ts";

/**
 * "Open Psyche at login" (Settings → Appearance → Background). On, the OS starts Psyche when the
 * owner signs in, with `--background`: no window, no Dock icon, only the menu bar item (the
 * notification-area icon on Windows), with the agent browser host and its bridge up, so scheduled
 * runs that need the browser find it. Off is the default; the Gateway can still start the app for
 * a run that needs it.
 *
 * Windows registers the login item in `HKCU\…\Run` through Electron. A Squirrel.Windows install
 * keeps each version in its own `app-<version>` folder that the next update deletes, so the item
 * must start the stable `Update.exe --processStart Psyche.exe` instead (`windowsLoginCommand`).
 *
 * Linux has no Electron login item: an XDG autostart entry (`platform/autostart.ts`) does the
 * same, written only when the caller passes `autostart` (main.ts does on Linux).
 */
export const OPEN_AT_LOGIN_KEY = "appearance.openAtLogin";

export const BACKGROUND_ARG = "--background";

/**
 * Windows: the value name of the login item under `HKCU\…\CurrentVersion\Run` (Electron writes
 * `name`, else the AppUserModelID) and, once the owner switches it off in Task Manager, under
 * `…\Explorer\StartupApproved\Run`. The uninstall hook removes both (squirrel-events.ts).
 */
export const LOGIN_ITEM_NAME = "Psyche";

/** Electron's login-item settings (the Windows-only keys included). */
export interface LoginItemSettings {
  openAtLogin: boolean;
  args?: string[];
  path?: string;
  /** Windows: the `Run` value's name. */
  name?: string;
}

/** The slice of Electron's `app` the login item drives. */
export interface LoginApp {
  setLoginItemSettings(settings: LoginItemSettings): void;
}

export function openAtLogin(value: unknown): boolean {
  return value === true;
}

/**
 * The Squirrel.Windows layout (`@electron-forge/maker-squirrel`): the running exe is
 * `<root>\app-<version>\<Exe>.exe` and `<root>\Update.exe` exists. Returns the stable launcher
 * and the exe name, or undefined for any other layout (a ZIP, an unpackaged run).
 */
export function squirrelLayout(
  execPath: string,
  exists: (path: string) => boolean = existsSync,
): { updateExe: string; exeName: string } | undefined {
  const versionDir = dirname(execPath);
  if (!/^app-\d+\.\d+\.\d+/i.test(basename(versionDir))) return undefined;
  const updateExe = join(dirname(versionDir), "Update.exe");
  return exists(updateExe) ? { updateExe, exeName: basename(execPath) } : undefined;
}

/** What the Windows `Run` entry starts: Squirrel's `Update.exe` when installed by it. */
export interface LaunchCommandOptions {
  exists?: (path: string) => boolean;
  /** Arguments before ours: an unpackaged run passes the app folder to Electron's binary. */
  leadingArgs?: readonly string[];
}

/**
 * How to start Psyche with `args` from outside (the login item, the taskbar's jump list): the
 * stable Squirrel launcher when installed by it (`--process-start-args` carries ours as one
 * string), else this exe.
 */
export function windowsLaunchCommand(
  execPath: string,
  args: readonly string[],
  o: LaunchCommandOptions = {},
): { path: string; args: string[] } {
  const squirrel = squirrelLayout(execPath, o.exists);
  if (squirrel === undefined) return { path: execPath, args: [...(o.leadingArgs ?? []), ...args] };
  return {
    path: squirrel.updateExe,
    args: ["--processStart", squirrel.exeName, "--process-start-args", args.join(" ")],
  };
}

export function windowsLoginCommand(
  execPath: string,
  o: LaunchCommandOptions = {},
): { path: string; args: string[] } {
  return windowsLaunchCommand(execPath, [BACKGROUND_ARG], o);
}

/** The settings to pass for `on` on this platform (undefined where there is no login item). */
export function loginItemSettings(
  on: boolean,
  platform: NodeJS.Platform,
  execPath: string,
  o: LaunchCommandOptions = {},
): LoginItemSettings | undefined {
  if (platform === "darwin") return { openAtLogin: on, args: [BACKGROUND_ARG] };
  if (platform === "win32") {
    return { openAtLogin: on, ...windowsLoginCommand(execPath, o), name: LOGIN_ITEM_NAME };
  }
  return undefined;
}

/** Linux: the XDG autostart file and the command it runs (without `--background`). */
export interface LinuxAutostart {
  file: string;
  exec: readonly string[];
}

export class LoginItem {
  readonly #app: LoginApp;
  readonly #platform: NodeJS.Platform;
  readonly #execPath: string;
  readonly #command: LaunchCommandOptions;
  readonly #autostart: LinuxAutostart | undefined;
  readonly #warn: ((message: string) => void) | undefined;

  constructor(
    app: LoginApp,
    o: LaunchCommandOptions & {
      platform?: NodeJS.Platform;
      execPath?: string;
      /** Linux: where the autostart entry goes and what it runs. Without it Linux does nothing. */
      autostart?: LinuxAutostart;
      warn?: (m: string) => void;
    } = {},
  ) {
    this.#app = app;
    this.#autostart = o.autostart;
    this.#platform = o.platform ?? hostPlatform();
    this.#execPath = o.execPath ?? process.execPath;
    this.#command = {
      ...(o.exists ? { exists: o.exists } : {}),
      ...(o.leadingArgs ? { leadingArgs: o.leadingArgs } : {}),
    };
    this.#warn = o.warn;
  }

  set(value: unknown): void {
    if (this.#platform === "linux") {
      this.#setAutostart(openAtLogin(value));
      return;
    }
    const settings = loginItemSettings(
      openAtLogin(value),
      this.#platform,
      this.#execPath,
      this.#command,
    );
    if (settings === undefined) return;
    try {
      this.#app.setLoginItemSettings(settings);
    } catch (err) {
      this.#warn?.(`could not set the login item: ${String(err)}`);
    }
  }

  #setAutostart(on: boolean): void {
    if (this.#autostart === undefined) return;
    try {
      if (on) enableAutostart(this.#autostart.file, [...this.#autostart.exec, BACKGROUND_ARG]);
      else disableAutostart(this.#autostart.file);
    } catch (err) {
      this.#warn?.(`could not set the autostart entry: ${String(err)}`);
    }
  }

  onSettingsChanged(entries: readonly { key: string; value: unknown }[]): void {
    const entry = entries.find((e) => e.key === OPEN_AT_LOGIN_KEY);
    if (entry) this.set(entry.value);
  }

  /** Reads the stored setting once paired, so a changed value from another device applies too. */
  async load(call: (method: string, params: unknown) => Promise<unknown>): Promise<void> {
    try {
      const res = (await call("settings.get", { keys: [OPEN_AT_LOGIN_KEY] })) as {
        settings?: Record<string, unknown>;
      };
      // Never set: leave the login item as the owner has it in System Settings.
      const value = res.settings?.[OPEN_AT_LOGIN_KEY];
      if (value !== undefined) this.set(value);
    } catch (err) {
      this.#warn?.(`could not read ${OPEN_AT_LOGIN_KEY}: ${String(err)}`);
    }
  }
}
