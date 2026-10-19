import { MockGateway } from "@psyche/web/testing";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.ts";
import { HANDLERS } from "./fixtures.ts";
import { cleanupTempDirs, closedPort, err, makeDeps, out, runJson } from "./helpers.ts";

const running: MockGateway[] = [];

async function startGateway(opts: ConstructorParameters<typeof MockGateway>[0]) {
  const gw = await new MockGateway({ handlers: HANDLERS, ...opts }).start();
  running.push(gw);
  return gw;
}

afterEach(async () => {
  for (const g of running.splice(0)) await g.stop();
  cleanupTempDirs();
});

describe("pairing outcomes", () => {
  it("pending → exit 3 with the code and the approve command", async () => {
    const gw = await startGateway({ pair: { phase: "pending", code: "WXYZ-1234" } });
    const deps = makeDeps();
    const code = await run(["vault", "status", "--url", gw.origin], deps);
    expect(code).toBe(3);
    expect(err(deps)).toContain("WXYZ-1234");
    expect(err(deps)).toContain("psyched devices approve WXYZ-1234");
    expect(out(deps)).toBe("");
    expect(gw.calls).toHaveLength(0);
  });

  it("pending --json → error code pairing with the code in details", async () => {
    const gw = await startGateway({ pair: { phase: "pending", code: "WXYZ-1234" } });
    const deps = makeDeps();
    const { code, json } = await runJson(["vault", "status", "--url", gw.origin], deps);
    expect(code).toBe(3);
    expect(json).toMatchObject({
      ok: false,
      error: { code: "pairing", details: { code: "WXYZ-1234" } },
    });
  });

  it("denied → exit 3 with the reason", async () => {
    const gw = await startGateway({ pair: { phase: "denied", reason: "unknown device" } });
    const deps = makeDeps();
    expect(await run(["devices", "list", "--url", gw.origin], deps)).toBe(3);
    expect(err(deps)).toContain("unknown device");
    const j = makeDeps();
    const { code, json } = await runJson(["devices", "list", "--url", gw.origin], j);
    expect(code).toBe(3);
    expect(json).toMatchObject({ ok: false, error: { code: "pairing" } });
  });

  it("a pairing that is approved later works on the next run with the same identity", async () => {
    const gw = await startGateway({ pair: { phase: "pending", code: "WXYZ-1234" } });
    const deps = makeDeps();
    expect(await run(["vault", "status", "--url", gw.origin], deps)).toBe(3);
    gw.pair = { phase: "paired", scopes: ["operator.read"] };
    expect(await run(["vault", "status", "--url", gw.origin], deps)).toBe(0);
    expect(gw.connects[0]?.deviceId).toBe(gw.connects[1]?.deviceId);
  });
});

describe("Gateway URL and reachability", () => {
  it("unreachable Gateway (closed port) → exit 4", async () => {
    const port = await closedPort();
    const deps = makeDeps();
    expect(await run(["vault", "status", "--url", `http://127.0.0.1:${port}`], deps)).toBe(4);
    expect(err(deps)).toMatch(/Gateway/);
    const j = makeDeps();
    const { code, json } = await runJson(
      ["devices", "list", "--url", `http://127.0.0.1:${port}`],
      j,
    );
    expect(code).toBe(4);
    expect(json).toMatchObject({ ok: false, error: { code: "unreachable" } });
  });

  it("PSYCHE_URL in the environment is used when --url is absent", async () => {
    const gw = await startGateway({});
    const deps = makeDeps({ extraEnv: { PSYCHE_URL: gw.origin } });
    expect(await run(["vault", "status"], deps)).toBe(0);
    expect(gw.connects).toHaveLength(1);
  });

  it("plain http to a non-loopback host is refused (exit 2)", async () => {
    const deps = makeDeps();
    expect(await run(["vault", "status", "--url", "http://example.com"], deps)).toBe(2);
    expect(err(deps)).toContain("Refusing plain http to example.com");
  });

  it("--insecure lifts the plain-http check", async () => {
    // `status` resolves the URL first (usage error without --insecure); with it the URL is
    // accepted and only the (stubbed, offline) HTTP probe runs.
    const offline = (() => Promise.reject(new TypeError("offline"))) as typeof fetch;
    const deps = makeDeps({ fetch: offline });
    expect(await run(["status", "--url", "http://example.com"], deps)).toBe(2);
    expect(err(deps)).toContain("--insecure");
    const ok = makeDeps({ fetch: offline });
    const { code, json } = await runJson(
      ["status", "--url", "http://example.com", "--insecure"],
      ok,
    );
    expect(code).toBe(1);
    expect(json.gateway).toMatchObject({ url: "http://example.com", reachable: false });
  });

  it("a URL with credentials or a non-http scheme is a usage error", async () => {
    for (const url of ["ftp://127.0.0.1", "http://u:p@127.0.0.1:1", "not a url"]) {
      const deps = makeDeps();
      expect(await run(["vault", "status", "--url", url], deps)).toBe(2);
    }
  });

  it("--timeout must be positive", async () => {
    const deps = makeDeps();
    expect(await run(["vault", "status", "--timeout", "0"], deps)).toBe(2);
  });
});

describe("usage and help", () => {
  it("unknown command → exit 2", async () => {
    const deps = makeDeps();
    expect(await run(["frobnicate"], deps)).toBe(2);
    expect(err(deps)).toContain("Unknown command: frobnicate");
  });

  it("unknown command --json → usage error object", async () => {
    const deps = makeDeps();
    const { code, json } = await runJson(["frobnicate"], deps);
    expect(code).toBe(2);
    expect(json).toMatchObject({ ok: false, error: { code: "usage" } });
  });

  it("unknown subcommand → exit 2", async () => {
    const deps = makeDeps();
    expect(await run(["pairing", "frobnicate"], deps)).toBe(2);
  });

  it("an unknown option → exit 2", async () => {
    const deps = makeDeps();
    expect(await run(["completion", "bash", "--frob"], deps)).toBe(2);
  });

  it("missing arguments → exit 2 with the command's usage", async () => {
    const deps = makeDeps();
    expect(await run(["pairing", "approve"], deps)).toBe(2);
    expect(err(deps)).toContain("Usage: psyche pairing approve <code>");
  });

  it("`psyche` alone prints help and exits 2", async () => {
    const deps = makeDeps();
    expect(await run([], deps)).toBe(2);
    expect(out(deps)).toContain("Usage: psyche <command> [options]");
    expect(out(deps)).toContain("pairing approve");
  });

  it("`psyche --help` exits 0", async () => {
    const deps = makeDeps();
    expect(await run(["--help"], deps)).toBe(0);
    expect(out(deps)).toContain("Exit codes:");
  });

  it("`psyche pairing` prints the group's help", async () => {
    const deps = makeDeps();
    expect(await run(["pairing"], deps)).toBe(2);
    const text = out(deps);
    expect(text).toContain("Usage: psyche pairing <command>");
    expect(text).toContain("pairing list");
    expect(text).toContain("pairing approve");
    expect(text).not.toContain("vault add");
  });

  it("`psyche pairing --help` exits 0", async () => {
    const deps = makeDeps();
    expect(await run(["pairing", "--help"], deps)).toBe(0);
  });

  it("--help on a command exits 0 and shows its options", async () => {
    const deps = makeDeps();
    expect(await run(["pairing", "approve", "--help"], deps)).toBe(0);
    const text = out(deps);
    expect(text).toContain("Usage: psyche pairing approve <code> [options]");
    expect(text).toContain("--admin");
    expect(text).toContain("--json");
  });
});
