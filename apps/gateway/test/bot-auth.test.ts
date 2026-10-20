import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authorityOf,
  BOT_AUTH_DIRECTORY_PATH,
  BOT_AUTH_DIRECTORY_TYPE,
  verifyBotAuth,
} from "@psyche/browser";
import { MockDesktop } from "@psyche/browser/testing";
import { setSetting } from "@psyche/db";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  BOT_AUTH_SETTING,
  type ComposedBrowser,
  type ComposedGateway,
  composeBrowser,
  composeGateway,
} from "../src/compose/index.ts";
import { silentLogger } from "../src/log.ts";
import { adminClient, ik, type TestClient } from "./helpers.ts";

/**
 * Web Bot Auth (I14) in the composed Gateway, with the real vault: rotate the key over the
 * protocol, serve the key directory over HTTP, and sign a profile tab's document request so a
 * fixture origin verifies it against that directory. No real browser: the mock desktop.
 */
let home = "";
let composed: ComposedGateway | null = null;
let desktop: MockDesktop | undefined;
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  desktop?.disconnect();
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("Web Bot Auth in the Gateway (I14)", () => {
  it("rotates the vault key, publishes the directory, and signs what the owner asked for", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-wba-"));
    const keyFile = join(home, "vault.key");
    writeFileSync(keyFile, Buffer.alloc(32, 7), { mode: 0o600 });
    let browser: ComposedBrowser | undefined;
    composed = await composeGateway({
      logger: silentLogger,
      retentionIntervalMs: 0,
      background: false,
      config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
      model: { provider: new FakeModelProvider(), model: "fake/model" },
      vault: { keyFile, argon2: { memory: 64, passes: 1, parallelism: 1 } },
      parts: [
        (s) => {
          browser = composeBrowser(s, { socketPath: false });
          return browser;
        },
      ],
    });
    const c = composed;
    await c.vault.setup();
    const owner = await adminClient(c.gateway);
    clients.push(owner);
    const base = `http://127.0.0.1:${c.gateway.port}`;

    // Nothing yet: off, no key, no directory.
    const before = await owner.call<{ status: Record<string, unknown> }>(
      "browser.botAuth.status",
      {},
    );
    expect(before.status).toMatchObject({
      enabled: false,
      keyId: null,
      directoryPath: BOT_AUTH_DIRECTORY_PATH,
    });
    expect((await fetch(`${base}${BOT_AUTH_DIRECTORY_PATH}`)).status).toBe(404);

    const rotated = await owner.call<{ status: { keyId: string; publicJwk: { x: string } } }>(
      "browser.botAuth.rotate",
      {},
      ik(),
    );
    expect(rotated.status.keyId).toMatch(/^[A-Za-z0-9_-]{43}$/);

    desktop = new MockDesktop({ quarantineDir: home });
    const a = desktop.browser.origin("a");
    setSetting(c.db, BOT_AUTH_SETTING, {
      enabled: true,
      signatureAgent: `${base}${BOT_AUTH_DIRECTORY_PATH}`,
      origins: [a],
    });
    const res = await fetch(`${base}${BOT_AUTH_DIRECTORY_PATH}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(BOT_AUTH_DIRECTORY_TYPE);
    const directory = (await res.json()) as { keys: { kty: string; crv: string; x: string }[] };
    expect(directory.keys).toEqual([{ kty: "OKP", crv: "Ed25519", x: rotated.status.publicJwk.x }]);
    const status = await owner.call<{ status: Record<string, unknown> }>(
      "browser.botAuth.status",
      {},
    );
    expect(status.status).toMatchObject({
      enabled: true,
      keyId: rotated.status.keyId,
      origins: [a],
    });

    // A profile tab on a listed origin: the site verifies the signature with the directory.
    const driver = (browser as ComposedBrowser).attach(await desktop.connect());
    const s = await driver.openSession({
      partition: "profile",
      policy: { devPreview: true, readWritable: [a] },
    });
    const url = desktop.browser.url("a/");
    const t = await driver.openTab(s.id, url);
    const sent = desktop.tab(t.id).requestHeaders.get(url) ?? {};
    expect(verifyBotAuth(sent, authorityOf(url), directory)).toMatchObject({
      ok: true,
      keyId: rotated.status.keyId,
    });
    // The private key never appears in what the owner can read.
    expect(JSON.stringify(await owner.call("vault.list", {}).catch(() => ({})))).not.toContain(
      "PRIVATE KEY",
    );
    // Switched off: no directory, no signature.
    setSetting(c.db, BOT_AUTH_SETTING, { enabled: false });
    expect((await fetch(`${base}${BOT_AUTH_DIRECTORY_PATH}`)).status).toBe(404);
    await driver.navigate(t.id, url);
    expect(desktop.tab(t.id).requestHeaders.get(url)?.Signature).toBeUndefined();
    await driver.closeSession(s.id);
  });
});
