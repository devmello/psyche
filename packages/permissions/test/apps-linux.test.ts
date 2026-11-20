import { describe, expect, it } from "vitest";
import { appCap, appIdAliases, effectiveTier } from "../src/index.ts";

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
    // Main's financial hard block (`FINANCIAL_APP_PREFIXES`) also caps the bare bank id; a longer
    // id that only starts with the same letters is not the bank's.
    expect(appCap("com.chase").cap).toBe("off");
    expect(appCap("com.chasex").cap).toBe("interact");
    expect(appCap("com.jetbrains.intellij").cap).toBe("click");
    expect(appCap("com.jetbrainsx.thing").cap).toBe("interact");
  });

  it("leaves ordinary Linux apps at interact", () => {
    for (const id of ["org.gnome.TextEditor", "libreoffice-writer", "gedit", "thunderbird"]) {
      expect(appCap(id).cap).toBe("interact");
    }
  });
});

/** Review of #1294, finding 10: apps that run what they open are off. */
describe("Linux program launchers", () => {
  it.each([
    "wine",
    "wine64",
    "wine-stable",
    "org.winehq.Wine",
    "winetricks",
    "com.usebottles.bottles",
    "net.lutris.Lutris",
    "lutris",
    "playonlinux",
    "java",
    "java-17-openjdk",
    "javaws",
    "openjdk-17-java",
    "icedtea-netx-javaws",
    "mono",
    "mono-runtime",
    "python",
    "python3",
    "python3.12",
    "idle3",
  ])("%s is off", (id) => {
    expect(appCap(id).cap).toBe("off");
    expect(effectiveTier(id, "interact")).toMatchObject({ tier: "off", capped: true });
  });

  it.each([
    "winecellar",
    "org.gnome.Wine-tasting",
    "javascript-editor",
    "javafx-scenebuilder",
    "monodevelop",
    "monospace-font-viewer",
    "pythonista",
    "org.gnome.TextEditor",
    "libreoffice-writer",
  ])("near miss %s keeps its tier", (id) => {
    expect(appCap(id).cap).not.toBe("off");
  });
});

/** Review of #1294 round 2, finding 1: snap desktop ids keep their app's caps. */
describe("snap desktop ids", () => {
  it.each([
    ["thunderbird_thunderbird", ["thunderbird_thunderbird", "thunderbird"]],
    ["chromium_chromium", ["chromium_chromium", "chromium"]],
    ["firefox_beta", ["firefox_beta", "beta", "firefox"]],
    ["Brave_Brave", ["brave_brave", "brave"]],
  ])("%s also stands for its app and snap", (id, aliases) => {
    expect(appIdAliases(id)).toEqual(aliases);
  });

  it.each([
    "org.claws_mail.claws-mail",
    "io.github.ungoogled_software.ungoogled_chromium",
    "com.apple.Safari",
    "a_b_c",
    "_x",
    "gnome-terminal",
  ])("%s is not split", (id) => {
    expect(appIdAliases(id)).toEqual([id.toLowerCase()]);
  });

  it.each([
    "chromium_chromium",
    "brave_brave",
    "firefox_firefox",
    "chrome",
    "brave",
    "io.github.ungoogled_software.ungoogled_chromium",
    "one.ablaze.floorp",
    "waterfox",
    "tor-browser",
    "mullvad-browser",
  ])("browser %s is read-only", (id) => {
    expect(appCap(id).cap).toBe("read");
  });

  it("the strictest alias wins", () => {
    // A snap whose app part is a password manager is off, whatever its snap is called.
    expect(appCap("whatever_keepassxc").cap).toBe("off");
    expect(appCap("gnome-terminal_x").cap).toBe("click");
    expect(appCap("thunderbird_thunderbird").cap).toBe("interact");
  });
});

/** Review of #1294 round 2, finding 4: more terminals, code-running IDEs and launchers. */
describe("more Linux caps", () => {
  it.each([
    "mate-terminal",
    "io.elementary.terminal",
    "guake",
    "org.kde.yakuake",
    "urxvt",
    "com.mitchellh.ghostty",
    "com.raggesilver.BlackBox",
    "footclient",
    "vim",
    "nvim",
    "org.geany.Geany",
    "thonny",
    "org.spyder_ide.spyder",
    "org.qt-project.qtcreator",
    "eclipse",
    "codeblocks",
  ])("%s is click-only", (id) => {
    expect(appCap(id).cap).toBe("click");
  });

  it.each(["idle-python3.12", "idle-python3", "lastpass", "dashlane"])("%s is off", (id) => {
    expect(appCap(id).cap).toBe("off");
  });

  it.each(["stellarium", "vimiv", "geany-plugins-doc", "org.gnome.TextEditor"])(
    "near miss %s keeps interact",
    (id) => {
      expect(appCap(id).cap).toBe("interact");
    },
  );
});
