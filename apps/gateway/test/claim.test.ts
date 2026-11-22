import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { getSetting, insertDevice, listDevices, openDb } from "@psyche/db";
import { claimTranscript, normalizeSetupCode } from "@psyche/protocol";
import {
  claimedMarkerPath,
  claimProof,
  deriveClaimKey,
  makeSetupCode,
  readSetupCode,
  setupCodePath,
} from "@psyche/protocol/claim-node";
import { afterEach, describe, expect, it, vi } from "vitest";
// The desktop's own claim client, so the round trip below is the one the app runs.
import { ClaimError, claimServer } from "../../desktop/src/lib/claim-client.ts";
import { CLAIM_LAN_CHOICE_SETTING, linuxDefaultRouteInterface } from "../src/claim/mode.ts";
import type { AdvertiseSpec, MdnsAdvertiser } from "../src/lan/discovery.ts";
import type { LanInterface } from "../src/lan/interfaces.ts";
import { LAN_SETTING } from "../src/lan/settings.ts";
import {
  adminClient,
  handshake,
  newDeviceKey,
  startTestGateway,
  TestClient,
  type TestGateway,
} from "./helpers.ts";

const IFACES: LanInterface[] = [
  { name: "lan0", address: "127.0.0.1", family: "IPv4", network: "127.0.0.0/8", isDefault: true },
];

// `removeSetupCode` can be made to fail, to check that nothing after the admin commit fails a claim.
const failing = vi.hoisted(() => ({ removeSetupCode: false }));
vi.mock("@psyche/protocol/claim-node", async (orig) => {
  const real = await orig<typeof import("@psyche/protocol/claim-node")>();
  return {
    ...real,
    removeSetupCode: (home: string) => {
      if (failing.removeSetupCode) throw new Error("EACCES: cannot remove the setup code");
      real.removeSetupCode(home);
    },
  };
});

let t: TestGateway | undefined;
const open: TestClient[] = [];
afterEach(async () => {
  failing.removeSetupCode = false;
  for (const c of open.splice(0)) c.close();
  await t?.cleanup();
  t = undefined;
});

