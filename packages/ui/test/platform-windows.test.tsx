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
import { CAPABILITIES, isAvailable } from "../src/screens/onboarding/capabilities.ts";
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

  it("offers classic Outlook's Mail, Calendar and Tasks once the Gateway lists them", () => {
    setUiPlatform("windows");
    // What the Gateway's catalogue lists while the Windows helper serves classic Outlook.
    const outlook = new Set(["microsoft", "apple:mail", "apple:calendar", "apple:reminders"]);
    const rows = offeredCatalog(outlook, { navigation: false });
    expect(rows.filter((c) => c.type.startsWith("apple:")).map((c) => [c.type, c.label])).toEqual([
      ["apple:reminders", "Outlook Tasks"],
      ["apple:calendar", "Outlook Calendar"],
      ["apple:mail", "Outlook Mail"],
    ]);
    // Notes and Shortcuts stay Mac-only even if a catalogue named them.
    const all = new Set([...outlook, "apple:notes", "apple:shortcuts"]);
    expect(offeredCatalog(all).some((c) => c.type === "apple:notes")).toBe(false);
    // Without classic Outlook the Gateway lists none, and none is offered.
    expect(offeredCatalog(new Set(["microsoft"])).some((c) => c.type.startsWith("apple:"))).toBe(
      false,
    );
    render(
      <ConnectorsStep persona="Wren" connected={[]} onConnect={vi.fn()} implemented={outlook} />,
    );
    expect(screen.getByText("On this PC")).toBeTruthy();
    expect(screen.getByText("Outlook Mail")).toBeTruthy();
    expect(screen.queryByText(/Apple/)).toBeNull();
    setUiPlatform("macos");
    expect(offeredCatalog(outlook).find((c) => c.type === "apple:mail")?.label).toBe("Apple Mail");
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

describe("the Reminders capability on Windows", () => {
  it("unlocks with Outlook Tasks (apple:reminders through the helper) or Microsoft To Do", () => {
    const reminders = CAPABILITIES.find((c) => c.id === "reminders");
    if (reminders === undefined) throw new Error("no reminders capability");
    expect(isAvailable(reminders, new Set(["apple:reminders"]))).toBe(true);
    expect(isAvailable(reminders, new Set(["microsoft:todo"]))).toBe(true);
    expect(isAvailable(reminders, new Set(["microsoft", "google"]))).toBe(false);
  });
});
