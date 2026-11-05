import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: () => undefined },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn(), send: vi.fn() },
}));

const { chromeFromArgv, platformAttribute } = await import("../../src/preload.ts");
const {
  backdropSupported,
  CANVAS_COLOR,
  CAPTION_SYMBOL_COLOR,
  chromeViewBackground,
  mainWindowOptions,
  QUICK_ENTRY_SIZE,
  quickEntryWindowOptions,
  settingsWindowOptions,
  TITLE_BAR_OVERLAY_HEIGHT,
  titleBarOverlayColors,
  windowMaterial,
} = await import("../../src/main/window-options.ts");
const { quickEntryBounds } = await import("../../src/main/window-placement.ts");
const { WindowTheme } = await import("../../src/lib/window-theme.ts");
const { transparencyEffects } = await import("../../src/main/tray-icon.ts");

const WIN11 = "10.0.26200";

describe("Windows window chrome", () => {
  it("hides the title bar behind a 40 px caption-button overlay over Mica", () => {
    const o = mainWindowOptions({ platform: "win32", release: WIN11 });
    expect(o).toMatchObject({
      minWidth: 900,
      minHeight: 600,
      titleBarStyle: "hidden",
      titleBarOverlay: {
        color: "#00000000",
        symbolColor: CAPTION_SYMBOL_COLOR.light,
        height: TITLE_BAR_OVERLAY_HEIGHT,
      },
      backgroundMaterial: "mica",
      backgroundColor: "#00000000",
    });
    expect(TITLE_BAR_OVERLAY_HEIGHT).toBe(40);
    expect(o).not.toHaveProperty("trafficLightPosition");
    expect(settingsWindowOptions({ platform: "win32", dark: true, release: WIN11 })).toMatchObject({
      minWidth: 760,
      minHeight: 520,
      titleBarOverlay: { symbolColor: CAPTION_SYMBOL_COLOR.dark, height: 40 },
      backgroundMaterial: "mica",
      backgroundColor: "#00000000",
    });
  });

  it("drops the material and uses solid system colours in a contrast theme", () => {
    const o = mainWindowOptions({
      platform: "win32",
      dark: true,
      highContrast: true,
      release: WIN11,
    });
    expect(o).not.toHaveProperty("backgroundMaterial");
    expect(o.titleBarOverlay).toEqual({ color: "#000000", symbolColor: "#ffffff", height: 40 });
    expect(windowMaterial("win32", true)).toBe("none");
    expect(windowMaterial("darwin")).toBe("none");
    expect(titleBarOverlayColors(false, true)).toEqual({
      color: "#ffffff",
      symbolColor: "#000000",
    });
  });

  it("draws Mica only on Windows 11 22H2 and later (Windows 10 stays opaque)", () => {
    expect(backdropSupported("10.0.22621")).toBe(true);
    expect(backdropSupported("10.0.26200")).toBe(true);
    expect(backdropSupported("10.0.22000")).toBe(false);
    expect(backdropSupported("10.0.19045")).toBe(false);
    expect(windowMaterial("win32", false, "10.0.19045")).toBe("none");
    expect(windowMaterial("win32", false, "10.0.26200")).toBe("mica");
    expect(transparencyEffects("    EnableTransparency    REG_DWORD    0x0\r\n")).toBe(false);
    expect(transparencyEffects("    EnableTransparency    REG_DWORD    0x1\r\n")).toBe(true);
    expect(transparencyEffects(undefined)).toBe(true);
  });

  it("keeps the app view transparent over Mica and on the canvas elsewhere", () => {
    expect(chromeViewBackground("win32", true, false, WIN11)).toBe("#00000000");
    expect(chromeViewBackground("win32", true, true)).toBe(CANVAS_COLOR.dark);
    expect(chromeViewBackground("darwin", false)).toBe(CANVAS_COLOR.light);
  });

  it("makes quick entry a rounded, acrylic, always-on-top bar out of the taskbar", () => {
    expect(quickEntryWindowOptions({ platform: "win32", release: WIN11 })).toMatchObject({
      ...QUICK_ENTRY_SIZE,
      frame: false,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      roundedCorners: true,
      backgroundMaterial: "acrylic",
    });
    expect(quickEntryWindowOptions({ platform: "darwin" })).not.toHaveProperty(
      "backgroundMaterial",
    );
  });

  it("opens quick entry a third of the way down the pointer's work area, above the taskbar", () => {
    // A 150 % monitor to the left of the primary one, taskbar at the bottom (DIPs).
    const area = { x: -1707, y: 0, width: 1707, height: 912 };
    expect(quickEntryBounds(area, QUICK_ENTRY_SIZE)).toEqual({
      x: -1707 + Math.round((1707 - 640) / 2),
      y: Math.round(912 / 3 - 80),
      width: 640,
      height: 160,
    });
    // A tiny work area clamps the bar inside it.
    expect(quickEntryBounds({ x: 0, y: 0, width: 500, height: 100 }, QUICK_ENTRY_SIZE)).toEqual({
      x: 0,
      y: 0,
      width: 500,
      height: 100,
    });
  });

  it("repaints the caption buttons and keeps the view transparent when the theme flips", () => {
    const overlays: unknown[] = [];
    const colors: string[] = [];
    let dark = false;
    const theme = new WindowTheme({
      targets: () => [
        {
          win: {
            setBackgroundColor: (c) => colors.push(`win ${c}`),
            isDestroyed: () => false,
            setTitleBarOverlay: (o) => overlays.push(o),
          },
          view: { setBackgroundColor: (c) => colors.push(`view ${c}`) },
        },
      ],
      call: async () => ({}),
      setThemeSource: () => undefined,
      canvas: () => (dark ? CANVAS_COLOR.dark : CANVAS_COLOR.light),
      overlay: () => titleBarOverlayColors(dark),
      materialBackground: () => chromeViewBackground("win32", dark, false, WIN11),
    });
    dark = true;
    theme.refresh();
    expect(overlays).toEqual([{ color: "#00000000", symbolColor: CAPTION_SYMBOL_COLOR.dark }]);
    expect(colors).toEqual(["win #00000000", "view #00000000"]);
  });
});

describe("what the renderer is told (preload)", () => {
  const arg = (v: unknown) => [`--psyche-chrome=${JSON.stringify(v)}`];

  it("passes the overlay height and the material, clamped to sane values", () => {
    expect(
      chromeFromArgv(
        arg({ titleBar: "overlay", titleBarOverlay: { height: 40 }, material: "mica" }),
      ),
    ).toEqual({ titleBar: "overlay", titleBarOverlay: { height: 40 }, material: "mica" });
    expect(chromeFromArgv(arg({ titleBar: "overlay", titleBarOverlay: { height: 9999 } }))).toEqual(
      {
        titleBar: "overlay",
        titleBarOverlay: { height: 40 },
      },
    );
    expect(chromeFromArgv(arg({ titleBar: "native", material: "glitter" }))).toEqual({
      titleBar: "native",
    });
    expect(chromeFromArgv(arg({ titleBar: "inset", trafficLights: { x: 20, y: 19 } }))).toEqual({
      titleBar: "inset",
      trafficLights: { x: 20, y: 19 },
    });
  });

  it("names the platform for CSS: windows, never linux, on win32", () => {
    expect(platformAttribute("win32")).toBe("windows");
    expect(platformAttribute("darwin")).toBe("macos");
    expect(platformAttribute("linux")).toBe("linux");
  });
});
