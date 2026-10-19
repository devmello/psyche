import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeBrowserDriverConformance } from "../src/conformance/suite.ts";
import { FsQuarantineWriter } from "../src/downloads/library.ts";
import { PlaywrightDriver } from "../src/drivers/playwright.ts";
import { findChromium } from "../src/profiles.ts";
import { FixtureServer } from "../src/testing/server.ts";

// Real Chromium against the local fixture server. Opt-in: PSYCHE_BROWSER_TESTS=1, and a
// Chromium must be found (PSYCHE_CHROMIUM_PATH, Chrome or Chromium). Skipped in CI otherwise.
const executablePath = findChromium();
const enabled = process.env.PSYCHE_BROWSER_TESTS === "1" && executablePath !== undefined;

describeBrowserDriverConformance(
  "Playwright driver (real Chromium)",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "psyche-s08-pw-"));
    const server = new FixtureServer();
    await server.start();
    const library = new FsQuarantineWriter(join(dir, "library"));
    const options: ConstructorParameters<typeof PlaywrightDriver>[0] = {
      library,
      psycheHome: join(dir, "home"),
      headless: true,
      downloadTimeoutMs: 10_000,
    };
    if (executablePath !== undefined) options.executablePath = executablePath;
    const driver = new PlaywrightDriver(options);
    const uploadFile = join(dir, "notes.txt");
    await writeFile(uploadFile, "hello");
    return {
      driver,
      url: (key) => server.url(key),
      origin: (h) => server.origin(h),
      submissions: () => server.submissions,
      takeControl: (s) => driver.setControlState(s, "user"),
      release: (s) => driver.setControlState(s, "agent"),
      libraryItem: (id) => library.items.get(id),
      uploadFile,
      close: async () => {
        await driver.dispose();
        await server.stop();
        await rm(dir, { recursive: true, force: true });
      },
    };
  },
  { skip: !enabled, snapshotBudgetMs: 300 },
);
