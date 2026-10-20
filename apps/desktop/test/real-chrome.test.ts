import { describe, expect, it } from "vitest";
import { realChromeOpenCommand, realChromeProfileDir } from "../src/lib/real-chrome.ts";

describe("Psyche Chrome profile (I13)", () => {
  it("lives under $PSYCHE_HOME and accepts only plain profile names", () => {
    expect(realChromeProfileDir("/Users/me/.psyche")).toBe(
      "/Users/me/.psyche/browser/real-chrome/default",
    );
    expect(realChromeProfileDir("/h", "work-2")).toBe("/h/browser/real-chrome/work-2");
    for (const bad of ["../x", "Default", "a/b", "", "-x"]) {
      expect(() => realChromeProfileDir("/h", bad), bad).toThrow();
    }
  });

  it("opens a separate Chrome instance with that profile and no DevTools port", () => {
    const mac = realChromeOpenCommand("darwin", "/h/browser/real-chrome/default");
    expect(mac).toEqual({
      command: "open",
      args: [
        "-n",
        "-a",
        "Google Chrome",
        "--args",
        "--user-data-dir=/h/browser/real-chrome/default",
        "--no-first-run",
        "--no-default-browser-check",
      ],
    });
    expect(mac?.args.join(" ")).not.toMatch(/remote-debugging/);
    expect(realChromeOpenCommand("linux", "/d")?.command).toBe("google-chrome");
    expect(realChromeOpenCommand("win32", "/d")).toBeNull();
  });
});
