import { describe, expect, it, vi } from "vitest";
import { type ChromeTarget, THEME_KEY, themeSource, WindowTheme } from "../src/lib/window-theme.ts";

function setup(call = vi.fn()) {
  let dark = true;
  const t = {
    win: { setBackgroundColor: vi.fn(), isDestroyed: () => false },
    view: { setBackgroundColor: vi.fn() },
  } satisfies ChromeTarget;
  const setThemeSource = vi.fn((s: string) => {
    dark = s === "dark" || (s === "system" && true);
  });
  const c = new WindowTheme({
    targets: () => [t],
    call,
    setThemeSource,
    canvas: () => (dark ? "#111112" : "#fcfcfe"),
  });
  return { c, t, setThemeSource, call };
}

describe("window theme (#597)", () => {
  it("maps the setting to a theme source; auto and unknown follow the system", () => {
    expect(themeSource("light")).toBe("light");
    expect(themeSource("dark")).toBe("dark");
    expect(themeSource("auto")).toBe("system");
    expect(themeSource(undefined)).toBe("system");
  });

  it("a Light app on a Dark Mac gets light native chrome and the light canvas", async () => {
    const call = vi.fn().mockResolvedValue({ settings: { [THEME_KEY]: "light" } });
    const { c, t, setThemeSource } = setup(call);
    await c.load();
    expect(call).toHaveBeenCalledWith("settings.get", { keys: [THEME_KEY] });
    expect(setThemeSource).toHaveBeenLastCalledWith("light");
    expect(t.win.setBackgroundColor).toHaveBeenLastCalledWith("#fcfcfe");
    expect(t.view.setBackgroundColor).toHaveBeenLastCalledWith("#fcfcfe");
  });

  it("follows settings.changed for the theme only", () => {
    const { c, setThemeSource } = setup();
    c.onSettingsChanged([{ key: "appearance.zoom", value: 110 }]);
    expect(setThemeSource).not.toHaveBeenCalled();
    c.onSettingsChanged([{ key: THEME_KEY, value: "dark" }]);
    expect(setThemeSource).toHaveBeenLastCalledWith("dark");
  });

  it("leaves the system appearance alone while unpaired", async () => {
    const warn = vi.fn();
    const call = vi.fn().mockRejectedValue(new Error("unpaired"));
    const c = new WindowTheme({
      targets: () => [],
      call,
      setThemeSource: vi.fn(),
      canvas: () => "#111112",
      warn,
    });
    await c.load();
    expect(warn).toHaveBeenCalled();
  });
});
