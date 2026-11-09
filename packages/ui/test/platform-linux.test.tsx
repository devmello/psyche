import { IntlMessageFormat } from "intl-messageformat";
import { afterEach, describe, expect, it } from "vitest";
import { createI18n, setActiveI18n, t } from "../src/i18n/core.ts";
import { en, type MessageId } from "../src/i18n/messages/index.ts";
import { linux } from "../src/i18n/messages/variants/linux.ts";
import { LINUX_LOCALES } from "../src/i18n/messages/variants/linux-locales.ts";
import { chordLabel, keysLabel } from "../src/lib/keys.ts";
import {
  isLinux,
  isMac,
  isWindows,
  normalizePlatform,
  setUiPlatform,
  uiPlatform,
} from "../src/lib/platform.ts";
import { macOnlyAvailable, platformTerm } from "../src/lib/platform-copy.ts";

afterEach(() => {
  setUiPlatform(undefined);
  setActiveI18n(createI18n({ locale: "en-US" }));
});

/** The argument names an ICU message uses, sorted (plural `#` and tags aside). */
function argumentsOf(message: string): string[] {
  const names = new Set<string>();
  const walk = (nodes: unknown[]) => {
    for (const n of nodes as { type: number; value?: unknown; options?: unknown }[]) {
      // 1 argument, 2 number, 3 date, 4 time, 5 select, 6 plural (icu-messageformat-parser).
      if (n.type >= 1 && n.type <= 6 && typeof n.value === "string") names.add(n.value);
      if (n.options && typeof n.options === "object")
        for (const o of Object.values(n.options as Record<string, { value: unknown[] }>))
          walk(o.value);
    }
  };
  // As core.ts compiles them: "<host>" in a hint is text, not a tag.
  walk(new IntlMessageFormat(message, "en", undefined, { ignoreTag: true }).getAst() as unknown[]);
  return [...names].sort();
}

describe("Linux platform detection", () => {
  it("reads <html data-platform> as the desktop sets it, and maps linux to its own platform", () => {
    expect(normalizePlatform("linux")).toBe("linux");
    expect(normalizePlatform("Linux")).toBe("linux");
    expect(normalizePlatform("web")).toBe("other");
    expect(normalizePlatform("other")).toBe("other");
    expect(normalizePlatform("freebsd")).toBeUndefined();
    document.documentElement.dataset.platform = "linux";
    expect(uiPlatform()).toBe("linux");
    expect(isLinux()).toBe(true);
    expect(isMac()).toBe(false);
    expect(isWindows()).toBe(false);
    delete document.documentElement.dataset.platform;
    // jsdom's own user agent names the host OS as "(linux)": that is not a browser.
    expect(uiPlatform()).toBe("other");
  });

  it("pins and mirrors the platform on <html data-platform>", () => {
    setUiPlatform("linux");
    expect(document.documentElement.dataset.platform).toBe("linux");
    expect(uiPlatform()).toBe("linux");
  });

  it("types Ctrl chords as text, as on Windows", () => {
    expect(chordLabel({ key: "k", mod: true }, "linux")).toBe("Ctrl+K");
    expect(chordLabel({ key: "b", mod: true, shift: true, alt: true }, "linux")).toBe(
      "Ctrl+Alt+Shift+B",
    );
    expect(keysLabel("Mod+K", "linux")).toBe("Ctrl+K");
  });
});

