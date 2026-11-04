import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  encodePairingLink,
  encodePairingLinkV2,
  PAIRING_LINK_PREFIX_V2,
  type PairingLinkPayloadV2,
} from "@psyche/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { fingerprintOf } from "../src/lib/gateway-identity.ts";
import {
  addGateway,
  addGatewayFromLanLink,
  EMPTY_GATEWAYS,
  GatewayAddressError,
  GatewayLinkError,
  gatewaysFilePath,
  isLanHost,
  isLanOrigin,
  loadGateways,
  THIS_MAC_ID,
} from "../src/lib/gateways.ts";
import { createPairLinkInbox, pairLinkFromArgv, pairLinkFromUrl } from "../src/lib/pair-link.ts";
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
  const d = mkdtempSync(join(tmpdir(), "psyche-lan-link-"));
  dirs.push(d);
  return d;
}

const NOW = new Date("2026-11-04T12:00:00.000Z");
const TOKEN = `pst_${Buffer.alloc(32, 5).toString("base64url")}`;
const KEY = (generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" }).x as string) ?? "";
const PIN = Buffer.alloc(32, 9).toString("base64url");
const OTHER_PIN = Buffer.alloc(32, 8).toString("base64url");
const LAN = "https://studio-mac.local:7979";

function link(over: Partial<PairingLinkPayloadV2> = {}): PairingLinkPayloadV2 {
  return {
    gatewayUrl: LAN,
    gatewayKey: KEY,
    certPin: PIN,
    setupToken: TOKEN,
    hostName: "studio-mac",
    ...over,
  };
}

describe("what the client calls the local network", () => {
  it("is .local names, private IPv4 and IPv6 unique-local, written plainly or in brackets", () => {
    for (const host of [
      "studio-mac.local",
      "192.168.1.20",
      "10.0.0.5",
      "172.16.9.9",
      "fd12:3456:789a:1::20",
      "[fd12:3456:789a:1::20]",
      "[FC00::1]",
    ]) {
      expect(isLanHost(host), host).toBe(true);
    }
    for (const host of [
      "studio-mac.tail1234.ts.net",
      "8.8.8.8",
      "100.64.1.2",
      "169.254.4.4",
      "[2600:1700:abcd::5]",
      "[fe80::1]",
      "fe80::1",
      "fe80::1%en0",
      "[::1]",
      "[::ffff:10.0.0.1]",
      "localhost",
    ]) {
      expect(isLanHost(host), host).toBe(false);
    }
    expect(isLanOrigin("https://[fd12:3456:789a:1::20]:7979")).toBe(true);
    expect(isLanOrigin("http://[fd12:3456:789a:1::20]:7979")).toBe(false);
    expect(isLanOrigin("https://[2600:1700::5]:7979")).toBe(false);
  });

  it("cannot even write a zone-qualified link-local address as a Gateway address", () => {
    expect(() => addGateway(EMPTY_GATEWAYS, { address: "https://[fe80::1%25en0]:7979" })).toThrow(
      GatewayAddressError,
    );
    expect(() => addGateway(EMPTY_GATEWAY_FILE, { address: "[fe80::1%en0]" })).toThrow(
      GatewayAddressError,
    );
  });

  it("reads a saved `lan` flag only for an address that can only be on a local network", () => {
    const dir = tempDir();
    const file = gatewaysFilePath(dir);
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        active: THIS_MAC_ID,
        gateways: [
          { id: "gw_aaaaaaaaaaaa", name: "a", origin: "https://169.254.1.1:7979", lan: true },
          { id: "gw_bbbbbbbbbbbb", name: "b", origin: "https://[fe80::1]:7979", lan: true },
          { id: "gw_cccccccccccc", name: "c", origin: "https://example.com", lan: true },
          { id: "gw_dddddddddddd", name: "d", origin: "https://[fd12::1]:7979", lan: true },
          { id: "gw_eeeeeeeeeeee", name: "e", origin: LAN, lan: true },
        ],
      }),
    );
    const entries = loadGateways(file, NOW).gateways;
    expect(entries.map((g) => [g.name, g.lan === true])).toEqual([
      ["a", false],
      ["b", false],
      ["c", false],
      ["d", true],
      ["e", true],
    ]);
  });
});

const EMPTY_GATEWAY_FILE = EMPTY_GATEWAYS;

