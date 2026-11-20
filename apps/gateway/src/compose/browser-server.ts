import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  type BrowserDriverEx,
  PlaywrightDriver,
  type PlaywrightDriverOptions,
} from "@psyche/browser";
import { type ErrorPayload, PsycheError, VscreenStatus } from "@psyche/protocol";
import { Value } from "@sinclair/typebox/value";
import { headlessLinuxHost } from "./headless-host.ts";

/**
 * The agent browser on a headless Linux Host (linux-helper-only design §7.4, B3). There is no
 * desktop window to serve the CDP bridge, so the Gateway runs the existing Playwright driver
 * against a headful Chromium on the Host helper's private screen (its Xvfb, L6). The owner watches
 * that screen in the watch pane (`computerWatch.*`, also from a paired desktop Client) and takes
 * over there to sign in. Persistent profiles live under the Host's `$PSYCHE_HOME/browser/profiles`,
 * which the exec deny profile already protects. G4 holds: the browser runs on the Host.
 */

/** The display Chromium opens on: the X display and its private authority file. */
export interface ServerScreen {
  display: string;
  /** `XAUTHORITY` for the display; null when the server needs no cookie. */
  xauthority: string | null;
}

/** A started server driver: what `composeBrowser` routes calls to. */
export type ServerDriver = BrowserDriverEx & { dispose(): Promise<void> };

/** While the owner holds the private screen (watch pane take-over), the agent's calls wait. */
export interface ScreenTakeOver {
  isTakenOver(): boolean;
  /** Resolves when the agent may act; rejects (retryable `user_in_control`) after a bound. */
  agentGate(signal?: AbortSignal): Promise<void>;
  /** Runs `listener` whenever the screen stopped; returns the unsubscribe. */
  onStopped?(listener: () => void): () => void;
}

export interface ServerBrowserSetup {
  /** Starts the private screen (or finds the running one). */
  screen(): Promise<ServerScreen>;
  /** The Chromium to launch; default `findChromium()`, else Playwright's own build. */
  executablePath?: string;
  /** Test seam: makes the driver (default `PlaywrightDriver`). */
  createDriver?: (options: PlaywrightDriverOptions) => ServerDriver;
}

/**
 * The server driver is wanted on a headless Linux Host (`headlessLinuxHost`): no desktop app can
 * serve the bridge there. `PSYCHE_BROWSER_DRIVER=bridge` keeps the bridge only, `=server` forces
 * the server driver on Linux even with a session. Only Linux has the helper's private screen.
 */
export function serverBrowserWanted(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (platform !== "linux") return false;
  const choice = env.PSYCHE_BROWSER_DRIVER?.trim().toLowerCase();
  if (choice === "bridge") return false;
  if (choice === "server") return true;
  return headlessLinuxHost(platform, env);
}

/** Common Chromium-family paths on Linux distributions, first found wins. */
export const CHROMIUM_PATHS = [
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
] as const;

/** `PSYCHE_CHROMIUM` when set, else the first installed path, else Playwright's own build. */
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

/** What `findXauthority` reads of the file system (a test seam). */
export interface XauthFs {
  readdir(dir: string): string[];
  lstat(path: string): {
    isDirectory(): boolean;
    isFile(): boolean;
    mode: number;
    uid: number;
    mtimeMs: number;
  };
}

const realFs: XauthFs = {
  readdir: (dir) => readdirSync(dir),
  lstat: (path) => lstatSync(path),
};

/**
 * The authority file the helper wrote for `display` (`Xvfb -auth`): `xauth-<tag>-<n>-<hex>` in
 * `$XDG_RUNTIME_DIR/psyche` (apps/linux-helper `vscreen/xauth.rs`). The directory must be a real
 * directory of this user that nobody else can reach (0700), and the file a regular file of this
 * user, not a link; a newer server on the same display wins. Anything else: null, and Chromium
 * cannot open the display (fail closed, never another account's cookie).
 */
