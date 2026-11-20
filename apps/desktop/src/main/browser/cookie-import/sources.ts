import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";

/**
 * The browsers "Import sign-ins from…" reads (docs/design/cookie-import-2026.md), and their
 * profiles. Only the owner's own files under their home folder are looked at, and only read.
 */

export const IMPORT_BROWSERS = ["chrome", "brave", "edge", "arc", "firefox", "safari"] as const;
export type ImportBrowser = (typeof IMPORT_BROWSERS)[number];

export function isImportBrowser(v: unknown): v is ImportBrowser {
  return typeof v === "string" && (IMPORT_BROWSERS as readonly string[]).includes(v);
}

/** Why a browser can't be read: Safari needs Full Disk Access; other OSes are a follow-up. */
export type UnsupportedReason = "full_disk_access" | "platform";

export interface ImportProfile {
  /** Chromium: the profile folder name (`Default`, `Profile 1`). Firefox: `profiles.ini` Path. */
  id: string;
  name: string;
}

export interface ImportSource {
  browser: ImportBrowser;
  /** Psyche can read this browser on this computer. */
  supported: boolean;
  reason?: UnsupportedReason;
  /** The browser's data folder exists. */
  installed: boolean;
  profiles: ImportProfile[];
}

interface ChromiumSpec {
  kind: "chromium";
  /** Under `~/Library/Application Support`. */
  dir: string[];
  /** The Keychain item macOS asks about ("<Browser> Safe Storage"). */
  keychainService: string;
}

const CHROMIUM: Record<"chrome" | "brave" | "edge" | "arc", ChromiumSpec> = {
  chrome: { kind: "chromium", dir: ["Google", "Chrome"], keychainService: "Chrome Safe Storage" },
  brave: {
    kind: "chromium",
    dir: ["BraveSoftware", "Brave-Browser"],
    keychainService: "Brave Safe Storage",
  },
  edge: {
    kind: "chromium",
    dir: ["Microsoft Edge"],
    keychainService: "Microsoft Edge Safe Storage",
  },
  arc: { kind: "chromium", dir: ["Arc", "User Data"], keychainService: "Arc Safe Storage" },
};

export function isChromium(b: ImportBrowser): b is keyof typeof CHROMIUM {
  return b in CHROMIUM;
}

export function keychainServiceOf(b: keyof typeof CHROMIUM): string {
  return CHROMIUM[b].keychainService;
}

function appSupport(homeDir: string): string {
  return join(homeDir, "Library", "Application Support");
}

function chromiumRoot(homeDir: string, b: keyof typeof CHROMIUM): string {
  return join(appSupport(homeDir), ...CHROMIUM[b].dir);
}

function firefoxRoot(homeDir: string): string {
  return join(appSupport(homeDir), "Firefox");
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Chromium moved `Cookies` into `Network/` (M96); older profiles keep it at the top. */
export function chromiumCookiesFile(profileDir: string): string | undefined {
  for (const p of [join(profileDir, "Network", "Cookies"), join(profileDir, "Cookies")]) {
    if (isFile(p)) return p;
  }
  return undefined;
}

const PROFILE_DIR = /^(Default|Profile \d{1,4}|Guest Profile)$/;

function chromiumProfiles(root: string): ImportProfile[] {
  const names = new Map<string, string>();
  try {
    const state = JSON.parse(readFileSync(join(root, "Local State"), "utf8")) as {
      profile?: { info_cache?: Record<string, { name?: unknown }> };
    };
    for (const [dir, info] of Object.entries(state.profile?.info_cache ?? {})) {
      if (typeof info?.name === "string" && info.name.trim() !== "") names.set(dir, info.name);
    }
  } catch {
    // No Local State: fall back to the folder names.
  }
  let dirs: string[] = [];
  try {
    dirs = readdirSync(root);
  } catch {
    return [];
  }
  return dirs
    .filter((d) => PROFILE_DIR.test(d) && d !== "Guest Profile")
    .filter((d) => chromiumCookiesFile(join(root, d)) !== undefined)
    .sort((a, b) => (a === "Default" ? -1 : b === "Default" ? 1 : a.localeCompare(b)))
    .map((d) => ({ id: d, name: names.get(d) ?? d }));
}

interface IniSection {
  name: string;
  keys: Map<string, string>;
}

function parseIni(text: string): IniSection[] {
  const out: IniSection[] = [];
  let cur: IniSection | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith(";") || line.startsWith("#")) continue;
    const head = /^\[(.+)\]$/.exec(line);
    if (head) {
      cur = { name: head[1] as string, keys: new Map() };
      out.push(cur);
      continue;
    }
    const eq = line.indexOf("=");
    if (cur && eq > 0) cur.keys.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return out;
}

/** Firefox profile folder for a `profiles.ini` entry; a relative Path must stay inside root. */
function firefoxProfileDir(root: string, path: string, relative: boolean): string | undefined {
  if (path === "") return undefined;
  if (!relative) return isAbsolute(path) ? path : undefined;
  const dir = resolve(root, path);
  return dir.startsWith(root + sep) ? dir : undefined;
}

function firefoxProfiles(root: string): ImportProfile[] {
  let text: string;
  try {
    text = readFileSync(join(root, "profiles.ini"), "utf8");
  } catch {
    return [];
  }
  const out: ImportProfile[] = [];
  for (const s of parseIni(text)) {
    if (!/^Profile\d+$/.test(s.name)) continue;
    const path = s.keys.get("Path") ?? "";
    const dir = firefoxProfileDir(root, path, s.keys.get("IsRelative") !== "0");
    if (dir === undefined || !isFile(join(dir, "cookies.sqlite"))) continue;
    out.push({ id: path, name: s.keys.get("Name") || path });
  }
  return out;
}

/** Every browser in the picker, with its profiles. Safari is listed as not supported. */
export function listSources(homeDir: string, platform: NodeJS.Platform): ImportSource[] {
  return IMPORT_BROWSERS.map((browser): ImportSource => {
    if (browser === "safari") {
      return {
        browser,
        supported: false,
        reason: "full_disk_access",
        installed: platform === "darwin",
        profiles: [],
      };
    }
    if (platform !== "darwin") {
      return { browser, supported: false, reason: "platform", installed: false, profiles: [] };
    }
    const root = isChromium(browser) ? chromiumRoot(homeDir, browser) : firefoxRoot(homeDir);
    const installed = existsSync(root);
    const profiles = !installed
      ? []
      : isChromium(browser)
        ? chromiumProfiles(root)
        : firefoxProfiles(root);
    return { browser, supported: true, installed, profiles };
  });
}

/**
 * The cookie file of a listed profile. The id comes from the renderer, so it is looked up in a
 * fresh listing rather than joined onto a path.
 */
export function cookieFileOf(
  homeDir: string,
  platform: NodeJS.Platform,
  browser: ImportBrowser,
  profileId: string,
): string | undefined {
  const source = listSources(homeDir, platform).find((s) => s.browser === browser);
  if (!source?.supported || !source.profiles.some((p) => p.id === profileId)) return undefined;
  if (isChromium(browser)) {
    return chromiumCookiesFile(join(chromiumRoot(homeDir, browser), profileId));
  }
  const root = firefoxRoot(homeDir);
  for (const s of parseIni(readFileSync(join(root, "profiles.ini"), "utf8"))) {
    if (!/^Profile\d+$/.test(s.name) || s.keys.get("Path") !== profileId) continue;
    const dir = firefoxProfileDir(root, profileId, s.keys.get("IsRelative") !== "0");
    return dir === undefined ? undefined : join(dir, "cookies.sqlite");
  }
  return undefined;
}
