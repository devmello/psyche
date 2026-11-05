import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { name: "Psyche", isPackaged: true, quit: () => {} },
  Menu: { buildFromTemplate: (t: MenuItemConstructorOptions[]) => t },
  nativeImage: { createEmpty: () => ({}) },
  Tray: class {},
}));

const { appMenuTemplate, hideMenuBar } = await import("../../src/main/menu.ts");
const { QUICK_ENTRY_SHORTCUT_KEY, QuickEntryShortcut, quickEntryShortcuts, screenAskShortcuts } =
  await import("../../src/main/shortcuts.ts");
const { ScreenAskShortcut } = await import("../../src/main/screen-ask/settings.ts");
const { loginItemSettings, LoginItem, squirrelLayout, windowsLaunchCommand } = await import(
  "../../src/main/login-item.ts"
);
const { jumpListTasks, taskFromArgv, firstCloseToTray } = await import("../../src/main/taskbar.ts");
const { handleSquirrelEvent, squirrelEvent, squirrelShortcutArgs } = await import(
  "../../src/main/squirrel-events.ts"
);
const { gatewayRowLabel, trayTemplate, trayTooltip } = await import("../../src/main/tray.ts");
const { taskbarIsDark, trayIconRgba, toBgraPremultiplied, TRAY_ICON_SIZES } = await import(
  "../../src/main/tray-icon.ts"
);

const noop = () => {};
const actions = {
  newSideChat: noop,
  palette: noop,
  closeThreadView: noop,
  quitEntirely: noop,
  settings: noop,
  zoomIn: noop,
  zoomOut: noop,
  zoomReset: noop,
};

function accelerators(t: readonly MenuItemConstructorOptions[]): string[] {
  const out: string[] = [];
  const walk = (items: readonly MenuItemConstructorOptions[]) => {
    for (const i of items) {
      if (typeof i.accelerator === "string") out.push(i.accelerator);
      if (Array.isArray(i.submenu)) walk(i.submenu);
    }
  };
  walk(t);
  return out;
}

function registry(taken: string[] = []) {
  const held = new Map<string, () => void>();
  return {
    held,
    register(a: string, cb: () => void) {
      if (taken.includes(a) || held.has(a)) return false;
      held.set(a, cb);
      return true;
    },
    unregister(a: string) {
      held.delete(a);
    },
  };
}

describe("the Windows app menu (no bar, keys only)", () => {
  it("has the same commands with Ctrl keys, and never Ctrl+Alt (AltGr) or Alt+Space", () => {
    const keys = accelerators(appMenuTemplate(actions, "win32"));
    for (const k of ["Ctrl+N", "Ctrl+,", "Ctrl+W", "Ctrl+Q", "Ctrl+Shift+Q", "CmdOrCtrl+K", "F11"])
      expect(keys).toContain(k);
    expect(keys.some((k) => /ctrl\+alt/i.test(k))).toBe(false);
    expect(keys.map((k) => k.toLowerCase())).not.toContain("cmdorctrl+l");
    // macOS keeps its own menu.
    expect(accelerators(appMenuTemplate(actions, "darwin"))).toContain("CmdOrCtrl+Alt+Q");
  });

  it("hides each window's bar without removing the menu (its keys keep working)", () => {
    const calls: string[] = [];
    hideMenuBar({
      setAutoHideMenuBar: (v) => calls.push(`auto ${v}`),
      setMenuBarVisibility: (v) => calls.push(`visible ${v}`),
    });
    expect(calls).toEqual(["auto false", "visible false"]);
    hideMenuBar({}); // a window without a menu bar API
  });
});

describe("global shortcuts on Windows", () => {
  it("never default to Alt+Space (the system menu)", () => {
    expect(quickEntryShortcuts("win32")).toEqual(["Control+Alt+Space", "Alt+Shift+Space"]);
    expect(screenAskShortcuts("win32")).toEqual(["Control+Alt+Shift+Space"]);
    expect([...quickEntryShortcuts("win32"), ...screenAskShortcuts("win32")]).not.toContain(
      "Alt+Space",
    );
    expect(quickEntryShortcuts("darwin")[0]).toBe("Alt+Space");
    expect(screenAskShortcuts("darwin")[0]).toBe("Alt+Shift+Space");
  });

  it("quick entry falls back when the default is taken, and follows its setting", async () => {
    const values: Record<string, unknown> = {};
    const shortcuts = registry(["Control+Alt+Space"]);
    let opened = 0;
    const changes: string[] = [];
    const q = new QuickEntryShortcut({
      call: async () => ({ settings: values }),
      shortcuts,
      toggle: () => opened++,
      platform: "win32",
      onChange: (a) => changes.push(a),
    });
    q.apply(undefined);
    expect(q.current).toBe("Alt+Shift+Space");
    shortcuts.held.get("Alt+Shift+Space")?.();
    expect(opened).toBe(1);
    values[QUICK_ENTRY_SHORTCUT_KEY] = "Control+Shift+P";
    q.onEvent("settings.changed", { entries: [{ key: QUICK_ENTRY_SHORTCUT_KEY }] });
    await new Promise((r) => setTimeout(r, 0));
    expect(q.current).toBe("Control+Shift+P");
    expect([...shortcuts.held.keys()]).toEqual(["Control+Shift+P"]);
    expect(changes).toEqual(["Alt+Shift+Space", "Control+Shift+P"]);
    q.dispose();
    expect(shortcuts.held.size).toBe(0);
  });

  it("Ask about screen registers Ctrl+Alt+Shift+Space by default on Windows", () => {
    const shortcuts = registry();
    const s = new ScreenAskShortcut({
      call: async () => ({}),
      shortcuts,
      trigger: noop,
      setEnabled: noop,
      platform: "win32",
    });
    s.apply(s.settings);
    expect(s.current).toBe("Control+Alt+Shift+Space");
  });
});

