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
import { afterEach, describe, expect, it } from "vitest";
import { desktopConnectParams } from "../src/gateway-client.ts";
import { generateDeviceKey } from "../src/lib/device-key.ts";
import {
  addGateway,
  clearGatewayPin,
  EMPTY_GATEWAYS,
  GatewayAddressError,
  GatewaysFileError,
  gatewayDataDir,
  gatewaysFilePath,
  loadGateways,
  loadGatewaysStrict,
  normalizeGatewayOrigin,
  pinGatewayKey,
  removeGateway,
  resolveTarget,
  saveGateways,
  THIS_MAC_ID,
} from "../src/lib/gateways.ts";
import { IPC, REMOTE_REFUSED_CHANNELS } from "../src/lib/ipc.ts";
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
  const d = mkdtempSync(join(tmpdir(), "psyche-gateways-"));
  dirs.push(d);
  return d;
}

const KEY_A = Buffer.alloc(32, 1).toString("base64url");
const KEY_B = Buffer.alloc(32, 2).toString("base64url");

function problem(input: string): string {
  try {
    normalizeGatewayOrigin(input);
  } catch (err) {
    if (err instanceof GatewayAddressError) return err.problem;
    throw err;
  }
  return "ok";
}

describe("normalizeGatewayOrigin", () => {
  it("accepts a MagicDNS name, with or without the scheme and a trailing slash", () => {
    for (const input of [
      "studio-mac.tail1234.ts.net",
      "https://studio-mac.tail1234.ts.net",
      "  https://studio-mac.tail1234.ts.net/  ",
      "HTTPS://Studio-Mac.tail1234.ts.net",
    ]) {
      expect(normalizeGatewayOrigin(input)).toBe("https://studio-mac.tail1234.ts.net");
    }
  });

  it("accepts plain http only for loopback (an SSH tunnel)", () => {
    expect(normalizeGatewayOrigin("http://127.0.0.1:7979")).toBe("http://127.0.0.1:7979");
    expect(normalizeGatewayOrigin("http://localhost:8000/")).toBe("http://localhost:8000");
    expect(problem("http://studio-mac.tail1234.ts.net")).toBe("needs_https");
    expect(problem("http://192.168.1.20:7979")).toBe("needs_https");
  });

  it("refuses what is not an origin", () => {
    expect(problem("")).toBe("empty");
    expect(problem("studio-mac")).toBe("needs_full_name");
    expect(problem("https://studio-mac")).toBe("needs_full_name");
    expect(problem("https://studio.tail1234.ts.net/chat")).toBe("has_path");
    expect(problem("https://studio.tail1234.ts.net/?x=1")).toBe("has_path");
    expect(problem("https://owner:pw@studio.tail1234.ts.net")).toBe("has_credentials");
    expect(problem("ftp://studio.tail1234.ts.net")).toBe("invalid");
    expect(problem("psyche-pair:v1:abc")).toBe("invalid");
    expect(problem("https://")).toBe("invalid");
  });
});

