import { appCap } from "@psyche/permissions/apps";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { IntlMessageFormat } from "intl-messageformat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createI18n, setActiveI18n } from "../src/i18n/core.ts";
import { en, type MessageId } from "../src/i18n/messages/index.ts";
import { CATALOGUES } from "../src/i18n/messages/locales/index.ts";
import { setUiPlatform } from "../src/lib/platform.ts";
import {
  ComputerUsePanel,
  LINUX_LOCKED_APPS,
  LOCKED_APPS,
  lockedApps,
  WINDOWS_LOCKED_APPS,
} from "../src/screens/settings/ComputerUseSection.tsx";
import {
  type LinuxAccessState,
  linuxAccessFromSettings,
} from "../src/screens/settings/LinuxAccess.tsx";

afterEach(() => {
  setUiPlatform(undefined);
  setActiveI18n(createI18n({ locale: "en-US" }));
});

const state = (over: Partial<LinuxAccessState> = {}): LinuxAccessState => ({
  session: "wayland",
  desktop: "gnome",
  backend: "portal",
  allowed: true,
  a11yEnabled: true,
  warnings: [],
  checkedAt: "2026-11-05T12:00:00.000Z",
  ...over,
});

function panel(
  values: Record<string, unknown>,
  onChange: (key: string, value: unknown) => void = vi.fn(),
) {
  render(<ComputerUsePanel values={values} onChange={onChange} persona="Wren" tcc={{}} />);
  return onChange;
}

const revoke = () => screen.getByRole("button", { name: "Revoke screen and input access" });