async function freePort(): Promise<number> {
  const s: Server = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

/** Records what Bonjour would announce, and its withdrawals. */
function fakeAdvertiser(): MdnsAdvertiser & { live: AdvertiseSpec[] } {
  const live: AdvertiseSpec[] = [];
  return {
    live,
    publish(spec) {
      live.push(spec);
      return {
        stop: async () => {
          live.splice(live.indexOf(spec), 1);
        },
      };
    },
  };
}

interface Started {
  t: TestGateway;
  port: number;
  announced: string[];
  ads: ReturnType<typeof fakeAdvertiser>;
  code: string | null;
}

async function startClaimable(
  opts: { home?: string; limits?: Record<string, number>; db?: ReturnType<typeof openDb> } = {},
): Promise<Started> {
  const port = await freePort();
  const announced: string[] = [];
  const ads = fakeAdvertiser();
  t = await startTestGateway({
    ...(opts.home ? { home: opts.home } : {}),
    ...(opts.db ? { db: opts.db } : {}),
    lan: { candidates: () => IFACES, hostLabel: () => "lab-box", advertiser: ads },
    claim: {
      enabled: true,
      port,
      announce: (l) => announced.push(l),
      defaultInterface: () => "lan0",
      limits: { watchMs: 0, ...opts.limits },
    },
  });
  const m = announced.join("\n").match(/Setup code: ([0-9A-Z]{5}-[0-9A-Z]{5})/);
  return { t, port, announced, ads, code: m?.[1] ?? null };
}

const device = () => {
  const key = newDeviceKey();
  return {
    key,
    claim: {
      deviceId: `dev_${randomBytes(8).toString("hex")}`,
      publicKey: key.publicKey,
      name: "Psyche Desktop (test)",
      platform: "macos" as const,
    },
  };
};

function lanClient(port: number): Promise<TestClient> {
  return TestClient.open(`wss://127.0.0.1:${port}/ws`, {}, { rejectUnauthorized: false });
}

describe("an unclaimed server", () => {
  it("makes a code, keeps only its derived key at 0600, and advertises claim=1", async () => {
    const s = await startClaimable();
    expect(s.code).not.toBeNull();
    const file = setupCodePath(s.t.home);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const text = readFileSync(file, "utf8");
    // The code itself is never stored.
    expect(text).not.toContain((normalizeSetupCode(s.code as string) ?? "x").slice(0, 10));
    expect(s.t.gateway.context.claim?.active()).toBe(true);
    expect(s.t.gateway.context.lan.status().listening).toEqual([
      { address: "127.0.0.1", port: s.port },
    ]);
    expect(s.ads.live.map((a) => a.txt.claim)).toEqual(["1"]);
    // Claim mode is not the owner's LAN choice: nothing is stored as gateway.lan.
    expect(getSetting(s.t.gateway.context.db, LAN_SETTING)).toBeUndefined();
  });

  it("is claimed by the right code: the device is the first admin and claim mode ends", async () => {
    const s = await startClaimable();
    const d = device();
    const got = await claimServer({
      host: "127.0.0.1",
      port: s.port,
      code: (s.code as string).toLowerCase(),
      device: d.claim,
    });
    const ctx = s.t.gateway.context;
    expect(got.gatewayKey).toBe(ctx.identity.publicKey);
    expect(got.certSpki).toBe(ctx.lan.certSpki());
    const admin = listDevices(ctx.db).find((x) => x.id === d.claim.deviceId);
    expect(admin?.scopes.sort()).toEqual(
      ["operator.admin", "operator.approvals", "operator.read", "operator.write"].sort(),
    );
    expect(admin?.pairedAt).not.toBeNull();
    // Single use: the code is gone and the server records that it is set up.
    expect(existsSync(setupCodePath(s.t.home))).toBe(false);
    expect(existsSync(claimedMarkerPath(s.t.home))).toBe(true);
    expect(ctx.claim?.active()).toBe(false);
    await new Promise((r) => setTimeout(r, 50));
    expect(s.ads.live.map((a) => a.txt.claim)).toEqual([undefined]);
    // LAN stays on where the claim came in until onboarding answers.
    expect(getSetting(ctx.db, LAN_SETTING)?.value).toMatchObject({
      enabled: true,
      interfaces: ["lan0"],
    });
    expect(getSetting(ctx.db, CLAIM_LAN_CHOICE_SETTING)?.value).toBe("pending");

    // The device now connects like any paired LAN device, with the pins it got.
    const c = await lanClient(s.port);
    open.push(c);
    const r = await handshake(c, `https://127.0.0.1:${s.port}`, {
      key: d.key,
      deviceId: d.claim.deviceId,
      gatewayKey: got.gatewayKey,
    });
    expect((r.verifyRes?.payload as { phase?: string } | undefined)?.phase).toBe("paired");
    const info = await c.call<{ claim?: { lanChoicePending: boolean } }>("gateway.info", {});
    expect(info.claim).toEqual({ lanChoicePending: true });

    // A second claim with the same (spent) code finds nothing to claim.
    await expect(
      claimServer({
        host: "127.0.0.1",
        port: s.port,
        code: s.code as string,
        device: device().claim,
      }),
    ).rejects.toMatchObject({ problem: "not_claimable" });
  });

  it("refuses a wrong code, counts down, then rate-limits the address", async () => {
    const s = await startClaimable({ limits: { failedPerMinutePerAddress: 3 } });
    const wrong = s.code === "00000-00000" ? "11111-11111" : "00000-00000";
    const left: (number | undefined)[] = [];
    for (let i = 0; i < 3; i++) {
      const err = await claimServer({
        host: "127.0.0.1",
        port: s.port,
        code: wrong,
        device: device().claim,
      }).catch((e: unknown) => e as ClaimError);
      expect(err).toBeInstanceOf(ClaimError);
      expect((err as ClaimError).problem).toBe("wrong_code");
      left.push((err as ClaimError).attemptsLeft);
    }
    expect(left).toEqual([2, 1, 0]);
    // Over the limit: even the right code waits, and nothing was claimed.
    const limited = await claimServer({
      host: "127.0.0.1",
      port: s.port,
      code: s.code as string,
      device: device().claim,
    }).catch((e: unknown) => e as ClaimError);
    expect((limited as ClaimError).problem).toBe("too_many_attempts");
    expect((limited as ClaimError).retryAfterSec).toBeGreaterThan(0);
    expect(s.t.gateway.context.claim?.active()).toBe(true);
    expect(listDevices(s.t.gateway.context.db)).toEqual([]);
  });

  it("refuses a replayed transcript: the server's nonce is fresh per connection", async () => {
    const s = await startClaimable();
    const d = device();
    const code = s.code as string;
    // One full exchange, captured, then refused at the last step so nothing is claimed yet.
    const c1 = await lanClient(s.port);
    open.push(c1);
    const clientNonce = randomBytes(32).toString("base64url");
    const hello = (await c1.call("gateway.claim.hello", { clientNonce, ...d.claim })) as Record<
      string,
      string
    >;
    const key = await deriveClaimKey(code, Buffer.from(hello.salt as string, "base64url"));
    const proof = claimProof(
      key,
      "client",
      claimTranscript({
        clientNonce,
        serverNonce: hello.serverNonce as string,
        salt: hello.salt as string,
        gatewayKey: hello.gatewayKey as string,
        certSpki: hello.certSpki as string,
        deviceId: d.claim.deviceId,
        devicePublicKey: d.claim.publicKey,
      }),
    );
    c1.close();
    // The proof sent on a new connection, for its new nonce, does not match.
    const c2 = await lanClient(s.port);
    open.push(c2);
    await c2.call("gateway.claim.hello", { clientNonce, ...d.claim });
    const replay = await c2.request("gateway.claim.prove", { proof });
    expect(replay).toMatchObject({
      ok: false,
      error: { code: "forbidden", details: { reason: "wrong_code" } },
    });
    expect(s.t.gateway.context.claim?.active()).toBe(true);
  });

  it("refuses an expired code and says to make a new one", async () => {
    const s = await startClaimable();
    // A code made a day and a minute ago.
    await makeSetupCode(s.t.home, new Date(Date.now() - 24 * 3_600_000 - 60_000));
    expect(readSetupCode(s.t.home)).toBe("expired");
    const err = await claimServer({
      host: "127.0.0.1",
      port: s.port,
      code: s.code as string,
      device: device().claim,
    }).catch((e: unknown) => e as ClaimError);
    expect((err as ClaimError).problem).toBe("code_expired");
    // `psyche setup code` replaces it, and the new one works without a restart.
    const fresh = await makeSetupCode(s.t.home);
    await expect(
      claimServer({ host: "127.0.0.1", port: s.port, code: fresh.code, device: device().claim }),
    ).resolves.toMatchObject({ gatewayKey: s.t.gateway.context.identity.publicKey });
  });

  it("accepts only the claim handshake before connect on the LAN", async () => {
    const s = await startClaimable();
    // connect is refused while claim mode runs, and the connection closes.
    const c = await lanClient(s.port);
    open.push(c);
    const r = await c.request("connect", {
      protocolVersion: { min: 1, max: 1 },
      deviceId: "someone",
      publicKey: newDeviceKey().publicKey,
      role: "client",
      platform: "macos",
      deviceFamily: "desktop",
      name: "neighbour",
    });
    expect(r).toMatchObject({
      ok: false,
      error: { code: "forbidden", details: { reason: "claim_mode" } },
    });
    // Any other method is not_paired.
    const c2 = await lanClient(s.port);
    open.push(c2);
    expect(await c2.request("threads.list", {})).toMatchObject({
      ok: false,
      error: { code: "not_paired" },
    });
    // A prove with no hello first is refused and ends the connection.
    const c3 = await lanClient(s.port);
    open.push(c3);
    expect(
      await c3.request("gateway.claim.prove", { proof: randomBytes(32).toString("base64url") }),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
    // The claim handshake is not offered on loopback.
    const local = await TestClient.open(`ws://127.0.0.1:${s.t.gateway.port}/ws`);
    open.push(local);
    expect(
      await local.request("gateway.claim.hello", {
        clientNonce: randomBytes(32).toString("base64url"),
        ...device().claim,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "forbidden", details: { reason: "not_claimable" } },
    });
  });

  it("the client refuses a server that does not know the code", async () => {
    const s = await startClaimable();
    // The code on disk is replaced by one the client was never told: the server now "knows" a
    // different code, so it refuses the client's proof. (A server that accepts any proof is in
    // the desktop's claim-client test: the client refuses its answer.)
    await makeSetupCode(s.t.home);
    const err = await claimServer({
      host: "127.0.0.1",
      port: s.port,
      code: s.code as string,
      device: device().claim,
    }).catch((e: unknown) => e as ClaimError);
    expect((err as ClaimError).problem).toBe("wrong_code");
  });
});

describe("a claim whose last steps go wrong or whose reply is lost", () => {
  const claimWith = (s: Started, d: ReturnType<typeof device>, code = s.code as string) =>
    claimServer({ host: "127.0.0.1", port: s.port, code, device: d.claim });

  it("still returns the server proof when removing the setup code fails after the commit", async () => {
    const s = await startClaimable();
    const d = device();
    failing.removeSetupCode = true;
    const got = await claimWith(s, d);
    expect(got.gatewayKey).toBe(s.t.gateway.context.identity.publicKey);
    const ctx = s.t.gateway.context;
    expect(listDevices(ctx.db).filter((x) => x.scopes.includes("operator.admin"))).toHaveLength(1);
    expect(ctx.claim?.active()).toBe(false);
    // The spent code file is still there, but claim mode is over: nobody else gets in with it.
    await expect(claimWith(s, device())).rejects.toMatchObject({ problem: "not_claimable" });
  });

  it("lets the same device key repeat the claim when the reply was lost", async () => {
    const s = await startClaimable();
    const d = device();
    const first = await claimWith(s, d);
    // The server cannot tell a lost reply from a repeat: the same key asks again.
    const again = await claimWith(s, d);
    expect(again).toMatchObject({ gatewayKey: first.gatewayKey, certSpki: first.certSpki });
    const admins = listDevices(s.t.gateway.context.db).filter((x) =>
      x.scopes.includes("operator.admin"),
    );
    expect(admins.map((x) => x.id)).toEqual([d.claim.deviceId]);
    // A wrong code on the repeat is refused and counted like any other.
    await expect(claimWith(s, d, "AAAAA-AAAAA")).rejects.toMatchObject({ problem: "wrong_code" });
  });

  it("refuses a different device, or the same id with another key, after a claim", async () => {
    const s = await startClaimable();
    const d = device();
    await claimWith(s, d);
    await expect(claimWith(s, device())).rejects.toMatchObject({ problem: "not_claimable" });
    const other = newDeviceKey();
    await expect(
      claimServer({
        host: "127.0.0.1",
        port: s.port,
        code: s.code as string,
        device: { ...d.claim, publicKey: other.publicKey },
      }),
    ).rejects.toMatchObject({ problem: "not_claimable" });
    expect(
      listDevices(s.t.gateway.context.db).filter((x) => x.scopes.includes("operator.admin")),
    ).toHaveLength(1);
  });

  it("stops answering repeats once the window has passed", async () => {
    const s = await startClaimable({ limits: { retryWindowMs: 1 } });
    const d = device();
    await claimWith(s, d);
    await new Promise((r) => setTimeout(r, 30));
    await expect(claimWith(s, d)).rejects.toMatchObject({ problem: "not_claimable" });
  });

  it("makes exactly one admin when two right claims arrive together", async () => {
    const s = await startClaimable();
    const results = await Promise.allSettled([claimWith(s, device()), claimWith(s, device())]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ problem: "not_claimable" });
    expect(
      listDevices(s.t.gateway.context.db).filter((x) => x.scopes.includes("operator.admin")),
    ).toHaveLength(1);
  });

  it("refuses gateway.claim.finish to a device that is not an admin", async () => {
    const s = await startClaimable();
    await claimWith(s, device());
    const ctx = s.t.gateway.context;
    const key = newDeviceKey();
    const deviceId = "reader-1";
    insertDevice(ctx.db, {
      id: deviceId,
      name: "reader",
      platform: "macos",
      role: "client",
      publicKey: key.publicKey,
      scopes: ["operator.read", "operator.write"],
      pairedAt: new Date().toISOString(),
      deviceFamily: "desktop",
    });
    const c = await lanClient(s.port);
    open.push(c);
    const r = await handshake(c, `https://127.0.0.1:${s.port}`, {
      key,
      deviceId,
      gatewayKey: ctx.identity.publicKey,
    });
    expect((r.verifyRes?.payload as { phase?: string } | undefined)?.phase).toBe("paired");
    const res = await c.request("gateway.claim.finish", { keepLan: false });
    expect(res).toMatchObject({ ok: false });
    expect(ctx.claim?.lanChoicePending()).toBe(true);
  });
});

describe("a server set up from the terminal", () => {
  it("never enters claim mode once it has an admin device", async () => {
    const db = openDb(":memory:");
    const first = await startClaimable({ db });
    const home = first.t.home;
    expect(first.t.gateway.context.claim?.active()).toBe(true);
    // `psyche setup` paired a CLI admin meanwhile (here: a granted device).
    const admin = await adminClient(first.t.gateway);
    admin.close();
    await first.t.gateway.stop("test");
    t = undefined;
    // Restart on the same data: the admin is there, so it is claimed and claim mode stays off.
    const again = await startClaimable({ home, db });
    expect(again.t.gateway.context.claim?.active()).toBe(false);
    expect(again.code).toBeNull();
    expect(existsSync(setupCodePath(home))).toBe(false);
    expect(existsSync(claimedMarkerPath(home))).toBe(true);
    expect(again.t.gateway.context.lan.status().listening).toEqual([]);
  });
});

describe("gateway.claim.finish", () => {
  it("off: LAN goes back to loopback after the answer; on: it stays", async () => {
    for (const keepLan of [false, true]) {
      const s = await startClaimable();
      const d = device();
      const got = await claimServer({
        host: "127.0.0.1",
        port: s.port,
        code: s.code as string,
        device: d.claim,
      });
      const c = await lanClient(s.port);
      open.push(c);
      await handshake(c, `https://127.0.0.1:${s.port}`, {
        key: d.key,
        deviceId: d.claim.deviceId,
        gatewayKey: got.gatewayKey,
      });
      const res = await c.call("gateway.claim.finish", { keepLan }, `finish-${keepLan}`);
      expect(res).toEqual({ lan: keepLan });
      await new Promise((r) => setTimeout(r, 500));
      const ctx = s.t.gateway.context;
      expect(ctx.lan.status().listening.length).toBe(keepLan ? 1 : 0);
      expect(
        (getSetting(ctx.db, LAN_SETTING)?.value as { enabled: boolean } | undefined)?.enabled,
      ).toBe(keepLan);
      expect(ctx.claim?.lanChoicePending()).toBe(false);
      for (const x of open.splice(0)) x.close();
      await s.t.cleanup();
      t = undefined;
    }
  });
});

describe("linuxDefaultRouteInterface", () => {
  it("reads the interface of the IPv4 default route", () => {
    const table = [
      "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask",
      "docker0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF",
      "eth0\t00000000\t018BA8C0\t0003\t0\t0\t100\t00000000",
    ].join("\n");
    expect(linuxDefaultRouteInterface(() => table)).toBe("eth0");
    expect(linuxDefaultRouteInterface(() => "Iface\tDestination\n")).toBeNull();
    expect(
      linuxDefaultRouteInterface(() => {
        throw new Error("no procfs");
      }),
    ).toBeNull();
  });
});
