#!/usr/bin/env node
// Stands in for Google Chrome in launcher tests: records its argv, writes DevToolsActivePort
// into --user-data-dir after FAKE_CHROME_DELAY_MS, and exits on SIGTERM. FAKE_CHROME_EXIT=1
// exits at once, as a crashing Chrome would.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

if (process.env.FAKE_CHROME_EXIT === "1") process.exit(3);
const dir = process.argv.find((a) => a.startsWith("--user-data-dir="))?.slice(16);
if (dir === undefined) process.exit(2);
writeFileSync(join(dir, "argv.json"), JSON.stringify(process.argv.slice(2)));
setTimeout(
  () => {
    writeFileSync(join(dir, "DevToolsActivePort"), "54321\n/devtools/browser/fake-id\n");
  },
  Number(process.env.FAKE_CHROME_DELAY_MS ?? "50"),
);
process.on("SIGTERM", () => process.exit(0));
setInterval(() => undefined, 1000);