describe("Settings → Computer use on Linux", () => {
  it("shows screen and input access instead of the macOS privacy panes", () => {
    setUiPlatform("linux");
    panel({ "computerUse.linux": state() });
    expect(screen.getByTestId("linux-access")).toBeTruthy();
    expect(screen.getByText("Desktop permissions")).toBeTruthy();
    expect(screen.getByText("Screen and input access")).toBeTruthy();
    expect(screen.getByText("Allowed until you revoke it")).toBeTruthy();
    expect(screen.queryByText("Screen Recording")).toBeNull();
    expect(screen.queryByText("Accessibility")).toBeNull();
  });

  it("says it asks the first time until the Gateway has read the helper, and keeps Revoke off", () => {
    setUiPlatform("linux");
    panel({});
    expect(screen.getByText("Asks the first time you use it")).toBeTruthy();
    expect((revoke() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId("linux-x11")).toBeNull();
    expect(screen.queryByTestId("linux-wlroots")).toBeNull();
    expect(screen.queryByTestId("linux-headless")).toBeNull();
  });

  it("asks again after a revoke: not allowed, Revoke disabled", () => {
    setUiPlatform("linux");
    panel({ "computerUse.linux": state({ allowed: false }) });
    expect(screen.getByText("Asks the first time you use it")).toBeTruthy();
    expect((revoke() as HTMLButtonElement).disabled).toBe(true);
  });

  it("sets computerUse.linuxRevoke to a timestamp when Revoke is clicked", async () => {
    setUiPlatform("linux");
    const onChange = panel({ "computerUse.linux": state() });
    expect((revoke() as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(revoke());
    expect(onChange).toHaveBeenCalledTimes(1);
    const [key, value] = (onChange as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
    expect(key).toBe("computerUse.linuxRevoke");
    expect(typeof value).toBe("string");
    expect(new Date(value as string).toISOString()).toBe(value);
  });

  it("warns on X11 that any app can read the screen and keystrokes, and needs no grant", () => {
    setUiPlatform("linux");
    panel({
      "computerUse.linux": state({
        session: "x11",
        backend: "x11",
        allowed: false,
        warnings: ["x11"],
      }),
    });
    expect(screen.getByText("Not needed on X11")).toBeTruthy();
    expect(screen.getByTestId("linux-x11").textContent).toBe(
      "On X11 any app can read your screen and keystrokes, including your password when you approve something.",
    );
    expect((revoke() as HTMLButtonElement).disabled).toBe(true);
  });

  it("warns on wlroots that Psyche cannot add a consent step", () => {
    setUiPlatform("linux");
    panel({
      "computerUse.linux": state({ desktop: "wlroots", backend: "wlroots", warnings: ["wlroots"] }),
    });
    expect(screen.getByTestId("linux-wlroots").textContent).toMatch(
      /any app can read your screen and type for you without asking\. Psyche cannot add a consent step/,
    );
  });

  it("says when there is no graphical session", () => {
    setUiPlatform("linux");
    panel({
      "computerUse.linux": state({
        session: "headless",
        desktop: null,
        backend: "none",
        allowed: false,
      }),
    });
    expect(screen.getByTestId("linux-headless").textContent).toMatch(/graphical session/);
    expect(screen.getByText("Not available")).toBeTruthy();
    expect((revoke() as HTMLButtonElement).disabled).toBe(true);
  });

  it("notes that apps opened from now on expose their structure, only while it is on", () => {
    setUiPlatform("linux");
    const note =
      "Apps opened from now on expose their structure to Psyche. Apps already open may need a restart.";
    const { unmount } = render(
      <ComputerUsePanel
        values={{ "computerUse.enabled": true, "computerUse.linux": state() }}
        onChange={vi.fn()}
        persona="Wren"
        tcc={{}}
      />,
    );
    expect(screen.getByTestId("linux-a11y").textContent).toBe(note);
    unmount();
    panel({ "computerUse.enabled": false, "computerUse.linux": state() });
    expect(screen.queryByTestId("linux-a11y")).toBeNull();
    document.body.innerHTML = "";
    panel({ "computerUse.enabled": true, "computerUse.linux": state({ a11yEnabled: false }) });
    expect(screen.queryByTestId("linux-a11y")).toBeNull();
  });

  it("lists the apps the Gateway locks on Linux, by desktop-file id, with the enforced caps", () => {
    setUiPlatform("linux");
    panel({
      "computerUse.enabled": true,
      "computerUse.apps": [{ id: "org.gnome.TextEditor", name: "Text Editor", tier: "ask" }],
    });
    const text = Array.from(document.querySelectorAll<HTMLElement>('[data-locked="true"]')).map(
      (r) => r.textContent ?? "",
    );
    expect(text.some((r) => r.includes("Firefox") && r.includes("Read only (fixed)"))).toBe(true);
    expect(text.some((r) => r.includes("GNOME Terminal") && r.includes("Click only (fixed)"))).toBe(
      true,
    );
    expect(screen.queryByText("Safari")).toBeNull();
    expect(screen.queryByText("Microsoft Edge")).toBeNull();
    for (const a of LINUX_LOCKED_APPS.filter((x) => x.id !== "banking")) {
      expect(a.id).toMatch(/^[a-z0-9._+-]+$/);
      expect(a.locked?.cap, a.id).toBe(appCap(a.id).cap);
    }
    expect(lockedApps("linux")).toBe(LINUX_LOCKED_APPS);
    expect(lockedApps("windows")).toBe(WINDOWS_LOCKED_APPS);
    expect(lockedApps("macos")).toBe(LOCKED_APPS);
    expect(lockedApps("other")).toBe(LOCKED_APPS);
  });

  it("leaves the Mac and Windows panels alone", () => {
    setUiPlatform("macos");
    panel({ "computerUse.linux": state() });
    expect(screen.queryByTestId("linux-access")).toBeNull();
    expect(screen.getByText("Accessibility")).toBeTruthy();
    expect(screen.getByText("Screen Recording")).toBeTruthy();
    document.body.innerHTML = "";
    setUiPlatform("windows");
    panel({ "computerUse.linux": state() });
    expect(screen.queryByTestId("linux-access")).toBeNull();
    expect(screen.getByTestId("windows-access")).toBeTruthy();
  });
});

describe("computerUse.linux from settings", () => {
  it("reads the shape the Gateway writes and drops anything else", () => {
    expect(linuxAccessFromSettings({})).toBeUndefined();
    expect(linuxAccessFromSettings({ "computerUse.linux": "x" })).toBeUndefined();
    expect(linuxAccessFromSettings({ "computerUse.linux": { session: "mars" } })).toBeUndefined();
    expect(linuxAccessFromSettings({ "computerUse.linux": state({ warnings: ["x11"] }) })).toEqual(
      state({ warnings: ["x11"] }),
    );
    expect(
      linuxAccessFromSettings({
        "computerUse.linux": { session: "wayland", allowed: "yes", warnings: [1, "x11"] },
      }),
    ).toMatchObject({ allowed: false, a11yEnabled: null, warnings: ["x11"], backend: "none" });
  });
});

describe("Linux access copy", () => {
  const ids = Object.keys(en).filter((id) =>
    id.startsWith("settings.computerUse.linux."),
  ) as MessageId[];
  const argumentsOf = (message: string): string[] => {
    const names = new Set<string>();
    const walk = (nodes: unknown[]) => {
      for (const n of nodes as { type: number; value?: unknown; options?: unknown }[]) {
        if (n.type >= 1 && n.type <= 6 && typeof n.value === "string") names.add(n.value);
        if (n.options && typeof n.options === "object")
          for (const o of Object.values(n.options as Record<string, { value: unknown[] }>))
            walk(o.value);
      }
    };
    walk(
      new IntlMessageFormat(message, "en", undefined, { ignoreTag: true }).getAst() as unknown[],
    );
    return [...names].sort();
  };

  it("has twelve messages", () => {
    expect(ids).toHaveLength(12);
  });

  it.each(Object.keys(CATALOGUES).filter((l) => l !== "en"))(
    "%s translates every one of them, with the same placeholders",
    (locale) => {
      const catalogue = CATALOGUES[locale as keyof typeof CATALOGUES] as Record<string, string>;
      for (const id of ids) {
        const text = catalogue[id];
        expect(text, `${locale} ${id}`).toBeTruthy();
        // Not the English text under another name.
        expect(text, `${locale} ${id}`).not.toBe(en[id]);
        expect(argumentsOf(text as string), `${locale} ${id}`).toEqual(argumentsOf(en[id]));
      }
    },
  );
});
