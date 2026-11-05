import { describe, expect, it } from "vitest";
import { hostOs, hostWords } from "../src/host-words.ts";

describe("hostWords", () => {
  it("follows the Host helper's kind first", () => {
    expect(hostOs("win-helper", "darwin")).toBe("windows");
    expect(hostOs("mac-helper", "win32")).toBe("macos");
    expect(hostWords("win-helper").presence).toBe("Windows Hello");
    expect(hostWords("mac-helper").presence).toBe("Touch ID");
  });

  it("falls back to the platform; Linux keeps the macOS words", () => {
    expect(hostOs(undefined, "win32")).toBe("windows");
    expect(hostOs(null, "darwin")).toBe("macos");
    expect(hostOs(undefined, "linux")).toBe("macos");
    expect(hostOs("remote", "win32")).toBe("windows");
  });

  it("has the Windows names for each place the owner is sent", () => {
    expect(hostWords(undefined, "win32")).toEqual({
      os: "windows",
      osName: "Windows",
      device: "PC",
      thisDevice: "this PC",
      yourDevice: "your PC",
      theDevice: "the PC",
      presence: "Windows Hello",
      secretStore: "Credential Manager",
      systemSettings: "Settings",
      fileManager: "File Explorer",
      helper: "the Windows helper",
    });
    expect(hostWords(undefined, "darwin")).toMatchObject({
      thisDevice: "this Mac",
      secretStore: "the keychain",
      systemSettings: "System Settings",
      fileManager: "Finder",
      helper: "the Mac helper",
    });
  });
});
