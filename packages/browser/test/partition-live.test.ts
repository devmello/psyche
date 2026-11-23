import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FsQuarantineWriter } from "../src/downloads/library.ts";
import { CdpBridgeDriver } from "../src/drivers/cdp.ts";
import { PartitionChooser, type PartitionMode } from "../src/origin/partition.ts";
import { MockDesktop } from "../src/testing/mock-desktop.ts";

/**
 * Narrowing the sign-in mode or the signed-in sites reaches tabs opened later in a session that
 * is already open: the chooser reads both on every choice, the way it reads the detected sites.
 */

describe("PartitionChooser reads the mode and the sites on every choice", () => {
  it("profile narrowed to clean: a later tab is clean, and so is the session default", () => {
    let mode: PartitionMode = "profile";
    const c = new PartitionChooser({ mode: () => mode });
    expect(c.choose("https://a.example/").partition).toBe("profile");
    expect(c.defaultPartition).toBe("profile");
    mode = "clean";
    expect(c.choose("https://a.example/")).toMatchObject({
      partition: "clean",
      reason: "task_clean",
    });
    expect(c.defaultPartition).toBe("clean");
  });

  it("auto: a site removed from the list stops opening in the profile", () => {
    let sites = ["https://a.example", "https://b.example"];
    const c = new PartitionChooser({ mode: "auto", signedInOrigins: () => sites });
    expect(c.choose("https://a.example/").partition).toBe("profile");
    sites = ["https://b.example"];
    expect(c.choose("https://a.example/").partition).toBe("clean");
    expect(c.choose("https://b.example/").partition).toBe("profile");
    // A positive control for the widening direction.
    sites = ["https://a.example", "https://b.example"];
    expect(c.choose("https://a.example/").partition).toBe("profile");
  });

  it("a static policy still works", () => {
    const c = new PartitionChooser({ mode: "auto", signedInOrigins: ["https://a.example"] });
    expect(c.choose("https://a.example/").partition).toBe("profile");
    expect(c.choose("https://b.example/").partition).toBe("clean");
  });

  it.each(["https://a..b", "https://x.com..", "https://.x.com", "", "https://*."])(
    "skips the stored entry %j and keeps the others",
    (bad) => {
      const c = new PartitionChooser({
        mode: "auto",
        signedInOrigins: [bad, "https://good.example"],
      });
      expect(c.choose("https://good.example/").partition).toBe("profile");
      expect(c.choose("https://other.example/").partition).toBe("clean");
      expect(c.isSignedIn("https://a.b/")).toBe(false);
    },
  );
});

describe("an open session follows the getters", () => {
  let dir = "";
  let desktop: MockDesktop;
  let driver: CdpBridgeDriver;
  let mode: PartitionMode = "profile";
  let sites: string[] = [];
  let sessionId = "";

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "psyche-partition-live-"));
    desktop = new MockDesktop({ quarantineDir: dir });
    driver = new CdpBridgeDriver(await desktop.connect(), {
      library: new FsQuarantineWriter(join(dir, "lib")),
    });
    sessionId = (
      await driver.openSession({
        taskId: "task_live",
        partition: () => mode,
        signedInOrigins: () => sites,
        policy: {
          devPreview: true,
          readWritable: [desktop.browser.origin("a"), desktop.browser.origin("b")],
        },
      })
    ).id;
  });
  afterAll(async () => {
    driver.dispose();
    desktop.disconnect();
    await rm(dir, { recursive: true, force: true });
  });

  it("profile narrowed to clean: a new tab in the same session is clean", async () => {
    mode = "profile";
    expect((await driver.openTab(sessionId, desktop.browser.url("a/"))).partition).toBe("profile");
    mode = "clean";
    expect((await driver.openTab(sessionId, desktop.browser.url("a/"))).partition).toBe("clean");
  });

  it("auto: a site removed from the list opens clean in the same session", async () => {
    mode = "auto";
    sites = [desktop.browser.origin("a")];
    expect((await driver.openTab(sessionId, desktop.browser.url("a/"))).partition).toBe("profile");
    sites = [];
    expect((await driver.openTab(sessionId, desktop.browser.url("a/"))).partition).toBe("clean");
  });
});
