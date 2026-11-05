/**
 * The platform module (Linux desktop design §10.8, PR L1). The one place in the desktop app that
 * reads `process.platform`: every other file asks a question here ("is there a Dock?", "which
 * shortcut opens the pop-up?") instead of comparing platform names, so a new platform means a new
 * answer in one table. `apps/desktop/test/platform/no-process-platform.test.ts` fails on a new
 * `process.platform` read anywhere else.
 *
 * Every function takes the platform as an argument (default: this machine's) so tests can ask
 * "what would Linux do?" on a Mac.
 */

export type Platform = NodeJS.Platform;

/** This machine's platform. The only `process.platform` read in the desktop app's main code. */
export function hostPlatform(): Platform {
  return process.platform;
}

export function isMac(platform: Platform = hostPlatform()): boolean {
  return platform === "darwin";
}

export function isLinux(platform: Platform = hostPlatform()): boolean {
  return platform === "linux";
}

/** What closing the last window does: `stay-with-tray` means "stay only while a tray can be shown". */
export type LastWindowClosed = "stay" | "stay-with-tray" | "quit";

export interface PlatformTraits {
  /** A Dock whose icon and activation policy the app manages (`DockPolicy`). */
  dock: boolean;
  /** Electron's `app.setLoginItemSettings` works (macOS and Windows only, not Linux). */
  nativeLoginItem: boolean;
  /** Glass (vibrancy) window mode and the macOS inset title bar with traffic lights. */
  glass: boolean;
  /** Files the app downloads carry the macOS quarantine attribute. */
  quarantine: boolean;
  /** `Tray.setTitle` draws text next to the icon (macOS only). */
  trayTitle: boolean;
  /** Whether the app and its tray outlive the last window. */
  lastWindowClosed: LastWindowClosed;
  /** Accelerators tried in order for the pop-up chat; the first one the OS accepts wins. */
  quickEntry: readonly string[];
  /** The label shown next to "Quick entry" in the tray menu. */
  quickEntryLabel: string;
}

const TRAITS: Record<"darwin" | "linux" | "other", PlatformTraits> = {
  darwin: {
    dock: true,
    nativeLoginItem: true,
    glass: true,
    quarantine: true,
    trayTitle: true,
    lastWindowClosed: "stay",
    // ⌥Space (docs/06 §3.21); ⌃⌥Space when another utility owns it.
    quickEntry: ["Alt+Space", "Control+Alt+Space"],
    quickEntryLabel: "Alt+Space",
  },
  linux: {
    dock: false,
    nativeLoginItem: false,
    glass: false,
    quarantine: false,
    trayTitle: false,
    lastWindowClosed: "stay-with-tray",
    // Alt+Space is the window menu on GNOME and KDE (design §10.4).
    quickEntry: ["Control+Alt+Space"],
    quickEntryLabel: "Ctrl+Alt+Space",
  },
  other: {
    dock: false,
    nativeLoginItem: true,
    glass: false,
    quarantine: false,
    trayTitle: false,
    lastWindowClosed: "quit",
    quickEntry: ["Alt+Space", "Control+Alt+Space"],
    quickEntryLabel: "Alt+Space",
  },
};

export function traitsFor(platform: Platform = hostPlatform()): PlatformTraits {
  return TRAITS[platform === "darwin" || platform === "linux" ? platform : "other"];
}

/**
 * Whether closing the last window quits the desktop process. On Linux it does when there is no
 * tray to reopen the app from (stock GNOME): an invisible process using RAM is the wrong answer.
 * The Gateway keeps running either way.
 */
export function quitsOnLastWindowClosed(
  platform: Platform = hostPlatform(),
  trayAvailable = true,
): boolean {
  const rule = traitsFor(platform).lastWindowClosed;
  return rule === "quit" || (rule === "stay-with-tray" && !trayAvailable);
}

/** The `.desktop` file id Electron reports to the shell, so GNOME's shortcut portal knows the app. */
export const LINUX_DESKTOP_NAME = "psyche.desktop";
