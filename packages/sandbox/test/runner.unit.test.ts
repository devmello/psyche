import { PsycheError } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { ContainerSandboxRunner, type ContainerSandboxRunnerOptions } from "../src/runner.ts";
import { EXEC_WRAPPER } from "../src/scripts.ts";
import { FakeDriver } from "./fake-driver.ts";

const scope = { kind: "task" as const, id: "t1" };
const notFound = (args: string[]) =>
  args[0] === "inspect" || (args[0] === "volume" && args[1] === "inspect")
    ? { exitCode: 1 }
    : undefined;

function setup(options: Partial<ContainerSandboxRunnerOptions> = {}) {
  const driver = new FakeDriver();
  driver.respond = notFound;
  const runner = new ContainerSandboxRunner({
    driver,
    detect: async () => [{ kind: "docker", cli: "/usr/bin/docker", version: "29" }],
    image: "psyche-sandbox:core-dev",
    idleTimeoutMs: 0,
    ...options,
  });
  return { driver, runner };
}

async function code(p: Promise<unknown>): Promise<string | undefined> {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  return e instanceof PsycheError ? e.code : e === undefined ? undefined : "not-psyche";
}

const inspectJson = (running: boolean, labels: Record<string, string>) =>
  Buffer.from(JSON.stringify([{ State: { Running: running }, Config: { Labels: labels } }]));

