import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodePairingLink, SETUP_TOKEN_TTL_MS } from "@psyche/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { desktopConnectParams } from "../src/gateway-client.ts";
import { generateDeviceKey } from "../src/lib/device-key.ts";
import {
  cleanGatewayName,
  EMPTY_GATEWAYS,
  gatewayDataDir,
  gatewaysFilePath,
  identityKeyFingerprint,
  loadGateways,
  loadGatewaysStrict,
  normalizeGatewayOrigin,
  saveGateways,
} from "../src/lib/gateways.ts";
import {
  type GatewayConfirm,
  GatewayManager,
  type GatewayManagerDeps,
} from "../src/main/gateway-manager.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "psyche-pairlink-"));
  dirs.push(d);
  return d;
}

const KEY_A = Buffer.alloc(32, 1).toString("base64url");
const KEY_B = Buffer.alloc(32, 2).toString("base64url");
const TOKEN = Buffer.alloc(32, 7).toString("base64url");
const URL_A = "https://studio-mac.tail1234.ts.net";

function link(over: Partial<Parameters<typeof encodePairingLink>[0]> = {}): string {
  return encodePairingLink({
    gatewayUrl: URL_A,
    gatewayIdentityKey: KEY_A,
    setupToken: TOKEN,
    hostName: "Studio Mac",
    ...over,
  });
}

function setup(opts: { confirm?: boolean } = {}) {
  const userData = tempDir();
  const confirms: GatewayConfirm[] = [];
  let clock = new Date("2026-11-04T12:00:00Z");
  const make = (target: GatewayManagerDeps["target"]) =>
    new GatewayManager({
      userData,
      target,
      confirm: async (c) => {
        confirms.push(c);
        return opts.confirm ?? true;
      },
      relaunch: () => undefined,
      now: () => clock,
    });
  const local = make({
    id: "this-mac",
    name: "This Mac",
    origin: "http://127.0.0.1:7979",
    remote: false,
    dataDir: null,
  });
  const remoteFor = (id: string) =>
    make({ id, name: "x", origin: URL_A, remote: true, dataDir: gatewayDataDir(userData, id) });
  return {
    userData,
    file: gatewaysFilePath(userData),
    confirms,
    local,
    remoteFor,
    now: () => clock,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
  };
}

describe("Add a Gateway from a pairing link", () => {
  it("accepts a valid link: address, name and identity key come from it, nothing is typed", async () => {
    const s = setup();
    const view = await s.local.add(link());
    expect(view).toMatchObject({ name: "Studio Mac", origin: URL_A, pinned: true });
    // The native dialog names the address and the key fingerprint the link pins.
    expect(s.confirms).toEqual([
      {
        kind: "add",
        origin: URL_A,
        name: "Studio Mac",
        viaLink: { fingerprint: identityKeyFingerprint(KEY_A) },
      },
    ]);
    const saved = loadGateways(s.file, s.now()).gateways[0];
    expect(saved).toMatchObject({ origin: URL_A, identityKey: KEY_A, setupToken: TOKEN });
  });

  it("refuses a bad link, and asks nothing", async () => {
    const s = setup();
    for (const bad of [
      "psyche-pair:v1:abc",
      "psyche-pair:v1:",
      `psyche-pair:v1:${Buffer.from(JSON.stringify({ gatewayUrl: "http://evil.example" })).toString("base64url")}`,
    ]) {
      await expect(s.local.add(bad)).rejects.toMatchObject({
        code: "invalid_params",
        details: { problem: "bad_link" },
      });
    }
    expect(s.confirms).toEqual([]);
    expect(loadGateways(s.file)).toEqual(EMPTY_GATEWAYS);
  });

  it("never turns a link into an address: the typed-address rules still refuse one", () => {
    expect(() => normalizeGatewayOrigin(link())).toThrow();
  });

  it("saves nothing when the owner cancels", async () => {
    const s = setup({ confirm: false });
    await expect(s.local.add(link())).rejects.toMatchObject({ code: "forbidden" });
    expect(loadGateways(s.file, s.now()).gateways).toEqual([]);
  });

  it("refuses a link whose key differs from the one already pinned for that address", async () => {
    const s = setup();
    await s.local.add(link());
    await expect(s.local.add(link({ gatewayIdentityKey: KEY_B }))).rejects.toMatchObject({
      code: "invalid_params",
      details: { problem: "pin_mismatch" },
    });
    expect(loadGateways(s.file, s.now()).gateways[0]?.identityKey).toBe(KEY_A);
  });

  it("updates the token (and pins) for an address that was saved without a link", async () => {
    const s = setup();
    await s.local.add("studio-mac.tail1234.ts.net");
    expect(loadGateways(s.file, s.now()).gateways[0]?.identityKey).toBeUndefined();
    await s.local.add(link());
    const saved = loadGateways(s.file, s.now()).gateways;
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ identityKey: KEY_A, setupToken: TOKEN });
  });
});

