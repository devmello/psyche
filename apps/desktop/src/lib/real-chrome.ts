import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { Runner } from "../main/supervisor-base.ts";

/**
 * Settings → Browser → "Open the Psyche Chrome profile" (feature I13): the owner opens the
 * profile real-Chrome mode uses, once, to sign in and install 1Password there. It runs as a
 * normal Chrome window: no DevTools port, nothing attached. Never the owner's own Chrome
 * profile: the directory is Psyche's (`$PSYCHE_HOME/browser/real-chrome/<profile>`, the same
 * path `@psyche/browser`'s `realChromeDir` launches).
 */

/** Profile names as `@psyche/browser` accepts them. */
const PROFILE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function realChromeProfileDir(psycheHome: string, profile = "default"): string {
  if (!PROFILE.test(profile)) throw new Error(`invalid profile name ${JSON.stringify(profile)}`);
  return join(psycheHome, "browser", "real-chrome", profile);
}

/** The Chromium browsers Windows can open the profile in, in order of preference. */
export const WINDOWS_CHROMIUM = [
  { name: "Google Chrome", exe: "chrome.exe", dirs: ["Google\\Chrome\\Application"] },
  { name: "Microsoft Edge", exe: "msedge.exe", dirs: ["Microsoft\\Edge\\Application"] },
  {
    name: "Brave",
    exe: "brave.exe",
    dirs: ["BraveSoftware\\Brave-Browser\\Application"],
  },
] as const;

export interface WindowsBrowserLookup {
  /** The default value of `HK{CU,LM}\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\<exe>`. */
  appPath: (exe: string) => Promise<string | undefined>;
  exists?: (path: string) => boolean;
  /** `%ProgramFiles%`, `%ProgramFiles(x86)%`, `%LOCALAPPDATA%` (per-user installs). */
  env?: NodeJS.ProcessEnv;
}

/**
 * Finds Chrome, then Edge, then Brave: the App Paths registration each installer writes (per
 * user first, then per machine), else the standard install folders. Chrome first, because the
 * profile is Chrome's and the Gateway's real-Chrome mode launches the same browser.
 */
export async function findWindowsChromium(
  lookup: WindowsBrowserLookup,
): Promise<{ name: string; path: string } | undefined> {
  const exists = lookup.exists ?? existsSync;
  const env = lookup.env ?? process.env;
  const roots = [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA].filter(
    (r): r is string => typeof r === "string" && r !== "",
  );
  for (const b of WINDOWS_CHROMIUM) {
    const registered = await lookup.appPath(b.exe).catch(() => undefined);
    const cleaned = registered?.trim().replace(/^"(.*)"$/, "$1");
    if (cleaned && exists(cleaned)) return { name: b.name, path: cleaned };
    for (const root of roots) {
      for (const dir of b.dirs) {
        const path = `${root.replace(/\\+$/, "")}\\${dir}\\${b.exe}`;
        if (exists(path)) return { name: b.name, path };
      }
    }
  }
  return undefined;
}

/** The registry keys `appPath` reads (per user first: a per-user install wins on this account). */
export function appPathKeys(exe: string): string[] {
  const sub = `SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`;
  return [`HKCU\\${sub}`, `HKLM\\${sub}`];
}

/**
 * The default value from `reg query <key> /ve` output. The "(Default)" label is localized, so
 * the line is found by its type column.
 */
export function parseRegDefault(out: string): string | undefined {
  for (const line of out.split(/\r?\n/)) {
    const m = /\s+REG_(?:EXPAND_)?SZ\s+(.+)$/.exec(line);
    if (m?.[1]) return m[1].trim();
  }
  return undefined;
}

/** The Chromium browsers Linux can open the profile in, in order of preference (design §10.6). */
export const LINUX_CHROMIUM_COMMANDS = [
  { name: "Google Chrome", command: "google-chrome" },
  { name: "Google Chrome", command: "google-chrome-stable" },
  { name: "Chromium", command: "chromium" },
  { name: "Chromium", command: "chromium-browser" },
  { name: "Brave", command: "brave-browser" },
  { name: "Microsoft Edge", command: "microsoft-edge" },
] as const;

/** The same browsers as Flatpaks, tried after every one on the PATH. */
export const LINUX_CHROMIUM_FLATPAKS = [
  { name: "Google Chrome", id: "com.google.Chrome" },
  { name: "Chromium", id: "org.chromium.Chromium" },
  { name: "Brave", id: "com.brave.Browser" },
  { name: "Microsoft Edge", id: "com.microsoft.Edge" },
] as const;

export interface LinuxBrowser {
  name: string;
  command: string;
  /** Arguments before the profile's (empty for a command on the PATH). */
  args: string[];
  /** A Flatpak sandbox cannot see the profile folder unless it is granted. */
  flatpakId?: string;
}

export interface LinuxBrowserLookup {
  run: Runner;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
}

/**
 * Finds a Chromium browser on Linux: a command on the PATH first (Chrome before Chromium, Brave,
 * Edge: the profile is Chrome's), then a Flatpak (`flatpak info <id>` succeeds when installed).
 */
export async function findLinuxChromium(
  lookup: LinuxBrowserLookup,
): Promise<LinuxBrowser | undefined> {
  const exists = lookup.exists ?? existsSync;
  const dirs = (lookup.env ?? process.env).PATH?.split(delimiter).filter((d) => d !== "") ?? [];
  for (const b of LINUX_CHROMIUM_COMMANDS) {
    if (dirs.some((d) => exists(join(d, b.command)))) {
      return { name: b.name, command: b.command, args: [] };
    }
  }
  for (const f of LINUX_CHROMIUM_FLATPAKS) {
    if ((await lookup.run("flatpak", ["info", f.id])).code === 0) {
      return { name: f.name, command: "flatpak", args: ["run", f.id], flatpakId: f.id };
    }
  }
  return undefined;
}

/** How to start Google Chrome on this platform with that profile, or null when unsupported. */
export function realChromeOpenCommand(
  platform: NodeJS.Platform,
  userDataDir: string,
  /** Windows: the browser `findWindowsChromium` found. */
  windowsBrowser?: string,
  /** Linux: the browser `findLinuxChromium` found (default: `google-chrome` on the PATH). */
  linuxBrowser?: LinuxBrowser,
): { command: string; args: string[] } | null {
  const chromeArgs = [
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];
  if (platform === "darwin") {
    // `-n`: a new instance for this data dir, separate from the owner's running Chrome.
    return { command: "open", args: ["-n", "-a", "Google Chrome", "--args", ...chromeArgs] };
  }
  if (platform === "linux") {
    if (linuxBrowser === undefined) return { command: "google-chrome", args: chromeArgs };
    // The sandbox sees the profile folder through `--filesystem=<dir>` and nothing else new.
    const head =
      linuxBrowser.flatpakId === undefined
        ? linuxBrowser.args
        : ["run", `--filesystem=${userDataDir}`, linuxBrowser.flatpakId];
    return { command: linuxBrowser.command, args: [...head, ...chromeArgs] };
  }
  // A separate --user-data-dir is a separate browser instance on Windows too.
  if (platform === "win32" && windowsBrowser) return { command: windowsBrowser, args: chromeArgs };
  return null;
}
