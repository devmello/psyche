import { randomBytes } from "node:crypto";
import { chmodSync, cpSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  KEYCHAIN_ACCESS_CONTROL,
  KeychainWrapper,
  KeyFileWrapper,
  SafeStorageWrapper,
  VaultStore,
} from "../src/index.ts";
import { fakeHelper, fakeSafeStorage, type Harness, makeHarness, tmpHome } from "./helpers.ts";

const PW = "correct-horse-battery-staple-91";
let h: Harness;
afterEach(() => h?.cleanup());

async function seeded(): Promise<{ recoveryKey: string }> {
  const { recoveryKey } = await h.vault.setup();
  await h.vault.add({
    kind: "login",
    name: "GitHub",
    bindings: [{ origin: "https://github.com" }],
    secret: { username: "pat", password: PW },
  });
  return { recoveryKey };
}

describe("vault create / unlock / lock (G1)", () => {
  it("creates private files and shows the recovery key once as grouped base32", async () => {
    h = makeHarness();
    expect(h.vault.status().state).toBe("uninitialized");
    const { recoveryKey, status } = await h.vault.setup();
    expect(recoveryKey).toMatch(/^([A-Z2-7]{4}-){12}[A-Z2-7]{4}$/);
    expect(status).toMatchObject({
      state: "unlocked",
      slots: ["keychain", "recovery"],
      recoveryConfirmed: false,
    });
    for (const f of ["vault.db", "slots.json", "recovery.slot"]) {
      expect(statSync(join(h.home, "vault", f)).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(h.home, "vault", f)).toString("latin1")).not.toContain(recoveryKey);
    }
    expect(statSync(join(h.home, "vault")).mode & 0o777).toBe(0o700);
    await expect(h.vault.setup()).rejects.toMatchObject({ code: "conflict" });
  });

  it("stores the key item with biometry-OR-passcode access control", async () => {
    h = makeHarness();
    await h.vault.setup();
    expect(h.helper.sets).toEqual([
      expect.objectContaining({
        accessControl: ["biometryCurrentSet", "or", "devicePasscode"],
        accessible: "whenPasscodeSetThisDeviceOnly",
        synchronizable: false,
        dataProtection: true,
      }),
    ]);
    expect(KEYCHAIN_ACCESS_CONTROL).toContain("or");
  });

  it("locks, emits events, and unlocks through Touch ID", async () => {
    h = makeHarness();
    await seeded();
    const events: string[] = [];
    h.vault.on("vault.locked", (e) => events.push(`locked:${e.reason}`));
    h.vault.on("vault.unlocked", (e) => events.push(`unlocked:${e.via}`));
    expect(h.vault.lock().state).toBe("locked");
    expect((await h.vault.list()).map((c) => c.slug)).toEqual(["github"]); // metadata while locked
    await expect(
      h.vault.add({ kind: "note", name: "n", bindings: [], secret: { text: "x" } }),
    ).rejects.toMatchObject({
      code: "unavailable",
    });
    expect((await h.vault.unlock("Open the vault")).state).toBe("unlocked");
    expect(h.helper.prompts).toEqual(["Open the vault"]);
    expect(events).toEqual(["locked:manual", "unlocked:keychain"]);
    expect((await h.audit.list()).map((e) => e.kind)).toContain("vault.unlocked");
  });

  it("refuses to unlock when Touch ID is cancelled", async () => {
    h = makeHarness();
    await seeded();
    h.vault.lock();
    h.helper.state.touchId = "cancel";
    await expect(h.vault.unlock("x")).rejects.toMatchObject({ code: "unauthorized" });
    expect(h.vault.locked).toBe(true);
  });

  it("locks after the idle timeout", async () => {
    h = makeHarness({ overrides: { autoLockMinutes: 10 } });
    await seeded();
    const reasons: string[] = [];
    h.vault.on("vault.locked", (e) => reasons.push(e.reason));
    h.clock.advance(9 * 60_000);
    expect(h.vault.locked).toBe(false);
    await h.vault.list();
    h.clock.advance(60_000);
    expect(h.vault.locked).toBe(true);
    expect(reasons).toEqual(["idle"]);
  });

  it("survives a restart: a new process starts locked and unlocks", async () => {
    h = makeHarness();
    await seeded();
    h.vault.lock();
    const again = h.reopen();
    expect(again.status().state).toBe("locked");
    await again.unlock("restart");
    expect((await again.list()).length).toBe(1);
    again.lock();
  });

  it("a copied vault.db is useless without the keychain item or the recovery key", async () => {
    h = makeHarness();
    await seeded();
    h.vault.lock();
    const raw = readFileSync(join(h.home, "vault", "vault.db"));
    expect(raw.includes(Buffer.from(PW))).toBe(false);
    expect(raw.subarray(0, 15).toString("latin1")).not.toBe("SQLite format 3");
    expect(() => VaultStore.open(join(h.home, "vault", "vault.db"), randomBytes(32))).toThrow(
      expect.objectContaining({ code: "unauthorized" }),
    );
    // Another machine: same files, a helper without the keychain item.
    const other = tmpHome();
    cpSync(join(h.home, "vault"), join(other.home, "vault"), { recursive: true });
    const stranger = makeHarness({
      home: other.home,
      wrapper: new KeychainWrapper({ helper: fakeHelper().node, account: "test" }),
    });
    await expect(stranger.vault.unlock("steal")).rejects.toMatchObject({ code: "unauthorized" });
    stranger.cleanup();
    other.cleanup();
  });

  it("recovers after biometric re-enrollment and re-wraps the key", async () => {
    h = makeHarness();
    const { recoveryKey } = await seeded();
    h.vault.lock();
    h.helper.items.clear(); // biometryCurrentSet items are invalidated by re-enrollment
    await expect(h.vault.unlock("x")).rejects.toBeDefined();
    // Mutate the first character: the last one also carries base32 padding bits.
    const wrong = `${recoveryKey.startsWith("A") ? "B" : "A"}${recoveryKey.slice(1)}`;
    await expect(h.vault.unlockWithRecovery(wrong)).rejects.toMatchObject({ code: "unauthorized" });
    await h.vault.unlockWithRecovery(recoveryKey.toLowerCase().replace(/-/g, " "));
    expect((await h.vault.list()).length).toBe(1);
    expect(h.helper.sets).toHaveLength(2);
    h.vault.lock();
    await h.vault.unlock("after recovery");
    expect(h.vault.locked).toBe(false);
  });

  it("completes setup only when the recovery key's last group is typed back", async () => {
    h = makeHarness();
    const { recoveryKey } = await h.vault.setup();
    await expect(h.vault.confirmRecovery("AAAA")).rejects.toMatchObject({ code: "invalid_params" });
    const last = recoveryKey.split("-").at(-1) ?? "";
    expect((await h.vault.confirmRecovery(last.toLowerCase())).recoveryConfirmed).toBe(true);
    expect(readFileSync(join(h.home, "vault", "slots.json"), "utf8")).not.toContain(
      "recoveryCheck",
    );
  });
});

