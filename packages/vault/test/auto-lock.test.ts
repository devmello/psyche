import { validateParams, validateResult } from "@psyche/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createVaultHandlers } from "../src/index.ts";
import { type Harness, makeHarness } from "./helpers.ts";

let h: Harness;
afterEach(() => h?.cleanup());

const MINUTE = 60_000;

async function rejectsWith(p: Promise<unknown>, code: string): Promise<void> {
  await expect(p).rejects.toMatchObject({ code });
}

describe("vault idle auto-lock (Settings → Credentials)", () => {
  it("reports the default, sets a new value, and keeps it across a restart", async () => {
    h = makeHarness();
    await h.vault.setup();
    expect(h.vault.status().autoLockMinutes).toBe(480);

    const changed = await h.vault.setAutoLock(15);
    expect(changed.autoLockMinutes).toBe(15);
    expect(h.vault.status().autoLockMinutes).toBe(15);

    // A new process with the default option still reads the owner's saved value.
    const reopened = h.reopen();
    expect(reopened.status().autoLockMinutes).toBe(15);
  });

  it("re-arms the running idle timer from now, so the new minutes count", async () => {
    h = makeHarness();
    await h.vault.setup();
    const reasons: string[] = [];
    h.vault.on("vault.locked", (e) => reasons.push(e.reason));

    h.clock.advance(5 * MINUTE);
    await h.vault.setAutoLock(10);
    // Still unlocked 9 minutes after the change, although the old 480-minute timer was armed.
    h.clock.advance(9 * MINUTE);
    expect(h.vault.locked).toBe(false);
    h.clock.advance(MINUTE);
    expect(h.vault.locked).toBe(true);
    expect(reasons).toEqual(["idle"]);
  });

  it("shortens a running timer: the vault locks at the new time, not the old one", async () => {
    h = makeHarness();
    await h.vault.setup();
    await h.vault.setAutoLock(5);
    h.clock.advance(5 * MINUTE);
    expect(h.vault.locked).toBe(true);
  });

  it("'never' cancels the timer: the vault stays unlocked and reports no lock time", async () => {
    h = makeHarness({ overrides: { autoLockMinutes: 10 } });
    await h.vault.setup();
    const status = await h.vault.setAutoLock(null);
    expect(status.autoLockMinutes).toBeNull();
    expect(status.lockAt).toBeNull();
    h.clock.advance(10_000 * MINUTE);
    expect(h.vault.locked).toBe(false);
    // Saved: a restart keeps "never" rather than the constructor's 10 minutes.
    expect(h.reopen().status().autoLockMinutes).toBeNull();
  });

  it("can be set on a locked vault without unlocking it, and stays locked", async () => {
    h = makeHarness();
    await h.vault.setup();
    h.vault.lock("manual");
    const status = await h.vault.setAutoLock(30);
    expect(status.state).toBe("locked");
    expect(status.lockAt).toBeNull();
    expect(status.autoLockMinutes).toBe(30);
  });

  it("refuses values that are not whole minutes from 1 to 7 days, or never", async () => {
    h = makeHarness();
    await h.vault.setup();
    for (const bad of [0, -5, 1.5, 10_081, Number.NaN, Number.POSITIVE_INFINITY]) {
      await rejectsWith(h.vault.setAutoLock(bad), "invalid_params");
    }
    // The bounds themselves are fine.
    expect((await h.vault.setAutoLock(1)).autoLockMinutes).toBe(1);
    expect((await h.vault.setAutoLock(10_080)).autoLockMinutes).toBe(10_080);
    // A refused value changes nothing.
    expect(h.vault.status().autoLockMinutes).toBe(10_080);
  });

  it("refuses to set a value before the vault exists", async () => {
    h = makeHarness();
    await rejectsWith(h.vault.setAutoLock(15), "not_found");
    expect(h.vault.status().state).toBe("uninitialized");
  });
});

describe("vault.setAutoLock handler and protocol schema", () => {
  it("validates params at the protocol and answers a protocol-valid result", async () => {
    h = makeHarness();
    await h.vault.setup();
    const handlers = createVaultHandlers(h.vault);
    const call = async (minutes: unknown) => {
      const params = validateParams("vault.setAutoLock", { minutes });
      const result = await handlers["vault.setAutoLock"](params);
      validateResult("vault.setAutoLock", result);
      return result;
    };
    expect((await call(30)).status.autoLockMinutes).toBe(30);
    expect((await call(null)).status.autoLockMinutes).toBeNull();
    expect(() => validateParams("vault.setAutoLock", { minutes: 0 })).toThrow();
    expect(() => validateParams("vault.setAutoLock", { minutes: 10_081 })).toThrow();
    expect(() => validateParams("vault.setAutoLock", { minutes: "15" })).toThrow();
    expect(() => validateParams("vault.setAutoLock", {})).toThrow();
  });
});
