import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { platformFromNode } from "../../src/lib/device-key.ts";
import {
  appPathKeys,
  findWindowsChromium,
  parseRegDefault,
  realChromeOpenCommand,
} from "../../src/lib/real-chrome.ts";
import {
  bridgeSocketPath,
  checkBridgeSocket,
  defaultBridgePipe,
  isNamedPipe,
} from "../../src/main/bridge/bridge-client.ts";
import { createPermissions, type PermissionDeps } from "../../src/main/permissions/permissions.ts";
import {
  captureDisplay,
  captureScreenFrame,
  cropRect,
  fitWithin,
  type ImageLike,
  wantsFallback,
} from "../../src/main/screen-ask/capture-fallback.ts";

describe("device platform", () => {
  it("is windows on win32, never linux", () => {
    expect(platformFromNode("win32")).toBe("windows");
    expect(platformFromNode("darwin")).toBe("macos");
    expect(platformFromNode("linux")).toBe("linux");
  });
});

describe("the Psyche Chrome profile on Windows", () => {
  const env = {
    ProgramFiles: "C:\\Program Files",
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
    LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local",
  };

  it("prefers Chrome's App Paths registration, then the install folders, then Edge and Brave", async () => {
    const reg: Record<string, string> = {
      "chrome.exe": '"D:\\Apps\\Chrome\\chrome.exe"',
      "msedge.exe": "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    };
    const files = new Set([
      "D:\\Apps\\Chrome\\chrome.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Users\\a\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
    ]);
    const find = (over: Partial<Record<string, string>>, have = files) =>
      findWindowsChromium({
        appPath: async (exe) => ({ ...reg, ...over })[exe],
        exists: (p) => have.has(p),
        env,
      });
    expect(await find({})).toEqual({ name: "Google Chrome", path: "D:\\Apps\\Chrome\\chrome.exe" });
    // A stale registration falls through to the per-user install folder.
    expect(await find({ "chrome.exe": "C:\\gone\\chrome.exe" })).toEqual({
      name: "Google Chrome",
      path: "C:\\Users\\a\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
    });
    expect(
      await find(
        { "chrome.exe": undefined },
        new Set(["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"]),
      ),
    ).toEqual({
      name: "Microsoft Edge",
      path: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    });
    expect(
      await findWindowsChromium({ appPath: async () => undefined, exists: () => false, env }),
    ).toBeUndefined();
  });

  it("reads the registry per user first, by the value's type column (any language)", () => {
    expect(appPathKeys("chrome.exe")).toEqual([
      "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe",
      "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe",
    ]);
    const out =
      "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\...\\chrome.exe\r\n    (Standard)    REG_SZ    C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe\r\n";
    expect(parseRegDefault(out)).toBe("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
    expect(parseRegDefault("ERROR: not found")).toBeUndefined();
  });

  it("opens it as its own instance with Psyche's profile and no DevTools port", () => {
    const cmd = realChromeOpenCommand("win32", "C:\\h\\browser\\real-chrome\\default", "C:\\c.exe");
    expect(cmd).toEqual({
      command: "C:\\c.exe",
      args: [
        "--user-data-dir=C:\\h\\browser\\real-chrome\\default",
        "--no-first-run",
        "--no-default-browser-check",
      ],
    });
    expect(cmd?.args.join(" ")).not.toMatch(/remote-debugging/);
  });
});

describe("Windows permissions", () => {
  const deps = (over: Partial<PermissionDeps> = {}): PermissionDeps => ({
    platform: "win32",
    systemPreferences: {
      isTrustedAccessibilityClient: vi.fn(() => false),
      getMediaAccessStatus: vi.fn(() => "granted"),
    },
    desktopCapturer: { getSources: vi.fn(async () => []) },
    openExternal: vi.fn(),
    showFirstNotification: () => true,
    ...over,
  });

  it("asks for nothing Windows does not have, and never opens macOS panes", async () => {
    const d = deps();
    const p = createPermissions(d);
    expect(await p.statusAll()).toEqual({
      accessibility: "granted",
      screenRecording: "granted",
      notifications: "granted",
      microphone: "granted",
    });
    expect(await p.request("accessibility")).toBe("granted");
    expect(await p.request("screenRecording")).toBe("granted");
    expect(d.systemPreferences.isTrustedAccessibilityClient).not.toHaveBeenCalled();
    expect(d.openExternal).not.toHaveBeenCalled();
  });

  it("reports the microphone privacy toggle and opens its settings page when it is off", async () => {
    const d = deps({
      systemPreferences: {
        isTrustedAccessibilityClient: vi.fn(() => false),
        getMediaAccessStatus: vi.fn((t: string) => (t === "microphone" ? "denied" : "granted")),
      },
    });
    const p = createPermissions(d);
    expect(await p.status("microphone")).toBe("denied");
    expect(await p.request("microphone")).toBe("denied");
    expect(d.openExternal).toHaveBeenCalledWith("ms-settings:privacy-microphone");
  });

  it("asks for the microphone on macOS the first time, then sends to System Settings", async () => {
    let state = "not-determined";
    const ask = vi.fn(async () => {
      state = "granted";
      return true;
    });
    const opened: string[] = [];
    const p = createPermissions({
      platform: "darwin",
      systemPreferences: {
        isTrustedAccessibilityClient: () => false,
        getMediaAccessStatus: () => state,
        askForMediaAccess: ask,
      },
      desktopCapturer: { getSources: async () => [] },
      openExternal: (u) => void opened.push(u),
    });
    expect(await p.request("microphone")).toBe("granted");
    state = "denied";
    expect(await p.request("microphone")).toBe("denied");
    expect(opened).toEqual([expect.stringContaining("Privacy_Microphone")]);
  });

  it("uses the Windows helper's notifications when it is online", async () => {
    const p = createPermissions(
      deps({
        helper: {
          notificationStatus: async () => "denied",
          requestNotifications: async () => "denied",
        },
      }),
    );
    expect(await p.status("notifications")).toBe("denied");
    expect(await p.request("notifications")).toBe("denied");
  });
});

describe("the browser bridge over a named pipe", () => {
  it("accepts the Gateway's pipe pointer and falls back to a per-home pipe", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const home = mkdtempSync(join(tmpdir(), "psy-pipe-"));
    expect(bridgeSocketPath(home, "win32")).toBe(defaultBridgePipe(home));
    expect(defaultBridgePipe(home)).toMatch(/^\\\\\.\\pipe\\psyche-[0-9a-f]{16}-browser-bridge$/);
    expect(defaultBridgePipe(home.toUpperCase())).toBe(defaultBridgePipe(home.toLowerCase()));
    mkdirSync(join(home, "run"), { recursive: true });
    writeFileSync(join(home, "run", "browser-bridge-socket"), "\\\\.\\pipe\\psyche-gw-bridge\n");
    expect(bridgeSocketPath(home, "win32")).toBe("\\\\.\\pipe\\psyche-gw-bridge");
    writeFileSync(join(home, "run", "browser-bridge-socket"), "relative\n");
    expect(bridgeSocketPath(home, "win32")).toBe(defaultBridgePipe(home));
    expect(bridgeSocketPath(home, "darwin")).toBe(join(home, "run", "browser-bridge.sock"));
    expect(isNamedPipe("\\\\.\\pipe\\x")).toBe(true);
    expect(isNamedPipe("C:\\x.sock")).toBe(false);
    expect(checkBridgeSocket("\\\\.\\pipe\\x")).toBeNull();
  });
});

describe("Ask about my screen without a helper (desktopCapturer)", () => {
  const primary = { id: 1, bounds: { x: 0, y: 0, width: 1280, height: 720 }, scaleFactor: 1.5 };
  const left = { id: 2, bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 };

  it("takes the display with the pointer, or the region's", () => {
    expect(captureDisplay({ mode: "window" }, [primary, left], { x: -10, y: 5 })).toBe(left);
    expect(
      captureDisplay(
        { mode: "region", rect: { x: 100, y: 100, width: 50, height: 50 } },
        [primary, left],
        { x: -10, y: 5 },
      ),
    ).toBe(primary);
  });

  it("crops the region in the display's physical pixels (DPI scaling)", () => {
    const frame = { width: 1920, height: 1080 }; // 1280 x 720 DIPs at 150 %
    expect(
      cropRect(
        { mode: "region", rect: { x: 100, y: 50, width: 200, height: 100 } },
        primary,
        frame,
      ),
    ).toEqual({ x: 150, y: 75, width: 300, height: 150 });
    // Clipped to the display; a region off it has no crop.
    expect(
      cropRect(
        { mode: "region", rect: { x: 1200, y: 700, width: 200, height: 100 } },
        primary,
        frame,
      ),
    ).toEqual({ x: 1800, y: 1050, width: 120, height: 30 });
    expect(
      cropRect({ mode: "region", rect: { x: 5000, y: 0, width: 10, height: 10 } }, primary, frame),
    ).toBeNull();
    expect(cropRect({ mode: "window" }, primary, frame)).toEqual({ x: 0, y: 0, ...frame });
    expect(fitWithin({ width: 3840, height: 2160 }, { width: 1600, height: 1000 })).toEqual({
      width: 1600,
      height: 900,
    });
    expect(fitWithin({ width: 300, height: 150 }, { width: 1600, height: 1000 })).toEqual({
      width: 300,
      height: 150,
    });
  });

  it("returns a JPEG frame with no text context, hiding Psyche's windows while it captures", async () => {
    const ops: string[] = [];
    const img = (w: number, h: number): ImageLike => ({
      getSize: () => ({ width: w, height: h }),
      isEmpty: () => false,
      crop: (r) => {
        ops.push(`crop ${r.x},${r.y},${r.width}x${r.height}`);
        return img(r.width, r.height);
      },
      resize: (o) => {
        ops.push(`resize ${o.width}x${o.height}`);
        return img(o.width, o.height);
      },
      toJPEG: () => Buffer.from("jpeg"),
    });
    const frame = await captureScreenFrame(
      { mode: "region", rect: { x: 100, y: 50, width: 200, height: 100 } },
      {
        displays: () => [primary, left],
        pointer: () => ({ x: 0, y: 0 }),
        sources: async (size) => {
          ops.push(`capture ${size.width}x${size.height}`);
          return [
            { display_id: "2", thumbnail: img(1920, 1080) },
            { display_id: "1", thumbnail: img(1920, 1080) },
          ];
        },
        excludeOwnWindows: async (run) => {
          ops.push("hide own");
          const r = await run();
          ops.push("show own");
          return r;
        },
      },
    );
    expect(frame).toEqual({
      image: Buffer.from("jpeg").toString("base64"),
      width: 300,
      height: 150,
      context: null,
    });
    expect(ops).toEqual(["hide own", "capture 1920x1080", "show own", "crop 150,75,300x150"]);
  });

  it("falls back only when nothing on this computer can capture", () => {
    expect(wantsFallback({ code: "unavailable" })).toBe(true);
    expect(wantsFallback({ code: "forbidden" })).toBe(false);
    expect(wantsFallback(null)).toBe(false);
  });
});