describe("key wrappers", () => {
  it("safeStorage round trip, refused on basic_text", async () => {
    const adapter = fakeSafeStorage();
    h = makeHarness({ wrapper: new SafeStorageWrapper(adapter) });
    await seeded();
    h.vault.lock();
    await h.vault.unlock("ss");
    expect(h.vault.status().slots).toEqual(["safe_storage", "recovery"]);
    h.vault.lock();
    adapter.backendName = "basic_text";
    await expect(h.vault.unlock("ss")).rejects.toMatchObject({ code: "unavailable" });
    const fresh = makeHarness({ wrapper: new SafeStorageWrapper(fakeSafeStorage("basic_text")) });
    await expect(fresh.vault.setup()).rejects.toMatchObject({ code: "unavailable" });
    fresh.cleanup();
  });

  it("keychain wrapper needs the helper's capabilities", async () => {
    const helper = fakeHelper();
    const w = new KeychainWrapper({ helper: helper.node, account: "a" });
    expect(await w.unavailableReason()).toBeNull();
    const dek = randomBytes(32);
    const wrapped = await w.wrap(dek);
    expect(JSON.stringify(wrapped)).not.toContain(dek.toString("base64"));
    expect((await w.unwrap(wrapped, { reason: "r" })).equals(dek)).toBe(true);
    await w.destroy(wrapped);
    await expect(w.unwrap(wrapped, { reason: "r" })).rejects.toBeDefined();
  });

  it("key file must be 0600", async () => {
    const tmp = tmpHome();
    const path = join(tmp.home, "vault.key");
    writeFileSync(path, randomBytes(32).toString("hex"), { mode: 0o644 });
    chmodSync(path, 0o644);
    const w = new KeyFileWrapper(path);
    expect(await w.unavailableReason()).toMatch(/0600/);
    chmodSync(path, 0o600);
    expect(await w.unavailableReason()).toBeNull();
    const dek = randomBytes(32);
    expect((await w.unwrap(await w.wrap(dek))).equals(dek)).toBe(true);
    tmp.cleanup();
  });
});