describe("saved Gateways file", () => {
  it("reads a missing, corrupt or hostile file as an empty list", () => {
    const dir = tempDir();
    const file = gatewaysFilePath(dir);
    expect(loadGateways(file)).toEqual(EMPTY_GATEWAYS);
    writeFileSync(file, "{not json");
    expect(loadGateways(file)).toEqual(EMPTY_GATEWAYS);
    writeFileSync(
      file,
      JSON.stringify({
        v: 1,
        active: "gw_000000000001",
        gateways: [
          { id: "../../etc", origin: "https://a.tail1.ts.net" },
          { id: "gw_000000000002", origin: "http://plain.example.com" },
          { id: "gw_000000000003", origin: "https://ok.tail1.ts.net", identityKey: "short" },
          null,
        ],
      }),
    );
    const loaded = loadGateways(file);
    // Bad ids and cleartext origins are dropped, a malformed pin is ignored, and an active id
    // that is not saved falls back to This Mac.
    expect(loaded.gateways.map((g) => g.id)).toEqual(["gw_000000000003"]);
    expect(loaded.gateways[0]?.identityKey).toBeUndefined();
    expect(loaded.active).toBe(THIS_MAC_ID);
  });

  it("round-trips at mode 0600", () => {
    const dir = tempDir();
    const file = gatewaysFilePath(dir);
    const { gateways } = addGateway(EMPTY_GATEWAYS, { address: "studio-mac.tail1234.ts.net" });
    saveGateways(file, pinGatewayKey(gateways, gateways.gateways[0]?.id as string, KEY_A));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const loaded = loadGateways(file);
    expect(loaded.gateways[0]).toMatchObject({
      name: "studio-mac",
      origin: "https://studio-mac.tail1234.ts.net",
      identityKey: KEY_A,
    });
  });

  it("adds an address once, never pinned, and removes by id", () => {
    const first = addGateway(EMPTY_GATEWAYS, { address: "studio-mac.tail1234.ts.net" });
    expect(first.entry.identityKey).toBeUndefined();
    const again = addGateway(first.gateways, { address: "https://studio-mac.tail1234.ts.net/" });
    expect(again.existing).toBe(true);
    expect(again.gateways.gateways).toHaveLength(1);
    const active = { ...first.gateways, active: first.entry.id };
    expect(removeGateway(active, first.entry.id)).toMatchObject({
      active: THIS_MAC_ID,
      gateways: [],
    });
  });

  it("clears a pin only for that Gateway", () => {
    let data = addGateway(
      EMPTY_GATEWAYS,
      { address: "a.tail1.ts.net" },
      "gw_aaaaaaaaaaaa",
    ).gateways;
    data = addGateway(data, { address: "b.tail1.ts.net" }, "gw_bbbbbbbbbbbb").gateways;
    data = pinGatewayKey(pinGatewayKey(data, "gw_aaaaaaaaaaaa", KEY_A), "gw_bbbbbbbbbbbb", KEY_B);
    const cleared = clearGatewayPin(data, "gw_aaaaaaaaaaaa");
    expect(cleared.gateways.map((g) => g.identityKey)).toEqual([undefined, KEY_B]);
  });
});

describe("resolveTarget", () => {
  it("is This Mac by default, with no data directory of its own", () => {
    const t = resolveTarget({ userData: "/u", env: {}, data: EMPTY_GATEWAYS });
    expect(t).toMatchObject({ id: THIS_MAC_ID, remote: false, dataDir: null });
    expect(t.origin).toBe("http://127.0.0.1:7979");
  });

  it("uses the active saved Gateway with its own data directory", () => {
    const { gateways, entry } = addGateway(
      EMPTY_GATEWAYS,
      { address: "studio-mac.tail1234.ts.net" },
      "gw_0123456789ab",
    );
    const t = resolveTarget({
      userData: "/u",
      env: {},
      data: { ...gateways, active: entry.id },
    });
    expect(t).toMatchObject({
      id: "gw_0123456789ab",
      remote: true,
      origin: "https://studio-mac.tail1234.ts.net",
      dataDir: gatewayDataDir("/u", "gw_0123456789ab"),
    });
  });

  it("keeps the environment path as it was: no pin, nothing saved, never a data directory", () => {
    const { gateways, entry } = addGateway(EMPTY_GATEWAYS, { address: "a.tail1.ts.net" });
    const t = resolveTarget({
      userData: "/u",
      env: { PSYCHE_GATEWAY_ORIGIN: "https://psyche.tail1.ts.net" },
      data: { ...gateways, active: entry.id },
    });
    expect(t).toMatchObject({ id: "env", remote: false, dataDir: null });
    expect(t.origin).toBe("https://psyche.tail1.ts.net");
  });

  it("refuses a data directory for anything that is not a saved id", () => {
    expect(() => gatewayDataDir("/u", "../x")).toThrow();
    expect(() => gatewayDataDir("/u", "this-mac")).toThrow();
  });
});

describe("this Mac's handshake secret", () => {
  it("is never sent to a saved remote Gateway, even through a loopback tunnel", async () => {
    const home = tempDir();
    mkdirSync(join(home, "run"), { recursive: true });
    writeFileSync(join(home, "run", "handshake.secret"), "local-secret\n");
    const { key } = generateDeviceKey();
    const local = await desktopConnectParams({ key, home, origin: "http://127.0.0.1:7979" });
    expect(local.handshakeSecret).toBe("local-secret");
    const tunnel = await desktopConnectParams({
      key,
      home,
      origin: "http://127.0.0.1:8000",
      remote: true,
    });
    expect(tunnel.handshakeSecret).toBeUndefined();
    const tailnet = await desktopConnectParams({
      key,
      home,
      origin: "https://studio-mac.tail1234.ts.net",
      remote: true,
    });
    expect(tailnet.handshakeSecret).toBeUndefined();
  });
});