describe("the Windows login item and jump list (Squirrel layout)", () => {
  const exe = "C:\\Users\\a\\AppData\\Local\\Psyche\\app-0.3.0\\Psyche.exe";
  const update = "C:\\Users\\a\\AppData\\Local\\Psyche\\Update.exe";
  const installed = (p: string) => p === update;

  it("recognizes a Squirrel install by its app-<version> folder and Update.exe", () => {
    expect(squirrelLayout(exe, installed)).toEqual({ updateExe: update, exeName: "Psyche.exe" });
    expect(squirrelLayout(exe, () => false)).toBeUndefined();
    expect(squirrelLayout("C:\\Psyche\\Psyche.exe", () => true)).toBeUndefined();
  });

  it("starts the stable Update.exe at login, with --background passed through", () => {
    expect(loginItemSettings(true, "win32", exe, { exists: installed })).toEqual({
      openAtLogin: true,
      path: update,
      args: ["--processStart", "Psyche.exe", "--process-start-args", "--background"],
      name: "Psyche",
    });
    // A ZIP copy, or an unpackaged run (Electron's binary and the app folder).
    expect(
      loginItemSettings(false, "win32", "D:\\e\\electron.exe", {
        exists: () => false,
        leadingArgs: ["D:\\repo\\apps\\desktop"],
      }),
    ).toEqual({
      openAtLogin: false,
      path: "D:\\e\\electron.exe",
      args: ["D:\\repo\\apps\\desktop", "--background"],
      name: "Psyche",
    });
    expect(loginItemSettings(true, "darwin", "/x")).toEqual({
      openAtLogin: true,
      args: ["--background"],
    });
    expect(loginItemSettings(true, "linux", "/x")).toBeUndefined();
  });

  it("sets the login item from the setting on Windows", () => {
    const set: unknown[] = [];
    const item = new LoginItem(
      { setLoginItemSettings: (s) => set.push(s) },
      { platform: "win32", execPath: exe, exists: installed },
    );
    item.onSettingsChanged([{ key: "appearance.openAtLogin", value: true }]);
    expect(set).toHaveLength(1);
    expect(set[0]).toMatchObject({ openAtLogin: true, path: update });
  });

  it("lists New side chat and Ask about my screen, each a second launch with its task", () => {
    const tasks = jumpListTasks(exe, { exists: installed, askScreen: true });
    expect(tasks.map((t) => t.title)).toEqual(["New side chat", "Ask about my screen"]);
    expect(tasks[0]).toMatchObject({
      program: update,
      arguments: "--processStart Psyche.exe --process-start-args --psyche-task=new-side-chat",
      iconPath: exe,
      iconIndex: 0,
    });
    expect(jumpListTasks(exe, { exists: () => false, askScreen: false })).toEqual([
      expect.objectContaining({ program: exe, arguments: "--psyche-task=new-side-chat" }),
    ]);
    expect(
      windowsLaunchCommand("D:\\e\\electron.exe", ["--psyche-task=ask-screen"], {
        exists: () => false,
        leadingArgs: ["D:\\my repo"],
      }),
    ).toEqual({ path: "D:\\e\\electron.exe", args: ["D:\\my repo", "--psyche-task=ask-screen"] });
    expect(taskFromArgv(["Psyche.exe", "--psyche-task=ask-screen"])).toBe("ask-screen");
    expect(taskFromArgv(["Psyche.exe", "--psyche-task=rm -rf"])).toBeUndefined();
  });

  it("says Psyche is still running only the first time the window closes", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const marker = join(mkdtempSync(join(tmpdir(), "psy-tray-")), "closed-to-tray");
    expect(firstCloseToTray(marker)).toBe(true);
    expect(firstCloseToTray(marker)).toBe(false);
  });
});