describe("saved Gateways from a psyche-pair:v2 link", () => {
  it("pins the key and the certificate at once, marks it a LAN Gateway and keeps the token", () => {
    const result = addGatewayFromLanLink(EMPTY_GATEWAYS, link(), NOW, "gw_000000000001");
    expect(result.entry).toEqual({
      id: "gw_000000000001",
      name: "studio-mac",
      origin: LAN,
      identityKey: KEY,
      certPin: PIN,
      lan: true,
      setupToken: TOKEN,
      setupTokenAt: NOW.toISOString(),
    });
    // No fingerprint-only pre-pin: the key itself is pinned.
    expect(result.entry.identityFingerprint).toBeUndefined();
  });

  it("takes an IPv6 unique-local address in brackets", () => {
    const result = addGatewayFromLanLink(
      EMPTY_GATEWAYS,
      link({ gatewayUrl: "https://[fd12:3456:789a:1::20]:7979" }),
      NOW,
    );
    expect(result.entry.origin).toBe("https://[fd12:3456:789a:1::20]:7979");
    expect(isLanOrigin(result.entry.origin)).toBe(true);
  });

  it("refuses, again at this layer, an address that is not on a local network", () => {
    for (const gatewayUrl of [
      "https://example.com",
      "https://studio-mac.tail1234.ts.net",
      "https://8.8.8.8:7979",
      "https://[2600:1700::5]:7979",
      "https://[fe80::1]:7979",
      "https://169.254.1.1:7979",
    ]) {
      expect(
        () => addGatewayFromLanLink(EMPTY_GATEWAYS, link({ gatewayUrl }), NOW),
        gatewayUrl,
      ).toThrow(GatewayLinkError);
    }
  });

  it("refuses a pin that is not 32 bytes of base64url", () => {
    expect(() => addGatewayFromLanLink(EMPTY_GATEWAYS, link({ certPin: "short" }), NOW)).toThrow(
      GatewayLinkError,
    );
    expect(() => addGatewayFromLanLink(EMPTY_GATEWAYS, link({ gatewayKey: "short" }), NOW)).toThrow(
      GatewayLinkError,
    );
  });

  it("updates the entry for the same address with a new token, and never replaces a pin", () => {
    const first = addGatewayFromLanLink(EMPTY_GATEWAYS, link(), NOW, "gw_000000000001");
    const later = new Date(NOW.getTime() + 60_000);
    const again = addGatewayFromLanLink(
      first.gateways,
      link({ setupToken: `pst_${Buffer.alloc(32, 6).toString("base64url")}` }),
      later,
    );
    expect(again.gateways.gateways).toHaveLength(1);
    expect(again.entry).toMatchObject({
      identityKey: KEY,
      certPin: PIN,
      setupTokenAt: later.toISOString(),
    });
    // A different certificate, or a different key, for an address that is already pinned.
    expect(() =>
      addGatewayFromLanLink(first.gateways, link({ certPin: OTHER_PIN }), later),
    ).toThrow(expect.objectContaining({ problem: "pin_mismatch" }));
    const otherKey = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" })
      .x as string;
    expect(() =>
      addGatewayFromLanLink(first.gateways, link({ gatewayKey: otherKey }), later),
    ).toThrow(expect.objectContaining({ problem: "pin_mismatch" }));
  });

  it("refuses to turn an address saved as a plain https Gateway into a pinned LAN one", () => {
    const plain = addGateway(EMPTY_GATEWAYS, { address: LAN }).gateways;
    expect(() => addGatewayFromLanLink(plain, link(), NOW)).toThrow(
      expect.objectContaining({ problem: "pin_mismatch" }),
    );
  });

  it("checks a link-made fingerprint against the key, so an older v1 pre-pin cannot be swapped", () => {
    const stale = {
      ...EMPTY_GATEWAYS,
      gateways: [
        {
          id: "gw_000000000009",
          name: "studio-mac.local",
          origin: LAN,
          lan: true as const,
          identityFingerprint: `sha256:${"cd".repeat(32)}`,
        },
      ],
    };
    expect(() => addGatewayFromLanLink(stale, link(), NOW)).toThrow(
      expect.objectContaining({ problem: "pin_mismatch" }),
    );
    const matching = {
      ...stale,
      gateways: [{ ...stale.gateways[0], identityFingerprint: fingerprintOf(KEY) }],
    };
    const result = addGatewayFromLanLink(matching as never, link(), NOW);
    expect(result.entry.identityKey).toBe(KEY);
    expect(result.entry.identityFingerprint).toBeUndefined();
  });
});

