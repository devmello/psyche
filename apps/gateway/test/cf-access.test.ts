import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import type { PairingRequest } from "@psyche/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { CloudflareAccessVerifier } from "../src/cf-access.ts";
import {
  adminClient,
  handshake,
  startTestGateway,
  TestClient,
  type TestGateway,
  verified,
  wsUrlOf,
} from "./helpers.ts";

const TEAM = "myteam.cloudflareaccess.com";
const AUD = "aud-tag-123";

function keypair(kid: string) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    kid,
    privateKey,
    jwk: { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" },
  };
}

function jwt(
  key: { kid: string; privateKey: KeyObject },
  claims: Record<string, unknown>,
  alg = "RS256",
): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = enc({ alg, kid: key.kid, typ: "JWT" });
  const body = enc(claims);
  const sig = sign("RSA-SHA256", Buffer.from(`${head}.${body}`), key.privateKey).toString(
    "base64url",
  );
  return `${head}.${body}.${sig}`;
}

const nowS = () => Math.floor(Date.now() / 1000);
const good = (extra: Record<string, unknown> = {}) => ({
  aud: [AUD],
  iss: `https://${TEAM}`,
  sub: "user-1",
  email: "owner@example.test",
  exp: nowS() + 600,
  iat: nowS(),
  ...extra,
});

function fakeFetch(keys: unknown[]) {
  const calls: string[] = [];
  return {
    calls,
    fetch: async (url: string) => {
      calls.push(url);
      return { ok: true, json: async () => ({ keys }) };
    },
  };
}

describe("CloudflareAccessVerifier", () => {
  const k1 = keypair("k1");
  const other = keypair("k2");

  it("accepts a valid assertion and fetches the team's certs", async () => {
    const f = fakeFetch([k1.jwk]);
    const v = new CloudflareAccessVerifier({ teamDomain: TEAM, audience: AUD }, { fetch: f.fetch });
    expect(await v.verify(jwt(k1, good()))).toEqual({
      subject: "user-1",
      email: "owner@example.test",
    });
    expect(f.calls).toEqual([`https://${TEAM}/cdn-cgi/access/certs`]);
  });

  it.each([
    ["missing", undefined],
    ["malformed", "a.b"],
    ["wrong audience", "aud"],
    ["wrong issuer", "iss"],
    ["expired", "exp"],
    ["not yet valid", "nbf"],
    ["unknown key", "kid"],
    ["unsupported algorithm", "alg"],
    ["bad signature", "sig"],
  ])("rejects %s", async (reason, how) => {
    const v = new CloudflareAccessVerifier(
      { teamDomain: TEAM, audience: AUD },
      { fetch: fakeFetch([k1.jwk]).fetch },
    );
    let token: string | undefined;
    if (how === undefined) token = undefined;
    else if (how === "a.b") token = "a.b";
    else if (how === "aud") token = jwt(k1, good({ aud: ["someone-else"] }));
    else if (how === "iss") token = jwt(k1, good({ iss: "https://evil.cloudflareaccess.com" }));
    else if (how === "exp") token = jwt(k1, good({ exp: nowS() - 3600 }));
    else if (how === "nbf") token = jwt(k1, good({ nbf: nowS() + 3600 }));
    else if (how === "kid") token = jwt(other, good());
    else if (how === "alg") token = jwt(k1, good(), "none");
    else {
      const [h, p] = jwt(k1, good()).split(".");
      token = `${h}.${p}.${jwt(other, good()).split(".")[2]}`;
    }
    await expect(v.verify(token)).rejects.toMatchObject({
      code: "unauthorized",
      message: expect.stringContaining(reason),
    });
  });

  it("re-fetches keys hourly: a rotated-out key stops verifying; stale keys fail closed", async () => {
    let t = Date.now();
    let keys: unknown[] = [k1.jwk];
    let up = true;
    const calls: string[] = [];
    const v = new CloudflareAccessVerifier(
      { teamDomain: TEAM, audience: AUD },
      {
        now: () => t,
        fetch: async (url) => {
          calls.push(url);
          return { ok: up, json: async () => ({ keys }) };
        },
      },
    );
    const token = () =>
      jwt(k1, good({ exp: Math.floor(t / 1000) + 600, iat: Math.floor(t / 1000) }));
    await v.verify(token());
    t += 30 * 60_000;
    await v.verify(token());
    expect(calls).toHaveLength(1); // cached within the hour
    keys = [other.jwk]; // Cloudflare rotated k1 out
    t += 31 * 60_000;
    await expect(v.verify(token())).rejects.toMatchObject({
      message: expect.stringContaining("unknown key"),
    });
    expect(calls).toHaveLength(2);

    // The JWKS endpoint goes away: cached keys serve for a day, then nothing verifies.
    keys = [k1.jwk];
    t += 61 * 60_000;
    await v.verify(token());
    up = false;
    t += 23 * 60 * 60_000;
    await v.verify(token());
    t += 2 * 60 * 60_000;
    await expect(v.verify(token())).rejects.toMatchObject({
      message: expect.stringContaining("stale"),
    });
  });
});

describe("Cloudflare Access in front of the Gateway", () => {
  let t: TestGateway | null = null;
  const clients: TestClient[] = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    await t?.cleanup();
    t = null;
  });

  const k1 = keypair("k1");

  async function setup() {
    t = await startTestGateway({
      config: { cloudflareAccess: { teamDomain: TEAM, audience: AUD } },
      cloudflareAccessFetch: { fetch: fakeFetch([k1.jwk]).fetch },
    });
    return t;
  }

  it("refuses a forwarded upgrade without a valid assertion with 401", async () => {
    const gw = (await setup()).gateway;
    await expect(
      TestClient.open(wsUrlOf(gw), { "X-Forwarded-For": "203.0.113.5" }),
    ).rejects.toThrow(/401/);
    await expect(
      TestClient.open(wsUrlOf(gw), {
        "X-Forwarded-For": "203.0.113.5",
        "Cf-Access-Jwt-Assertion": jwt(k1, good({ aud: ["other"] })),
      }),
    ).rejects.toThrow(/401/);
  });

  it("lets a verified upgrade through to pairing (never auto-paired) and shows the identity", async () => {
    const gw = (await setup()).gateway;
    const admin = await adminClient(gw);
    clients.push(admin);
    const c = await TestClient.open(wsUrlOf(gw), {
      "X-Forwarded-For": "203.0.113.5",
      "Cf-Access-Jwt-Assertion": jwt(k1, good()),
    });
    clients.push(c);
    const res = await handshake(c, gw.origin, { handshakeSecret: gw.handshakeSecret });
    expect(verified<{ phase: string }>(res).phase).toBe("pending");
    const evt = await admin.waitForEvent((e) => e.event === "pairing.requested");
    expect((evt.payload as { pairingRequest: PairingRequest }).pairingRequest.display).toContain(
      "Cloudflare Access owner@example.test",
    );
  });

  it("does not require an assertion from the local desktop", async () => {
    const gw = (await setup()).gateway;
    const c = await TestClient.open(wsUrlOf(gw));
    clients.push(c);
    const res = await handshake(c, gw.origin, { handshakeSecret: gw.handshakeSecret });
    expect(verified<{ phase: string }>(res).phase).toBe("paired");
  });
});
