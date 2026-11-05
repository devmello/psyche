/**
 * The operating system the UI runs on, for copy ("This Mac" / "This PC"), keyboard shortcuts
 * (⌘K / Ctrl+K) and the few platform styles (`:root[data-platform]`). One source for the kit and
 * the web shell, so no screen checks `navigator` itself.
 *
 * Detection, first match wins:
 * 1. `setUiPlatform()` (tests, stories, the dev `?platform=` flag);
 * 2. `<html data-platform>`: the desktop renderer sets it from the preload's `process.platform`
 *    before the first render ("macos" | "windows"; "darwin" / "win32" are accepted too);
 * 3. the browser: `navigator.userAgentData.platform`, `navigator.platform`, then the user agent.
 *
 * Anything else (Linux, phones, jsdom) is `other`: Ctrl shortcuts and the default (macOS) copy,
 * as before this module existed.
 */

export type UiPlatform = "macos" | "windows" | "other";

let pinned: UiPlatform | undefined;

/** Maps what hosts report (`process.platform`, `navigator.platform`, a dataset value) to a platform. */
export function normalizePlatform(raw: string | null | undefined): UiPlatform | undefined {
  if (raw === null || raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "") return undefined;
  if (v === "macos" || v === "mac" || v === "darwin" || v === "macintel" || v === "macintosh")
    return "macos";
  if (v === "windows" || v === "win32" || v === "win64" || v === "win") return "windows";
  if (v === "other" || v === "linux" || v === "web") return "other";
  return undefined;
}

function fromNavigator(): UiPlatform {
  // Node has a `navigator` too (Node 21+, "Win32" on Windows): without a document this is not a
  // browser, and helpers rendered there (tests, the CLI) keep the default copy.
  if (typeof navigator === "undefined" || typeof document === "undefined") return "other";
  const data = (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform;
  const fromData = normalizePlatform(data);
  if (fromData !== undefined) return fromData;
  const p = navigator.platform ?? "";
  // iPad and iPhone keyboards use ⌘ too; their copy is the default (macOS) copy anyway.
  if (/^(Mac|iPhone|iPad)/.test(p)) return "macos";
  if (/^Win/.test(p)) return "windows";
  // Real browsers' user agents only: jsdom's "(win32)" / "(darwin)" tokens stay `other`.
  const ua = navigator.userAgent ?? "";
  if (/Windows NT/.test(ua)) return "windows";
  if (/Macintosh|Mac OS X/.test(ua)) return "macos";
  return "other";
}

let detected: UiPlatform | undefined;

/** The platform the UI renders for. Cheap (every `t()` asks); call it where the value is used. */
export function uiPlatform(): UiPlatform {
  if (pinned !== undefined) return pinned;
  if (typeof document !== "undefined") {
    const fromRoot = normalizePlatform(document.documentElement.dataset.platform);
    if (fromRoot !== undefined) return fromRoot;
  }
  detected ??= fromNavigator();
  return detected;
}

/**
 * Pins the platform (tests, stories, a dev flag) and mirrors it on `<html data-platform>`;
 * `undefined` goes back to detection.
 */
export function setUiPlatform(platform: UiPlatform | undefined): void {
  pinned = platform;
  if (typeof document === "undefined") return;
  if (platform === undefined) delete document.documentElement.dataset.platform;
  else document.documentElement.dataset.platform = platform;
}

/**
 * Writes the detected platform to `<html data-platform>` when the host has not, so the platform
 * styles apply in a browser too. The value the desktop set is left alone.
 */
export function applyPlatformAttribute(): UiPlatform {
  const platform = uiPlatform();
  if (typeof document !== "undefined") {
    const root = document.documentElement;
    if (normalizePlatform(root.dataset.platform) !== platform) root.dataset.platform = platform;
  }
  return platform;
}

/** ⌘ is the command key (macOS); elsewhere Ctrl is. */
export const isMac = (): boolean => uiPlatform() === "macos";
export const isWindows = (): boolean => uiPlatform() === "windows";
