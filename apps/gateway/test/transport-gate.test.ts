import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CloudflareAccessVerifier } from "../src/cf-access.ts";
import { resolveConfig } from "../src/config.ts";
import { resolvePeer, trustedProxyList } from "../src/proxy.ts";
import { readGatewayToken, TransportGate } from "../src/transport-gate.ts";

const TOKEN = "t".repeat(48);
const TEAM = "myteam.cloudflareaccess.com";
const AUD = "aud-1";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tokenFile(mode: number, body = TOKEN): string {
  const d = mkdtempSync(join(tmpdir(), "psyche-tok-"));
  dirs.push(d);
  const p = join(d, "token");
  writeFileSync(p, `${body}\n`);
  chmodSync(p, mode);
  return p;
}

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1" };
function accessJwt(key: KeyObject = privateKey): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const h = enc({ alg: "RS256", kid: "k1" });
  const p = enc({
    aud: [AUD],
    iss: `https://${TEAM}`,
    sub: "u1",
    email: "owner@example.test",
    exp: now + 600,
  });
  return `${h}.${p}.${sign("RSA-SHA256", Buffer.from(`${h}.${p}`), key).toString("base64url")}`;
}

// The Compose network: proxies at 172.20.0.2 (cloudflared) and 172.20.0.3 (tailscale).
const trusted = ["172.20.0.2/32", "172.20.0.3/32"];
function gate(): TransportGate {
  return new TransportGate({
    mode: "container",
    token: TOKEN,
    trustedProxies: trustedProxyList(trusted),
    tailscaleProxies: trustedProxyList(["172.20.0.3/32"]),
    cfAccess: new CloudflareAccessVerifier(
      { teamDomain: TEAM, audience: AUD },
      { fetch: async () => ({ ok: true, json: async () => ({ keys: [jwk] }) }) },
    ),
  });
}

function req(remoteAddress: string, headers: Record<string, string> = {}): IncomingMessage {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { socket: { remoteAddress }, headers: lower } as unknown as IncomingMessage;
}

async function admit(r: IncomingMessage) {
  return gate().admit(
    r,
    resolvePeer(
      r.socket.remoteAddress,
      r.headers,
      { enabled: true, trustedProxies: trusted },
      trustedProxyList(trusted),
    ),
  );
}

describe("container bind transport gate (security §10, issue #79)", () => {
  it("refuses a trusted-proxy peer that carries no verified identity", async () => {
    expect(await admit(req("172.20.0.2", { "X-Forwarded-For": "203.0.113.9" }))).toEqual({
      refused: "proxy_identity_required",
    });
    // Tailscale headers only count from the tailscale proxy.
    expect(
      await admit(req("172.20.0.2", { "Tailscale-User-Login": "owner@example.test" })),
    ).toEqual({
      refused: "proxy_identity_required",
    });
  });

  it("accepts a trusted proxy with a valid Access JWT, and refuses an invalid one", async () => {
    const ok = await admit(
      req("172.20.0.2", {
        "X-Forwarded-For": "203.0.113.9",
        "Cf-Access-Jwt-Assertion": accessJwt(),
      }),
    );
    expect(ok).toMatchObject({
      peer: { claimedIdentity: "Cloudflare Access owner@example.test", remoteLoopback: false },
    });
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    expect(await admit(req("172.20.0.2", { "Cf-Access-Jwt-Assertion": accessJwt(other) }))).toEqual(
      {
        refused: "cloudflare_access",
      },
    );
  });

  it("accepts the Tailscale identity headers from the tailscale proxy", async () => {
    const ok = await admit(
      req("172.20.0.3", {
        "X-Forwarded-For": "100.64.1.2",
        "Tailscale-User-Login": "owner@example.test",
      }),
    );
    expect(ok).toMatchObject({ peer: { claimedIdentity: "Tailscale owner@example.test" } });
  });

  it("refuses a non-proxy peer without the token and accepts it with the token", async () => {
    expect(await admit(req("172.20.0.9"))).toEqual({ refused: "token_required" });
    expect(await admit(req("172.20.0.9", { Authorization: `Bearer ${"x".repeat(48)}` }))).toEqual({
      refused: "token_required",
    });
    // Identity headers from a non-proxy peer are worth nothing.
    expect(
      await admit(req("172.20.0.9", { "Tailscale-User-Login": "owner@example.test" })),
    ).toEqual({
      refused: "token_required",
    });
    expect(await admit(req("172.20.0.9", { Authorization: `Bearer ${TOKEN}` }))).toMatchObject({
      peer: {},
    });
  });
});

describe("container bind startup", () => {
  it("refuses a token file with loose permissions", () => {
    expect(() => readGatewayToken(tokenFile(0o644))).toThrow(/0600/);
    expect(() => readGatewayToken(tokenFile(0o640))).toThrow(/0600/);
    expect(readGatewayToken(tokenFile(0o600))).toBe(TOKEN);
    expect(readGatewayToken(tokenFile(0o400))).toBe(TOKEN);
  });

  it("requires the token file, a long token and a real interface address", () => {
    const home = mkdtempSync(join(tmpdir(), "psyche-bind-"));
    dirs.push(home);
    const env = (extra: Record<string, string>) => ({
      PSYCHE_HOME: home,
      PSYCHE_BIND: "container",
      ...extra,
    });
    expect(() => resolveConfig(env({ PSYCHE_HOST: "10.9.8.7" }))).toThrow(
      /PSYCHE_GATEWAY_TOKEN_FILE/,
    );
    expect(() =>
      resolveConfig(
        env({ PSYCHE_HOST: "10.9.8.7", PSYCHE_GATEWAY_TOKEN_FILE: tokenFile(0o600, "short") }),
      ),
    ).toThrow(/at least/);
    for (const host of ["0.0.0.0", "::", "127.0.0.1"]) {
      expect(() =>
        resolveConfig(env({ PSYCHE_HOST: host, PSYCHE_GATEWAY_TOKEN_FILE: tokenFile(0o600) })),
      ).toThrow(/Refusing to bind/);
    }
    const cfg = resolveConfig(
      env({ PSYCHE_HOST: "10.9.8.7", PSYCHE_GATEWAY_TOKEN_FILE: tokenFile(0o600) }),
    );
    expect(cfg).toMatchObject({ bind: "container", host: "10.9.8.7", gatewayToken: TOKEN });
    expect(() => resolveConfig({ PSYCHE_HOME: home, PSYCHE_BIND: "everywhere" })).toThrow(
      /PSYCHE_BIND/,
    );
    // The default stays loopback-only.
    expect(() => resolveConfig({ PSYCHE_HOME: home, PSYCHE_HOST: "10.9.8.7" })).toThrow(
      /Refusing to bind/,
    );
  });
});
