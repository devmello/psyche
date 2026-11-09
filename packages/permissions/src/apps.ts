import type { AppTier } from "./policy.ts";

/**
 * Per-app computer-use tiers with fixed caps (security §12 "Tiers and fixed caps", architecture
 * §6, feature F6): browsers read-only (the agent browser is how to act on the web), terminals and
 * IDEs click-only, password managers, banking and trading apps Off and not overridable.
 */

export const TIER_RANK: Record<AppTier, number> = { off: 0, read: 1, click: 2, interact: 3 };

export const BROWSER_APPS = [
  "com.apple.Safari",
  "com.google.Chrome",
  "com.google.Chrome.canary",
  "org.mozilla.firefox",
  "com.microsoft.edgemac",
  "company.thebrowser.Browser",
  "com.brave.Browser",
  "com.operasoftware.Opera",
  "com.vivaldi.Vivaldi",
  "org.chromium.Chromium",
  // Windows: the helper names an app by its lowercase executable (apps/win-helper).
  "msedge.exe",
  "chrome.exe",
  "brave.exe",
  "firefox.exe",
  "opera.exe",
  "vivaldi.exe",
  "arc.exe",
  // Linux: desktop-file ids (apps/linux-helper), compared without case.
  "firefox",
  "firefox-esr",
  "chromium",
  "chromium-browser",
  "org.chromium.chromium",
  "google-chrome",
  "google-chrome-stable",
  "google-chrome-beta",
  "com.google.chrome",
  "brave-browser",
  "com.brave.browser",
  "vivaldi-stable",
  "vivaldi",
  "com.vivaldi.vivaldi",
  "epiphany",
  "org.gnome.epiphany",
  "microsoft-edge",
  "microsoft-edge-stable",
  "com.microsoft.edge",
  "librewolf",
  "io.gitlab.librewolf-community",
  "opera",
  "falkon",
  "org.kde.falkon",
  "zen-browser",
];

export const TERMINAL_IDE_APPS = [
  "com.apple.Terminal",
  "com.googlecode.iterm2",
  "dev.warp.Warp-Stable",
  "com.mitchellh.ghostty",
  "net.kovidgoyal.kitty",
  "io.alacritty",
  "com.microsoft.VSCode",
  "com.microsoft.VSCodeInsiders",
  "com.todesktop.230313mzl4w4u92",
  "dev.zed.Zed",
  "com.apple.dt.Xcode",
  "com.sublimetext.4",
  "com.jetbrains.*",
  // Windows terminals, shells and IDEs.
  "windowsterminal.exe",
  "wt.exe",
  "cmd.exe",
  "powershell.exe",
  "pwsh.exe",
  "conhost.exe",
  "openconsole.exe",
  "wezterm-gui.exe",
  "alacritty.exe",
  "code.exe",
  "code - insiders.exe",
  "cursor.exe",
  "zed.exe",
  "devenv.exe",
  "sublime_text.exe",
  "idea64.exe",
  "pycharm64.exe",
  "webstorm64.exe",
  "rider64.exe",
  "goland64.exe",
  "clion64.exe",
  // Linux terminals, editors and IDEs (desktop-file ids).
  "gnome-terminal",
  "org.gnome.terminal",
  "ptyxis",
  "org.gnome.ptyxis",
  "konsole",
  "org.kde.konsole",
  "kitty",
  "alacritty",
  "org.alacritty.alacritty",
  "wezterm",
  "org.wezfurlong.wezterm",
  "foot",
  "xterm",
  "uxterm",
  "xfce4-terminal",
  "tilix",
  "com.gexperts.tilix",
  "terminator",
  "lxterminal",
  "qterminal",
  "kgx",
  "org.gnome.console",
  "code",
  "code-oss",
  "codium",
  "vscodium",
  "com.visualstudio.code",
  "com.vscodium.codium",
  "cursor",
  "zed",
  "dev.zed.zed",
  "sublime_text",
  "sublime-text",
  "emacs",
  "gvim",
  "jetbrains-*",
  "idea",
  "pycharm",
  "webstorm",
  "clion",
  "goland",
  "rider",
  "android-studio",
  "org.gnome.builder",
  "org.kde.kate",
  "org.kde.kdevelop",
];

