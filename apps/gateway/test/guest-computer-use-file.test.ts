import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computerUseFile } from "../src/compose/computer-settings.ts";

/**
 * The separate desktop's guest helper reads its tiers from a root-owned file in the image
 * (`/etc/psyche/computer-use.json`, `PSYCHE_COMPUTER_USE_SETTINGS`), not from a path its own apps
 * can write. It carries the Gateway's fixed caps, so an id only the Gateway lists (a browser, a
 * launcher) is capped in the guest as on the Host (review of #1294, round 3).
 *
 * Regenerate after a list change: `UPDATE_GUEST_CAPS=1 pnpm exec vitest run
 * test/guest-computer-use-file.test.ts` in apps/gateway.
 */
const FILE = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "deploy",
  "sandbox-image",
  "desktop",
  "computer-use.json",
);

describe("the guest's computer-use file", () => {
  it("is the Gateway's own file for the separate desktop: Ask, no apps, the fixed caps", () => {
    const want = `${JSON.stringify(computerUseFile(true, {}), null, 2)}\n`;
    if (process.env.UPDATE_GUEST_CAPS === "1") writeFileSync(FILE, want);
    expect(readFileSync(FILE, "utf8")).toBe(want);
    const parsed = JSON.parse(want) as {
      default: string;
      apps: object;
      caps: Record<string, string>;
    };
    expect(parsed.default).toBe("ask");
    expect(parsed.apps).toEqual({});
    // A few ids only the Gateway lists, and the launchers, are capped in the guest too.
    expect(parsed.caps["app.zen-browser.zen"]).toBe("read");
    expect(parsed.caps["chromium_chromium"]).toBe("read");
    expect(parsed.caps["wine"]).toBe("off");
    expect(parsed.caps["python3*"]).toBe("off");
  });

  it("is installed root-owned and read through PSYCHE_COMPUTER_USE_SETTINGS", () => {
    const dockerfile = readFileSync(join(FILE, "..", "..", "Dockerfile"), "utf8");
    expect(dockerfile).toMatch(
      /COPY --chown=0:0 --chmod=0644 desktop\/computer-use\.json \/etc\/psyche\/computer-use\.json/,
    );
    expect(dockerfile).toMatch(/PSYCHE_COMPUTER_USE_SETTINGS=\/etc\/psyche\/computer-use\.json/);
  });
});