describe("ContainerSandboxRunner (fake CLI)", () => {
  it("fails with unavailable and runs nothing when there is no backend", async () => {
    const driver = new FakeDriver();
    const runner = new ContainerSandboxRunner({ driver, detect: async () => [] });
    expect(await runner.backends()).toEqual([]);
    expect(await code(runner.ensureSandbox(scope))).toBe("unavailable");
    expect(driver.calls).toEqual([]);
  });

  it("creates a volume and a container on first ensure, then reuses it", async () => {
    const { driver, runner } = setup();
    const a = await runner.ensureSandbox(scope);
    const b = await runner.ensureSandbox(scope);
    expect(b.id).toBe(a.id);
    expect(a).toMatchObject({ backend: "docker", network: "none", status: "ready" });
    expect(driver.find("volume", "create")).toHaveLength(1);
    expect(driver.find("run")).toHaveLength(1);
  });

  it("concurrent ensures for one scope create one container", async () => {
    const { driver, runner } = setup();
    const [a, b] = await Promise.all([runner.ensureSandbox(scope), runner.ensureSandbox(scope)]);
    expect(a.id).toBe(b.id);
    expect(driver.find("run")).toHaveLength(1);
  });

  it("adopts an existing container with a matching config instead of recreating it", async () => {
    const first = setup();
    await first.runner.ensureSandbox(scope);
    const runArgs = first.driver.find("run")[0]?.args ?? [];
    const labels = Object.fromEntries(
      runArgs.flatMap((a, i) => (runArgs[i - 1] === "--label" ? [a.split("=")] : [])),
    );
    const second = setup();
    second.driver.respond = (args) =>
      args[0] === "inspect" ? { stdout: inspectJson(false, labels) } : undefined;
    await second.runner.ensureSandbox(scope);
    expect(second.driver.find("run")).toHaveLength(0);
    expect(second.driver.find("start")).toHaveLength(1);
  });

  it("recreates a container whose config differs", async () => {
    const { driver, runner } = setup();
    driver.respond = (args) =>
      args[0] === "inspect" ? { stdout: inspectJson(true, { stale: "1" }) } : undefined;
    await runner.ensureSandbox(scope);
    expect(driver.find("rm", "--force")).toHaveLength(1);
    expect(driver.find("run")).toHaveLength(1);
  });

  it("execs through the fixed wrapper: argv stays separate, env goes over stdin", async () => {
    const { driver, runner } = setup();
    const sbx = await runner.ensureSandbox(scope);
    await runner.exec({
      sandboxId: sbx.id,
      argv: ["echo", "$HOME; rm -rf /"],
      cwd: "/workspace",
      env: { PSYCHE_SECRET_TOKEN: "s3cr3t-value" },
      timeoutMs: 5_000,
    });
    const call = driver.calls.find((c) => c.args.includes(EXEC_WRAPPER));
    const args = call?.args ?? [];
    expect(args.slice(-2)).toEqual(["echo", "$HOME; rm -rf /"]);
    expect(args.slice(0, 4)).toEqual(["exec", "--interactive", "--user", "1000:1000"]);
    expect(args.join(" ")).not.toContain("s3cr3t-value");
    expect(String(call?.options.input)).toBe("PSYCHE_SECRET_TOKEN=s3cr3t-value\0");
    // Every process started is the fixed container CLI, never a host shell.
    expect(new Set(driver.calls.map((c) => c.file))).toEqual(new Set(["/usr/bin/docker"]));
  });

  it("maps exit codes, the timeout bound and truncation", async () => {
    const { driver, runner } = setup();
    const sbx = await runner.ensureSandbox(scope);
    const exec = (timeoutMs = 5_000) =>
      runner.exec({ sandboxId: sbx.id, argv: ["x"], cwd: "/workspace", timeoutMs });
    const answer = (r: object) => {
      driver.respond = (args) => (args.includes(EXEC_WRAPPER) ? r : undefined);
    };
    answer({ exitCode: 2, stderrTruncated: true });
    expect(await exec()).toMatchObject({ exitCode: 2, outcome: "failed", truncated: true });
    answer({ exitCode: 0, stdout: Buffer.from("hi\n") });
    expect(await exec()).toMatchObject({ exitCode: 0, outcome: "ok", stdout: "hi\n" });
    answer({ exitCode: 124, durationMs: 1_010 });
    expect(await exec(1_000)).toMatchObject({
      exitCode: null,
      timedOut: true,
      outcome: "uncertain",
    });
    // A command that exits 124 by itself, well before its bound, is an ordinary failure.
    answer({ exitCode: 124, durationMs: 10 });
    expect(await exec(1_000)).toMatchObject({ exitCode: 124, timedOut: false, outcome: "failed" });
    // The client died by signal: nobody knows what happened inside.
    answer({ exitCode: null, signal: "SIGKILL" });
    expect(await exec()).toMatchObject({ exitCode: null, outcome: "uncertain" });
  });

  it("parses filesChanged from the NUL-separated listing", async () => {
    const { driver, runner } = setup();
    const sbx = await runner.ensureSandbox(scope);
    driver.respond = (args) =>
      args.includes("psyche-changed") ? { stdout: Buffer.from("a.txt\0dir/b.pdf\0") } : undefined;
    const r = await runner.exec({ sandboxId: sbx.id, argv: ["x"], cwd: "/", timeoutMs: 1_000 });
    expect(r.filesChanged).toEqual(["a.txt", "dir/b.pdf"]);
  });

  it("validates requests before touching the CLI", async () => {
    const { driver, runner } = setup();
    const sbx = await runner.ensureSandbox(scope);
    const before = driver.calls.length;
    const base = { sandboxId: sbx.id, argv: ["true"], cwd: "/workspace", timeoutMs: 1_000 };
    expect(await code(runner.exec({ ...base, argv: [] }))).toBe("invalid_params");
    expect(await code(runner.exec({ ...base, sandboxId: "sbx_nope" }))).toBe("not_found");
    expect(await code(runner.exec({ ...base, cwd: "relative" }))).toBe("invalid_params");
    expect(await code(runner.exec({ ...base, env: { "BAD=": "x" } }))).toBe("invalid_params");
    expect(await code(runner.exec({ ...base, timeoutMs: 31 * 60_000 }))).toBe("invalid_params");
    const ac = new AbortController();
    ac.abort();
    expect(await code(runner.exec({ ...base, signal: ac.signal }))).toBe("cancelled");
    expect(driver.calls.length).toBe(before);
  });

  it("network proxy needs a configured proxy, joins its network, keeps the URL out of argv", async () => {
    const plain = setup();
    expect(await code(plain.runner.ensureSandbox(scope, { network: "proxy" }))).toBe("unavailable");
    const { driver, runner } = setup({
      egressProxy: { network: "psyche-egress", url: (s) => `http://tok-${s.id}@10.0.0.1:3128` },
    });
    const sbx = await runner.ensureSandbox(scope, { network: "proxy" });
    expect(sbx.network).toBe("proxy");
    const run = driver.find("run")[0];
    expect(run?.args[run.args.indexOf("--network") + 1]).toBe("psyche-egress");
    expect(run?.args.join(" ")).not.toContain("tok-t1");
    expect(run?.options.env?.HTTPS_PROXY).toBe("http://tok-t1@10.0.0.1:3128");
    expect(await code(runner.ensureSandbox(scope))).toBe("conflict");
  });

  it("refuses network proxy on Apple container (an internal vmnet exposes host services)", async () => {
    const { runner } = setup({
      detect: async () => [{ kind: "apple-container", cli: "/bin/container", version: "1.5" }],
      egressProxy: { network: "psyche-egress", url: "http://192.168.128.1:3128" },
    });
    expect(await code(runner.ensureSandbox(scope, { network: "proxy" }))).toBe("unavailable");
  });

  it("reports a missing local image as unavailable with a build hint", async () => {
    const { driver, runner } = setup();
    driver.respond = (args) => (args[0] === "image" ? { exitCode: 1 } : notFound(args));
    const err = await runner.ensureSandbox(scope).catch((e: unknown) => e);
    expect((err as PsycheError).code).toBe("unavailable");
    expect((err as PsycheError).message).toMatch(/sandbox:build/);
  });

  it("restarts a stopped sandbox on the next use", async () => {
    const { driver, runner } = setup();
    const sbx = await runner.ensureSandbox(scope);
    await runner.stop(sbx.id);
    driver.respond = (args) =>
      args[0] === "inspect"
        ? { stdout: inspectJson(false, Object.fromEntries([])) }
        : notFound(args);
    expect((await runner.ensureSandbox(scope)).status).toBe("ready");
    expect(driver.find("stop")).toHaveLength(1);
  });

  it("stops the least recently used idle sandbox above maxRunningSandboxes", async () => {
    const { driver, runner } = setup({ maxRunningSandboxes: 2 });
    const a = await runner.ensureSandbox({ kind: "task", id: "a" });
    await runner.ensureSandbox({ kind: "task", id: "b" });
    await runner.ensureSandbox({ kind: "task", id: "c" });
    const nameOf = (args: string[]) => args[args.indexOf("--name") + 1];
    const stopped = driver.find("stop").map((c) => c.args.at(-1));
    expect(stopped).toEqual([nameOf(driver.find("run")[0]?.args ?? [])]);
    expect((await runner.ensureSandbox({ kind: "task", id: "a" })).id).toBe(a.id);
  });

  it("limits open terminals per sandbox", async () => {
    const { runner } = setup({ maxPtys: 1 });
    const sbx = await runner.ensureSandbox(scope);
    await runner.openPty(sbx.id);
    expect(await code(runner.openPty(sbx.id))).toBe("rate_limited");
  });
});
