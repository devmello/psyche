import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeBrowserDriverConformance } from "../src/conformance/suite.ts";
import { FsQuarantineWriter } from "../src/downloads/library.ts";
import { CdpBridgeDriver } from "../src/drivers/cdp.ts";
import { MockDesktop } from "../src/testing/mock-desktop.ts";

describeBrowserDriverConformance("CDP driver over the mock desktop bridge", async () => {
  const dir = await mkdtemp(join(tmpdir(), "psyche-s08-"));
  const library = new FsQuarantineWriter(join(dir, "library"));
  const desktop = new MockDesktop({ quarantineDir: dir });
  const client = await desktop.connect();
  const driver = new CdpBridgeDriver(client, { library, downloadTimeoutMs: 5000 });
  const uploadFile = join(dir, "notes.txt");
  await writeFile(uploadFile, "hello");
  const settle = () => new Promise((r) => setTimeout(r, 20));
  return {
    driver,
    url: (key) => desktop.browser.url(key),
    origin: (h) => desktop.browser.origin(h),
    submissions: () => desktop.browser.submissions,
    takeControl: async (_s, tabId) => {
      desktop.takeControl(tabId, "keyboard");
      await settle();
    },
    release: async (_s, tabId) => {
      desktop.release(tabId);
      await settle();
    },
    libraryItem: (id) => library.items.get(id),
    uploadFile,
    close: async () => {
      driver.dispose();
      desktop.disconnect();
      await rm(dir, { recursive: true, force: true });
    },
  };
});