describe("GatewayManager", () => {
  function setup(opts: { active?: string; confirm?: boolean } = {}) {
    const userData = tempDir();
    const confirms: GatewayConfirm[] = [];
    const relaunches: number[] = [];
    const stops: number[] = [];
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
        stopLocal: async () => void stops.push(1),
      });
    const local = make({
      id: THIS_MAC_ID,
      name: "This Mac",
      origin: "http://127.0.0.1:7979",
      remote: false,
      dataDir: null,
    });
    return { userData, file, confirms, relaunches, stops, local, make };
  }

  it("lists This Mac first and marks the one in use", async () => {
    const s = setup();
    await s.local.add("studio-mac.tail1234.ts.net");
    const list = s.local.list();
    expect(list.map((g) => [g.name, g.active, g.remote, g.pinned])).toEqual([
      ["This Mac", true, false, false],
      ["studio-mac", false, true, false],
    ]);
    expect(list[0]?.origin).toBeNull();
  });

  it("adds a Gateway only after a native confirmation naming the normalized address", async () => {
    const s = setup();
    const view = await s.local.add("studio-mac.tail1234.ts.net/", "Studio");
    expect(s.confirms).toEqual([
      { kind: "add", origin: "https://studio-mac.tail1234.ts.net", name: "Studio" },
    ]);
    expect(view.origin).toBe("https://studio-mac.tail1234.ts.net");
    const declined = setup({ confirm: false });
    await expect(declined.local.add("other.tail1234.ts.net")).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(loadGateways(declined.file).gateways).toEqual([]);
  });

  it("reports an unusable address as invalid_params with the problem, and asks nothing", async () => {
    const s = setup();
    await expect(s.local.add("studio-mac")).rejects.toMatchObject({
      code: "invalid_params",
      details: { problem: "needs_full_name" },
    });
    expect(s.confirms).toEqual([]);
  });

  it("switches by saving the choice and restarting, and can stop this Mac's Gateway first", async () => {
    const s = setup();
    const { id } = await s.local.add("studio-mac.tail1234.ts.net");
    await s.local.switchTo(id, { stopLocal: true });
    expect(loadGateways(s.file).active).toBe(id);
    expect(s.confirms.at(-1)).toEqual({ kind: "stopLocal" });
    expect(s.stops).toHaveLength(1);
    expect(s.relaunches).toHaveLength(1);
    // Declining the stop still switches, and leaves This Mac's Gateway running.
    const keep = setup({ confirm: true });
    const added = await keep.local.add("studio-mac.tail1234.ts.net");
    const noStop = new GatewayManager({
      userData: keep.userData,
      target: {
        id: THIS_MAC_ID,
        name: "This Mac",
        origin: "http://127.0.0.1:7979",
        remote: false,
        dataDir: null,
      },
      confirm: async (c) => c.kind !== "stopLocal",
      relaunch: () => keep.relaunches.push(1),
      stopLocal: async () => void keep.stops.push(1),
    });
    await noStop.switchTo(added.id, { stopLocal: true });
    expect(keep.stops).toHaveLength(0);
    expect(loadGateways(keep.file).active).toBe(added.id);
    await expect(noStop.switchTo("gw_ffffffffffff")).rejects.toMatchObject({ code: "not_found" });
  });

  it("pins the first key the active remote Gateway proves, once", async () => {
    const s = setup();
    const { id } = await s.local.add("studio-mac.tail1234.ts.net");
    const remote = s.make({
      id,
      name: "studio-mac",
      origin: "https://studio-mac.tail1234.ts.net",
      remote: true,
      dataDir: gatewayDataDir(s.userData, id),
    });
    expect(remote.pinnedKey()).toBeUndefined();
    remote.pin(KEY_A);
    remote.pin(KEY_B); // a second key never replaces the pin
    expect(remote.pinnedKey()).toBe(KEY_A);
    expect(remote.list().find((g) => g.id === id)).toMatchObject({ active: true, pinned: true });
    // This Mac keeps no pin.
    s.local.pin(KEY_B);
    expect(s.local.pinnedKey()).toBeUndefined();
    expect(loadGateways(s.file).gateways[0]?.identityKey).toBe(KEY_A);
  });

  it("pairs again: drops the pin and this computer's key, after confirming", async () => {
    const s = setup();
    const { id } = await s.local.add("studio-mac.tail1234.ts.net");
    const dir = gatewayDataDir(s.userData, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "device-key.json"), "{}");
    const remote = s.make({
      id,
      name: "studio-mac",
      origin: "https://studio-mac.tail1234.ts.net",
      remote: true,
      dataDir: dir,
    });
    remote.pin(KEY_A);
    await remote.repair(id);
    expect(s.confirms.at(-1)).toMatchObject({ kind: "repair" });
    expect(remote.pinnedKey()).toBeUndefined();
    expect(existsSync(join(dir, "device-key.json"))).toBe(false);
    expect(s.relaunches).toHaveLength(1);
  });

  it("forgets a Gateway: entry and data go, and forgetting the active one restarts on This Mac", async () => {
    const s = setup();
    const a = await s.local.add("a.tail1234.ts.net");
    const dir = gatewayDataDir(s.userData, a.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "device-key.json"), "{}");
    await s.local.remove(a.id);
    expect(loadGateways(s.file).gateways).toEqual([]);
    expect(existsSync(dir)).toBe(false);
    expect(s.relaunches).toHaveLength(0);

    const b = await s.local.add("b.tail1234.ts.net");
    await s.local.switchTo(b.id);
    const bDir = gatewayDataDir(s.userData, b.id);
    const activeB = s.make({
      id: b.id,
      name: "b",
      origin: "https://b.tail1234.ts.net",
      remote: true,
      dataDir: bDir,
    });
    mkdirSync(bDir, { recursive: true });
    await activeB.remove(b.id);
    expect(loadGateways(s.file)).toMatchObject({ active: THIS_MAC_ID, gateways: [] });
    expect(s.relaunches.length).toBeGreaterThan(1);
    // The running copy still uses that directory, so the next start sweeps it.
    expect(existsSync(bDir)).toBe(true);
    s.local.sweepForgottenData();
    expect(existsSync(bDir)).toBe(false);
  });

  it("does not forget or pair again when the owner declines the native dialog", async () => {
    const s = setup();
    const { id } = await s.local.add("a.tail1234.ts.net");
    const no = setup({ confirm: false });
    const declined = new GatewayManager({
      userData: s.userData,
      target: {
        id: THIS_MAC_ID,
        name: "This Mac",
        origin: "http://127.0.0.1:7979",
        remote: false,
        dataDir: null,
      },
      confirm: async () => false,
      relaunch: () => no.relaunches.push(1),
    });
    await expect(declined.remove(id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(declined.repair(id)).rejects.toMatchObject({ code: "forbidden" });
    expect(loadGateways(s.file).gateways).toHaveLength(1);
  });
});

