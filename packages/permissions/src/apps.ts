import { FINANCIAL_APP_PREFIXES, isBrowserWebApp } from "@psyche/protocol/financial-block";
import type { AppTier } from "./policy.ts";

/**
 * Per-app computer-use tiers with fixed caps (security §12 "Tiers and fixed caps", architecture
 * §6, feature F6): browsers read-only (the agent browser is how to act on the web), terminals and
 * IDEs click-only, password managers, banking and trading apps Off and not overridable.
 */

export const TIER_RANK: Record<AppTier, number> = { off: 0, read: 1, click: 2, interact: 3 };

export const BROWSER_APPS = [
  // Each browser's channels (`com.google.Chrome.beta`, `.dev`, `.canary`, Edge Beta, Brave
  // Nightly, Firefox Developer Edition, Safari Technology Preview…): read-only like the browser.
  // Installed web apps (`com.google.Chrome.app.<id>`, `com.apple.Safari.WebApp.<id>`) are not
  // browsers and keep the owner's tier (`isBrowserWebApp`); computer use reads the page they show
  // before it acts there (#1321 round 3).
  "com.apple.Safari",
  "com.apple.Safari.*",
  "com.apple.SafariTechnologyPreview",
  "com.google.Chrome",
  "com.google.Chrome.*",
  "org.mozilla.firefox",
  "org.mozilla.firefox.*",
  "org.mozilla.firefoxdeveloperedition",
  "org.mozilla.nightly",
  "com.microsoft.edgemac",
  "com.microsoft.edgemac.*",
  "company.thebrowser.Browser",
  "company.thebrowser.*",
  "com.brave.Browser",
  "com.brave.Browser.*",
  "com.operasoftware.Opera",
  "com.operasoftware.*",
  "com.vivaldi.Vivaldi",
  "com.vivaldi.*",
  "org.chromium.Chromium",
  "org.chromium.*",
  "app.zen-browser.zen",
  "com.kagi.kagimacOS",
  "com.duckduckgo.macos.browser",
  "ai.perplexity.comet",
  "com.openai.atlas",
  "org.torproject.torbrowser",
  "com.sigmaos.sigmaos.macos",
  "net.waterfox.waterfox",
  "org.mozilla.librewolf",
  "io.gitlab.librewolf-community",
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
  // Linux snap, Flatpak and other browser ids (mirrors the helper's BROWSERS).
  "chrome",
  "brave",
  "brave-browser-stable",
  "google-chrome-unstable",
  "microsoft-edge-beta",
  "microsoft-edge-dev",
  "torbrowser-launcher",
  "mullvad-browser",
  "chromium_chromium",
  "brave_brave",
  "firefox_firefox",
  "io.github.ungoogled_software.ungoogled_chromium",
  "org.torproject.torbrowser-launcher",
  "com.github.micahflee.torbrowser-launcher",
  "one.ablaze.floorp",
  "com.opera.opera",
  "waterfox",
  "floorp",
  "tor-browser",
];

/**
 * Terminals, IDEs and script runners: click-only. The same list as the Mac helper's
 * `FixedCaps.terminalsAndIDEs` (Tiers.swift; a test keeps the two in step), which also caps any
 * other app whose Info.plist says it is a developer tool or a shell.
 */
export const TERMINAL_IDE_APPS = [
  "com.apple.Terminal",
  "com.googlecode.iterm2",
  "dev.warp.Warp-Stable",
  "com.mitchellh.ghostty",
  "net.kovidgoyal.kitty",
  "io.alacritty",
  "org.alacritty",
  "com.github.wez.wezterm",
  "co.zeit.hyper",
  "app.crynta.terax",
  "com.microsoft.VSCode",
  "com.microsoft.VSCodeInsiders",
  "com.vscodium",
  "com.todesktop.230313mzl4w4u92",
  "com.exafunction.windsurf",
  "dev.zed.Zed",
  "com.apple.dt.Xcode",
  "com.sublimetext.*",
  "com.jetbrains.*",
  "com.google.android.studio",
  "com.panic.Nova",
  "com.barebones.bbedit",
  "com.apple.ScriptEditor2",
  "com.apple.Automator",
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
];

/**
 * Linux terminals, editors and IDEs (desktop-file ids, compared without case): click-only, as the
 * Linux helper's `TERMINALS_AND_IDES` caps them. Kept apart from `TERMINAL_IDE_APPS`, which
 * the Mac and Windows helpers' lists mirror (`terminal-caps-sync.test.ts`).
 */
