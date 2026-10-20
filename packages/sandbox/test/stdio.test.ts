import { PsycheError } from "@psyche/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { ContainerSandboxRunner, type ContainerSandboxRunnerOptions } from "../src/runner.ts";
import { KILL_GROUP, STDIO_RELAY } from "../src/scripts.ts";
import { FakeDriver } from "./fake-driver.ts";

const scope = { kind: "task" as const, id: "mcp:files" };

function setup(options: Partial<ContainerSandboxRunnerOptions> = {}) {
  const driver = new FakeDriver();
  driver.respond = (args) =>
    args[0] === "inspect" || (args[0] === "volume" && args[1] === "inspect")
      ? { exitCode: 1 }
      : undefined;
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

/** The relay's argv after `-c STDIO_RELAY`: pid file, then the command. */
const relayArgs = (args: string[]) => args.slice(args.indexOf(STDIO_RELAY) + 1);
const header = (pairs: string[]) => {
  const body = Buffer.from(pairs.map((p) => `${p}\0`).join(""), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  return Buffer.concat([head, body]);
};
const tick = () => new Promise((r) => setTimeout(r, 5));

const runners: ContainerSandboxRunner[] = [];
afterEach(async () => {
  for (const r of runners.splice(0)) await r.dispose();
});

describe("openStdio (#143)", () => {
  it("runs the relay by absolute path as UID 1000 in /workspace, never through a shell", async () => {
    const { runner, driver } = setup();
    runners.push(runner);
    const { id } = await runner.ensureSandbox(scope);
    await runner.openStdio(id, { argv: ["node", "server.js"] });
    const s = driver.streams[0];
    if (s === undefined) throw new Error("no stream");
    expect(s.args.slice(0, 2)).toEqual(["exec", "--interactive"]);
    expect(s.args).toContain("--user");
    expect(s.args[s.args.indexOf("--user") + 1]).toBe("1000:1000");
    expect(s.args[s.args.indexOf("--workdir") + 1]).toBe("/workspace");
    expect(s.args).toContain("/usr/bin/python3");
    expect(s.args.slice(s.args.indexOf("/usr/bin/python3"), s.args.indexOf(STDIO_RELAY))).toEqual([
      "/usr/bin/python3",
      "-I",
      "-S",
      "-c",
    ]);
    const [pidFile, ...cmd] = relayArgs(s.args);
    expect(pidFile).toMatch(/^\/tmp\/\.psyche\/[0-9a-f]{16}\.pid$/);
    expect(cmd).toEqual(["node", "server.js"]);
    expect(s.args).not.toContain("bash");
  });

  it("delivers env on stdin before the payload, never in any argv", async () => {
    const { runner, driver } = setup();
    runners.push(runner);
    const { id } = await runner.ensureSandbox(scope);
    const secret = "sk_live_stdio_secret";
    const proc = await runner.openStdio(id, {
      argv: ["node", "server.js"],
      env: { API_KEY: secret, MODE: "a=b" },
    });
    const s = driver.streams[0];
    if (s === undefined) throw new Error("no stream");
    const all: Buffer[] = [];
    s.stdin.on("data", (d: Buffer) => all.push(d));
    proc.stdin.write('{"jsonrpc":"2.0","id":1}\n');
    await tick();
    // The relay's stdin: the env header, then the raw payload.
    expect(
      Buffer.concat(all).equals(
        Buffer.concat([
          header([`API_KEY=${secret}`, "MODE=a=b"]),
          Buffer.from('{"jsonrpc":"2.0","id":1}\n'),
        ]),
      ),
    ).toBe(true);
    // Never in any CLI argv, nor in the CLI's environment.
    for (const c of driver.calls) {
      expect(c.args.join(" ")).not.toContain(secret);
      expect(JSON.stringify(c.options)).not.toContain(secret);
    }
  });

  it("passes raw bytes both ways and reports the exit", async () => {
    const { runner, driver } = setup();
    runners.push(runner);
    const { id } = await runner.ensureSandbox(scope);
    const proc = await runner.openStdio(id, { argv: ["mcp-server"], env: { K: "v" } });
    const s = driver.streams[0];
    if (s === undefined) throw new Error("no stream");
    const chunks: Buffer[] = [];
    s.stdin.on("data", (d: Buffer) => chunks.push(d));
    proc.stdin.write(Buffer.from([0x7b, 0x0d, 0x0a, 0x00, 0xff]));
    await tick();
    // After the header, byte-exact: no CRLF translation, NUL and 0xff intact.
    expect(
      Buffer.concat(chunks).equals(
        Buffer.concat([header(["K=v"]), Buffer.from([0x7b, 0x0d, 0x0a, 0x00, 0xff])]),
      ),
    ).toBe(true);
    const out = new Promise<Buffer>((r) => proc.stdout.once("data", r));
    s.stdout.write(Buffer.from('{"id":1}\r\n'));
    expect((await out).toString()).toBe('{"id":1}\r\n');
    s.exit(3);
    expect(await proc.exited).toEqual({ exitCode: 3, signal: null });
    const receipt = await proc.receipt();
    expect(receipt).toMatchObject({
      sandboxId: id,
      argv: ["mcp-server"],
      cwd: "/workspace",
      envNames: ["K"],
      exitCode: 3,
      outcome: "failed",
    });
    expect(JSON.stringify(receipt)).not.toContain('"v"');
  });

  it("the env header is exactly the length-prefixed pairs", async () => {
    const { runner, driver } = setup();
    runners.push(runner);
    const { id } = await runner.ensureSandbox(scope);
    const sniff: Buffer[] = [];
    const origStream = driver.stream.bind(driver);
    driver.stream = (file, args) => {
      const st = origStream(file, args);
      st.stdin.on("data", (d: Buffer) => sniff.push(d));
      return st;
    };
    await runner.openStdio(id, { argv: ["srv"], env: { A: "1", B: "x=y" } });
    await tick();
    expect(Buffer.concat(sniff).equals(header(["A=1", "B=x=y"]))).toBe(true);
  });

  it("keeps the container busy while open and releases it on exit", async () => {
    const { runner, driver } = setup({ idleTimeoutMs: 20 });
    runners.push(runner);
    const { id } = await runner.ensureSandbox(scope);
    const before = driver.find("stop").length;
    const proc = await runner.openStdio(id, { argv: ["srv"] });
    await new Promise((r) => setTimeout(r, 60));
    expect(driver.find("stop").length).toBe(before);
    driver.streams[0]?.exit(0);
    await proc.exited;
    await new Promise((r) => setTimeout(r, 60));
    expect(driver.find("stop").length).toBeGreaterThan(before);
  });

  it("limits open processes per scope", async () => {
    const { runner, driver } = setup({ maxStdioProcesses: 1 });
    runners.push(runner);
    const { id } = await runner.ensureSandbox(scope);
    const a = await runner.openStdio(id, { argv: ["srv"] });
    expect(await code(runner.openStdio(id, { argv: ["srv"] }))).toBe("rate_limited");
    driver.streams[0]?.exit(0);
    await a.exited;
    await runner.openStdio(id, { argv: ["srv"] });
    expect(driver.streams).toHaveLength(2);
  });

  it("kill signals the process group from a second exec and reports the signal", async () => {
    const { runner, driver } = setup();
    runners.push(runner);
    const { id } = await runner.ensureSandbox(scope);
    const proc = await runner.openStdio(id, { argv: ["srv"] });
    const s = driver.streams[0];
    if (s === undefined) throw new Error("no stream");
    const pidId = (relayArgs(s.args)[0] ?? "").replace(/^.*\//, "").replace(/\.pid$/, "");
    const killing = proc.kill("TERM");
    await tick();
    const kills = driver.calls.filter((c) => c.args.includes(KILL_GROUP));
    expect(kills).toHaveLength(1);
    expect(kills[0]?.args.slice(-2)).toEqual([pidId, "TERM"]);
    s.exit(128 + 15);
    await killing;
    expect(await proc.exited).toEqual({ exitCode: null, signal: "SIGTERM" });
    expect((await proc.receipt()).outcome).toBe("uncertain");
  });

  it("destroy and dispose TERM open process groups first", async () => {
    const { runner, driver } = setup();
    const { id } = await runner.ensureSandbox(scope);
    await runner.openStdio(id, { argv: ["srv"] });
    await runner.destroy(id);
    const order = driver.calls.map((c) =>
      c.args.includes(KILL_GROUP) ? "kill" : c.args[0] === "rm" ? "rm" : "",
    );
    expect(order.indexOf("kill")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("kill")).toBeLessThan(order.indexOf("rm"));

    const second = setup();
    const sbx = await second.runner.ensureSandbox(scope);
    await second.runner.openStdio(sbx.id, { argv: ["srv"] });
    await second.runner.dispose();
    expect(second.driver.calls.some((c) => c.args.includes(KILL_GROUP))).toBe(true);
  });

  it("validates like exec and makes the workspace untrusted", async () => {
    const { runner } = setup();
    runners.push(runner);
    const { id } = await runner.ensureSandbox(scope);
    expect(await code(runner.openStdio(id, { argv: [] }))).toBe("invalid_params");
    expect(await code(runner.openStdio(id, { argv: ["a=b"] }))).toBe("invalid_params");
    expect(await code(runner.openStdio(id, { argv: ["srv"], cwd: "rel" }))).toBe("invalid_params");
    expect(await code(runner.openStdio(id, { argv: ["srv"], env: { "BAD-KEY": "x" } }))).toBe(
      "invalid_params",
    );
    expect(await code(runner.openStdio("sbx_nope", { argv: ["srv"] }))).toBe("not_found");
    const proc = await runner.openStdio(id, { argv: ["srv"] });
    expect(proc.provenance).toBe("untrusted");
    const r = await runner.exec({
      sandboxId: id,
      argv: ["ls"],
      cwd: "/workspace",
      timeoutMs: 1000,
      provenance: "trusted",
    });
    expect(r.provenance).toBe("untrusted");
  });

  it("has no host fallback without a backend", async () => {
    const driver = new FakeDriver();
    const runner = new ContainerSandboxRunner({ driver, detect: async () => [] });
    expect(await code(runner.ensureSandbox(scope))).toBe("unavailable");
    expect(await code(runner.openStdio("sbx_x", { argv: ["srv"] }))).toBe("not_found");
    expect(driver.calls).toEqual([]);
  });
});