describe("a saved-Gateways file that cannot be understood (never an empty list)", () => {
  const bad = [
    ["not JSON", "{nope"],
    ["not an object", "[]"],
    [
      "an entry with a bad id",
      JSON.stringify({
        v: 1,
        active: "this-mac",
        gateways: [{ id: "x", origin: "https://a.tail1.ts.net" }],
      }),
    ],
    [
      "a malformed pin",
      JSON.stringify({
        v: 1,
        active: "this-mac",
        gateways: [
          { id: "gw_000000000001", origin: "https://a.tail1.ts.net", identityKey: "short" },
        ],
      }),
    ],
    [
      "an active Gateway that is not saved",
      JSON.stringify({ v: 1, active: "gw_00000000000f", gateways: [] }),
    ],
  ] as const;

  it("is an error in the strict reader, and a missing file is empty", () => {
    const dir = tempDir();
    const file = gatewaysFilePath(dir);
    expect(loadGatewaysStrict(file)).toEqual(EMPTY_GATEWAYS);
    for (const [, text] of bad) {
      writeFileSync(file, text);
      expect(() => loadGatewaysStrict(file)).toThrow(GatewaysFileError);
    }
  });

  it("is never overwritten by a pin, a switch, an add or a forget, and the active pin check fails", async () => {
    for (const [, text] of bad) {
      const userData = tempDir();
      const file = gatewaysFilePath(userData);
      writeFileSync(file, text);
      const remote = new GatewayManager({
        userData,
        target: {
          id: "gw_000000000001",
          name: "a",
          origin: "https://a.tail1.ts.net",
          remote: true,
          dataDir: null,
        },
        confirm: async () => true,
        relaunch: () => {},
      });
      expect(() => remote.pinnedKey()).toThrow();
      expect(() => remote.pin(KEY_A)).toThrow();
      await expect(remote.add("b.tail1.ts.net")).rejects.toThrow();
      await expect(remote.switchTo(THIS_MAC_ID)).rejects.toThrow();
      expect(remote.list().map((g) => g.name)).toEqual(["This Mac"]);
      expect(readFileSync(file, "utf8")).toBe(text);
    }
  });

  it("fails the pin check when the active Gateway is gone from the file", () => {
    const userData = tempDir();
    saveGateways(gatewaysFilePath(userData), EMPTY_GATEWAYS);
    const remote = new GatewayManager({
      userData,
      target: {
        id: "gw_000000000001",
        name: "a",
        origin: "https://a.tail1.ts.net",
        remote: true,
        dataDir: null,
      },
      confirm: async () => true,
      relaunch: () => {},
    });
    expect(() => remote.pinnedKey()).toThrow();
  });
});

