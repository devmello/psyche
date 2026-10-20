import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FsQuarantineWriter } from "../src/downloads/library.ts";
import { PlaywrightDriver } from "../src/drivers/playwright.ts";
import {
  findBrandedChrome,
  launchRealChrome,
  type RealChrome,
} from "../src/realchrome/launcher.ts";
import { FixtureServer } from "../src/testing/server.ts";

// The real-Chrome proof for I13: branded Google Chrome on its own data dir, attached over CDP
// with the same driver as server mode. Opt-in (PSYCHE_BROWSER_TESTS=1 and Chrome installed),
// as for the Playwright conformance suite; it runs on the macOS CI job.
const chrome = findBrandedChrome();
const enabled = process.env.PSYCHE_BROWSER_TESTS === "1" && chrome !== undefined;

const portOpen = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = connect({ host: "127.0.0.1", port });
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
  });

describe.skipIf(!enabled)("real-Chrome mode against Google Chrome (I13)", () => {
  let home: string;
  let server: FixtureServer;
  let rc: RealChrome;
  let driver: PlaywrightDriver;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "psyche-rc-live-"));
    server = new FixtureServer();
    await server.start();
    rc = await launchRealChrome({
      psycheHome: home,
      ...(chrome === undefined ? {} : { executablePath: chrome }),
      extraArgs: ["--headless=new"],
    });
    driver = new PlaywrightDriver({
      mode: "connect",
      cdpEndpoint: rc.endpoint,
      library: new FsQuarantineWriter(join(home, "library")),
    });
  }, 60_000);
  afterAll(async () => {
    await driver?.dispose();
    await rc?.close();
    await server?.stop();
    await rm(home, { recursive: true, force: true });
  });

  it("drives tabs it opened under the task's origin policy and nothing else", async () => {
    expect(new URL(rc.endpoint.replace(/^ws/, "http")).hostname).toBe("127.0.0.1");
    expect(rc.userDataDir.startsWith(join(home, "browser", "real-chrome"))).toBe(true);
    expect(await driver.listProfiles()).toEqual([
      { id: "default", name: "Chrome", kind: "real_chrome" },
    ]);

    // The owner has a tab of their own open in that Chrome; the agent never sees it.
    const owner = await chromium.connectOverCDP(rc.endpoint);
    const ownerPage = await (owner.contexts()[0] ?? (await owner.newContext())).newPage();
    await ownerPage.goto(server.url("b/"));

    const s = await driver.openSession({
      partition: "profile",
      policy: { devPreview: true, readWritable: [server.origin("a")] },
    });
    const t = await driver.openTab(s.id, server.url("a/login"));
    const snap = await driver.snapshot(t.id);
    expect(snap.text).toContain("Sign in");
    expect((await driver.listTabs(s.id)).map((x) => x.id)).toEqual([t.id]);
    // Origin sets are unchanged: site B is not in this task's set.
    await expect(driver.navigate(t.id, server.url("b/"))).rejects.toMatchObject({
      code: "approval_required",
    });
    await driver.closeSession(s.id);
    await owner.close();
  });

  it("closes the DevTools port with Chrome", async () => {
    expect(await portOpen(rc.port)).toBe(true);
    await driver.dispose();
    await rc.close();
    expect(rc.running).toBe(false);
    expect(await portOpen(rc.port)).toBe(false);
  });
});
