import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { configWarnings, editDistance, readConfigFile } from "../src/config.ts";

/**
 * A typo in a security section must not fail open (updates design §2.7, review M1): unknown keys
 * there stay fatal, and so does a key that is a couple of edits from a known one. Only a file
 * from a newer version (`configVersion`) may carry keys this build does not know.
 */

const dir = mkdtempSync(join(tmpdir(), "psy-strict-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const read = (json: unknown, warned: string[] = []) => {
  const path = join(dir, `c${++n}.json`);
  writeFileSync(path, JSON.stringify(json));
  return readConfigFile(path, (k) => warned.push(k));
};

describe("security sections stay strict", () => {
  it("refuses a misspelt allowedLogins instead of reading it as any login", () => {
    expect(() =>
      read({
        gateway: {
          trustedProxy: {
            enabled: true,
            trustedProxies: ["10.0.0.0/8"],
            allowedLogin: ["me@x.com"],
          },
        },
      }),
    ).toThrow(/allowedLogin.*allowedLogins/);
  });

  it("refuses any unknown key under trustedProxy and cloudflareAccess, even a far one", () => {
    expect(() => read({ gateway: { trustedProxy: { somethingNew: 1 } } })).toThrow(
      /gateway\.trustedProxy\.somethingNew/,
    );
    expect(() =>
      read({
        gateway: {
          cloudflareAccess: { teamDomain: "t.cloudflareaccess.com", audience: "a", extra: 1 },
        },
      }),
    ).toThrow(/gateway\.cloudflareAccess\.extra/);
    expect(() =>
      read({ gateway: { cloudflareAccess: { teamDomian: "x", audience: "a" } } }),
    ).toThrow(/teamDomian/);
  });

  it("refuses a gateway key that is a typo of a known one", () => {
    expect(() => read({ gateway: { hots: "127.0.0.1" } })).toThrow(/did you mean "host"/);
    expect(() => read({ gateway: { trustedProxie: { enabled: true } } })).toThrow(/trustedProxy/);
    expect(() => read({ gateway: { allowedOrigin: ["https://x"] } })).toThrow(/allowedOrigins/);
    expect(() => read({ gatway: { port: 1 } })).toThrow(/did you mean "gateway"/);
    expect(() => read({ credentials: { onePasswrd: {} } })).toThrow(/onePassword/);
  });

  it("still validates the nested values", () => {
    expect(() => read({ gateway: { trustedProxy: { allowedLogins: "me@x.com" } } })).toThrow(
      /allowedLogins/,
    );
    expect(
      read({ gateway: { trustedProxy: { allowedLogins: ["me@x.com"] } } }).gateway?.trustedProxy,
    ).toEqual({ allowedLogins: ["me@x.com"] });
  });
});

describe("keys from elsewhere", () => {
  it("only warn when they are far from every known key", () => {
    const warned: string[] = [];
    const cfg = read({ gateway: { port: 8123, quantumFlux: 1 }, brandNew: { a: 1 } }, warned);
    expect(cfg.gateway?.port).toBe(8123);
    expect(warned.sort()).toEqual(["brandNew", "gateway.quantumFlux"]);
  });

  it("are tolerated, even in security sections, from a newer configVersion", () => {
    const warned: string[] = [];
    const cfg = read(
      {
        configVersion: 2,
        gateway: { port: 8123, hots: "x", trustedProxy: { enabled: false, allowedLogin: ["x"] } },
      },
      warned,
    );
    expect(cfg.gateway?.port).toBe(8123);
    expect(warned.sort()).toEqual(["gateway.hots", "gateway.trustedProxy.allowedLogin"]);
  });

  it("insists on a sane configVersion, and the same file at the current one is strict", () => {
    expect(() => read({ configVersion: "2" })).toThrow(/configVersion/);
    expect(() => read({ configVersion: 1, gateway: { hots: "x" } })).toThrow(/host/);
  });

  it("are listed for gateway.info and the UI", () => {
    const path = join(dir, "default-warn.json");
    writeFileSync(path, JSON.stringify({ gateway: { quantumFluxCapacitor: 1 } }));
    readConfigFile(path);
    expect(configWarnings()).toContain("gateway.quantumFluxCapacitor");
  });
});

describe("editDistance", () => {
  it("counts edits, ignoring case", () => {
    expect(editDistance("host", "host")).toBe(0);
    expect(editDistance("Host", "host")).toBe(0);
    expect(editDistance("hots", "host")).toBe(2);
    expect(editDistance("allowedLogin", "allowedLogins")).toBe(1);
    expect(editDistance("", "abc")).toBe(3);
  });
});
