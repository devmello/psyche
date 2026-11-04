import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  encodePairingLink,
  gatewaySigningPayload,
  type PairingLinkPayload,
  SETUP_TOKEN_TTL_MS,
} from "@psyche/protocol";
import { Handshake } from "@psyche/web/client";
import { afterEach, describe, expect, it } from "vitest";
import { createGatewayVerifier, fingerprintOf } from "../src/lib/gateway-identity.ts";
import {
  addGatewayFromLink,
  EMPTY_GATEWAYS,
  GatewayLinkError,
  gatewaysFilePath,
  loadGateways,
  loadGatewaysStrict,
  saveGateways,
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
  const d = mkdtempSync(join(tmpdir(), "psyche-pairing-links-"));
  dirs.push(d);
  return d;
}

interface Identity {
  publicKey: string;
  signFor(input: { nonce: string; serverOrigin: string; devicePublicKey: string }): string;
}
function newIdentity(): Identity {
  const { privateKey } = generateKeyPairSync("ed25519");
  const x = privateKey.export({ format: "jwk" }).x as string;
  return {
    publicKey: x,
    signFor: (input) => sign(null, gatewaySigningPayload(input), privateKey).toString("base64url"),
  };
}

const REMOTE = "https://studio-mac.tail1234.ts.net";
const NOW = new Date("2026-11-04T12:00:00.000Z");
const NONCE = Buffer.alloc(32, 9).toString("base64url");
const DEVICE = Buffer.alloc(32, 3).toString("base64url");
const TOKEN = `pst_${Buffer.alloc(32, 5).toString("base64url")}`;

function linkFor(id: Identity, over: Partial<PairingLinkPayload> = {}): PairingLinkPayload {
  return {
    gatewayUrl: REMOTE,
    gatewayFingerprint: fingerprintOf(id.publicKey),
    setupToken: TOKEN,
    hostName: "studio-mac",
    ...over,
  };
}

function challenge(id: Identity) {
  return {
    nonce: NONCE,
    serverOrigin: REMOTE,
    gatewayKey: id.publicKey,
    gatewaySignature: id.signFor({ nonce: NONCE, serverOrigin: REMOTE, devicePublicKey: DEVICE }),
  };
}

describe("saved Gateways from a pairing link", () => {
  it("pre-pins the fingerprint and keeps the token, and the file reads back the same", () => {
    const id = newIdentity();
    const { gateways, entry } = addGatewayFromLink(
      EMPTY_GATEWAYS,
      linkFor(id, { gatewayUrl: "https://Studio-Mac.tail1234.ts.net/" }),
      NOW,
      "gw_aaaaaaaaaaaa",
    );
    expect(entry).toMatchObject({
      origin: REMOTE,
      name: "studio-mac",
      identityFingerprint: fingerprintOf(id.publicKey),
      setupToken: TOKEN,
      setupTokenAt: NOW.toISOString(),
    });
    expect(entry.identityKey).toBeUndefined();
    const file = join(tempDir(), "gateways.json");
    saveGateways(file, gateways);
    expect(loadGatewaysStrict(file, NOW).gateways).toEqual([entry]);
    expect(loadGateways(file, NOW).gateways).toEqual([entry]);
  });

  it("refuses a link whose address an address field would refuse", () => {
    const id = newIdentity();
    for (const gatewayUrl of [
      "http://studio-mac.tail1234.ts.net",
      "https://studio-mac",
      "https://user:pw@studio-mac.tail1234.ts.net",
      "https://studio-mac.tail1234.ts.net/path",
      "ftp://studio-mac.tail1234.ts.net",
    ]) {
      expect(() => addGatewayFromLink(EMPTY_GATEWAYS, linkFor(id, { gatewayUrl }), NOW)).toThrow();
    }
  });

  it("will not let a link replace the pin of a Gateway saved with another identity", () => {
    const real = newIdentity();
    const { gateways } = addGatewayFromLink(EMPTY_GATEWAYS, linkFor(real), NOW);
    const id = gateways.gateways[0]?.id ?? "";
    const pinned = {
      ...gateways,
      gateways: gateways.gateways.map((g) => ({ ...g, identityKey: real.publicKey })),
    };
    expect(() => addGatewayFromLink(pinned, linkFor(newIdentity()), NOW)).toThrow(GatewayLinkError);
    // The same identity again only gives it a fresh token.
    const again = addGatewayFromLink(
      pinned,
      linkFor(real, { setupToken: `${TOKEN.slice(0, -1)}A` }),
      NOW,
    );
    expect(again.entry.id).toBe(id);
    expect(again.entry.setupToken?.endsWith("A")).toBe(true);
  });

  it("refuses a file whose link fingerprint is unreadable instead of running without it", () => {
    const id = newIdentity();
    const { gateways } = addGatewayFromLink(EMPTY_GATEWAYS, linkFor(id), NOW);
    const file = join(tempDir(), "gateways.json");
    saveGateways(file, gateways);
    writeFileSync(file, readFileSync(file, "utf8").replace(/sha256:[0-9a-f]{64}/, "sha256:zz"));
    expect(() => loadGatewaysStrict(file, NOW)).toThrow(/cannot read/);
  });
});

