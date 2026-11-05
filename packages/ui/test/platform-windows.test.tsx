import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { IntlMessageFormat } from "intl-messageformat";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WINDOWS_IDS,
  windowsDevices,
  windowsNodes,
  windowsPresenceKeys,
} from "../src/fixtures/index.ts";
import { createI18n, setActiveI18n, t } from "../src/i18n/core.ts";
import { en, type MessageId } from "../src/i18n/messages/index.ts";
import { windows } from "../src/i18n/messages/variants/windows.ts";
import { chordLabel, keysLabel, parseChord } from "../src/lib/keys.ts";
import { normalizePlatform, setUiPlatform, uiPlatform } from "../src/lib/platform.ts";
import { platformTerm } from "../src/lib/platform-copy.ts";
import { ConnectorsStep } from "../src/screens/onboarding/OnboardingSteps.tsx";
import { ComputerUsePanel } from "../src/screens/settings/ComputerUseSection.tsx";
import { offeredCatalog } from "../src/screens/settings/connector-catalog.tsx";
import { DevicesPanel } from "../src/screens/settings/DevicesSection.tsx";
import { MacHelperStatusRow } from "../src/screens/settings/MacHelperStatus.tsx";
import { presenceKeyText } from "../src/screens/settings/TouchIdKeySetup.tsx";
import { SHORTCUTS } from "../src/shell/shortcuts.ts";

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

describe("platform detection", () => {
  it("reads <html data-platform> as the desktop sets it, in either spelling", () => {
    expect(normalizePlatform("win32")).toBe("windows");
    expect(normalizePlatform("windows")).toBe("windows");
    expect(normalizePlatform("darwin")).toBe("macos");
    expect(normalizePlatform("MacIntel")).toBe("macos");
    expect(normalizePlatform("linux")).toBe("other");
    document.documentElement.dataset.platform = "win32";
    expect(uiPlatform()).toBe("windows");
    delete document.documentElement.dataset.platform;
    // jsdom's own user agent names the host OS as "(win32)" or "(darwin)": that is not a browser.
    expect(uiPlatform()).toBe("other");
  });
});

describe("Windows copy (i18n/messages/variants/windows.ts)", () => {
  it("names this PC, Windows Hello and File Explorer on Windows, and the Mac elsewhere", () => {
    expect(t("web.remote.thisMac")).toBe("This Mac");
    setUiPlatform("windows");
    expect(t("web.remote.thisMac")).toBe("This PC");
    expect(t("onboarding.safety.touchId")).toBe("Windows Hello for approvals");
    expect(t("settings.about.revealHome")).toBe("Show in File Explorer");
    expect(t("settings.model.ram.fits", { gb: 16, fits: "Qwen" })).toBe(
      "This PC has 16 GB, so Qwen fit.",
    );
    expect(platformTerm("trayArea")).toBe("notification area");
    setUiPlatform("macos");
    expect(t("web.remote.thisMac")).toBe("This Mac");
    expect(platformTerm("presence")).toBe("Touch ID");
  });

  it("shows the English variant in a catalogue that has no Windows translation yet", () => {
    setActiveI18n(createI18n({ locale: "de-DE", language: "de" }));
    expect(t("web.remote.thisMac")).not.toBe("This PC");
    setUiPlatform("windows");
    expect(t("web.remote.thisMac")).toBe("This PC");
  });

  it("keeps every variant valid ICU with the English message's placeholders, and Mac-free", () => {
    const ids = Object.keys(windows) as MessageId[];
    expect(ids.length).toBeGreaterThan(150);
    for (const id of ids) {
      expect(en[id], id).toBeDefined();
      const variant = windows[id] as string;
      expect(argumentsOf(variant), id).toEqual(argumentsOf(en[id]));
      // The Host may be a Mac: approving there can still mean its Touch ID.
      if (id === "web.remotePresence.approveOnHost") continue;
      expect(variant, id).not.toMatch(/\bMac\b|Touch ID|Finder|System Settings|⌘|⌥|⌃/);
    }
  });
});