describe("the setup token on the first connect", () => {
  async function added() {
    const s = setup();
    await s.local.add(link());
    const id = loadGateways(s.file, s.now()).gateways[0]?.id as string;
    return { s, id, remote: s.remoteFor(id) };
  }

  it("is offered for the active saved Gateway until the connect is answered, then forgotten", async () => {
    const { s, remote } = await added();
    expect(remote.setupToken()).toBe(TOKEN);
    remote.clearSetupToken();
    expect(remote.setupToken()).toBeUndefined();
    const saved = loadGateways(s.file, s.now()).gateways[0];
    expect(saved?.setupToken).toBeUndefined();
    // The pin from the link stays.
    expect(saved?.identityKey).toBe(KEY_A);
  });

  it("is not offered after its ten minutes", async () => {
    const { s, remote } = await added();
    s.advance(SETUP_TOKEN_TTL_MS - 1000);
    expect(remote.setupToken()).toBe(TOKEN);
    s.advance(2000);
    expect(remote.setupToken()).toBeUndefined();
  });

  it("is never offered for This Mac", async () => {
    const { s } = await added();
    expect(s.local.setupToken()).toBeUndefined();
  });

  it("is sent in connect only to a remote Gateway", async () => {
    const home = tempDir();
    mkdirSync(join(home, "run"), { recursive: true });
    writeFileSync(join(home, "run", "handshake.secret"), "local-secret\n");
    const { key } = generateDeviceKey();
    const withToken = await desktopConnectParams({
      key,
      home,
      origin: URL_A,
      remote: true,
      setupToken: TOKEN,
    });
    expect(withToken.setupToken).toBe(TOKEN);
    expect(withToken.handshakeSecret).toBeUndefined();
    // This Mac's own Gateway never gets one, even if it were passed.
    const local = await desktopConnectParams({
      key,
      home,
      origin: "http://127.0.0.1:7979",
      setupToken: TOKEN,
    });
    expect(local.setupToken).toBeUndefined();
    // A connect without a token is exactly what it was.
    const plain = await desktopConnectParams({ key, home, origin: URL_A, remote: true });
    expect("setupToken" in plain).toBe(false);
  });
});

describe("an expired token in gateways.json", () => {
  it("is dropped when the file is loaded, in either loader, and the rest of the entry stays", async () => {
    const s = setup();
    await s.local.add(link());
    const later = new Date(s.now().getTime() + SETUP_TOKEN_TTL_MS + 60_000);
    const strict = loadGatewaysStrict(s.file, later);
    expect(strict.gateways[0]).toMatchObject({ origin: URL_A, identityKey: KEY_A });
    expect(strict.gateways[0]?.setupToken).toBeUndefined();
    expect(strict.gateways[0]?.setupTokenAt).toBeUndefined();
    expect(loadGateways(s.file, later).gateways[0]?.setupToken).toBeUndefined();
    // Still there inside its ten minutes.
    expect(loadGateways(s.file, s.now()).gateways[0]?.setupToken).toBe(TOKEN);
    // And saving what was loaded writes it out without the token.
    saveGateways(s.file, strict);
    expect(loadGateways(s.file, s.now()).gateways[0]?.setupToken).toBeUndefined();
  });
});

describe("a name shown in a native dialog", () => {
  it("loses format, separator and filler characters, not only controls", () => {
    expect(cleanGatewayName("Studio\u202EMac")).toBe("Studio Mac");
    expect(cleanGatewayName("A\u200DB\u115FC\u3164D\u2028E\u{E0041}F")).toBe("A B C D E F");
    expect(cleanGatewayName("Café 日本")).toBe("Café 日本");
  });
});
