import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  type BrowserDriverEx,
  PlaywrightDriver,
  type PlaywrightDriverOptions,
} from "@psyche/browser";
import { PsycheError } from "@psyche/protocol";

/**
 * The agent browser on a headless Linux Host (linux-helper-only design §7.4, B3). There is no
 * desktop window to serve the CDP bridge, so the Gateway runs the existing Playwright driver
 * against **headless** Chromium (Chromium's own headless mode: no display at all). It never
 * shares a display with computer use, which keeps the helper's private screen, so a
 * `virtual_screen` screenshot can never show the agent browser's pages or fields, and XTest input
 * can never reach them (B3 review r1, findings 2 and 3). The browser needs nothing of the helper.
 *
 * Chromium gets a private home and runtime dir under `$PSYCHE_HOME/browser/` (0700), its own NSS
 * store with none of the owner's client certificates or CAs, and no session bus. Persistent
 * profiles live under `$PSYCHE_HOME/browser/profiles`, which the exec deny profile protects, as it
 * does the private home. G4 holds: the browser runs on the Host.
 */

/** A started server driver: what `composeBrowser` routes calls to. */
export type ServerDriver = BrowserDriverEx & { dispose(): Promise<void> };

export interface ServerBrowserSetup {
  /**
   * Whether the server driver serves the agent's tabs now: a headless Host. Default for the
   * composed Gateway: `serverBrowserChoice` (the service env's `PSYCHE_BROWSER_DRIVER`, else
   * B0's logind answer `cachedGraphicalSession`); a setup passed in without it always serves.
   */
  wanted?: (signal?: AbortSignal) => Promise<boolean>;
  /** The Chromium to launch; default `findChromium()`. Without one the browser is unavailable. */
  executablePath?: string;
  /** Test seam: makes the driver (default `PlaywrightDriver`). */
  createDriver?: (options: PlaywrightDriverOptions) => ServerDriver;
  /** Test seam: makes the private dirs (default `preparePrivateDirs`). */
  prepareDirs?: (dirs: ServerBrowserDirs) => void;
  /** The service environment Chromium's PATH and locale come from (default this process's). */
  env?: NodeJS.ProcessEnv;
}

/**
 * The server driver as the Gateway composes it on Linux, from the service environment (read
 * once here; nothing the agent does can change it) and B0's shared logind answer: `bridge` turns
 * it off, `server` forces it, otherwise it serves exactly while logind reports no graphical
 * session for this user. Off on every other platform.
 */
export function serverBrowserSetupFor(
  platform: NodeJS.Platform,
  serviceEnv: NodeJS.ProcessEnv,
  graphicalSession: (signal?: AbortSignal) => Promise<boolean>,
): ServerBrowserSetup | false {
  const choice = serverBrowserChoice(platform, serviceEnv);
  if (choice === "bridge") return false;
  const env = { ...serviceEnv };
  const executablePath = findChromium(env);
  return {
    wanted:
      choice === "server" ? async () => true : async (signal) => !(await graphicalSession(signal)),
    ...(executablePath === undefined ? {} : { executablePath }),
    env,
  };
}

/**
 * `PSYCHE_BROWSER_DRIVER` from the **service** environment (read once, when the Gateway is
 * composed; the agent cannot set it): `bridge` keeps the desktop's bridge only, `server` forces the
 * server driver on Linux. Anything else: undefined, and logind decides. Only Linux has it.
 */
export function serverBrowserChoice(
  platform: NodeJS.Platform,
  serviceEnv: NodeJS.ProcessEnv,
): "bridge" | "server" | undefined {
  if (platform !== "linux") return "bridge";
  const choice = serviceEnv.PSYCHE_BROWSER_DRIVER?.trim().toLowerCase();
  return choice === "bridge" || choice === "server" ? choice : undefined;
}

/** Common Chromium-family paths on Linux distributions, first found wins. */
export const CHROMIUM_PATHS = [
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
] as const;

/** `PSYCHE_CHROMIUM` (service env) when set, else the first installed path, else undefined. */
export function findChromium(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = isFile,
): string | undefined {
  const chosen = env.PSYCHE_CHROMIUM?.trim();
  if (chosen !== undefined && chosen !== "") return chosen;
  return CHROMIUM_PATHS.find((p) => exists(p));
}

function isFile(path: string): boolean {
  try {
    return lstatSync(path).isFile() || lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

export const NO_CHROMIUM_MESSAGE =
  "Psyche's browser on this computer needs Chromium. Install it (for example `apt install chromium`) or set PSYCHE_CHROMIUM in the service's environment.";

export function noChromium(): PsycheError {
  return new PsycheError("unavailable", NO_CHROMIUM_MESSAGE, {
    details: { reason: "no_chromium" },
  });
}

/** Chromium's private dirs, all under `$PSYCHE_HOME/browser/`. */
export interface ServerBrowserDirs {
  home: string;
  config: string;
  cache: string;
  data: string;
  runtime: string;
}

export function serverBrowserDirs(psycheHome: string): ServerBrowserDirs {
  const home = join(psycheHome, "browser", "home");
  return {
    home,
    config: join(home, ".config"),
    cache: join(home, ".cache"),
    data: join(home, ".local", "share"),
    runtime: join(psycheHome, "browser", "run"),
  };
}

/** Makes the dirs 0700 (narrowing an existing one), refusing a link in their place. */
export function preparePrivateDirs(dirs: ServerBrowserDirs): void {
  for (const dir of [dirs.home, dirs.config, dirs.cache, dirs.data, dirs.runtime]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = lstatSync(dir);
    if (!st.isDirectory()) {
      throw new PsycheError("internal", `${dir} is not a directory`);
    }
    if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
  }
}

/**
 * The exact environment Chromium gets (B3 review r1, finding 6). Kept from the service env: PATH,
 * the locale, TZ and FONTCONFIG_PATH. Set: a private HOME and XDG dirs (its own `~/.pki/nssdb`, so
 * none of the owner's certificates or CAs), a private 0700 runtime dir, and no session bus
 * (`disabled:`), so neither Chromium nor anything it spawns reaches the owner's user bus. No
 * DISPLAY, WAYLAND_DISPLAY or XAUTHORITY: headless Chromium has no display.
 */
export function serverBrowserEnv(
  dirs: ServerBrowserDirs,
  base: NodeJS.ProcessEnv,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "LANG", "LC_ALL", "TZ", "FONTCONFIG_PATH"]) {
    const v = base[key];
    if (v !== undefined && v !== "") env[key] = v;
  }
  env.PATH ??= "/usr/local/bin:/usr/bin:/bin";
  env.HOME = dirs.home;
  env.XDG_CONFIG_HOME = dirs.config;
  env.XDG_CACHE_HOME = dirs.cache;
  env.XDG_DATA_HOME = dirs.data;
  env.XDG_RUNTIME_DIR = dirs.runtime;
  env.DBUS_SESSION_BUS_ADDRESS = "disabled:";
  return env;
}

/** Driver options for the server mode: headless, private env, profiles under the Host's home. */
export function serverDriverOptions(
  base: Pick<PlaywrightDriverOptions, "library" | "broker" | "redact" | "botAuth">,
  home: string,
  executablePath: string,
  env: NodeJS.ProcessEnv = process.env,
): PlaywrightDriverOptions {
  return {
    ...base,
    mode: "launch",
    headless: true,
    psycheHome: home,
    env: serverBrowserEnv(serverBrowserDirs(home), env),
    executablePath,
  };
}

export const createPlaywrightServerDriver = (options: PlaywrightDriverOptions): ServerDriver =>
  new PlaywrightDriver(options);
