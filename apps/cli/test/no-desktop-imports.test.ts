import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * psyched's bundle (`deploy/scripts/build-psyched.mjs` PRUNE) and the server image's deps stage
 * drop `apps/desktop`, so a CLI source file that imports from it breaks `psyche` inside them.
 */
describe("the CLI never imports desktop code", () => {
  const src = join(import.meta.dirname, "../src");
  const files = (readdirSync(src, { recursive: true }) as string[]).filter((f) =>
    f.endsWith(".ts"),
  );

  it.each(files)("%s", (file) => {
    const text = readFileSync(join(src, file), "utf8");
    expect(text).not.toMatch(/from\s+["'][^"']*apps\/desktop\/|from\s+["'](\.\.\/)+desktop\//);
  });
});