/**
 * Messages that name macOS things on purpose, so Windows reads them as written: Mac-only features
 * (hidden or "Available on macOS" there), labels for a Mac device or key, and copy only a Mac
 * renders. Everything else that names a Mac needs a Windows variant.
 */
const ABOUT_MACOS = new Set<string>([
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
  // The sandbox Mac (VM guests).
  "settings.key.vm.enabled",
  "settings.key.vm.resetPerTask",
  "settings.vm.phase.installing",
  "settings.vm.description",
  "settings.vm.sandboxMac",
  "settings.vm.between",
  "settings.vm.credentialsHint",
  "settings.vm.noReports",
  // Apple apps (Notes, Reminders, Calendar, Mail, Safari, Shortcuts) and their macOS grants.
  "settings.connectors.catalog.appleNotes",
  "settings.connectors.catalog.appleReminders",
  "settings.connectors.catalog.appleCalendar",
  "settings.connectors.catalog.appleMail",
  "settings.connectors.app.safari",
  "settings.connectors.grant.allowed",
  "settings.connect.needsPermission",
  "settings.connect.notAskedYet",
  "settings.connect.noPrompt",
  "gallery.builtin.appleNotes",
  "gallery.builtin.appleMail",
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
  "settings.devices.presenceKey.keychain",
  "settings.devices.presenceKey.enclaveFile",
  "settings.devices.presenceKey.unknown",
  "settings.devices.touchId.allowDevFileKey",
  "settings.devices.touchId.devFileKey",
  "web.about.appleSilicon",
  // "Available on macOS" itself.
  "platform.macOnly",
  "platform.macOnlyHint",
]);

/**
 * Mac wording whose Windows copy belongs to work in progress elsewhere (local search sources on
 * Windows; Outlook-backed trusted sources). Remove an id here once its variant lands.
 */
const PENDING_ELSEWHERE = new Set<string>([
  "settings.searchSources.hint.mail",
  "settings.searchSources.hint.notes",
  "settings.searchSources.hint.contacts",
  "settings.trusted.loading",
  "settings.trusted.noHelper",
  "settings.trusted.failed",
]);

