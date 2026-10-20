import { describe, expect, it, vi } from "vitest";
import {
  createPermissions,
  notificationStateOf,
  type PermissionDeps,
  PRIVACY_PANE,
} from "../src/main/permissions/permissions.ts";

function deps(over: Partial<PermissionDeps> = {}) {
  let trusted = false;
  let screen = "not-determined";
  const opened: string[] = [];
  const d: PermissionDeps = {
    platform: "darwin",
    systemPreferences: {
      isTrustedAccessibilityClient: vi.fn((prompt: boolean) => {
        void prompt;
        return trusted;
      }),
      getMediaAccessStatus: vi.fn(() => screen),
    },
    desktopCapturer: { getSources: vi.fn(async () => []) },
    openExternal: (url) => void opened.push(url),
    ...over,
  };
  return {
    d,
    opened,
    trust: (v: boolean) => (trusted = v),
    setScreen: (v: string) => (screen = v),
  };
}

describe("macOS permissions (issue #384)", () => {
  it("prompts for Accessibility and opens its pane while it is still off", async () => {
    const t = deps();
    const p = createPermissions(t.d);
    expect(await p.request("accessibility")).toBe("denied");
    expect(t.d.systemPreferences.isTrustedAccessibilityClient).toHaveBeenCalledWith(true);
    expect(t.opened).toEqual([PRIVACY_PANE.accessibility]);
    t.trust(true);
    expect(await p.status("accessibility")).toBe("granted");
    // Status never prompts.
    expect(t.d.systemPreferences.isTrustedAccessibilityClient).toHaveBeenLastCalledWith(false);
    expect(await p.request("accessibility")).toBe("granted");
    expect(t.opened).toHaveLength(1);
  });

  it("triggers the Screen Recording prompt with one capture request, then the pane", async () => {
    const t = deps();
    const p = createPermissions(t.d);
    expect(await p.status("screenRecording")).toBe("not_determined");
    expect(await p.request("screenRecording")).toBe("denied");
    expect(t.d.desktopCapturer.getSources).toHaveBeenCalledTimes(1);
    expect(t.opened).toEqual([PRIVACY_PANE.screenRecording]);
    t.setScreen("granted");
    expect(await p.request("screenRecording")).toBe("granted");
    expect(t.d.desktopCapturer.getSources).toHaveBeenCalledTimes(1);
  });

  it("asks the helper for notifications, falling back to Electron's first notification", async () => {
    const helper = {
      notificationStatus: vi.fn(async () => "not_determined" as const),
      requestNotifications: vi.fn(async () => "granted" as const),
    };
    const show = vi.fn(() => true);
    const withHelper = createPermissions(deps({ helper, showFirstNotification: show }).d);
    expect(await withHelper.request("notifications")).toBe("granted");
    expect(show).not.toHaveBeenCalled();

    const offline = {
      notificationStatus: vi.fn(async () => {
        throw new Error("helper offline");
      }),
      requestNotifications: vi.fn(async () => {
        throw new Error("helper offline");
      }),
    };
    const fallback = createPermissions(deps({ helper: offline, showFirstNotification: show }).d);
    expect(await fallback.request("notifications")).toBe("granted");
    expect(show).toHaveBeenCalledTimes(1);
    expect(await fallback.status("notifications")).toBe("unavailable");
    expect(await createPermissions(deps().d).request("notifications")).toBe("unavailable");
  });

  it("is unavailable off macOS", async () => {
    const p = createPermissions(deps({ platform: "linux" }).d);
    expect(await p.request("accessibility")).toBe("unavailable");
    expect(await p.statusAll()).toEqual({
      accessibility: "unavailable",
      screenRecording: "unavailable",
      notifications: "unavailable",
    });
  });

  it("reads the helper's notify.* results", () => {
    expect(notificationStateOf({ granted: true })).toBe("granted");
    expect(notificationStateOf({ granted: false })).toBe("denied");
    expect(notificationStateOf({ status: "provisional" })).toBe("granted");
    expect(notificationStateOf({ authorization: "notDetermined" })).toBe("not_determined");
    expect(notificationStateOf(undefined)).toBe("unavailable");
  });
});
