import { createHash, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { clientMetadataDocument, MemoryTokenStore, PsycheMcpHost } from "../src/index.ts";
import { type EchoServer, startEchoServer } from "./fixtures/echo-server.ts";

const CIMD_URL = "https://psyche.example/oauth/client-metadata.json";

interface MockAs {
  server: EchoServer;
  hits: { register: number; authorize: URLSearchParams[]; token: URLSearchParams[] };
  issued: Set<string>;
}

/**
 * Mock authorization server on the resource server's origin: RFC 9728 protected resource
 * metadata, RFC 8414 AS metadata, an authorize endpoint that "consents" immediately and
 * redirects back with code + state + iss, and a token endpoint that verifies PKCE S256.
 */
async function startMockAs(options: { cimd: boolean; registration?: boolean }): Promise<MockAs> {
  const hits: MockAs["hits"] = { register: 0, authorize: [], token: [] };
  const issued = new Set<string>();
  const codes = new Map<string, { challenge: string; redirect: string; clientId: string }>();
  let origin = "";
  const server = await startEchoServer({
    requireToken: () => [...issued].at(-1),
    extraRoutes: async (req) => {
      const url = new URL(req.url);
      origin = url.origin;
      if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
        return Response.json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          authorization_response_iss_parameter_supported: true,
          client_id_metadata_document_supported: options.cimd,
          ...(options.registration === true ? { registration_endpoint: `${origin}/register` } : {}),
        });
      }
      if (url.pathname === "/register") {
        hits.register += 1;
        return Response.json({ client_id: "dcr-client", redirect_uris: [] }, { status: 201 });
      }
      if (url.pathname === "/authorize") {
        const q = url.searchParams;
        hits.authorize.push(q);
        // Without CIMD support the AS does not know the URL client id and refuses it.
        if (
          q.get("code_challenge_method") !== "S256" ||
          q.get("client_id") !== CIMD_URL ||
          !options.cimd
        ) {
          return new Response("bad request", { status: 400 });
        }
        const code = randomBytes(8).toString("hex");
        codes.set(code, {
          challenge: q.get("code_challenge") ?? "",
          redirect: q.get("redirect_uri") ?? "",
          clientId: q.get("client_id") ?? "",
        });
        const back = new URL(q.get("redirect_uri") ?? "");
        back.searchParams.set("code", code);
        back.searchParams.set("state", q.get("state") ?? "");
        back.searchParams.set("iss", origin);
        return Response.redirect(back.href, 302);
      }
      if (url.pathname === "/token" && req.method === "POST") {
        const form = new URLSearchParams(await req.text());
        hits.token.push(form);
        const entry = codes.get(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        if (
          entry === undefined ||
          entry.challenge !== challenge ||
          entry.redirect !== form.get("redirect_uri") ||
          entry.clientId !== form.get("client_id")
        ) {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        codes.delete(form.get("code") ?? "");
        const token = `at_${randomBytes(12).toString("hex")}`;
        issued.add(token);
        return Response.json({ access_token: token, token_type: "Bearer", expires_in: 3600 });
      }
      return undefined;
    },
  });
  return { server, hits, issued };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("OAuth 2.1 with a Client ID Metadata Document", () => {
  it("runs PRM discovery, authorize with PKCE + state on a loopback redirect, then connects", async () => {
    const as = await startMockAs({ cimd: true, registration: true });
    const store = new MemoryTokenStore();
    const opened: URL[] = [];
    const host = new PsycheMcpHost({
      oauth: {
        clientMetadataUrl: CIMD_URL,
        tokenStore: store,
        openAuthorizationUrl: ({ url }) => {
          opened.push(url);
          // The "browser": follow the AS redirect back to the loopback receiver.
          void fetch(url);
        },
        timeoutMs: 10_000,
      },
    });
    cleanups.push(
      () => as.server.close(),
      () => host.close(),
    );
    const info = await host.addServer({
      id: "remote",
      name: "Remote",
      trust: "verified",
      transport: { kind: "http", url: as.server.url },
    });
    expect(info.status).toBe("connected");
    expect(opened).toHaveLength(1);
    const q = as.hits.authorize[0];
    expect(q?.get("client_id")).toBe(CIMD_URL);
    expect(q?.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(q?.get("state")?.length).toBeGreaterThan(20);
    expect(q?.get("resource")).toBe(as.server.url);
    expect(as.hits.register).toBe(0);
    expect((await store.load(`remote|${as.server.url}`))?.access_token).toMatch(/^at_/);
    const { toolsListHash } = await host.listTools("remote");
    const authed = await host.callTool("remote", "echo", { text: "authed" }, { toolsListHash });
    expect(authed.isError).toBe(false);
    await host.removeServer("remote");
    expect(await store.load(`remote|${as.server.url}`)).toBeUndefined();
  });

  it("reuses stored tokens without a new authorization", async () => {
    const as = await startMockAs({ cimd: true });
    const store = new MemoryTokenStore();
    let opens = 0;
    const host = new PsycheMcpHost({
      oauth: {
        clientMetadataUrl: CIMD_URL,
        tokenStore: store,
        openAuthorizationUrl: ({ url }) => {
          opens += 1;
          void fetch(url);
        },
      },
    });
    cleanups.push(
      () => as.server.close(),
      () => host.close(),
    );
    const cfg = {
      id: "r",
      name: "R",
      trust: "unknown" as const,
      transport: { kind: "http" as const, url: as.server.url },
    };
    expect((await host.addServer(cfg)).status).toBe("connected");
    expect((await host.connect("r")).status).toBe("connected");
    expect(opens).toBe(1);
  });

  it("never falls back to dynamic client registration", async () => {
    const as = await startMockAs({ cimd: false, registration: true });
    const host = new PsycheMcpHost({
      oauth: {
        clientMetadataUrl: CIMD_URL,
        tokenStore: new MemoryTokenStore(),
        openAuthorizationUrl: ({ url }) => void fetch(url),
        timeoutMs: 2000,
      },
    });
    cleanups.push(
      () => as.server.close(),
      () => host.close(),
    );
    const info = await host.addServer({
      id: "nodcr",
      name: "x",
      trust: "unknown",
      transport: { kind: "http", url: as.server.url },
    });
    expect(info.status).toBe("error");
    expect(as.hits.register).toBe(0);
    expect(as.hits.token).toHaveLength(0);
  });

  it("ignores a callback with the wrong state and times out", async () => {
    const as = await startMockAs({ cimd: true });
    const host = new PsycheMcpHost({
      oauth: {
        clientMetadataUrl: CIMD_URL,
        tokenStore: new MemoryTokenStore(),
        openAuthorizationUrl: async ({ url }) => {
          const forged = new URL(url.searchParams.get("redirect_uri") ?? "");
          forged.searchParams.set("code", "attacker");
          forged.searchParams.set("state", "forged");
          const res = await fetch(forged);
          expect(res.status).toBe(400);
        },
        timeoutMs: 300,
      },
    });
    cleanups.push(
      () => as.server.close(),
      () => host.close(),
    );
    const info = await host.addServer({
      id: "csrf",
      name: "x",
      trust: "unknown",
      transport: { kind: "http", url: as.server.url },
    });
    expect(info.status).toBe("error");
    expect(host.describe("csrf").error).toMatch(/not completed in time/);
    expect(as.hits.token).toHaveLength(0);
  });

  it("publishes a valid metadata document and rejects a non-HTTPS client id URL", () => {
    expect(clientMetadataDocument(CIMD_URL)).toMatchObject({
      client_id: CIMD_URL,
      token_endpoint_auth_method: "none",
    });
    expect(
      () =>
        new PsycheMcpHost({
          oauth: {
            clientMetadataUrl: "http://psyche.example/c.json",
            tokenStore: new MemoryTokenStore(),
            openAuthorizationUrl: () => {},
          },
        }),
    ).toThrow(/HTTPS/);
  });
});
