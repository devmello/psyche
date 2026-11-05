import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readConfigFile } from "../src/config.ts";

/**
 * Keys this version does not know are warned about and ignored, never fatal and never removed
 * (updates design §2.7): a rollback after an update must still start on the config the newer
 * version wrote.
 */

const dir = mkdtempSync(join(tmpdir(), "psy-cfg-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;

function write(json: unknown): string {
  const path = join(dir, `config-${++n}.json`);
  writeFileSync(path, JSON.stringify(json));
  return path;
}

describe("unknown config.json keys", () => {
  it("warns for each one, at every level, and keeps reading the keys it knows", () => {
    const warned: string[] = [];
    const cfg = readConfigFile(
      write({
        future: true,
        gateway: { port: 8123, quantum: 1, rateLimits: { fetchPerMinute: 5, burst: 9 } },
        credentials: { onePassword: { kind: "cli", fromTheFuture: 1 }, keychain: {} },
        connectors: { slack: {}, google: { secret: "x" } },
      }),
      (key) => warned.push(key),
    );
    expect(cfg.gateway?.port).toBe(8123);
    expect(cfg.gateway?.rateLimits).toEqual({ fetchPerMinute: 5 });
    expect(cfg.credentials?.onePassword).toEqual({ kind: "cli" });
    expect(warned.sort()).toEqual(
      [
        "connectors.google.secret",
        "connectors.slack",
        "credentials.keychain",
        "credentials.onePassword.fromTheFuture",
        "future",
        "gateway.quantum",
        "gateway.rateLimits.burst",
      ].sort(),
    );
  });

  it("never fails on them and never writes the file", () => {
    const path = write({ gateway: { somethingNew: { nested: [1, 2] } }, other: 1 });
    const before = readFileSync(path, "utf8");
    expect(() => readConfigFile(path, () => undefined)).not.toThrow();
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("still refuses a bad value for a key it knows", () => {
    expect(() => readConfigFile(write({ gateway: { port: "seven" } }), () => undefined)).toThrow(
      /gateway\.port/,
    );
    expect(() =>
      readConfigFile(write({ gateway: { rateLimits: { fetchPerMinute: 0 } } }), () => undefined),
    ).toThrow(/fetchPerMinute/);
  });
});