describe("GatewayManager with a pairing link", () => {
  function setup(opts: { confirm?: boolean; now?: () => Date } = {}) {
    const userData = tempDir();
    const confirms: GatewayConfirm[] = [];
    const relaunches: number[] = [];
    const file = gatewaysFilePath(userData);
    const make = (target: GatewayManagerDeps["target"]) =>
      new GatewayManager({
        userData,
        target,
        confirm: async (c) => {
          confirms.push(c);
          return opts.confirm ?? true;
        },
        relaunch: () => relaunches.push(1),
        ...(opts.now ? { now: opts.now } : {}),
      });
    const local = make({
      id: THIS_MAC_ID,
      name: "This Mac",
      origin: "http://127.0.0.1:7979",
      remote: false,
      dataDir: null,
    });
    const asRemote = (id: string) =>
      make({ id, name: "studio-mac", origin: REMOTE, remote: true, dataDir: null });
    return { userData, file, confirms, relaunches, local, asRemote };
  }

  it("asks in a native dialog that names the normalized address and the fingerprint", async () => {
    const id = newIdentity();
    const s = setup();
    const link = encodePairingLink(
      linkFor(id, { gatewayUrl: "https://Studio-Mac.tail1234.ts.net/" }),
    );
    const view = await s.local.addFromLink(link);
    expect(s.confirms).toEqual([
      {
        kind: "addLink",
        origin: REMOTE,
        fingerprint: fingerprintOf(id.publicKey),
        external: false,
      },
    ]);
    expect(view).toMatchObject({ origin: REMOTE, pinned: true, active: false });
    // Adding connects to nothing and restarts nothing.
    expect(s.relaunches).toEqual([]);
    // The renderer is never given the token.
    expect(JSON.stringify(s.local.list())).not.toContain(TOKEN);
    expect(JSON.stringify(view)).not.toContain(TOKEN);
  });

  it("never repeats the link's own host name: the entry is named by its address", async () => {
    const id = newIdentity();
    const s = setup();
    const view = await s.local.addFromLink(
      encodePairingLink(linkFor(id, { hostName: "Your Bank: call 555-0100" })),
    );
    expect(view.name).toBe("studio-mac");
    expect(JSON.stringify(s.confirms)).not.toContain("Bank");
  });

  it("tells the owner when the OS, not their paste, handed over the link", async () => {
    const id = newIdentity();
    const s = setup();
    await s.local.addFromLink(encodePairingLink(linkFor(id)), { external: true });
    expect(s.confirms[0]).toMatchObject({ kind: "addLink", external: true });
  });

  it("takes the Host's own name once paired, unless the owner renamed the entry", async () => {
    const id = newIdentity();
    const s = setup({ now: () => NOW });
    const { id: gwId } = await s.local.addFromLink(encodePairingLink(linkFor(id)));
    const remote = s.asRemote(gwId);
    remote.adoptHostName("Studio Mac");
    expect(loadGateways(s.file, NOW).gateways[0]?.name).toBe("Studio Mac");
    remote.adoptHostName("Other");
    expect(loadGateways(s.file, NOW).gateways[0]?.name).toBe("Studio Mac");
  });

  it("drops lapsed tokens whenever the file is read, for every entry", () => {
    const a = addGatewayFromLink(EMPTY_GATEWAYS, linkFor(newIdentity()), NOW, "gw_aaaaaaaaaaaa");
    const b = addGatewayFromLink(
      a.gateways,
      linkFor(newIdentity(), { gatewayUrl: "https://other.tail1234.ts.net" }),
      new Date(NOW.getTime() + 9 * 60_000),
      "gw_bbbbbbbbbbbb",
    );
    const file = join(tempDir(), "gateways.json");
    saveGateways(file, b.gateways);
    const later = new Date(NOW.getTime() + SETUP_TOKEN_TTL_MS + 1_000);
    for (const load of [loadGatewaysStrict, loadGateways]) {
      const entries = load(file, later).gateways;
      expect(entries.map((g) => g.setupToken !== undefined)).toEqual([false, true]);
      expect(entries.every((g) => g.identityFingerprint !== undefined)).toBe(true);
    }
  });

  it("refuses a link to a Gateway on the local network until links carry a certificate pin", async () => {
    const id = newIdentity();
    const s = setup();
    for (const gatewayUrl of [
      "https://studio-mac.local:7979",
      "https://192.168.1.20:7979",
      "https://10.0.0.5",
    ]) {
      await expect(
        s.local.addFromLink(encodePairingLink(linkFor(id, { gatewayUrl }))),
      ).rejects.toMatchObject({ code: "invalid_params", details: { problem: "link_lan" } });
    }
    expect(s.confirms).toEqual([]);
    expect(loadGateways(s.file, NOW).gateways).toEqual([]);
  });

  it("saves nothing when the owner declines", async () => {
    const s = setup({ confirm: false });
    await expect(
      s.local.addFromLink(encodePairingLink(linkFor(newIdentity()))),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(loadGateways(s.file, NOW).gateways).toEqual([]);
  });

  it("refuses malformed links and bad addresses before asking anything", async () => {
    const s = setup();
    const id = newIdentity();
    await expect(s.local.addFromLink("psyche-pair:v1:!!!")).rejects.toMatchObject({
      code: "invalid_params",
      details: { problem: "link_malformed" },
    });
    await expect(s.local.addFromLink("https://studio-mac.tail1234.ts.net")).rejects.toMatchObject({
      details: { problem: "link_not_a_pairing_link" },
    });
    await expect(
      s.local.addFromLink(
        `psyche-pair:v1:${Buffer.from(JSON.stringify(linkFor(id, { gatewayUrl: "http://evil.example.com" }))).toString("base64url")}`,
      ),
    ).rejects.toMatchObject({
      code: "invalid_params",
      details: { problem: "link_bad_field" },
    });
    expect(s.confirms).toEqual([]);
    expect(loadGateways(s.file, NOW).gateways).toEqual([]);
  });

  it("gives the connection the fingerprint and the token, but only for the active remote Gateway", async () => {
    const id = newIdentity();
    const s = setup({ now: () => NOW });
    const { id: gwId } = await s.local.addFromLink(encodePairingLink(linkFor(id)));
    expect(s.local.setupToken()).toBeUndefined();
    expect(s.local.pinnedFingerprint()).toBeUndefined();
    const remote = s.asRemote(gwId);
    expect(remote.pinnedFingerprint()).toBe(fingerprintOf(id.publicKey));
    expect(remote.setupToken()).toBe(TOKEN);
  });

  it("drops a token older than the Host accepts, so it is never presented late", async () => {
    const id = newIdentity();
    let clock = NOW;
    const s = setup({ now: () => clock });
    const { id: gwId } = await s.local.addFromLink(encodePairingLink(linkFor(id)));
    const remote = s.asRemote(gwId);
    clock = new Date(NOW.getTime() + SETUP_TOKEN_TTL_MS - 1);
    expect(remote.setupToken()).toBe(TOKEN);
    clock = new Date(NOW.getTime() + SETUP_TOKEN_TTL_MS);
    expect(remote.setupToken()).toBeUndefined();
    expect(loadGateways(s.file, clock).gateways[0]?.setupToken).toBeUndefined();
    // The fingerprint stays: a later connect without a token is still verified.
    expect(remote.pinnedFingerprint()).toBe(fingerprintOf(id.publicKey));
  });

  it("pins the key at the first paired connect, and forgets the token then", async () => {
    const id = newIdentity();
    const s = setup({ now: () => NOW });
    const { id: gwId } = await s.local.addFromLink(encodePairingLink(linkFor(id)));
    const remote = s.asRemote(gwId);
    remote.pin(id.publicKey);
    expect(loadGateways(s.file, NOW).gateways[0]).toMatchObject({
      identityKey: id.publicKey,
      setupToken: TOKEN,
    });
    expect(loadGateways(s.file, NOW).gateways[0]?.identityFingerprint).toBeUndefined();
    remote.markConnected();
    expect(loadGateways(s.file, NOW).gateways[0]?.setupToken).toBeUndefined();
    expect(loadGateways(s.file, NOW).gateways[0]?.identityKey).toBe(id.publicKey);
  });

  it("forgets the token when the Host refuses it, and keeps the fingerprint", async () => {
    const id = newIdentity();
    const s = setup({ now: () => NOW });
    const { id: gwId } = await s.local.addFromLink(encodePairingLink(linkFor(id)));
    const remote = s.asRemote(gwId);
    remote.clearSetupToken();
    expect(remote.setupToken()).toBeUndefined();
    expect(remote.pinnedFingerprint()).toBe(fingerprintOf(id.publicKey));
  });

  it("Pair again forgets the link's fingerprint and token too", async () => {
    const id = newIdentity();
    const s = setup({ now: () => NOW });
    const { id: gwId } = await s.local.addFromLink(encodePairingLink(linkFor(id)));
    await s.local.repair(gwId);
    expect(loadGateways(s.file, NOW).gateways[0]).toEqual({
      id: gwId,
      name: "studio-mac",
      origin: REMOTE,
    });
  });
});

describe("a link makes the first connect verified (strict verifier)", () => {
  const verifier = (fingerprint: string | undefined, pinned?: string) =>
    createGatewayVerifier({
      dialedOrigin: REMOTE,
      mode: "strict",
      pinnedKey: () => pinned,
      pinnedFingerprint: () => fingerprint,
    });

  it("accepts the Gateway the link named, and then holds its key as the candidate to pin", () => {
    const id = newIdentity();
    const verify = verifier(fingerprintOf(id.publicKey));
    expect(verify(challenge(id), DEVICE)).toMatchObject({ ok: true, gatewayKey: id.publicKey });
    expect(verify.candidateKey()).toBe(id.publicKey);
  });

  it("refuses any other Gateway, even one with a valid signature: the identity-changed screen", () => {
    const named = newIdentity();
    const verify = verifier(fingerprintOf(named.publicKey));
    expect(verify(challenge(newIdentity()), DEVICE)).toEqual({
      ok: false,
      code: "gateway_identity_changed",
    });
    expect(verify.candidateKey()).toBeUndefined();
  });

  it("is replaced by the pinned key once there is one", () => {
    const real = newIdentity();
    const stale = newIdentity();
    // A fingerprint left over beside a pin is ignored; the key decides.
    expect(
      verifier(fingerprintOf(stale.publicKey), real.publicKey)(challenge(real), DEVICE),
    ).toMatchObject({ ok: true });
  });
});

describe("the handshake presents the token only to a Gateway that proved the linked identity", () => {
  const params = {
    protocolVersion: { min: 1, max: 1 },
    deviceId: "dev_test",
    publicKey: DEVICE,
    role: "client" as const,
    platform: "macos",
    deviceFamily: "desktop",
    name: "test",
  };
  const frame = (id: Identity) =>
    ({
      type: "res" as const,
      id: "connect",
      ok: true as const,
      payload: {
        phase: "challenge",
        protocolVersion: 1,
        expiresAt: new Date().toISOString(),
        ...challenge(id),
      },
    }) as const;

  it("refuses a Gateway with the wrong fingerprint before any pairing request or token is sent", async () => {
    const named = newIdentity();
    const sent: unknown[] = [];
    const hs = new Handshake(
      params,
      () => {
        throw new Error("must not sign");
      },
      createGatewayVerifier({
        dialedOrigin: REMOTE,
        mode: "strict",
        pinnedKey: () => undefined,
        pinnedFingerprint: () => fingerprintOf(named.publicKey),
      }),
      TOKEN,
    );
    sent.push(hs.start());
    const step = await hs.onFrame(frame(newIdentity()));
    expect(step.status).toEqual({ type: "error", code: "gateway_identity_changed" });
    expect(step.send).toBeUndefined();
    expect(step.done).toBe(true);
    // Only the first `connect` frame went out, and it carries no token.
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent)).not.toContain(TOKEN);
  });

  it("sends the token in connect.verify, never in connect, once the identity checked out", async () => {
    const id = newIdentity();
    const hs = new Handshake(
      params,
      () => "sig",
      createGatewayVerifier({
        dialedOrigin: REMOTE,
        mode: "strict",
        pinnedKey: () => undefined,
        pinnedFingerprint: () => fingerprintOf(id.publicKey),
      }),
      TOKEN,
    );
    expect(JSON.stringify(hs.start())).not.toContain(TOKEN);
    const step = await hs.onFrame(frame(id));
    expect(step.send?.method).toBe("connect.verify");
    expect(step.send?.params).toMatchObject({ setupToken: TOKEN, gatewayKey: id.publicKey });
  });

  it("sends no token without a verifier that bound the connect to a key", async () => {
    const hs = new Handshake(params, () => "sig", undefined, TOKEN);
    hs.start();
    const step = await hs.onFrame(frame(newIdentity()));
    expect(JSON.stringify(step.send)).not.toContain(TOKEN);
  });

  it("reads a refused token as a denial with its code, not as a pending approval", async () => {
    const id = newIdentity();
    const hs = new Handshake(
      params,
      () => "sig",
      createGatewayVerifier({
        dialedOrigin: REMOTE,
        mode: "strict",
        pinnedKey: () => undefined,
      }),
      TOKEN,
    );
    hs.start();
    await hs.onFrame(frame(id));
    const step = await hs.onFrame({
      type: "res",
      id: "connect.verify",
      ok: true,
      payload: { phase: "denied", reason: "used", code: "setup_token_invalid" },
    });
    expect(step.status).toEqual({ type: "denied", reason: "used", code: "setup_token_invalid" });
    expect(step.done).toBe(true);
  });
});