describe("writes that wait on a native dialog", () => {
  it("keep a pin written while the owner decided (add and switch read the file again)", async () => {
    const userData = tempDir();
    const file = gatewaysFilePath(userData);
    const a = addGateway(EMPTY_GATEWAYS, { address: "a.tail1.ts.net" }, "gw_aaaaaaaaaaaa");
    saveGateways(file, a.gateways);
    const target = {
      id: "gw_aaaaaaaaaaaa",
      name: "a",
      origin: "https://a.tail1.ts.net",
      remote: true,
      dataDir: null,
    };
    let manager: GatewayManager;
    manager = new GatewayManager({
      userData,
      target,
      // The connection pins the key while the dialog is open.
      confirm: async () => {
        manager.pin(KEY_A);
        return true;
      },
      relaunch: () => {},
      stopLocal: async () => {},
    });
    await manager.add("b.tail1.ts.net");
    let saved = loadGateways(file).gateways;
    expect(saved.map((g) => g.name)).toEqual(["a", "b"]);
    expect(saved[0]?.identityKey).toBe(KEY_A);
    // Switch with the stop-local dialog: the pin of b, written during it, survives.
    const bId = saved[1]?.id as string;
    manager = new GatewayManager({
      userData,
      target,
      confirm: async () => {
        saveGateways(file, pinGatewayKey(loadGateways(file), bId, KEY_B));
        return true;
      },
      relaunch: () => {},
      stopLocal: async () => {},
    });
    await manager.switchTo(bId, { stopLocal: true });
    saved = loadGateways(file).gateways;
    expect(saved[1]?.identityKey).toBe(KEY_B);
    expect(loadGateways(file).active).toBe(bId);
  });
});

describe("what a window can type", () => {
  it("strips control and bidirectional characters from a name", () => {
    const { entry } = addGateway(EMPTY_GATEWAYS, {
      address: "a.tail1.ts.net",
      name: "Studio\n\nDetail: ok\u202eevil\u0007 Mac",
    });
    expect(entry.name).toBe("Studio Detail: ok evil Mac");
  });

  it("ignores PSYCHE_GATEWAY_ORIGIN in a packaged build", () => {
    const env = { PSYCHE_GATEWAY_ORIGIN: "https://elsewhere.tail1.ts.net" };
    expect(
      resolveTarget({ userData: "/u", env, data: EMPTY_GATEWAYS, packaged: true }),
    ).toMatchObject({
      id: THIS_MAC_ID,
      origin: "http://127.0.0.1:7979",
    });
    expect(resolveTarget({ userData: "/u", env, data: EMPTY_GATEWAYS, packaged: false }).id).toBe(
      "env",
    );
  });
});

describe("what main refuses for a client of another computer's Gateway", () => {
  it("covers the shell, folders, helper, Touch ID, dictation checks and opening sources", () => {
    for (const channel of [
      IPC.terminalOpen,
      IPC.dialogPickFolder,
      IPC.permissionsRequest,
      IPC.helperLaunch,
      IPC.touchIdIdentity,
      IPC.touchIdRegister,
      IPC.touchIdApprove,
      IPC.dictationRecheck,
      IPC.dictationCheckHotkey,
      IPC.sourceOpen,
    ]) {
      expect(REMOTE_REFUSED_CHANNELS.has(channel)).toBe(true);
    }
    // The Gateway connection itself and the saved Gateways stay.
    expect(REMOTE_REFUSED_CHANNELS.has(IPC.call)).toBe(false);
    expect(REMOTE_REFUSED_CHANNELS.has(IPC.gatewaysList)).toBe(false);
  });
});