describe("Linux copy (i18n/messages/variants/linux.ts)", () => {
  it("names this computer, your password and Files on Linux, and the Mac elsewhere", () => {
    expect(t("web.remote.thisMac")).toBe("This Mac");
    setUiPlatform("linux");
    expect(t("web.remote.thisMac")).toBe("This computer");
    expect(t("onboarding.safety.touchId")).toBe("Your password for payments");
    expect(t("settings.about.revealHome")).toBe("Show in Files");
    expect(t("settings.model.ram.fits", { gb: 16, fits: "Qwen" })).toBe(
      "This computer has 16 GB, so Qwen fit.",
    );
    expect(t("blocks.permission.openSystemSettings")).toBe("Open Settings");
    expect(platformTerm("os")).toBe("Linux");
    expect(platformTerm("thisDevice")).toBe("This computer");
    expect(platformTerm("presence")).toBe("your password");
    expect(platformTerm("fileManager")).toBe("Files");
    expect(platformTerm("systemSettings")).toBe("Settings");
    expect(platformTerm("trayArea")).toBe("system tray");
    expect(platformTerm("mod")).toBe("Ctrl");
    setUiPlatform("macos");
    expect(t("web.remote.thisMac")).toBe("This Mac");
    expect(platformTerm("presence")).toBe("Touch ID");
    setUiPlatform("windows");
    expect(t("web.remote.thisMac")).toBe("This PC");
  });

  it("writes shortcut hints with Ctrl on Linux", () => {
    setUiPlatform("linux");
    expect(t("chat.toolbar.keySheet")).toBe("Ctrl+Shift+A");
    expect(t("chat.approval.keysHint", { allows: "allows", denies: "denies" })).toBe(
      "Ctrl+Enter allows · Ctrl+D denies",
    );
    expect(t("web.threads.newSideChatTitle")).toBe("New side chat (Ctrl+N)");
    expect(t("settings.voice.key.rightOption")).toBe("Right Alt");
  });

  it("keeps the Mac-only capability rule as it was (the web may talk to a Mac Gateway)", () => {
    setUiPlatform("linux");
    expect(macOnlyAvailable()).toBe(true);
  });

  it("shows the English variant in a catalogue with no Linux translation, never the Mac wording", () => {
    setActiveI18n(createI18n({ locale: "pl-PL", language: "pl" }));
    setUiPlatform("linux");
    expect(t("web.remote.thisMac")).toBe("This computer");
  });

  it("translates into German: Computer, Passwort and Dateien, never the Mac", () => {
    setActiveI18n(createI18n({ locale: "de-DE", language: "de" }));
    expect(t("web.remote.thisMac")).toMatch(/Mac/);
    setUiPlatform("linux");
    expect(t("web.remote.thisMac")).toBe("Dieser Computer");
    expect(t("onboarding.safety.touchId")).toContain("Passwort");
    expect(t("settings.about.revealHome")).toContain("Dateien");
    const text = t("web.security.alert.requested", { action: "x", when: "y" });
    expect(text).toContain("diesem Computer");
    expect(text).not.toMatch(/Mac|\bPC\b/);
    expect(t("web.security.needsApproval")).toContain("Passwort");
    expect(t("web.security.needsApproval")).not.toMatch(/Touch ID|Windows Hello/);
  });

  it("translates into Japanese: the computer, the password and Files, never the Mac", () => {
    setActiveI18n(createI18n({ locale: "ja-JP", language: "ja" }));
    setUiPlatform("linux");
    expect(t("web.remote.thisMac")).toBe("このコンピュータ");
    expect(t("onboarding.safety.touchId")).toContain("パスワード");
    expect(t("settings.about.revealHome")).toContain("ファイル");
    const text = t("web.security.alert.requested", { action: "x", when: "y" });
    expect(text).toContain("コンピュータ");
    expect(text).not.toMatch(/Mac|\bPC\b|Windows/);
    expect(t("web.security.needsApproval")).toContain("パスワード");
  });

  it("keeps every variant valid ICU with the English message's placeholders, and Mac-free", () => {
    const ids = Object.keys(linux) as MessageId[];
    expect(ids.length).toBeGreaterThan(200);
    for (const id of ids) {
      expect(en[id], id).toBeDefined();
      const variant = linux[id] as string;
      expect(argumentsOf(variant), id).toEqual(argumentsOf(en[id]));
      // The Host may be a Mac or a PC: approving there can still mean its Touch ID.
      if (id === "web.remotePresence.approveOnHost") continue;
      expect(variant, id).not.toMatch(/\bMac\b|Touch ID|Finder|System Settings|⌘|⌥|⌃/);
      expect(variant, id).not.toMatch(/\bPC\b|Windows|Outlook|Credential Manager|Recycle/);
    }
  });
});

/**
 * Messages that name macOS things on purpose, so Linux reads them as written: Mac-only features
 * (hidden or "Available on macOS" there), labels for a Mac device or key, and copy only a Mac
 * renders. The same list the Windows test keeps.
 */