describe("GatewayManager with a psyche-pair:v2 link", () => {
  function setup(opts: { confirm?: boolean } = {}) {
    const userData = tempDir();
    const confirms: GatewayConfirm[] = [];
    const make = (target: GatewayManagerDeps["target"]) =>
      new GatewayManager({
        userData,
        target,
        confirm: async (c) => {
          confirms.push(c);
          return opts.confirm ?? true;
        },
        relaunch: () => undefined,
        now: () => NOW,
      });
    const local = make({
      id: THIS_MAC_ID,
      name: "This Mac",
      origin: "http://127.0.0.1:7979",
      remote: false,
      dataDir: null,
    });
    return {
      userData,
      confirms,
      local,
      file: gatewaysFilePath(userData),
      asRemote: (id: string, origin = LAN) =>
        make({ id, name: "studio-mac", origin, remote: true, lan: true, dataDir: null }),
    };
  }

  it("asks in a native dialog that names the address, the key's fingerprint and the certificate", async () => {
    const s = setup();
    const view = await s.local.addFromLink(encodePairingLinkV2(link()));
    expect(s.confirms).toEqual([
      {
        kind: "addLink",
        origin: LAN,
        fingerprint: fingerprintOf(KEY),
        external: false,
        lan: { certPin: PIN },
      },
    ]);
    expect(view).toMatchObject({ origin: LAN, pinned: true, lan: true, active: false });
    expect(JSON.stringify(s.local.list())).not.toContain(TOKEN);
  });

  it("gives the connection the pinned certificate and key before any token is used", async () => {
    const s = setup();
    const { id } = await s.local.addFromLink(encodePairingLinkV2(link()));
    const remote = s.asRemote(id);
    // The first connect is already held to both pins (no trust on first use) ...
    expect(remote.pinnedCert()).toBe(PIN);
    expect(remote.pinnedKey()).toBe(KEY);
    // ... and a later pin from the first paired connect cannot replace them.
    remote.pin(generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" }).x as string);
    remote.pinCert(OTHER_PIN);
    expect(remote.pinnedKey()).toBe(KEY);
    expect(remote.pinnedCert()).toBe(PIN);
    expect(remote.setupToken()).toBe(TOKEN);
  });

  it("refuses the same link again for a different pin, and saves nothing new", async () => {
    const s = setup();
    await s.local.addFromLink(encodePairingLinkV2(link()));
    await expect(
      s.local.addFromLink(encodePairingLinkV2(link({ certPin: OTHER_PIN }))),
    ).rejects.toMatchObject({ code: "invalid_params", details: { problem: "link_pin_mismatch" } });
    expect(loadGateways(s.file, NOW).gateways).toHaveLength(1);
    expect(loadGateways(s.file, NOW).gateways[0]?.certPin).toBe(PIN);
  });

  it("still refuses a v1 link for a local-network address, and says what to do", async () => {
    const s = setup();
    await expect(
      s.local.addFromLink(
        encodePairingLink({
          gatewayUrl: LAN,
          gatewayFingerprint: fingerprintOf(KEY),
          setupToken: TOKEN,
          hostName: "studio-mac",
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_params", details: { problem: "link_lan" } });
    expect(s.confirms).toEqual([]);
  });

  it("refuses, before asking anything, a v2 link that names a public or link-local address", async () => {
    const s = setup();
    for (const gatewayUrl of ["https://example.com", "https://[fe80::1]:7979", "https://8.8.8.8"]) {
      const body = Buffer.from(JSON.stringify({ ...link(), gatewayUrl })).toString("base64url");
      await expect(
        s.local.addFromLink(`${PAIRING_LINK_PREFIX_V2}${body}`),
        gatewayUrl,
      ).rejects.toMatchObject({ code: "invalid_params", details: { problem: "link_bad_field" } });
    }
    // A v2 link with no pin at all.
    const { certPin: _gone, ...noPin } = link();
    const body = Buffer.from(JSON.stringify(noPin)).toString("base64url");
    await expect(s.local.addFromLink(`${PAIRING_LINK_PREFIX_V2}${body}`)).rejects.toMatchObject({
      details: { problem: "link_bad_field" },
    });
    expect(s.confirms).toEqual([]);
    expect(loadGateways(s.file, NOW).gateways).toEqual([]);
  });

  it("saves nothing when the owner declines", async () => {
    const s = setup({ confirm: false });
    await expect(s.local.addFromLink(encodePairingLinkV2(link()))).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(loadGateways(s.file, NOW).gateways).toEqual([]);
  });
});

describe("opening a psyche-pair:v2 link from the OS", () => {
  it("is recognised like a v1 link, returned as written, and still adds nothing", () => {
    const text = encodePairingLinkV2(link());
    expect(pairLinkFromUrl(text)).toBe(text);
    expect(pairLinkFromUrl(`  ${text}\n`)).toBe(text);
    expect(pairLinkFromArgv(["--flag", text])).toBe(text);
    expect(pairLinkFromUrl(`${PAIRING_LINK_PREFIX_V2}!!`)).toBeNull();
    const shown: string[] = [];
    const inbox = createPairLinkInbox({ show: () => shown.push("show"), notify: () => undefined });
    expect(inbox.offer(text)).toBe(true);
    expect(inbox.wasOffered(text)).toBe(true);
    expect(inbox.take()).toBe(text);
    expect(shown).toEqual(["show"]);
  });
});