describe("Squirrel.Windows events", () => {
  const exe = "C:\\L\\Psyche\\app-0.3.0\\Psyche.exe";

  it("handles install, update, uninstall and obsolete, and nothing else", async () => {
    expect(squirrelEvent(["Psyche.exe", "--squirrel-install", "0.3.0"])).toBe("install");
    expect(squirrelEvent(["Psyche.exe", "--squirrel-firstrun"])).toBeUndefined();
    expect(squirrelEvent(["Psyche.exe", "psyche://chat"])).toBeUndefined();
    expect(squirrelShortcutArgs("updated", exe)).toEqual(["--createShortcut=Psyche.exe"]);
    expect(squirrelShortcutArgs("uninstall", exe)).toEqual(["--removeShortcut=Psyche.exe"]);
    expect(squirrelShortcutArgs("obsolete", exe)).toBeUndefined();

    const ran: string[][] = [];
    let cleaned = false;
    const quit = await handleSquirrelEvent({
      platform: "win32",
      argv: ["Psyche.exe", "--squirrel-uninstall"],
      execPath: exe,
      onUninstall: async () => {
        cleaned = true;
      },
      run: async (file, args) => void ran.push([file, ...args]),
    });
    expect(quit).toBe(true);
    expect(cleaned).toBe(true);
    expect(ran).toEqual([["C:\\L\\Psyche\\Update.exe", "--removeShortcut=Psyche.exe"]]);
    expect(
      await handleSquirrelEvent({
        platform: "darwin",
        argv: ["x", "--squirrel-install"],
        execPath: exe,
      }),
    ).toBe(false);
  });
});

describe("the Windows notification-area icon", () => {
  const status = { phase: "paired" } as never;
  const model = {
    status,
    run: { kind: "running", mode: "taskscheduler" } as const,
    pendingApprovals: 0,
    usagePercentRemaining: null,
  };

  it("has the menu-bar extra's items, with the shortcuts actually registered", () => {
    const items = trayTemplate(
      { ...model, shortcuts: { quickEntry: "Control+Alt+Space", askScreen: "" } },
      {
        open: noop,
        newSideChat: noop,
        quickEntry: noop,
        askScreen: noop,
        openApprovals: noop,
        closeWindow: noop,
        quitApp: noop,
        quitEntirely: noop,
      },
    );
    const labels = items.map((i) => i.label).filter(Boolean);
    expect(labels).toEqual([
      "Psyche — connected",
      "Usage: —",
      "Nothing needs you",
      "Open Psyche",
      "New side chat",
      "Quick entry",
      "Ask about screen",
      "Psyche is running",
      "Close window",
      "Quit Psyche (tasks keep running)",
      "Quit Psyche entirely",
    ]);
    expect(items.find((i) => i.label === "Quick entry")?.accelerator).toBe("Control+Alt+Space");
    expect(items.find((i) => i.label === "Ask about screen")?.accelerator).toBeUndefined();
    expect(gatewayRowLabel({ kind: "running", mode: "taskscheduler" })).toBe("Psyche is running");
    expect(trayTooltip({ ...model, pendingApprovals: 2 })).toBe("Psyche — 2 things need you");
  });

  it("draws the mark white on a dark taskbar, dark on a light one, with a badge dot", () => {
    for (const size of TRAY_ICON_SIZES) {
      const { rgba } = trayIconRgba(size, { dark: true });
      expect(rgba.length).toBe(size * size * 4);
      // The ring passes through the left middle; the corners are empty.
      const at = (x: number, y: number) => (y * size + x) * 4;
      const left = at(Math.round(size * 0.09), Math.floor(size / 2));
      expect(rgba[left + 3]).toBeGreaterThan(100);
      expect(rgba[left]).toBe(255);
      expect(rgba[at(0, 0) + 3]).toBe(0);
    }
    const light = trayIconRgba(32, { dark: false }).rgba;
    const i = (16 * 32 + Math.round(32 * 0.09)) * 4;
    expect(light[i]).toBe(28);
    const badged = trayIconRgba(32, { dark: true, badge: true }).rgba;
    const dot = (6 * 32 + 25) * 4;
    expect([badged[dot], badged[dot + 1], badged[dot + 2]]).toEqual([124, 92, 255]);
    // BGRA, premultiplied, for nativeImage.
    const bgra = toBgraPremultiplied(Buffer.from([200, 100, 50, 255, 200, 100, 50, 0]));
    expect([...bgra]).toEqual([50, 100, 200, 255, 0, 0, 0, 0]);
  });

  it("reads the taskbar's own light/dark setting", () => {
    const out = (v: string) =>
      `\r\nHKEY_CURRENT_USER\\...\\Personalize\r\n    SystemUsesLightTheme    REG_DWORD    ${v}\r\n`;
    expect(taskbarIsDark(out("0x0"))).toBe(true);
    expect(taskbarIsDark(out("0x1"))).toBe(false);
    expect(taskbarIsDark(undefined)).toBe(true);
  });
});