const ABOUT_MACOS = new Set<string>([
  "settings.devices.touchId.confirmReplace",
  // The macOS bundle integrity check at start-up (main.ts runs it on macOS only).
  "app.integrity.detail",
  // iMessage / SMS channel: Apple vouches for iMessage senders.
  "blocks.message.weak",
  // Rendered on macOS only (MapLibre's Mac help text; the ⌘L keycap behind isMac()).
  "map.gesture.mac",
  "shell.search.keyCmdL",
  // Apple's on-device model (Search, Everything memory).
  "settings.searchModel.apple",
  "settings.searchModel.appleName",
  "settings.searchModel.appleHint",
  "settings.searchModel.apple.why.off",
  "settings.searchModel.apple.why.os",
  "settings.searchModel.apple.why.device",
  "settings.searchModel.apple.why.notReady",
  "settings.searchModel.apple.ready",
  "settings.searchModel.apple.needsAi",
  "everything.model.apple",
  "everything.model.appleHint",
  // Apple apps (Notes, Reminders, Calendar, Mail, Safari, Shortcuts) and their macOS grants.
  "settings.connectors.catalog.appleNotes",
  "settings.connectors.app.safari",
  "settings.connectors.grant.allowed",
  "settings.connect.notAskedYet",
  "settings.connect.noPrompt",
  "gallery.builtin.appleNotes",
  "settings.searchSources.hint.notes",
  "settings.shortcuts.loading",
  "settings.shortcuts.noHelper",
  // Apple's container runtime (macOS 26 on Apple silicon).
  "settings.sandbox.runtime.appleContainer",
  "settings.sandbox.missing.appleContainer",
  "settings.sandbox.step.downloadLink",
  // A Mac device, its helper and its keys, named as such wherever they are listed.
  "settings.devices.platform.macos",
  "settings.devices.nodeKind.macHelper",
  "settings.devices.thisMacAdmin",
  "settings.devices.presenceKey.unknown",
  "settings.devices.presenceKey.deviceIdentity",
  "web.about.appleSilicon",
  // "Available on macOS" itself.
  "platform.macOnly",
  "platform.macOnlyHint",
]);

/**
 * Mail, Calendar, Reminders and Contacts are Apple apps on a Mac and classic Outlook on Windows.
 * Linux has neither, so their rows are not shown there; the Mac wording stays for the Mac.
 */
const APPLE_APPS = new Set<string>([
  "settings.connectors.catalog.appleMail",
  "settings.connectors.catalog.appleCalendar",
  "settings.connectors.catalog.appleReminders",
  "gallery.builtin.appleMail",
  "settings.searchSources.hint.mail",
  "settings.searchSources.hint.contacts",
]);

const MAC_ONLY_TERMS =
  /\bMac(?:s|'s)?\b|macOS|Touch ID|[Kk]eychain|Finder|Safari|⌘|⌥|\bOption\b|\bDock\b|menu bar|System Settings|\bApple\b/;

describe("Linux variants cover every Mac-specific message", () => {
  it("has a Linux variant for each message that names a Mac, unless it is about macOS", () => {
    const missing = (Object.entries(en) as [MessageId, string][])
      .filter(([id, msg]) => MAC_ONLY_TERMS.test(msg) && linux[id] === undefined)
      .map(([id]) => id)
      .filter((id) => !ABOUT_MACOS.has(id) && !APPLE_APPS.has(id));
    expect(missing).toEqual([]);
  });

  it("keeps the allowlists to messages that exist, still need them, and have no Linux variant", () => {
    for (const id of [...ABOUT_MACOS, ...APPLE_APPS]) {
      const msg = en[id as MessageId];
      expect(msg, id).toBeDefined();
      expect(MAC_ONLY_TERMS.test(msg), id).toBe(true);
      expect(linux[id as MessageId], `${id} has a Linux variant now`).toBeUndefined();
    }
  });
});

describe("Linux variants in every language", () => {
  const LANGUAGES = ["ar", "de", "es", "fr", "hi", "it", "ja", "ko", "pt", "zh"] as const;

  it("translates every Linux variant into all ten languages", () => {
    expect(Object.keys(LINUX_LOCALES).sort()).toEqual([...LANGUAGES].sort());
    for (const lang of LANGUAGES) {
      const table = LINUX_LOCALES[lang] ?? {};
      const missing = (Object.keys(linux) as MessageId[]).filter((id) => !table[id]);
      expect(missing, lang).toEqual([]);
      const extra = Object.keys(table).filter((id) => linux[id as MessageId] === undefined);
      expect(extra, lang).toEqual([]);
    }
  });

  it("keeps each translation valid ICU with the Linux variant's placeholders and no wrong OS", () => {
    for (const lang of LANGUAGES) {
      for (const [id, text] of Object.entries(LINUX_LOCALES[lang] ?? {})) {
        const english = linux[id as MessageId] as string;
        expect(text, `${lang} ${id}`).toBeTruthy();
        expect(
          () => new IntlMessageFormat(text as string, lang, undefined, { ignoreTag: true }),
        ).not.toThrow();
        expect(argumentsOf(text as string), `${lang} ${id}`).toEqual(argumentsOf(english));
        if (id === "web.remotePresence.approveOnHost") continue;
        expect(text, `${lang} ${id}`).not.toMatch(
          /\bMac\b|Touch ID|Finder|\bPC\b|Windows|Credential Manager|⌘|⌥|⌃/,
        );
      }
    }
  });
});
