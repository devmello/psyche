import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Runs deploy/scripts/upgrade-roundtrip.mjs (real psyched and psyche processes on fresh
 * $PSYCHE_HOMEs): migrate --check, online backup, restore, migrate --check, boot from the restore.
 */
const SCRIPT = resolve(import.meta.dirname, "../../../deploy/scripts/upgrade-roundtrip.mjs");

describe("upgrade and backup round trip (scripted)", () => {
  it("passes every step", () => {
    const r = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8", timeout: 170_000 });
    expect(r.stdout, r.stderr).toContain("upgrade round trip: all steps passed");
    expect(r.stdout).not.toContain("FAIL");
    expect(r.status).toBe(0);
  }, 180_000);
});
