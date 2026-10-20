import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "../src/report.ts";

/**
 * The Milestone 2 scenario files are S18's format: the same validator that gates tests/scenarios
 * in CI checks them (schema, ids, fixtures, attachment hashes, calendar offsets, kill points,
 * secret patterns).
 */
describe("Milestone 2 scenario files", () => {
  it("pass tests/scenarios/validate.mjs", () => {
    const out = execFileSync(
      process.execPath,
      [
        join(ROOT, "tests/scenarios/validate.mjs"),
        "--dir",
        join(ROOT, "tests/acceptance/scenarios-m2"),
      ],
      { encoding: "utf8" },
    );
    expect(out.trim().split("\n").at(-1)).toBe("ok");
    for (const id of [
      "v5-permission-slip",
      "v6-messages-voice-note",
      "v8-subscription-audit",
      "v9-weekly-review",
    ])
      expect(out).toContain(id);
  });
});
