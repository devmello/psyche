import type { PairingRequest } from "@psyche/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.ts";
import { resolvePeer, trustedProxyList } from "../src/proxy.ts";
import {
  adminClient,
  handshake,
  startTestGateway,
  TestClient,
  type TestGateway,
  verified,
  wsUrlOf,
} from "./helpers.ts";

const OFF = { enabled: false, trustedProxies: [] };
const ON = { enabled: true, trustedProxies: ["127.0.0.1/32", "::1", "100.64.0.0/10"] };
const onList = trustedProxyList(ON.trustedProxies);

describe("resolvePeer", () => {
  it("treats a direct loopback connection without forwarding headers as loopback", () => {
    expect(resolvePeer("127.0.0.1", {}, OFF, trustedProxyList([]))).toMatchObject({
      remoteAddress: "127.0.0.1",
      remoteLoopback: true,
      forwarded: false,
    });
    expect(resolvePeer("::ffff:127.0.0.1", {}, OFF, trustedProxyList([])).remoteAddress).toBe(
      "127.0.0.1",
    );
  });

  it("never treats a forwarded connection as loopback, even with the mode off", () => {
    for (const h of [
      { "x-forwarded-for": "203.0.113.9" },
      { forwarded: "for=203.0.113.9" },
      { "x-real-ip": "1.2.3.4" },
    ]) {
      const p = resolvePeer("127.0.0.1", h, OFF, trustedProxyList([]));
      expect(p).toMatchObject({
        remoteLoopback: false,
        forwarded: true,
        remoteAddress: "127.0.0.1",
        claimedIdentity: null,
      });
    }
  });

  it("in trusted-proxy mode takes the first untrusted X-Forwarded-For hop from the right", () => {
    const p = resolvePeer(
      "127.0.0.1",
      { "x-forwarded-for": "6.6.6.6, 203.0.113.9, 100.64.1.2" },
      ON,
      onList,
    );
    expect(p).toMatchObject({ remoteAddress: "203.0.113.9", remoteLoopback: false });
  });

  it("ignores forwarding headers from a peer that is not a trusted proxy", () => {
    const p = resolvePeer(
      "192.0.2.7",
      { "x-forwarded-for": "203.0.113.9", "tailscale-user-login": "a@b" },
      ON,
      onList,
    );
    expect(p).toMatchObject({ remoteAddress: "192.0.2.7", claimedIdentity: null });
  });

  it("reports the Tailscale login only as a claim, and stops at garbage hops", () => {
    const p = resolvePeer(
      "127.0.0.1",
      { "x-forwarded-for": "not-an-ip", "tailscale-user-login": "owner@example.test" },
      ON,
      onList,
    );
    expect(p).toMatchObject({
      remoteAddress: "127.0.0.1",
      claimedIdentity: "owner@example.test",
      remoteLoopback: false,
    });
  });

  it("rejects malformed trustedProxies at startup", () => {
    for (const bad of ["10.0.0.0/33", "nonsense", "10.0.0.1/8/1", "::1/129"]) {
      expect(() => trustedProxyList([bad])).toThrow(/trustedProxies/);
    }
    expect(() =>
      resolveConfig({}, { home: "/tmp/psyche-proxy-cfg", trustedProxy: ON }),
    ).not.toThrow();
  });
});

describe("trusted-proxy mode end to end", () => {
  let t: TestGateway;
  const clients: TestClient[] = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    await t?.cleanup();
  });

  async function open(headers: Record<string, string>): Promise<TestClient> {
    const c = await TestClient.open(wsUrlOf(t.gateway), headers);
    clients.push(c);
    return c;
  }

  it("does not auto-pair a forwarded connection that presents the handshake secret", async () => {
    t = await startTestGateway();
    const c = await open({ "X-Forwarded-For": "203.0.113.9" });
    const res = await handshake(c, t.gateway.origin, {
      handshakeSecret: t.gateway.handshakeSecret,
    });
    expect(verified<{ phase: string }>(res).phase).toBe("pending");
  });

  it("records the client address and the proxy's claim on the pairing card, and limits per client", async () => {
    t = await startTestGateway({ config: { trustedProxy: ON }, limits: { pairingsPerHour: 1 } });
    const admin = await adminClient(t.gateway);
    clients.push(admin);
    const headers = {
      "X-Forwarded-For": "100.101.102.103",
      "Tailscale-User-Login": "owner@example.test",
    };
    const first = await handshake(await open(headers), t.gateway.origin, {});
    expect(verified<{ phase: string }>(first).phase).toBe("pending");
    const evt = await admin.waitForEvent((e) => e.event === "pairing.requested");
    const request = (evt.payload as { pairingRequest: PairingRequest }).pairingRequest;
    expect(request.remoteAddress).toBe("100.101.102.103");
    expect(request.display).toContain("proxy says owner@example.test");
    // The per-address limit applies to the client behind the proxy, not to the proxy itself.
    const second = await handshake(await open(headers), t.gateway.origin, {});
    expect(second.verifyRes).toMatchObject({ ok: false, error: { code: "rate_limited" } });
    const other = await handshake(
      await open({ "X-Forwarded-For": "100.64.9.9, 203.0.113.50" }),
      t.gateway.origin,
      {},
    );
    expect(verified<{ phase: string }>(other).phase).toBe("pending");
  });
});
