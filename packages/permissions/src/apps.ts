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
  "com.robinhood.*",
  "com.coinbase.*",
  "com.schwab.*",
  "com.fidelity.*",
  "com.etrade.*",
  "com.webull.*",
  "com.interactivebrokers.*",
  "com.paypal.*",
  "com.chase.*",
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
      reason: "password managers, banking, trading and system settings are off",
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
  if (["screenshot", "ax_tree", "snapshot", "read", "find", "zoom", "list_windows"].includes(a))
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
