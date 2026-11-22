/**
 * The words the Gateway and the packages use for the computer they run on, in text that reaches
 * the owner (errors, statuses, approval cards, notifications): "this Mac" / "Touch ID" on macOS,
 * "this PC" / "Windows Hello" on Windows, "this computer" / "your password" on Linux (the account
 * password through the system dialog). Browser-safe (`@psyche/protocol/host-words`): no Node
 * imports.
 *
 * The Host helper runs on the Gateway's own computer (it pairs only over the local transport), so
 * its kind and `process.platform` agree; a caller that has the helper passes its kind, everything
 * else uses the platform.
 */

export type HostOs = "macos" | "windows" | "linux";

export interface HostWords {
  os: HostOs;
  /** "macOS" / "Windows" / "Linux". */
  osName: string;
  /** "Mac" / "PC" / "computer". */
  device: string;
  /** "this Mac" / "this PC" / "this computer". */
  thisDevice: string;
  /** "your Mac" / "your PC" / "your computer". */
  yourDevice: string;
  /** "the Mac" / "the PC" / "the computer". */
  theDevice: string;
  /** "Touch ID" / "Windows Hello" / "your password". */
  presence: string;
  /** "the keychain" / "Credential Manager" / "the system keyring". */
  secretStore: string;
  /** "System Settings" / "Settings". */
  systemSettings: string;
  /** "Finder" / "File Explorer" / "Files". */
  fileManager: string;
  /** "the Mac helper" / "the Windows helper" / "the Linux helper". */
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

const LINUX: HostWords = {
  os: "linux",
  osName: "Linux",
  device: "computer",
  thisDevice: "this computer",
  yourDevice: "your computer",
  theDevice: "the computer",
  presence: "your password",
  secretStore: "the system keyring",
  systemSettings: "Settings",
  fileManager: "Files",
  helper: "the Linux helper",
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
 * `mac-helper` → macOS, `linux-helper` → Linux; the generic `host-helper` kind says nothing), otherwise
 * the platform (`win32` → Windows, `linux` → Linux, anything else macOS).
 */
export function hostOs(
  helperKind?: string | null,
  platform: string | undefined = currentPlatform(),
): HostOs {
  if (helperKind === "win-helper") return "windows";
  if (helperKind === "mac-helper") return "macos";
  if (helperKind === "linux-helper") return "linux";
  if (platform === "win32") return "windows";
  return platform === "linux" ? "linux" : "macos";
}

/** The words for the Host: see `hostOs` for how the OS is chosen. */
export function hostWords(
  helperKind?: string | null,
  platform: string | undefined = currentPlatform(),
): HostWords {
  const os = hostOs(helperKind, platform);
  return os === "windows" ? WINDOWS : os === "linux" ? LINUX : MAC;
}
