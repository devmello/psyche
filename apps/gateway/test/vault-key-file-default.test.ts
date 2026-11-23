import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "@psyche/db";
import { FakePermissionBroker } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { composeVault } from "../src/compose/vault.ts";

/**
 * The key-file default (psyched on Linux with no `PSYCHE_VAULT_KEY_FILE`): the vault key slot is
 * `$PSYCHE_HOME/secrets/vault.key`, created on first use. macOS keeps the keychain slot.
 */

const TEST_ARGON2 = { memory: 64, passes: 1, parallelism: 1 };
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function compose(home: string, platform: NodeJS.Platform) {
  const db = openDb(join(home, "psyche.db"));
  const vault = composeVault(
    {
      home,
      db,
      permissions: new FakePermissionBroker(),
      audit: { append: async () => undefined } as never,
      clock: { now: () => Date.now() },
      publish: () => undefined,
    },
    { argon2: TEST_ARGON2, platform },
  );
  cleanups.push(() => {
    vault.stop();
    db.close();
  });
  return vault;
}

function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), "psyche-vault-keyfile-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

describe("vault key-file default on Linux", () => {
  it("creates secrets/vault.key on an empty home, 0600 in a 0700 folder, and uses the key_file slot", async () => {
    const home = freshHome();
    const vault = compose(home, "linux");

    expect(vault.slot).toBe("key_file");
    expect(await vault.wrapper.unavailableReason()).toBeNull();

    const keyFile = join(home, "secrets", "vault.key");
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, "secrets")).mode & 0o777).toBe(0o700);
    expect(readFileSync(keyFile).length).toBe(32);

    // The vault can be created end to end with that slot, and the key is then reused.
    await vault.vault.setup();
    const slots = JSON.parse(readFileSync(join(home, "vault", "slots.json"), "utf8")) as {
      slots: Record<string, unknown>;
    };
    expect(Object.keys(slots.slots)).toEqual(["key_file"]);
    const before = readFileSync(keyFile);
    vault.vault.lock("manual");
    const again = compose(home, "linux");
    expect(again.slot).toBe("key_file");
    expect(readFileSync(keyFile).equals(before)).toBe(true);
  });

  it("never switches a vault that uses another slot: nothing is written and the reason says why", async () => {
    const home = freshHome();
    mkdirSync(join(home, "vault"), { recursive: true });
    writeFileSync(
      join(home, "vault", "slots.json"),
      JSON.stringify({
        version: 1,
        vaultId: "v",
        recoveryConfirmed: true,
        slots: { keychain: {} },
      }),
    );

    const vault = compose(home, "linux");
    expect(vault.slot).toBe("key_file");
    const reason = await vault.wrapper.unavailableReason();
    expect(reason).toContain("the vault uses the keychain slot");
    expect(reason).toContain("does not switch an existing vault to a key file");
    expect(reason).not.toContain("keychain.set");
    expect(existsSync(join(home, "secrets", "vault.key"))).toBe(false);
    await expect(vault.wrapper.unwrap({}, { reason: "test" })).rejects.toMatchObject({
      code: "unavailable",
    });
  });

  it("keeps an existing key file that the key_file slot already uses", async () => {
    const home = freshHome();
    const keyFile = join(home, "secrets", "vault.key");
    mkdirSync(join(home, "secrets"), { recursive: true, mode: 0o700 });
    const key = Buffer.alloc(32, 7);
    writeFileSync(keyFile, key, { mode: 0o600 });
    mkdirSync(join(home, "vault"), { recursive: true });
    writeFileSync(
      join(home, "vault", "slots.json"),
      JSON.stringify({
        version: 1,
        vaultId: "v",
        recoveryConfirmed: true,
        slots: { key_file: {} },
      }),
    );

    const vault = compose(home, "linux");
    expect(vault.slot).toBe("key_file");
    expect(await vault.wrapper.unavailableReason()).toBeNull();
    expect(readFileSync(keyFile).equals(key)).toBe(true);
  });

  it("keeps the keychain slot on darwin and creates no key file", async () => {
    const home = freshHome();
    const vault = compose(home, "darwin");

    expect(vault.slot).toBe("keychain");
    expect(existsSync(join(home, "secrets"))).toBe(false);
  });
});
