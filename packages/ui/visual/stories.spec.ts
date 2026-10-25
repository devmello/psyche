import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

interface IndexEntry {
  id: string;
  type: "story" | "docs";
  title: string;
  name: string;
}

const index = JSON.parse(
  readFileSync(new URL("../storybook-static/index.json", import.meta.url), "utf8"),
) as { entries: Record<string, IndexEntry> };

const stories = Object.values(index.entries).filter((e) => e.type === "story");

/** Every story in light; dark only for the core surfaces, to keep the baseline small. */
const DARK = /^(Primitives|Cards|Chat|Shell|Avatar|Agent)\//;

for (const story of stories) {
  const themes = DARK.test(story.title) ? (["light", "dark"] as const) : (["light"] as const);
  for (const theme of themes) {
    test(`${story.title} / ${story.name} (${theme})`, async ({ page }) => {
      await page.goto(
        `/iframe.html?id=${story.id}&viewMode=story&globals=theme:${theme};motion:reduced`,
      );
      await page.waitForSelector("#storybook-root > *", { state: "attached" });
      // Let the mock Gateway settle and fonts load.
      await page.waitForTimeout(150);
      await page.evaluate(() => document.fonts.ready);
      await expect(page).toHaveScreenshot(`${story.id}--${theme}.png`);
    });
  }
}
