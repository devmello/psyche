import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpsServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimTranscript } from "@psyche/protocol";
import { claimProof, deriveClaimKey } from "@psyche/protocol/claim-node";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
// Test-only: the Gateway's own certificate maker, so the stand-in serves a real LAN certificate.
import { ensureLanCert } from "../../gateway/src/lan/cert.ts";
import { ClaimError, type ClaimOptions, claimServer } from "../src/lib/claim-client.ts";
import { addGatewayFromClaim, claimOriginFor, EMPTY_GATEWAYS } from "../src/lib/gateways.ts";
import { toDiscovered } from "../src/lib/lan-discovery.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const KEY = "A".repeat(43);
const device = {
  deviceId: "dev_test",
  publicKey: randomBytes(32).toString("base64url"),
  name: "Psyche Desktop (test)",
  platform: "macos" as const,
};

/**
 * A server stand-in that answers the claim handshake however a test says: with the code it
 * knows (`knows`), with a proof it made up (`acceptAnything`), or naming another certificate.
 */
async function fakeServer(opts: {
  knows?: string;
  acceptAnything?: boolean;
  otherSpki?: boolean;
  dropAfterProve?: boolean;
}) {
  const home = mkdtempSync(join(tmpdir(), "psyche-claim-client-"));
  const cert = await ensureLanCert(home, ["lab-box.local", "127.0.0.1"]);
  const server: Server = createHttpsServer({ key: cert.keyPem, cert: cert.certPem });
  const wss = new WebSocketServer({ noServer: true });
  const salt = randomBytes(16);
  const frames: string[] = [];
  server.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      let hello: Record<string, string> | null = null;
      const serverNonce = randomBytes(32).toString("base64url");
      ws.on("message", async (raw) => {
        const f = JSON.parse(raw.toString()) as {
          id: string;
          method: string;
          params: Record<string, string>;
        };
        frames.push(f.method);
        if (f.method === "gateway.claim.hello") {
          hello = f.params;
          ws.send(
            JSON.stringify({
              type: "res",
              id: f.id,
              ok: true,
              payload: {
                serverNonce,
                salt: salt.toString("base64url"),
                gatewayKey: KEY,
                certSpki: opts.otherSpki ? "B".repeat(43) : cert.spki,
                hostName: "lab-box",
                expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
              },
            }),
          );
          return;
        }
        if (opts.dropAfterProve) {
          // The claim went through, the reply never arrives.
          ws.terminate();
          return;
        }
        let proof = randomBytes(32).toString("base64url");
        if (opts.knows !== undefined && hello !== null) {
          const key = await deriveClaimKey(opts.knows, salt);
          const t = claimTranscript({
            clientNonce: hello.clientNonce as string,
            serverNonce,
            salt: salt.toString("base64url"),
            gatewayKey: KEY,
            certSpki: cert.spki,
            deviceId: hello.deviceId as string,
            devicePublicKey: hello.publicKey as string,
          });
          if (claimProof(key, "client", t) !== f.params.proof && !opts.acceptAnything) {
            ws.send(
              JSON.stringify({
                type: "res",
                id: f.id,
                ok: false,
                error: {
                  code: "forbidden",
                  message: "no",
                  details: { reason: "wrong_code", attemptsLeft: 4 },
                },
              }),
            );
            return;
          }
          proof = claimProof(key, "server", t);
        }
        ws.send(
          JSON.stringify({
            type: "res",
            id: f.id,
            ok: true,
            payload: { proof, deviceId: device.deviceId, scopes: ["operator.admin"] },
          }),
        );
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(async () => {
    for (const c of wss.clients) c.terminate();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(home, { recursive: true, force: true });
  });
  return { port: (server.address() as AddressInfo).port, spki: cert.spki, frames };
}

const claim = (port: number, code: string, extra: Partial<ClaimOptions> = {}) =>
  claimServer({ host: "127.0.0.1", port, code, device, ...extra });

describe("the desktop's side of the claim", () => {
  it("pins only what a server that knows the code proved", async () => {
    const s = await fakeServer({ knows: "7K3QM-XR2TD" });
    await expect(claim(s.port, "7k3qm xr2td")).resolves.toEqual({
      gatewayKey: KEY,
      certSpki: s.spki,
      hostName: "lab-box",
    });
  });

  it("refuses a server that accepts the code without knowing it", async () => {
    // It answers prove with a made-up proof: whatever it says about itself is not pinned.
    const s = await fakeServer({ acceptAnything: true });
    const err = await claim(s.port, "7K3QM-XR2TD").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClaimError);
    expect((err as ClaimError).problem).toBe("server_unproven");
  });

  it("says the claim is unconfirmed when the connection drops after the proof was sent", async () => {
    const s = await fakeServer({ knows: "7K3QM-XR2TD", dropAfterProve: true });
    const err = await claim(s.port, "7K3QM-XR2TD").catch((e: unknown) => e);
    expect((err as ClaimError).problem).toBe("unconfirmed");
  });

  it("stops before proving anything when the server names another certificate", async () => {
    const s = await fakeServer({ knows: "7K3QM-XR2TD", otherSpki: true });
    const err = await claim(s.port, "7K3QM-XR2TD").catch((e: unknown) => e);
    expect((err as ClaimError).problem).toBe("cert_mismatch");
    // The proof (which could be guessed at offline) was never sent.
    expect(s.frames).toEqual(["gateway.claim.hello"]);
  });

  it("passes the server's wrong-code answer on with the attempts left", async () => {
    const s = await fakeServer({ knows: "7K3QM-XR2TD" });
    const err = await claim(s.port, "00000-00000").catch((e: unknown) => e);
    expect(err).toMatchObject({ problem: "wrong_code", attemptsLeft: 4 });
  });

  it("checks the code locally and sends nothing for a malformed one", async () => {
    const s = await fakeServer({ knows: "7K3QM-XR2TD" });
    for (const bad of ["", "7K3QM", "7K3QM-XR2TU", "7K3QM-XR2TD-1"]) {
      await expect(claim(s.port, bad)).rejects.toMatchObject({ problem: "bad_code" });
    }
    expect(s.frames).toEqual([]);
  });

  it("says unreachable when nothing answers", async () => {
    const s = await fakeServer({});
    const port = s.port;
    await cleanups.splice(0)[0]?.();
    await expect(claim(port, "7K3QM-XR2TD", { timeoutMs: 2_000 })).rejects.toMatchObject({
      problem: "unreachable",
    });
  });
});

describe("where a claim goes and what it saves", () => {
  it("claims only a local-network address, on the Gateway's port unless one was typed", () => {
    expect(claimOriginFor("192.168.139.196")).toBe("https://192.168.139.196:7979");
    expect(claimOriginFor("lab-box.local")).toBe("https://lab-box.local:7979");
    expect(claimOriginFor("https://192.168.1.20:8443")).toBe("https://192.168.1.20:8443");
    expect(claimOriginFor("https://192.168.1.20:443")).toBe("https://192.168.1.20");
    for (const bad of ["example.com", "8.8.8.8", "100.100.1.1", "studio.tail1234.ts.net", ""]) {
      expect(() => claimOriginFor(bad)).toThrow();
    }
  });

  it("pins the key and certificate at once, like a v2 link", () => {
    const r = addGatewayFromClaim(
      EMPTY_GATEWAYS,
      { origin: "https://192.168.1.20:7979", gatewayKey: KEY, certPin: "B".repeat(43) },
      "gw_0123456789ab",
    );
    expect(r.entry).toMatchObject({
      id: "gw_0123456789ab",
      origin: "https://192.168.1.20:7979",
      identityKey: KEY,
      certPin: "B".repeat(43),
      lan: true,
    });
    expect(r.entry.setupToken).toBeUndefined();
    // Another key for an address already pinned is refused, never swapped in.
    expect(() =>
      addGatewayFromClaim(
        r.gateways,
        {
          origin: "https://192.168.1.20:7979",
          gatewayKey: "C".repeat(43),
          certPin: "B".repeat(43),
        },
        "gw_0123456789ab",
      ),
    ).toThrow();
  });

  it("reads claim=1 from the network as a hint", () => {
    const base = {
      host: "lab-box.local",
      port: 7979,
      txt: { v: "1", name: "lab-box", fp: "cd".repeat(32) },
    };
    expect(toDiscovered(base)?.claimable).toBe(false);
    expect(toDiscovered({ ...base, txt: { ...base.txt, claim: "1" } })?.claimable).toBe(true);
    expect(toDiscovered({ ...base, txt: { ...base.txt, claim: "yes" } })?.claimable).toBe(false);
  });
});

describe("GatewayManager.claim", () => {
  const target = {
    id: "this-mac",
    name: "This Mac",
    origin: "http://127.0.0.1:7979",
    remote: false,
    dataDir: null,
  };

  it("confirms natively, claims with this computer's key for it, and saves it pinned", async () => {
    const { GatewayManager } = await import("../src/main/gateway-manager.ts");
    const userData = mkdtempSync(join(tmpdir(), "psyche-claim-ud-"));
    cleanups.push(() => rmSync(userData, { recursive: true, force: true }));
    const asked: unknown[] = [];
    let sent: ClaimOptions | undefined;
    const m = new GatewayManager({
      userData,
      target,
      confirm: async (c) => {
        asked.push(c);
        return true;
      },
      relaunch: () => {},
      claimServer: async (o) => {
        sent = o;
        return { gatewayKey: KEY, certSpki: "B".repeat(43), hostName: "lab-box" };
      },
    });
    const view = await m.claim("192.168.139.196", "7K3QM-XR2TD");
    expect(asked).toEqual([{ kind: "claim", origin: "https://192.168.139.196:7979" }]);
    expect(sent).toMatchObject({ host: "192.168.139.196", port: 7979, code: "7K3QM-XR2TD" });
    expect(view).toMatchObject({ remote: true, pinned: true, lan: true });
    // The key that claimed is the one this Gateway's entry will connect with.
    const keyFile = join(userData, "gateways", view.id, "device-key.json");
    expect(JSON.parse(readFileSync(keyFile, "utf8")).deviceId).toBe(sent?.device.deviceId);
  });

  it("saves nothing and drops the new key when the claim fails or is cancelled", async () => {
    const { GatewayManager } = await import("../src/main/gateway-manager.ts");
    const userData = mkdtempSync(join(tmpdir(), "psyche-claim-ud-"));
    cleanups.push(() => rmSync(userData, { recursive: true, force: true }));
    const m = new GatewayManager({
      userData,
      target,
      confirm: async () => true,
      relaunch: () => {},
      claimServer: async () => {
        throw new ClaimError("wrong_code", { attemptsLeft: 2 });
      },
    });
    await expect(m.claim("192.168.139.196", "7K3QM-XR2TD")).rejects.toMatchObject({
      code: "forbidden",
      details: { problem: "claim_wrong_code", attemptsLeft: 2 },
    });
    expect(m.list().length).toBe(1);
    const dirs = join(userData, "gateways");
    expect(existsSync(dirs) ? readdirSync(dirs) : []).toEqual([]);
    const cancelled = new GatewayManager({
      userData,
      target,
      confirm: async () => false,
      relaunch: () => {},
    });
    await expect(cancelled.claim("192.168.139.196", "7K3QM-XR2TD")).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(cancelled.claim("example.com", "7K3QM-XR2TD")).rejects.toMatchObject({
      details: { problem: "claim_not_lan" },
    });
  });
});
