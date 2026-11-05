import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { LaunchdSupervisor } from "../../src/main/supervisor.ts";

/** The start-up screen's Retry after an update failure (review round 2). */

const dir = mkdtempSync(join(tmpdir(), "psy-sup-restore-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("retryAfterUpdateFailure", () => {
  const make = () => {
    const home = mkdtempSync(join(dir, "home-"));
    mkdirSync(join(home, "run"));
    writeFileSync(join(home, "run", "update-failed.json"), "{}");
    writeFileSync(join(home, "run", "restore-in-progress.json"), "{}");
    const sup = new LaunchdSupervisor({
      mode: "launchd",
      psycheHome: home,
      healthUrl: "http://127.0.0.1:1/healthz",
    });
    return { home, sup };
  };

  it("forgets the failure but keeps an unfinished restore for the Gateway to finish", () => {
    const { home, sup } = make();
    expect(sup.retryAfterUpdateFailure()).toBe(true);
    expect(existsSync(join(home, "run", "update-failed.json"))).toBe(false);
    expect(existsSync(join(home, "run", "restore-in-progress.json"))).toBe(true);
  });

  it("forgets the restore too only when the owner says they restored it themselves", () => {
    const { home, sup } = make();
    sup.retryAfterUpdateFailure({ restoredByHand: true });
    expect(existsSync(join(home, "run", "restore-in-progress.json"))).toBe(false);
  });
});
