import { describe, expect, it } from "vitest";
import { findLinuxChromium, realChromeOpenCommand } from "../../src/lib/real-chrome.ts";

const noFlatpak = async () => ({ code: 1, stdout: "", stderr: "" });

describe("real Chrome on Linux", () => {
  it("prefers Chrome, then Chromium, Brave, Edge, from the PATH", async () => {
    const has =
      (...names: string[]) =>
      (p: string) =>
        names.some((n) => p === `/usr/bin/${n}`);
    const find = (exists: (p: string) => boolean) =>
      findLinuxChromium({ run: noFlatpak, env: { PATH: "/opt/x:/usr/bin" }, exists });
    expect((await find(has("chromium", "google-chrome-stable")))?.command).toBe(
      "google-chrome-stable",
    );
    expect((await find(has("chromium-browser", "brave-browser")))?.command).toBe(
      "chromium-browser",
    );
    expect((await find(has("microsoft-edge")))?.name).toBe("Microsoft Edge");
    expect(await find(has())).toBeUndefined();
  });

  it("falls back to a Flatpak, tried after every PATH browser", async () => {
    const asked: string[] = [];
    const run = async (_f: string, args: string[]) => {
      asked.push(args.join(" "));
      return { code: args[1] === "org.chromium.Chromium" ? 0 : 1, stdout: "", stderr: "" };
    };
    const found = await findLinuxChromium({ run, env: { PATH: "/usr/bin" }, exists: () => false });
    expect(found).toMatchObject({ command: "flatpak", flatpakId: "org.chromium.Chromium" });
    expect(asked).toEqual(["info com.google.Chrome", "info org.chromium.Chromium"]);
    const onPath = await findLinuxChromium({
      run,
      env: { PATH: "/usr/bin" },
      exists: (p) => p === "/usr/bin/chromium",
    });
    expect(onPath?.command).toBe("chromium");
  });

  it("opens the profile with the command found; a Flatpak is granted the profile folder only", () => {
    expect(
      realChromeOpenCommand("linux", "/h/p", undefined, {
        name: "Chromium",
        command: "chromium",
        args: [],
      }),
    ).toEqual({
      command: "chromium",
      args: ["--user-data-dir=/h/p", "--no-first-run", "--no-default-browser-check"],
    });
    const flat = realChromeOpenCommand("linux", "/h/p", undefined, {
      name: "Google Chrome",
      command: "flatpak",
      args: ["run", "com.google.Chrome"],
      flatpakId: "com.google.Chrome",
    });
    expect(flat?.command).toBe("flatpak");
    expect(flat?.args.slice(0, 3)).toEqual(["run", "--filesystem=/h/p", "com.google.Chrome"]);
    expect(flat?.args).toContain("--user-data-dir=/h/p");
    expect(flat?.args.join(" ")).not.toMatch(/remote-debugging|no-sandbox/);
  });

  it("without a found browser keeps the old google-chrome default", () => {
    expect(realChromeOpenCommand("linux", "/d")?.command).toBe("google-chrome");
  });
});