describe("opening a psyche-pair: link from the OS", () => {
  const id = newIdentity();
  const link = encodePairingLink(linkFor(id));

  it("recognises only a valid pairing link, and returns it as written", () => {
    expect(pairLinkFromUrl(link)).toBe(link);
    expect(pairLinkFromUrl(`  ${link}\n`)).toBe(link);
    expect(pairLinkFromUrl(link.replace("psyche-pair:", "PSYCHE-PAIR:"))).not.toBeNull();
    for (const bad of [
      "psyche://chat",
      "https://studio-mac.tail1234.ts.net",
      "psyche-pair:v1:",
      "psyche-pair:v2:abc",
      `${link}x!`,
      `psyche-pair:${"a".repeat(5000)}`,
    ]) {
      expect(pairLinkFromUrl(bad)).toBeNull();
    }
    expect(pairLinkFromArgv(["electron", "--flag", "psyche://chat", link])).toBe(link);
    expect(pairLinkFromArgv(["electron", "psyche-pair:junk"])).toBeNull();
  });

  it("only shows Settings and tells open windows: no Gateway is added or contacted", () => {
    const calls: string[] = [];
    const inbox = createPairLinkInbox({
      show: () => calls.push("show"),
      notify: () => calls.push("notify"),
    });
    expect(inbox.offer("psyche-pair:v1:garbage!")).toBe(false);
    expect(calls).toEqual([]);
    expect(inbox.offer(link)).toBe(true);
    expect(calls).toEqual(["show", "notify"]);
    // The window asks for it once.
    expect(inbox.take()).toBe(link);
    expect(inbox.take()).toBeNull();
    // Main remembers that the OS made this offer, so its dialog can say so.
    expect(inbox.wasOffered(link)).toBe(true);
    expect(inbox.wasOffered(`${link}x`)).toBe(false);
  });

  it("keeps a link that arrived before the windows existed, and shows it once they do", () => {
    const calls: string[] = [];
    const inbox = createPairLinkInbox({
      show: () => calls.push("show"),
      notify: () => calls.push("notify"),
    });
    inbox.showPending();
    expect(calls).toEqual([]);
    inbox.offerArgv(["electron", link]);
    calls.length = 0;
    inbox.showPending();
    expect(calls).toEqual(["show"]);
  });

  it("main wires the OS link to the inbox alone: it never calls the Gateway manager", () => {
    const main = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../src/main.ts"),
      "utf8",
    );
    const inbox = main.slice(main.indexOf("const pairLinks = createPairLinkInbox"));
    const wiring = inbox.slice(0, inbox.indexOf("});") + 3);
    expect(wiring).toContain("windows?.showSettings");
    expect(wiring).not.toMatch(/gateways\./);
    // The three places a link can arrive from only offer it to the inbox.
    expect(main).toMatch(/isPairLinkUrl\(url\)\) pairLinks\.offer\(url\)/);
    expect(main).toMatch(/pairLinks\.offerArgv\(argv\)/);
    expect(main).toMatch(/pairLinks\.offerArgv\(process\.argv\)/);
    // The only code that adds a link's Gateway is the IPC handler, behind the native dialog.
    expect(main.match(/addFromLink\(/g)).toHaveLength(1);
    expect(main).toMatch(/handle\(IPC\.gatewaysAddLink/);
    // Registered as a protocol handler in packaged builds only.
    expect(main).toMatch(/app\.isPackaged\) app\.setAsDefaultProtocolClient\(PAIR_LINK_SCHEME\)/);
  });
});