const MAC_ONLY_TERMS =
  /\bMac(?:s|'s)?\b|macOS|Touch ID|[Kk]eychain|Finder|Safari|⌘|⌥|\bOption\b|\bDock\b|menu bar|System Settings|\bApple\b/;

describe("Windows variants cover every Mac-specific message", () => {
  it("has a Windows variant for each message that names a Mac, unless it is about macOS", () => {
    const missing = (Object.entries(en) as [MessageId, string][])
      .filter(([id, msg]) => MAC_ONLY_TERMS.test(msg) && windows[id] === undefined)
      .map(([id]) => id)
      .filter((id) => !ABOUT_MACOS.has(id) && !PENDING_ELSEWHERE.has(id));
    expect(missing).toEqual([]);
  });

  it("keeps the allowlists to messages that exist and still need them", () => {
    for (const id of [...ABOUT_MACOS, ...PENDING_ELSEWHERE]) {
      const msg = en[id as MessageId];
      expect(msg, id).toBeDefined();
      expect(MAC_ONLY_TERMS.test(msg), id).toBe(true);
      expect(windows[id as MessageId], `${id} has a Windows variant now`).toBeUndefined();
    }
  });
});

describe("Windows shortcuts", () => {
  it("writes chords as text with Ctrl, Alt and Shift on Windows, glyphs on macOS", () => {
    expect(chordLabel({ key: "b", mod: true, shift: true }, "windows")).toBe("Ctrl+Shift+B");
    expect(chordLabel({ key: "b", mod: true, shift: true }, "macos")).toBe("⇧⌘B");
    expect(keysLabel("Alt+Mod+B", "windows")).toBe("Ctrl+Alt+B");
    expect(keysLabel("Mod+Enter", "windows")).toBe("Ctrl+Enter");
    expect(keysLabel("Mod+\\", "windows")).toBe("Ctrl+\\");
    expect(parseChord("Ctrl+`")).toEqual({ key: "`", ctrl: true });
    setUiPlatform("windows");
    const keys = Object.fromEntries(SHORTCUTS.map((s) => [s.id, s.keys]));
    expect(keys.palette).toBe("Ctrl+K");
    expect(keys.compactSidebar).toBe("Ctrl+Alt+B");
    expect(keys.cycleThreads).toBe("Ctrl+Tab");
    expect(Object.values(keys).join(" ")).not.toMatch(/[⌘⌥⌃⇧]/);
  });
});

describe("Windows in Settings and onboarding", () => {
  it("lists the PC, its Windows helper and the RSA-2048 Windows Hello key in Devices", () => {
    setUiPlatform("windows");
    render(
      <DevicesPanel
        devices={windowsDevices()}
        pairing={[]}
        nodes={windowsNodes()}
        presenceKeys={windowsPresenceKeys()}
        thisDeviceId={WINDOWS_IDS.device}
      />,
    );
    expect(screen.getByText("Windows helper")).toBeTruthy();
    expect(screen.getByTestId("presence-key").textContent).toBe(
      "Windows Hello key (RSA-2048), as reported by the helper",
    );
    expect(screen.getByTestId("this-mac-admin").textContent).toMatch(/^This PC is the admin/);
    expect(screen.getByText(/Windows PC/)).toBeTruthy();
  });

  it("names a key by its kind, not by the platform this window runs on", () => {
    setUiPlatform("windows");
    expect(presenceKeyText({ kind: "keychain" })).toMatch(/^Touch ID key/);
    expect(presenceKeyText({}, "win-helper")).toBe("Windows Hello key, as reported by the helper");
    expect(presenceKeyText({ algorithm: "rs256" })).toMatch(/RSA-2048/);
    expect(presenceKeyText({ algorithm: "rsa-2048-pkcs1-sha256" })).toMatch(/RSA-2048/);
  });

  it("offers no Apple apps on Windows and points mail and calendar at accounts", () => {
    setUiPlatform("windows");
    expect(offeredCatalog(undefined).some((c) => c.type.startsWith("apple:"))).toBe(false);
    render(<ConnectorsStep persona="Wren" connected={[]} onConnect={vi.fn()} />);
    expect(screen.queryByText("On this PC")).toBeNull();
    expect(screen.getByTestId("windows-accounts-hint").textContent).toMatch(/Microsoft, Google/);
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe("microsoft");
    setUiPlatform("macos");
    expect(offeredCatalog(undefined).some((c) => c.type.startsWith("apple:"))).toBe(true);
  });

  it("shows what Windows asks for instead of the macOS privacy panes", async () => {
    setUiPlatform("windows");
    const open = vi.fn();
    render(
      <ComputerUsePanel
        values={{}}
        onChange={vi.fn()}
        persona="Wren"
        tcc={{ microphone: "denied" }}
        onOpenSystemSettings={open}
      />,
    );
    expect(screen.getByText("Windows access")).toBeTruthy();
    expect(screen.queryByText("Screen Recording")).toBeNull();
    expect(screen.getAllByText("No permission needed")).toHaveLength(2);
    expect(screen.getByText(/run as administrator/)).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: "Open Windows Settings for Microphone" }),
    );
    expect(open).toHaveBeenCalledWith("microphone");
  });

  it("restarts the helper from its status row and says when it did not start", async () => {
    setUiPlatform("windows");
    const restart = vi.fn(async () => ({ kind: "offline" as const, reason: "timed out" }));
    render(<MacHelperStatusRow state={{ kind: "offline" }} onRestart={restart} />);
    expect(screen.getByText("Not connected")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Restart helper" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("The helper didn't start (timed out)."),
    );
    expect(restart).toHaveBeenCalledOnce();
  });
});
