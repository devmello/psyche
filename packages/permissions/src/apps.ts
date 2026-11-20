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
];

/** Bundle ids compare without case: LaunchServices treats them case-insensitively (review #13). */
function matchesAny(bundleId: string, patterns: readonly string[]): boolean {
  const id = bundleId.toLowerCase();
  return patterns.some((raw) => {
    const p = raw.toLowerCase();
    return p.endsWith(".*") ? id.startsWith(p.slice(0, -1)) : id === p;
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
  if (matchesAny(bundleId, BROWSER_APPS) && !isBrowserWebApp(bundleId)) {
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
