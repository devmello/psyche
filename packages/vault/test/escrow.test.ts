import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { KeychainWrapper } from "../src/index.ts";
import { fakeHelper, type Harness, makeHarness } from "./helpers.ts";

/** Escrow: a secret sealed under the vault's key, which a new Mac opens with the recovery key. */

const open: Harness[] = [];
afterEach(() => {
  for (const h of open.splice(0)) h.cleanup();
});

describe("vault escrow", () => {
  it("seals and opens with the same name, and refuses another name", async () => {
    const h = makeHarness();
    open.push(h);
    await h.vault.setup();
    const key = randomBytes(32);
    const box = h.vault.escrow("memory-store", key);
    expect(JSON.stringify(box)).not.toContain(key.toString("hex"));
    expect(h.vault.unescrow("memory-store", box).equals(key)).toBe(true);
    expect(() => h.vault.unescrow("search-index", box)).toThrow();
  });

  it("needs the vault unlocked", async () => {
    const h = makeHarness();
    open.push(h);
    await h.vault.setup();
    const box = h.vault.escrow("memory-store", randomBytes(32));
    h.vault.lock();
    expect(() => h.vault.escrow("memory-store", randomBytes(32))).toThrow(/locked/);
    expect(() => h.vault.unescrow("memory-store", box)).toThrow(/locked/);
  });

  it("on a new Mac (another keychain, same vault files) the recovery key opens it", async () => {
    const h = makeHarness();
    open.push(h);
    const { recoveryKey } = await h.vault.setup();
    const key = randomBytes(32);
    const box = h.vault.escrow("memory-store", key);
    const newMac = h.reopen({
      wrapper: new KeychainWrapper({ helper: fakeHelper().node, account: "new-mac" }),
    });
    await newMac.unlockWithRecovery(recoveryKey);
    expect(newMac.unescrow("memory-store", box).equals(key)).toBe(true);
  });
});
