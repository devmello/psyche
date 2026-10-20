import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeModelProvider } from "@psyche/testing";
import type { BitwardenSource } from "@psyche/vault";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { BITWARDEN_CONNECTOR, binaryOnPath, bitwardenSource } from "../src/compose/vault.ts";
import { readConfigFile } from "../src/config.ts";
import { silentLogger } from "../src/log.ts";

/** G11: the Gateway hands the vault its Bitwarden source (`credentials.bitwarden`). */

const SESSION = "bw_fake_session_key_Z2F0ZXdheS10ZXN0";
const PW = "bitwarden-gateway-pw-58";

let home = "";
let composed: ComposedGateway | null = null;
afterEach(async () => {
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

/** A fake `bw` that answers `get password Shop` only for the right session (from its data dir). */
function fakeBw(dir: string): { bin: string; data: string } {
  const data = join(dir, "bw-data");
  mkdirSync(data);
  writeFileSync(join(data, "session"), SESSION);
  const bin = join(dir, "bw");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const session = fs.readFileSync(process.env.BITWARDENCLI_APPDATA_DIR + "/session", "utf8");
if (process.env.BW_SESSION !== session) { process.stderr.write("Vault is locked."); process.exit(1); }
const [cmd, what, ref] = process.argv.slice(2);
if (cmd === "get" && what === "password" && ref === "Shop") { process.stdout.write(${JSON.stringify(PW)}); process.exit(0); }
process.stderr.write("Not found."); process.exit(1);
`,
  );
  chmodSync(bin, 0o755);
  return { bin, data };
}

async function gatewayIn(dir: string, bitwarden?: BitwardenSource) {
  const keyFile = join(dir, "vault.key");
  writeFileSync(keyFile, Buffer.alloc(32, 5), { mode: 0o600 });
  composed = await composeGateway({
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    config: { home: dir, port: 0, dbPath: join(dir, "psyche.db"), webRoot: null },
    model: { provider: new FakeModelProvider(), model: "fake/model" },
    vault: {
      keyFile,
      argon2: { memory: 64, passes: 1, parallelism: 1 },
      ...(bitwarden === undefined ? {} : { bitwarden }),
    },
  });
  await composed.vault.setup();
  return composed;
}

const link = {
  kind: "login" as const,
  name: "Shop",
  bindings: [{ origin: "https://shop.example.com" }],
  ref: { item: "Shop" },
};

describe("Bitwarden in the composition (G11)", () => {
  it("builds the CLI source from config.json and audits it, with no session in the config", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-bw-"));
    const { bin, data } = fakeBw(home);
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ credentials: { bitwarden: { bw: bin, appDataDir: data } } }),
    );
    const c = await gatewayIn(home);
    await expect(c.vault.linkBitwarden(link)).resolves.toMatchObject({
      name: "Shop",
      backend: "bitwarden",
    });
    const audit = await c.audit.query({ kind: "vault.external_source" });
    expect(audit.map((e) => e.data)).toEqual([
      { source: "bitwarden", kind: "cli", available: true },
    ]);
    // A session key in config.json is refused: it belongs in the vault. Paths must be absolute.
    writeFileSync(
      join(home, "bad.json"),
      JSON.stringify({ credentials: { bitwarden: { session: "x" } } }),
    );
    expect(() => readConfigFile(join(home, "bad.json"))).toThrow(/session key lives in the vault/);
    writeFileSync(
      join(home, "rel.json"),
      JSON.stringify({ credentials: { bitwarden: { bw: "bin/bw" } } }),
    );
    expect(() => readConfigFile(join(home, "rel.json"))).toThrow(/absolute path/);
  });

  it("reads the session key from the vault's bitwarden item, per call", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-bw-"));
    const { bin, data } = fakeBw(home);
    const c = await gatewayIn(home);
    const { source } = bitwardenSource({ bw: bin, appDataDir: data }, () => c.vault);
    if (source === undefined) throw new Error("no source");
    await expect(source.readField({ item: "Shop" }, "password")).rejects.toMatchObject({
      code: "unavailable",
      details: { reason: "bw_session_missing" },
    });
    await c.vault.store({
      connectorId: BITWARDEN_CONNECTOR,
      slug: "bitwarden-session",
      name: "Bitwarden session",
      bindings: [{ connector: BITWARDEN_CONNECTOR }],
      tokens: { accessToken: SESSION },
    });
    await expect(source.readField({ item: "Shop" }, "password")).resolves.toBe(PW);
    expect(process.env.BW_SESSION).toBeUndefined();
  });

  it("answers unavailable without a configured source", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-bw-"));
    const c = await gatewayIn(home);
    await expect(c.vault.linkBitwarden(link)).rejects.toMatchObject({ code: "unavailable" });
  });

  it("finds an executable bw on PATH as an absolute path", () => {
    home = mkdtempSync(join(tmpdir(), "psyche-bw-"));
    const bin = join(home, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "bw"), "#!/bin/sh\n");
    chmodSync(join(bin, "bw"), 0o755);
    expect(binaryOnPath("bw", `relative/dir:${bin}`)).toBe(join(bin, "bw"));
    expect(binaryOnPath("bw", "/nonexistent")).toBeUndefined();
  });
});