export function findXauthority(
  display: string,
  runtimeDir: string | undefined,
  uid: number = process.getuid?.() ?? -1,
  fs: XauthFs = realFs,
): string | null {
  const n = /^:(\d{1,4})$/.exec(display)?.[1];
  if (n === undefined || runtimeDir === undefined || runtimeDir === "") return null;
  const dir = join(runtimeDir, "psyche");
  try {
    const st = fs.lstat(dir);
    if (!st.isDirectory() || st.uid !== uid || (st.mode & 0o077) !== 0) return null;
  } catch {
    return null;
  }
  const pattern = new RegExp(`^xauth-[A-Za-z0-9]+-${n}-[0-9a-f]{12}$`);
  let best: { path: string; at: number } | null = null;
  let names: string[];
  try {
    names = fs.readdir(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    if (!pattern.test(name)) continue;
    const path = join(dir, name);
    try {
      const st = fs.lstat(path);
      if (!st.isFile() || st.uid !== uid || (st.mode & 0o077) !== 0) continue;
      if (best === null || st.mtimeMs > best.at) best = { path, at: st.mtimeMs };
    } catch {
      // Removed meanwhile: an older server's late cleanup.
    }
  }
  return best?.path ?? null;
}

/** The minimum the screen needs of the Host helper (`NodeRegistry.hostHelper`). */
export interface ScreenHelper {
  invoke(
    capability: string,
    params: Record<string, unknown>,
    options: { timeoutMs: number },
  ): Promise<{ ok: boolean; result?: unknown; error?: ErrorPayload }>;
}

const NO_SCREEN: ErrorPayload = {
  code: "unavailable",
  message:
    "Psyche's browser on this computer needs the Linux helper's private screen, and the helper is not connected.",
  details: { reason: "no_linux_helper" },
};

/**
 * Starts the private screen on the Host helper (`vscreen.start`, idempotent while it runs) and
 * finds its authority file. The Gateway's own internal start: the agent never gets `vscreen.*`
 * from here (input stays the owner's, through the watch pane); the browser's own calls are
 * brokered by the browser tools' gate.
 */
export async function startServerScreen(
  helper: ScreenHelper | undefined,
  env: NodeJS.ProcessEnv = process.env,
  find: typeof findXauthority = findXauthority,
): Promise<ServerScreen> {
  if (helper === undefined) throw fromPayload(NO_SCREEN);
  const res = await helper.invoke("vscreen.start", {}, { timeoutMs: 20_000 });
  if (!res.ok) throw fromPayload(res.error ?? { code: "internal", message: "the helper failed" });
  const status: unknown = res.result;
  if (!Value.Check(VscreenStatus, status) || typeof status.display !== "string") {
    throw new PsycheError(
      "internal",
      "vscreen.start: the helper answered with an unexpected shape",
    );
  }
  const display = status.display;
  return { display, xauthority: find(display, env.XDG_RUNTIME_DIR) };
}

function fromPayload(e: ErrorPayload): PsycheError {
  return new PsycheError(e.code, e.message, {
    ...(e.details === undefined ? {} : { details: e.details }),
    ...(e.retryable === undefined ? {} : { retryable: e.retryable }),
  });
}

/**
 * The environment Chromium gets: the private screen and nothing of the owner's own display or
 * session bus, so a page can never open on, or talk to, a screen the owner is using.
 */
export function serverBrowserEnv(
  screen: ServerScreen,
  base: NodeJS.ProcessEnv,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [
    "PATH",
    "HOME",
    "LANG",
    "LC_ALL",
    "TZ",
    "XDG_RUNTIME_DIR",
    "FONTCONFIG_PATH",
  ]) {
    const v = base[key];
    if (v !== undefined) env[key] = v;
  }
  env.DISPLAY = screen.display;
  if (screen.xauthority !== null) env.XAUTHORITY = screen.xauthority;
  return env;
}

/** Driver options for the server mode: headful, on the screen, profiles under the Host's home. */
export function serverDriverOptions(
  screen: ServerScreen,
  base: Pick<PlaywrightDriverOptions, "library" | "broker" | "redact" | "botAuth">,
  home: string,
  executablePath: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): PlaywrightDriverOptions {
  return {
    ...base,
    mode: "launch",
    headless: false,
    psycheHome: home,
    env: serverBrowserEnv(screen, env),
    ...(executablePath === undefined ? {} : { executablePath }),
  };
}

export const createPlaywrightServerDriver = (options: PlaywrightDriverOptions): ServerDriver =>
  new PlaywrightDriver(options);
