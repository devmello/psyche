import { describe, expect, it, vi } from "vitest";
import { BACKGROUND_ARG, LoginItem, OPEN_AT_LOGIN_KEY } from "../../src/main/login-item.ts";

const app = () => ({ setLoginItemSettings: vi.fn() });

describe("Open Psyche at login", () => {
  it("registers the login item with --background, and removes it when turned off", () => {
    const a = app();
    const item = new LoginItem(a, { platform: "darwin" });
    item.onSettingsChanged([{ key: OPEN_AT_LOGIN_KEY, value: true }]);
    expect(a.setLoginItemSettings).toHaveBeenLastCalledWith({
      openAtLogin: true,
      args: [BACKGROUND_ARG],
    });
    item.onSettingsChanged([{ key: OPEN_AT_LOGIN_KEY, value: false }]);
    expect(a.setLoginItemSettings).toHaveBeenLastCalledWith({
      openAtLogin: false,
      args: [BACKGROUND_ARG],
    });
    item.onSettingsChanged([{ key: "appearance.zoom", value: 1 }]);
    expect(a.setLoginItemSettings).toHaveBeenCalledTimes(2);
  });

  it("leaves the system's login item alone when the setting was never stored", async () => {
    const a = app();
    await new LoginItem(a, { platform: "darwin" }).load(async () => ({ settings: {} }));
    expect(a.setLoginItemSettings).not.toHaveBeenCalled();
    await new LoginItem(a, { platform: "darwin" }).load(async () => ({
      settings: { [OPEN_AT_LOGIN_KEY]: true },
    }));
    expect(a.setLoginItemSettings).toHaveBeenCalledOnce();
  });

  it("does nothing off macOS and logs a failing call", () => {
    const a = app();
    new LoginItem(a, { platform: "linux" }).set(true);
    expect(a.setLoginItemSettings).not.toHaveBeenCalled();
    const warn = vi.fn();
    const bad = {
      setLoginItemSettings: vi.fn(() => {
        throw new Error("denied");
      }),
    };
    new LoginItem(bad, { platform: "darwin", warn }).set(true);
    expect(warn).toHaveBeenCalled();
  });
});
