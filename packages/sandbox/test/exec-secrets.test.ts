import { execFileSync, spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { ContainerSandboxRunner, type ContainerSandboxRunnerOptions } from "../src/runner.ts";
import { ENV_TRAMPOLINE, EXEC_WRAPPER, FILES_CHANGED, REAP } from "../src/scripts.ts";
import { FakeDriver } from "./fake-driver.ts";

const scope = { kind: "task" as const, id: "t1" };

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

const exec = (runner: ContainerSandboxRunner, id: string, env?: Record<string, string>) =>
  runner.exec({
    sandboxId: id,
    argv: ["sh", "-c", "sleep 600 &"],
    cwd: "/workspace",
    timeoutMs: 1000,
    ...(env === undefined ? {} : { env }),
  });

/** Index of the first call whose argv includes `script`. */
const at = (d: FakeDriver, script: string) => d.calls.findIndex((c) => c.args.includes(script));

describe("secrets never in argv (#289)", () => {
  it("passes env to the command through fd 3, never as arguments of setsid, timeout or env", () => {
    const lines = EXEC_WRAPPER.split("\n");
    const execs = lines.filter((l) => l.includes("/usr/bin/setsid"));
    expect(execs).toHaveLength(2);
    for (const l of execs) {
      // The array is expanded only inside the process substitution that feeds fd 3.
      const before = l.split("3< <(")[0] ?? "";
      expect(before).not.toContain("__env[@]");
      expect(l).not.toContain("/usr/bin/env --");
    }
    expect(execs[1]).toContain(`3< <(printf '%s\\0' "\${__env[@]}"`);
    expect(EXEC_WRAPPER).not.toContain("\0");
    // The wrapper parses (bash -n reads it without running anything).
    execFileSync("bash", ["-n", "-c", EXEC_WRAPPER]);
  });

  it("the trampoline gives the command the value, and no process's argv holds it", async () => {
    const value = `s3cr3t-${process.pid}-${Date.now()}`;
    const child = spawn(
      "python3",
      [
        "-I",
        "-S",
        "-c",
        ENV_TRAMPOLINE,
        "/bin/sh",
        "-c",
        'printf "%s|%s" "$API_KEY" "$PSYCHE_EXEC_MARK"; sleep 1',
      ],
      { stdio: ["ignore", "pipe", "inherit", "pipe"] },
    );
    const fd3 = child.stdio[3] as NodeJS.WritableStream;
    fd3.end(Buffer.from(`API_KEY=${value}\0PSYCHE_EXEC_MARK=e1\0`));
    const out: Buffer[] = [];
    child.stdout?.on("data", (d: Buffer) => out.push(d));
    await new Promise((r) => setTimeout(r, 400));
    const table = execFileSync("ps", ["-axo", "args="]).toString();
    expect(table.includes(value)).toBe(false);
    await new Promise((r) => child.once("exit", r));
    expect(Buffer.concat(out).toString()).toBe(`${value}|e1`);
  });

  it("the host CLI's argv and environment never hold the value either", async () => {
    const { driver, runner } = setup();
    const { id } = await runner.ensureSandbox(scope);
    const value = "sk_live_never_in_argv";
    await exec(runner, id, { PSYCHE_SECRET_API: value });
    const call = driver.calls[at(driver, EXEC_WRAPPER)];
    expect(call?.args.join(" ")).not.toContain(value);
    expect(JSON.stringify(call?.options.env ?? {})).not.toContain(value);
    expect(String(call?.options.input)).toContain(`PSYCHE_SECRET_API=${value}\0`);
  });
});

describe("leftovers of a secret-bearing exec are reaped (#290, #286)", () => {
  it("reaps the exec's session and marked processes before anything else runs", async () => {
    const { driver, runner } = setup();
    const { id } = await runner.ensureSandbox(scope);
    await exec(runner, id, { PSYCHE_SECRET_API: "v" });
    const wrapper = driver.calls[at(driver, EXEC_WRAPPER)];
    const execId = wrapper?.args[wrapper.args.indexOf("psyche-exec") + 1];
    const reapAt = at(driver, REAP);
    expect(reapAt).toBeGreaterThan(at(driver, EXEC_WRAPPER));
    expect(driver.calls[reapAt]?.args.at(-1)).toBe(execId);
    // Before the pid file that names the session is removed.
    expect(reapAt).toBeLessThan(at(driver, FILES_CHANGED));
  });

  it("leaves an ordinary exec's background processes alone (a dev server with PORT set)", async () => {
    const { driver, runner } = setup();
    const { id } = await runner.ensureSandbox(scope);
    await exec(runner, id, { PORT: "3000" });
    await exec(runner, id);
    expect(at(driver, REAP)).toBe(-1);
  });

  it('reaps every exec with reapBackground: "always" (one-shot work like conversion)', async () => {
    const { driver, runner } = setup({ reapBackground: "always" });
    const { id } = await runner.ensureSandbox(scope);
    await exec(runner, id);
    expect(at(driver, REAP)).toBeGreaterThan(-1);
  });

  it("stops the container when the reap fails, so nothing outlives the secret", async () => {
    const { driver, runner } = setup();
    const base = driver.respond;
    driver.respond = (args, o) => (args.includes(REAP) ? { exitCode: 1 } : base(args, o));
    const { id } = await runner.ensureSandbox(scope);
    await exec(runner, id, { PSYCHE_SECRET_API: "v" });
    expect(driver.find("stop").length).toBeGreaterThan(0);
  });
});
