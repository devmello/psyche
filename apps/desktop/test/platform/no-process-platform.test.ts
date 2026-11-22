import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The platform module (`src/platform/index.ts`) is the one place that answers "which OS is
 * this?". A new `process.platform` read anywhere else in the desktop app's source fails here: ask
 * the platform module a question instead (`traitsFor`, `isLinux`, `hostPlatform`), or take the
 * platform as an argument with `hostPlatform()` as its default.
 *
 * The baseline is every file that read it when this rule was added (the macOS and Windows code
 * from before, text matches counted, comments included). It may shrink, never grow: lower a count
 * when a read goes away, and do not add a file.
 */
const BASELINE: Record<string, number> = {
  "gateway-client.ts": 1,
  "main.ts": 14,
  "main/screen-ask/settings.ts": 2,
  "main/window-options.ts": 4,
  "main/dictation/controller.ts": 2,
  "main/dictation/service.ts": 4,
  "main/browser/partitions.ts": 1,
  "main/menu.ts": 2,
  "main/squirrel-events.ts": 1,
  "main/supervisor-base.ts": 3,
  "main/bridge/bridge-client.ts": 1,
  "main/supervisor.ts": 1,
  "main/helper-launcher.ts": 2,
  "main/updater.ts": 3,
  "main/shortcuts.ts": 2,
  "lib/app-info.ts": 1,
  "lib/source-open.ts": 1,
  "preload.ts": 3,
};

const src = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });
}

describe("process.platform reads outside src/platform/", () => {
  const counts = new Map<string, number>();
  for (const file of sources(src)) {
    const rel = relative(src, file).split(sep).join("/");
    if (rel.startsWith("platform/")) continue;
    const n = readFileSync(file, "utf8").match(/process\.platform/g)?.length ?? 0;
    if (n > 0) counts.set(rel, n);
  }

  it("has no file that is not in the baseline", () => {
    const extra = [...counts.keys()].filter((f) => !(f in BASELINE));
    expect(extra, "new process.platform reads: use src/platform instead").toEqual([]);
  });

  it("has no file with more reads than the baseline", () => {
    const grown = [...counts].filter(([f, n]) => n > (BASELINE[f] ?? 0)).map(([f]) => f);
    expect(grown).toEqual([]);
  });

  it("the baseline lists no file that stopped reading it (lower it)", () => {
    const stale = Object.keys(BASELINE).filter((f) => !counts.has(f));
    expect(stale).toEqual([]);
  });

  it("the platform module itself reads it exactly once, in hostPlatform()", () => {
    const text = readFileSync(join(src, "platform", "index.ts"), "utf8");
    expect(text.match(/process\.platform;/g)?.length).toBe(1);
  });
});
