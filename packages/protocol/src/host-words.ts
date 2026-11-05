/**
 * The words the Gateway and the packages use for the computer they run on, in text that reaches
 * the owner (errors, statuses, approval cards, notifications): "this Mac" / "Touch ID" on macOS,
 * "this PC" / "Windows Hello" on Windows. Browser-safe (`@psyche/protocol/host-words`): no Node
 * imports.
 *
 * The Host helper runs on the Gateway's own computer (it pairs only over the local transport), so
 * its kind and `process.platform` agree; a caller that has the helper passes its kind, everything
 * else uses the platform. Linux Gateways keep the macOS words, as they always had.
 */

export type HostOs = "macos" | "windows";

export interface HostWords {
  os: HostOs;
  /** "macOS" / "Windows". */
  osName: string;
  /** "Mac" / "PC". */
  device: string;
  /** "this Mac" / "this PC". */
  thisDevice: string;
  /** "your Mac" / "your PC". */
  yourDevice: string;
  /** "the Mac" / "the PC". */
  theDevice: string;
  /** "Touch ID" / "Windows Hello". */
  presence: string;
  /** "the keychain" / "Credential Manager". */
  secretStore: string;
  /** "System Settings" / "Settings". */
  systemSettings: string;
  /** "Finder" / "File Explorer". */
  fileManager: string;
  /** "the Mac helper" / "the Windows helper". */
  helper: string;
}

const MAC: HostWords = {
  os: "macos",
  osName: "macOS",
  device: "Mac",
  thisDevice: "this Mac",
  yourDevice: "your Mac",
  theDevice: "the Mac",
  presence: "Touch ID",
  secretStore: "the keychain",
  systemSettings: "System Settings",
  fileManager: "Finder",
  helper: "the Mac helper",
};

const WINDOWS: HostWords = {
  os: "windows",
  osName: "Windows",
  device: "PC",
  thisDevice: "this PC",
  yourDevice: "your PC",
  theDevice: "the PC",
  presence: "Windows Hello",
  secretStore: "Credential Manager",
  systemSettings: "Settings",
  fileManager: "File Explorer",
  helper: "the Windows helper",
};

/**
 * `process.platform` in Node; in a browser bundle (the UI kit renders approval cards too), the
 * viewing device's OS from the user agent, as the UI's own platform copy does.
 */
function currentPlatform(): string | undefined {
  if (typeof process !== "undefined" && typeof process.platform === "string") {
    return process.platform;
  }
  if (typeof navigator !== "undefined" && /Windows NT/.test(navigator.userAgent ?? "")) {
    return "win32";
  }
  return undefined;
}

/**
 * Which OS the words are for: the Host helper's kind when known (`win-helper` → Windows,
 * `mac-helper` → macOS), otherwise the platform (`win32` → Windows, anything else macOS).
 */
export function hostOs(
  helperKind?: string | null,
  platform: string | undefined = currentPlatform(),
): HostOs {
  if (helperKind === "win-helper") return "windows";
  if (helperKind === "mac-helper") return "macos";
  return platform === "win32" ? "windows" : "macos";
}

/** The words for the Host: see `hostOs` for how the OS is chosen. */
export function hostWords(
  helperKind?: string | null,
  platform: string | undefined = currentPlatform(),
): HostWords {
  return hostOs(helperKind, platform) === "windows" ? WINDOWS : MAC;
}