/** Off, and the owner cannot raise them (chat or settings). */
export const LOCKED_OFF_APPS = [
  "com.1password.1password",
  "com.agilebits.onepassword7",
  "com.bitwarden.desktop",
  "com.lastpass.LastPass",
  "com.dashlane.Dashlane",
  "com.apple.Passwords",
  "com.apple.keychainaccess",
  "com.apple.systempreferences",
  "com.apple.SystemSettings",
  // Psyche's own windows and the processes that draw its approval banners and system
  // authorization prompts (#269): the agent must never press Approve on its own cards.
  "com.psyche.desktop",
  "com.psyche.helper",
  "com.apple.notificationcenterui",
  "com.apple.UserNotificationCenter",
  "com.apple.SecurityAgent",
  "com.apple.LocalAuthentication.UIAgent",
  "com.apple.coreservices.uiagent",
  "com.apple.loginwindow",
  "com.dashlane.dashlanephonefinal",
  "com.robinhood.*",
  "com.coinbase.*",
  "com.schwab.*",
  "com.fidelity.*",
  "com.etrade.*",
  "com.webull.*",
  "com.interactivebrokers.*",
  "com.paypal.*",
  "com.chase.*",
  // Windows: password managers, Settings and the system's credential and consent prompts,
  // Psyche's own app and helper.
  "1password.exe",
  "bitwarden.exe",
  "keepass.exe",
  "keepassxc.exe",
  "dashlane.exe",
  "lastpass.exe",
  "systemsettings.exe",
  "consent.exe",
  "credentialuibroker.exe",
  "lockapp.exe",
  "logonui.exe",
  "psyche.exe",
  "psyche-helper.exe",
  // Linux: password managers and keyrings, the shell, Settings and the authentication prompts,
  // Psyche itself, and banking and crypto apps (desktop-file ids).
  "keepassxc",
  "org.keepassxc.keepassxc",
  "keepass2",
  "bitwarden",
  "1password",
  "enpass",
  "seahorse",
  "org.gnome.seahorse.application",
  "kwalletmanager5",
  "kwalletmanager6",
  "org.kde.kwalletmanager5",
  "org.kde.kwalletmanager6",
  "gnome-keyring",
  "proton-pass",
  "nordpass",
  "gnome-shell",
  "org.gnome.shell",
  "plasmashell",
  "org.kde.plasmashell",
  "gnome-control-center",
  "org.gnome.settings",
  "org.gnome.controlcenter",
  "systemsettings",
  "org.kde.systemsettings",
  "polkit-gnome-authentication-agent-1",
  "polkit-kde-authentication-agent-1",
  "org.kde.polkit-kde-authentication-agent-1",
  "polkit-mate-authentication-agent-1",
  "lxqt-policykit-agent",
  "xfce-polkit",
  "gcr-prompter",
  "gcr-viewer",
  "pinentry-gnome3",
  "pinentry-qt",
  "pinentry-gtk-2",
  "org.gnome.initialsetup",
  "gnome-initial-setup",
  "gdm",
  "sddm",
  "lightdm",
  "gnome-screensaver",
  "org.gnome.screensaver",
  "xscreensaver",
  "swaylock",
  "hyprlock",
  "psyche",
  "psyche-desktop",
  "psyche-helper",
  "electrum",
  "org.electrum.electrum",
  "exodus",
  "ledger-live-desktop",
  "trezor-suite",
  "bitcoin-qt",
  "org.bitcoin.bitcoin-qt",
  "sparrow",
  "tradingview",
  "coinbase*",
  "robinhood*",
  "revolut*",
];

/**
 * Bundle ids compare without case: LaunchServices treats them case-insensitively (review #13).
 * A pattern ending in "*" matches every id that starts with what comes before it
 * ("com.chase.*", "jetbrains-*", "coinbase*").
 */
function matchesAny(bundleId: string, patterns: readonly string[]): boolean {
  const id = bundleId.toLowerCase();
  return patterns.some((raw) => {
    const p = raw.toLowerCase();
    return p.endsWith("*") ? id.startsWith(p.slice(0, -1)) : id === p;
  });
}

export function appCap(bundleId: string): { cap: AppTier; reason: string } {
  if (matchesAny(bundleId, LOCKED_OFF_APPS)) {
    return {
      cap: "off",
      reason:
        "password managers, banking, trading, system settings, notifications and security prompts are off",
    };
  }
  if (matchesAny(bundleId, BROWSER_APPS)) {
    return { cap: "read", reason: "browsers are read-only; the agent browser acts on the web" };
  }
  if (matchesAny(bundleId, TERMINAL_IDE_APPS)) {
    return { cap: "click", reason: "terminals and IDEs are click-only" };
  }
  return { cap: "interact", reason: "" };
}

/** Tier an action needs. Unknown actions need `interact`. */
export function tierRequired(action: string): AppTier {
  const a = action.replace(/^computer\./, "");
  if (
    [
      "screenshot",
      "ax_tree",
      "snapshot",
      "check_target",
      "read",
      "find",
      "zoom",
      "list_windows",
    ].includes(a)
  )
    return "read";
  if (["click", "left_click", "double_click", "scroll", "hover", "open_app", "focus"].includes(a))
    return "click";
  return "interact";
}

/**
 * Effective tier: the owner's setting (or `undefined` when never chosen) capped by the fixed
 * caps. Returns the cap reason when the cap lowered it.
 */
export function effectiveTier(
  bundleId: string,
  configured: AppTier | undefined,
): { tier: AppTier | undefined; capped: boolean; reason: string } {
  const { cap, reason } = appCap(bundleId);
  if (configured === undefined)
    return { tier: cap === "off" ? "off" : undefined, capped: cap === "off", reason };
  if (TIER_RANK[configured] > TIER_RANK[cap]) return { tier: cap, capped: true, reason };
  return { tier: configured, capped: false, reason: "" };
}
