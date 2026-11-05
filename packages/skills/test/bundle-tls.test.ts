import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pinnedFetch, pinnedLookup } from "../src/bundle-url.ts";
import { tempDir } from "./helpers.ts";

/**
 * The real pinned transport against a local TLS server with a self-signed certificate. The CA is
 * passed in for the test only: production passes none, so it verifies against the system's CAs,
 * and always checks the certificate against the real host name (`servername`).
 */

let server: Server;
let port = 0;
let cert = "";
const BODY = '{"psyche-bundle":1}';

beforeAll(async () => {
  const dir = tempDir("psyche-tls-");
  writeFileSync(
    join(dir, "openssl.cnf"),
    [
      "[req]",
      "distinguished_name=dn",
      "x509_extensions=v3",
      "prompt=no",
      "[dn]",
      "CN=bundle.test",
      "[v3]",
      "subjectAltName=DNS:bundle.test",
      "basicConstraints=CA:TRUE",
      "",
    ].join("\n"),
  );
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(dir, "k.pem"),
      "-out",
      join(dir, "c.pem"),
      "-days",
      "2",
      "-config",
      join(dir, "openssl.cnf"),
    ],
    { stdio: "ignore" },
  );
  cert = readFileSync(join(dir, "c.pem"), "utf8");
  server = createServer({ key: readFileSync(join(dir, "k.pem")), cert }, (req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "https://bundle.test/elsewhere" });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(BODY);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => {
  server.close();
});

const init = () => ({
  headers: { accept: "application/json" },
  signal: AbortSignal.timeout(10_000),
});

describe("pinnedLookup", () => {
  it("answers both forms: a list for {all: true}, a single address otherwise", () => {
    const l = pinnedLookup("93.184.216.34");
    let got: unknown[] = [];
    l("example.com", { all: true }, (...a) => {
      got = a;
    });
    expect(got).toEqual([null, [{ address: "93.184.216.34", family: 4 }]]);
    l("example.com", {}, (...a) => {
      got = a;
    });
    expect(got).toEqual([null, "93.184.216.34", 4]);
    l("example.com", undefined, (...a) => {
      got = a;
    });
    expect(got).toEqual([null, "93.184.216.34", 4]);
    pinnedLookup("2606:4700::1111")("x", { all: true }, (...a) => {
      got = a;
    });
    expect(got).toEqual([null, [{ address: "2606:4700::1111", family: 6 }]]);
  });
});

describe("pinnedFetch (the production transport)", () => {
  it("connects to the pinned address with the real host name for TLS, under autoSelectFamily", async () => {
    // The URL names bundle.test; nothing resolves it. The connection goes to 127.0.0.1.
    const res = await pinnedFetch(
      `https://bundle.test:${port}/x.psyche-skill`,
      init(),
      "127.0.0.1",
      {
        ca: cert,
      },
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(BODY);
  });

  it("does not follow a redirect itself: the caller re-checks every hop", async () => {
    const res = await pinnedFetch(`https://bundle.test:${port}/redirect`, init(), "127.0.0.1", {
      ca: cert,
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://bundle.test/elsewhere");
  });

  it("still checks the certificate against the host name in the URL", async () => {
    await expect(
      pinnedFetch(`https://other.test:${port}/x`, init(), "127.0.0.1", { ca: cert }),
    ).rejects.toThrow();
  });

  it("with no test CA it verifies against the system's, so a self-signed server is refused", async () => {
    await expect(
      pinnedFetch(`https://bundle.test:${port}/x`, init(), "127.0.0.1"),
    ).rejects.toThrow();
  });
});
