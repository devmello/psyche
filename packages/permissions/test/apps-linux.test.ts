import { describe, expect, it } from "vitest";
import { appCap, effectiveTier } from "../src/index.ts";

/** Linux desktop-file ids (apps/linux-helper): the same fixed caps as the Mac and Windows lists. */
describe("Linux fixed caps", () => {
  it.each([
    "firefox",
    "firefox-esr",
    "org.mozilla.firefox",
    "chromium",
    "chromium-browser",
    "google-chrome",
    "google-chrome-stable",
    "brave-browser",
    "vivaldi-stable",
    "epiphany",
    "org.gnome.Epiphany",
    "microsoft-edge",
    "librewolf",
    "falkon",
    "zen-browser",
  ])("browser %s is read-only", (id) => {
    expect(appCap(id).cap).toBe("read");
    expect(effectiveTier(id, "interact")).toMatchObject({ tier: "read", capped: true });
  });

  it.each([
    "gnome-terminal",
    "org.gnome.Terminal",
    "ptyxis",
    "konsole",
    "kitty",
    "alacritty",
    "wezterm",
    "foot",
    "xterm",
    "xfce4-terminal",
    "tilix",
    "kgx",
    "org.gnome.Console",
    "code",
    "code-oss",
    "codium",
    "cursor",
    "dev.zed.Zed",
    "sublime_text",
    "emacs",
    "idea",
    "pycharm",
    "android-studio",
    "org.gnome.Builder",
    "org.kde.kate",
    "org.kde.kdevelop",
    "jetbrains-idea",
    "jetbrains-pycharm-ce",
  ])("terminal or IDE %s is click-only", (id) => {
    expect(appCap(id).cap).toBe("click");
    expect(effectiveTier(id, "interact")).toMatchObject({ tier: "click", capped: true });
  });

  it.each([
    "keepassxc",
    "org.keepassxc.KeePassXC",
    "bitwarden",
    "1password",
    "enpass",
    "seahorse",
    "org.gnome.seahorse.Application",
    "kwalletmanager5",
    "org.kde.kwalletmanager6",
    "proton-pass",
    "nordpass",
    "gnome-shell",
    "plasmashell",
    "gnome-control-center",
    "org.gnome.Settings",
    "systemsettings",
    "polkit-gnome-authentication-agent-1",
    "org.kde.polkit-kde-authentication-agent-1",
    "gcr-prompter",
    "pinentry-gnome3",
    "gnome-initial-setup",
    "gdm",
    "sddm",
    "swaylock",
    "hyprlock",
    "psyche",
    "psyche-desktop",
    "psyche-helper",
    "com.psyche.desktop",
    "electrum",
    "org.electrum.Electrum",
    "ledger-live-desktop",
    "trezor-suite",
    "bitcoin-qt",
    "sparrow",
    "tradingview",
    "coinbase",
    "coinbase-wallet",
    "robinhood-desktop",
    "revolut",
  ])("%s is off and cannot be raised", (id) => {
    expect(appCap(id).cap).toBe("off");
    expect(effectiveTier(id, "interact")).toMatchObject({ tier: "off", capped: true });
    expect(effectiveTier(id, undefined)).toMatchObject({ tier: "off", capped: true });
  });

  it("compares ids without case", () => {
    expect(appCap("FireFox").cap).toBe("read");
    expect(appCap("GNOME-TERMINAL").cap).toBe("click");
    expect(appCap("KeePassXC").cap).toBe("off");
    expect(appCap("JetBrains-IDEA").cap).toBe("click");
  });

  it("caps any id under a trailing * prefix, and only those", () => {
    expect(appCap("jetbrains-idea").cap).toBe("click");
    expect(appCap("jetbrains-").cap).toBe("click");
    expect(appCap("jetbrainsx").cap).toBe("interact");
    expect(appCap("coinbasepro").cap).toBe("off");
    expect(appCap("xcoinbase").cap).toBe("interact");
  });

  it("keeps the dotted prefix patterns working as before", () => {
    expect(appCap("com.chase.mobile").cap).toBe("off");
    expect(appCap("com.chase").cap).toBe("interact");
    expect(appCap("com.jetbrains.intellij").cap).toBe("click");
    expect(appCap("com.jetbrainsx.thing").cap).toBe("interact");
  });

  it("leaves ordinary Linux apps at interact", () => {
    for (const id of ["org.gnome.TextEditor", "libreoffice-writer", "gedit", "thunderbird"]) {
      expect(appCap(id).cap).toBe("interact");
    }
  });
});