export const LINUX_TERMINAL_IDE_APPS = [
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
  // More Linux terminals, and editors and IDEs that run code (mirrors the helper).
  "mate-terminal",
  "io.elementary.terminal",
  "guake",
  "tilda",
  "org.kde.yakuake",
  "yakuake",
  "terminology",
  "sakura",
  "rxvt-unicode",
  "rxvt",
  "urxvt",
  "urxvtc",
  "st",
  "cool-retro-term",
  "deepin-terminal",
  "ghostty",
  "com.raggesilver.blackbox",
  "footclient",
  "foot-server",
  "vim",
  "nvim",
  "neovide",
  "nvim-qt",
  "geany",
  "org.geany.geany",
  "thonny",
  "org.thonny.thonny",
  "spyder",
  "org.spyder_ide.spyder",
  "qtcreator",
  "org.qt-project.qtcreator",
  "io.qt.qtcreator",
  "eclipse",
  "org.eclipse.java",
  "codeblocks",
  "org.codeblocks.codeblocks",
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
  // Every brokerage, exchange, wallet, bank and P2P app the hard block on trades and transfers
  // knows (`@psyche/protocol/financial-block`): one list, so the two cannot drift apart.
  ...FINANCIAL_APP_PREFIXES.flatMap((prefix) => [prefix, `${prefix}.*`]),
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
  // Linux password managers the helper also caps.
  "lastpass",
  "dashlane",
];

/**
 * Linux program launchers (desktop-file ids): opening a document with one of them runs it as a
 * program, whatever its extension (`wine invoice.pdf.exe`, `java -jar`, a Python script). Off,
 * so `apps.open` and computer use never drive them.
 */
export const LAUNCHER_APPS = [
  "wine",
  "wine64",
  "wine-*",
  "org.winehq.*",
  "winetricks",
  "wine-desktop",
  "com.usebottles.bottles",
  "bottles",
  "net.lutris.lutris",
  "lutris",
  "playonlinux",
  "q4wine",
  "crossover",
  "java",
  "java-*",
  "javaws",
  "openjdk-*",
  "icedtea-*",
  "mono",
  "mono-*",
  "python",
  "python2*",
  "python3*",
  "idle",
  "idle3*",
  "idle-python3*",
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

/** A snap's desktop-file id: `<snap>_<app>` (one underscore, no dots, snapd's characters). */
const SNAP_DESKTOP_ID = /^([a-z0-9][a-z0-9+-]*)_([a-z0-9][a-z0-9+-]*)$/;

/**
 * The ids an app id also stands for. A snap's desktop id `<snap>_<app>` (`thunderbird_thunderbird`,
 * `chromium_chromium`) is that app and that snap too, so the fixed caps and the send rule judge
 * every one of them (the Linux helper's `app_id::aliases` does the same). Dotted ids (Flatpak, Mac,
 * `org.claws_mail.claws-mail`) are never split. An extra alias can only add a match.
 */
export function appIdAliases(appId: string): string[] {
  const id = appId.trim().toLowerCase();
  const m = SNAP_DESKTOP_ID.exec(id);
  if (m === null) return [id];
  const [, snap = "", app = ""] = m;
  return [...new Set([id, app, snap])];
}

/** The fixed cap for one id, without aliases. */
function capOf(bundleId: string): { cap: AppTier; reason: string } {
  if (matchesAny(bundleId, LOCKED_OFF_APPS)) {
    return {
      cap: "off",
      reason:
        "password managers, banking, trading, system settings, notifications and security prompts are off",
    };
  }
  if (matchesAny(bundleId, LAUNCHER_APPS)) {
    return { cap: "off", reason: "apps that run programs (Wine, Java, Mono, Python) are off" };
  }
  if (matchesAny(bundleId, BROWSER_APPS) && !isBrowserWebApp(bundleId)) {
    return { cap: "read", reason: "browsers are read-only; the agent browser acts on the web" };
  }
  if (matchesAny(bundleId, TERMINAL_IDE_APPS) || matchesAny(bundleId, LINUX_TERMINAL_IDE_APPS)) {
    return { cap: "click", reason: "terminals and IDEs are click-only" };
  }
  return { cap: "interact", reason: "" };
}

/** The highest tier an app can ever get: the strictest cap of the id and its aliases. */
export function appCap(bundleId: string): { cap: AppTier; reason: string } {
  let best = capOf(bundleId);
  for (const alias of appIdAliases(bundleId).slice(1)) {
    const c = capOf(alias);
    if (TIER_RANK[c.cap] < TIER_RANK[best.cap]) best = c;
  }
  return best;
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
