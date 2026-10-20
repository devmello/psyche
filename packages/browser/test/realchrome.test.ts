import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  launchRealChrome,
  parseDevToolsActivePort,
  realChromeDir,
} from "../src/realchrome/launcher.ts";

const FAKE = fileURLToPath(new URL("./fixtures/fake-chrome.mjs", import.meta.url));

describe("real-Chrome launcher (I13)", () => {
  let home: string;
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "psyche-rc-"));
  });
  afterAll(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("starts Chrome on its own data dir with a random loopback DevTools port, and closes it", async () => {
    const dir = realChromeDir("default", home);
    await import("node:fs/promises").then((fs) => fs.mkdir(dir, { recursive: true }));
    // A stale port file from a crashed run must not be trusted.
    await writeFile(join(dir, "DevToolsActivePort"), "1111\n/devtools/browser/stale\n");
    process.env.FAKE_CHROME_DELAY_MS = "150";
    const rc = await launchRealChrome({ psycheHome: home, executablePath: FAKE });
    delete process.env.FAKE_CHROME_DELAY_MS;
    expect(rc).toMatchObject({
      endpoint: "ws://127.0.0.1:54321/devtools/browser/fake-id",
      port: 54321,
      userDataDir: dir,
      running: true,
    });
    expect(rc.pid).toBeGreaterThan(0);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    const argv = JSON.parse(await readFile(join(dir, "argv.json"), "utf8")) as string[];
    expect(argv).toContain(`--user-data-dir=${dir}`);
    expect(argv).toContain("--remote-debugging-port=0");
    expect(argv).toContain("--window-name=Psyche is driving this window");
    let exited = false;
    rc.onExit(() => {
      exited = true;
    });
    await rc.close();
    expect(rc.running).toBe(false);
    expect(exited).toBe(true);
    expect(existsSync(join(dir, "DevToolsActivePort"))).toBe(false);
  });

  it("never opens the owner's Chrome profile and owns the debugging switches", async () => {
    const ownerHome = join(
      homedir(),
      "Library",
      "Application Support",
      "Google",
      "Chrome",
      "psyche",
    );
    await expect(
      launchRealChrome({ psycheHome: ownerHome, executablePath: FAKE }),
    ).rejects.toMatchObject({
      code: "policy_denied",
      details: { reason: "owner_profile" },
    });
    for (const arg of [
      "--remote-debugging-port=9222",
      "--remote-debugging-pipe",
      "--user-data-dir=/tmp/x",
      "--load-extension=/tmp/evil",
      "--remote-allow-origins=*",
    ]) {
      await expect(
        launchRealChrome({ psycheHome: home, executablePath: FAKE, extraArgs: [arg] }),
        arg,
      ).rejects.toMatchObject({ code: "invalid_params" });
    }
    expect(() => realChromeDir("../escape", home)).toThrow();
  });

  it("fails cleanly when Chrome exits before it is ready", async () => {
    process.env.FAKE_CHROME_EXIT = "1";
    try {
      await expect(
        launchRealChrome({ psycheHome: home, profile: "crashy", executablePath: FAKE }),
      ).rejects.toMatchObject({ code: "unavailable" });
    } finally {
      delete process.env.FAKE_CHROME_EXIT;
    }
  });

  it("parses DevToolsActivePort and refuses anything else", () => {
    expect(parseDevToolsActivePort("9333\n/devtools/browser/abc\n")).toEqual({
      port: 9333,
      path: "/devtools/browser/abc",
    });
    for (const bad of ["", "x\n/devtools/browser/a", "70000\n/devtools/browser/a", "9333\n/json"]) {
      expect(() => parseDevToolsActivePort(bad), bad).toThrow();
    }
  });
});
