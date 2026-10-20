import type { Duplex } from "node:stream";
import { PsycheError, type SandboxScope } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { encodeFrame, FRAME } from "../src/egress/tunnel.ts";
import { ContainerSandboxRunner, type ContainerSandboxRunnerOptions } from "../src/runner.ts";
import { EGRESS_SHIM } from "../src/scripts.ts";
import { FakeDriver, type FakeStream } from "./fake-driver.ts";

const scope = { kind: "task" as const, id: "task_9" };

function setup(
  options: Partial<ContainerSandboxRunnerOptions> = {},
  kind: "docker" | "apple-container" = "docker",
) {
  const driver = new FakeDriver();
  driver.respond = (args) =>
    args[0] === "inspect" || (args[0] === "volume" && args[1] === "inspect")
      ? { exitCode: 1 }
      : undefined;
  const handled: Array<{ scope: SandboxScope; conn: Duplex }> = [];
  const cleared: SandboxScope[] = [];
  const runner = new ContainerSandboxRunner({
    driver,
    detect: async () => [{ kind, cli: `/usr/bin/${kind}`, version: "1" }],
    image: "psyche-sandbox:core-dev",
    idleTimeoutMs: 0,
    ...(kind === "apple-container" ? { appleVolumeSize: "1G" } : {}),
    egressTunnel: {
      handle: (s, conn) => handled.push({ scope: s, conn }),
      clear: (s) => cleared.push(s),
    },
    ...options,
  });
  return { driver, runner, handled, cleared };
}

const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 2));
  }
};

const shims = (d: FakeDriver) => d.streams.filter((s) => s.args.includes(EGRESS_SHIM));

/** Answers the shim's ready frame once the runner starts it. */
async function ready(driver: FakeDriver, n = 1): Promise<FakeStream> {
  await until(() => shims(driver).length >= n);
  const s = shims(driver)[n - 1] as FakeStream;
  s.stdout.write(encodeFrame(FRAME.READY, 0, Buffer.from("3128")));
  return s;
}

async function code(p: Promise<unknown>): Promise<string | undefined> {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  return e instanceof PsycheError ? e.code : e === undefined ? undefined : "not-psyche";
}

describe("network proxy through the egress shim (K4)", () => {
  it("keeps network none, points HTTP_PROXY at the shim and waits for it to be ready", async () => {
    const { runner, driver } = setup();
    const pending = runner.ensureSandbox(scope, { network: "proxy" });
    const shim = await ready(driver);
    const sbx = await pending;
    expect(sbx.network).toBe("proxy");
    const run = driver.find("run")[0];
    expect(run?.args[run.args.indexOf("--network") + 1]).toBe("none");
    expect(run?.options.env?.HTTPS_PROXY).toBe("http://127.0.0.1:3128");
    expect(run?.options.env?.HTTP_PROXY).toBe("http://127.0.0.1:3128");
    expect(shim.args).toContain("--user");
    expect(shim.args.slice(-2)).toEqual([EGRESS_SHIM, "3128"]);
    await runner.dispose();
  });

  it("hands every connection the shim accepts to the proxy with the sandbox's scope", async () => {
    const { runner, driver, handled } = setup();
    const pending = runner.ensureSandbox(scope, { network: "proxy" });
    const shim = await ready(driver);
    await pending;
    shim.stdout.write(encodeFrame(FRAME.OPEN, 1));
    shim.stdout.write(
      encodeFrame(FRAME.DATA, 1, Buffer.from("CONNECT pypi.org:443 HTTP/1.1\r\n\r\n")),
    );
    await until(() => handled.length === 1);
    expect(handled[0]?.scope).toEqual(scope);
    const conn = handled[0]?.conn as Duplex;
    const got = await new Promise<string>((r) => conn.once("data", (d: Buffer) => r(d.toString())));
    expect(got).toBe("CONNECT pypi.org:443 HTTP/1.1\r\n\r\n");
    // Bytes back to the container go out as data frames on the shim's stdin.
    const frames: Buffer[] = [];
    shim.stdin.on("data", (d: Buffer) => frames.push(d));
    conn.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    await until(() => frames.length > 0);
    const f = Buffer.concat(frames);
    expect([f.readUInt8(0), f.readUInt32BE(1)]).toEqual([FRAME.DATA, 1]);
    await runner.dispose();
  });

  it("works on Apple container too, which has no safe internal network", async () => {
    const { runner, driver } = setup({}, "apple-container");
    driver.respond = (args) =>
      args[0] === "inspect" || (args[0] === "volume" && args[1] === "inspect")
        ? { exitCode: 1 }
        : args[0] === "system"
          ? { exitCode: 0 }
          : undefined;
    const pending = runner.ensureSandbox(scope, { network: "proxy" });
    await ready(driver);
    expect((await pending).network).toBe("proxy");
    await runner.dispose();
  });

  it("refuses to run in proxy mode when the shim dies before it is ready", async () => {
    const { runner, driver } = setup();
    const pending = runner.ensureSandbox(scope, { network: "proxy" });
    await until(() => shims(driver).length === 1);
    shims(driver)[0]?.exit(1);
    expect(await code(pending)).toBe("unavailable");
  });

  it("restarts the shim with the container, and deleteWorkspace clears the proxy's scope", async () => {
    const { runner, driver, cleared } = setup();
    const pending = runner.ensureSandbox(scope, { network: "proxy" });
    const first = await ready(driver);
    const { id } = await pending;
    await runner.stop(id);
    expect(first.killed).toBe(true);
    const exec = runner.exec({
      sandboxId: id,
      argv: ["pip", "install", "x"],
      cwd: "/workspace",
      timeoutMs: 1000,
    });
    await ready(driver, 2);
    await exec;
    expect(shims(driver)).toHaveLength(2);
    await runner.deleteWorkspace(scope);
    expect(cleared).toEqual([scope]);
  });

  it("without an egress handler or proxy config, proxy mode is unavailable as before", async () => {
    const { runner } = setup({ egressTunnel: undefined });
    expect(await code(runner.ensureSandbox(scope, { network: "proxy" }))).toBe("unavailable");
  });
});

describe("createSandboxEgress (the Gateway hook)", () => {
  it("gives the runner its tunnel handler and mcp-host its allowlist setter, and logs metadata only", async () => {
    const { createSandboxEgress } = await import("../src/index.ts");
    const lines: Array<[string, string, Record<string, unknown> | undefined]> = [];
    const egress = createSandboxEgress({
      logger: { log: (level, msg, fields) => lines.push([level, msg, fields]) },
    });
    egress.egressAllowlist(scope, ["pypi.org", "*.pythonhosted.org"]);
    expect(egress.proxy.allowlist(scope).map((e) => e.host)).toEqual([
      "pypi.org",
      "*.pythonhosted.org",
    ]);
    expect(egress.egressTunnel).toBe(egress.proxy);
    const { PassThrough } = await import("node:stream");
    const conn = new PassThrough();
    const answer: Buffer[] = [];
    conn.on("data", (d: Buffer) => answer.push(d));
    egress.proxy.handle(scope, conn);
    conn.write("CONNECT evil.test:443 HTTP/1.1\r\n\r\n");
    await until(() => lines.length === 1);
    expect(lines[0]?.[0]).toBe("warn");
    expect(lines[0]?.[2]).toMatchObject({
      origin: "https://evil.test",
      decision: "blocked",
      reason: "blocked-by-allowlist",
    });
  });
});
