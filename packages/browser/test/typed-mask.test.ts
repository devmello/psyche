import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResolvedSecret } from "@psyche/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FsQuarantineWriter } from "../src/downloads/library.ts";
import { CdpBridgeDriver } from "../src/drivers/cdp.ts";
import { SECURE_MASK } from "../src/snapshot/builder.ts";
import { MockDesktop } from "../src/testing/mock-desktop.ts";

// A card CVC or expiry typed into a plain `type=text` field (matched by name, not marked secure by
// the page) must not come back through the next snapshot.
describe("values typed by a vault fill are masked in snapshots", () => {
  let dir: string;
  let desktop: MockDesktop;
  let driver: CdpBridgeDriver;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "psyche-typed-mask-"));
    desktop = new MockDesktop({ quarantineDir: dir });
    driver = new CdpBridgeDriver(await desktop.connect(), {
      library: new FsQuarantineWriter(join(dir, "library")),
      downloadTimeoutMs: 5000,
    });
  });
  afterAll(async () => {
    driver.dispose();
    desktop.disconnect();
    await rm(dir, { recursive: true, force: true });
  });

  it("masks a plain text field after a secret was typed into it, until navigation", async () => {
    const a = desktop.browser.origin("a");
    const s = await driver.openSession({
      taskId: "task_mask",
      policy: { devPreview: true, readWritable: [a], readOnly: [] },
    });
    const t = await driver.openTab(s.id, desktop.browser.url("a/login"));
    const snap = await driver.snapshot(t.id);
    const user = snap.refs.find((r) => r.role === "textbox" && r.name.includes("Username"))?.ref;
    expect(user).toBeDefined();
    const cvv = "737";
    await driver.fillSecret(
      t.id,
      user as string,
      new ResolvedSecret(cvv, { credentialId: "pay", target: { kind: "origin", value: a } }),
      a,
    );
    const after = await driver.snapshot(t.id);
    expect(after.text).not.toContain(cvv);
    expect(after.text).toContain(SECURE_MASK);
    expect(JSON.stringify(after.refs)).not.toContain(cvv);
  });
});
