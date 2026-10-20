import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeModelProvider } from "@psyche/testing";
import type { OnePasswordSource } from "@psyche/vault";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { opOnPath } from "../src/compose/vault.ts";
import { readConfigFile } from "../src/config.ts";
import { silentLogger } from "../src/log.ts";

/** G10: the Gateway hands the vault its 1Password source (`credentials.onePassword`). */

let home = "";
let composed: ComposedGateway | null = null;
afterEach(async () => {
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

async function gateway(onePassword?: OnePasswordSource) {
  home = mkdtempSync(join(tmpdir(), "psyche-op-"));
  return gatewayIn(home, onePassword);
}

async function gatewayIn(dir: string, onePassword?: OnePasswordSource) {
  const keyFile = join(dir, "vault.key");
  writeFileSync(keyFile, Buffer.alloc(32, 3), { mode: 0o600 });
  composed = await composeGateway({
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    config: { home: dir, port: 0, dbPath: join(dir, "psyche.db"), webRoot: null },
    model: { provider: new FakeModelProvider(), model: "fake/model" },
    vault: {
      keyFile,
      argon2: { memory: 64, passes: 1, parallelism: 1 },
      ...(onePassword === undefined ? {} : { onePassword }),
    },
  });
  await composed.vault.setup();
  return composed;
}

const link = {
  kind: "login" as const,
  name: "Shop",
  bindings: [{ origin: "https://shop.example.com" }],
  ref: { vault: "Personal", item: "Shop" },
};

describe("1Password in the composition (G10)", () => {
  it("links items through the composed source, read-only, and audits the source", async () => {
    const reads: string[] = [];
    const fake: OnePasswordSource = {
      kind: "cli",
      unavailableReason: async () => null,
      readField: async (ref, field) => {
        reads.push(`${ref.vault}/${ref.item}/${field}`);
        return "s3cret";
      },
    };
    const c = await gateway(fake);
    const meta = await c.vault.linkOnePassword(link);
    expect(meta).toMatchObject({ name: "Shop", kind: "login" });
    // Linking stores a reference only: nothing is read until a fill is approved.
    expect(reads).toEqual([]);
    const audit = await c.audit.query({ kind: "vault.external_source" });
    expect(audit.map((e) => e.data)).toEqual([
      { source: "1password", kind: "cli", available: true },
    ]);
  });

  it("answers unavailable without a configured source", async () => {
    const c = await gateway();
    await expect(c.vault.linkOnePassword(link)).rejects.toMatchObject({ code: "unavailable" });
  });

  it("builds a Connect source from config.json, with no token in the config", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-op-"));
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        credentials: { onePassword: { kind: "connect", url: "https://op.example.test" } },
      }),
    );
    const c = await gatewayIn(home);
    await expect(c.vault.linkOnePassword(link)).resolves.toMatchObject({ name: "Shop" });
    const audit = await c.audit.query({ kind: "vault.external_source" });
    expect(audit.map((e) => e.data)).toEqual([
      { source: "1password", kind: "connect", available: true },
    ]);
    // A token in config.json is refused: it belongs in the vault.
    writeFileSync(
      join(home, "bad.json"),
      JSON.stringify({ credentials: { onePassword: { kind: "cli", token: "ops_x" } } }),
    );
    expect(() => readConfigFile(join(home, "bad.json"))).toThrow(/token lives in the vault/);
  });

  it("finds an executable op on PATH as an absolute path", () => {
    home = mkdtempSync(join(tmpdir(), "psyche-op-"));
    const bin = join(home, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "op"), "#!/bin/sh\n");
    chmodSync(join(bin, "op"), 0o755);
    expect(opOnPath(`relative/dir:${bin}`)).toBe(join(bin, "op"));
    expect(opOnPath("/nonexistent")).toBeUndefined();
  });
});
