import { execFileSync, spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { ContainerSandboxRunner, type ContainerSandboxRunnerOptions } from "../src/runner.ts";
import { ENV_TRAMPOLINE, EXEC_WRAPPER, FILES_CHANGED, REAP } from "../src/scripts.ts";
import { FakeDriver } from "./fake-driver.ts";
import { runWrapper } from "./wrapper-harness.ts";

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
  it("passes env only to the trampoline over stdin, never as arguments, and leaves no child behind", () => {
    const execs = EXEC_WRAPPER.split("\n").filter((l) => l.includes("/usr/bin/setsid"));
    expect(execs).toHaveLength(2);
    for (const l of execs) {
      expect(l).not.toContain("/usr/bin/env --");
      // No process substitution: `setsid --wait` must have no sibling child to reap (#314 regression).
      expect(l).not.toContain("<(");
    }
    // The wrapper shell never reads the pairs (only the embedded trampoline does).
    expect(EXEC_WRAPPER.replace(ENV_TRAMPOLINE, "")).not.toMatch(/\bread\b/);
    expect(EXEC_WRAPPER).not.toContain("\0");
    execFileSync("bash", ["-n", "-c", EXEC_WRAPPER]);
  });

  it("the trampoline gives the command the value and the mark, and no process's argv holds it", async () => {
    const value = `s3cr3t-${process.pid}-${Date.now()}`;
    const child = spawn(
      "python3",
      [
        "-I",
        "-S",
        "-c",
        ENV_TRAMPOLINE,
        "e1",
        "/bin/sh",
        "-c",
        'printf "%s|%s" "$API_KEY" "$PSYCHE_EXEC_MARK"; read x || printf "|eof"; sleep 1',
      ],
      { stdio: ["pipe", "pipe", "inherit"] },
    );
    child.stdin?.end(Buffer.from(`API_KEY=${value}\0`));
    const out: Buffer[] = [];
    child.stdout?.on("data", (d: Buffer) => out.push(d));
    await new Promise((r) => setTimeout(r, 400));
    const table = execFileSync("ps", ["-axo", "args="]).toString();
    expect(table.includes(value)).toBe(false);
    await new Promise((r) => child.once("exit", r));
    // The command's stdin is /dev/null, not the pipe that carried the pairs.
    expect(Buffer.concat(out).toString()).toBe(`${value}|e1|eof`);
  });

  it("runs end to end under a strict setsid --wait: env, literal argv, hostile names, no env", () => {
    const pairs = (o: Record<string, string>) =>
      Buffer.from(
        Object.entries(o)
          .map(([k, v]) => `${k}=${v}\0`)
          .join(""),
      );
    const literal = runWrapper(EXEC_WRAPPER, {
      id: "e1",
      mode: "--env",
      argv: ["printf", "%s|%s", "$HOME; rm -rf /", "$PSYCHE_SMOKE"],
      stdin: pairs({ PSYCHE_SMOKE: "a b;c" }),
    });
    expect(literal).toEqual({ status: 0, stdout: "$HOME; rm -rf /|$PSYCHE_SMOKE", stderr: "" });
    const env = runWrapper(EXEC_WRAPPER, {
      id: "e2",
      mode: "--env",
      argv: ["/bin/sh", "-c", 'printf %s "$PSYCHE_SMOKE|$PSYCHE_EXEC_MARK"'],
      stdin: pairs({ PSYCHE_SMOKE: "a b;c" }),
    });
    expect(env.stdout).toBe("a b;c|e2");
    // Names the wrapper uses itself cannot touch it; PATH applies to the command only.
    const hostile = runWrapper(EXEC_WRAPPER, {
      id: "e3",
      mode: "--env",
      argv: ["/usr/bin/printf", "%s", "ok"],
      stdin: pairs({
        PSYCHE_SECRET_SMOKE: "do-not-leak",
        secs: "86400",
        __id: "x",
        __mode: "--",
        PATH: "/nowhere",
      }),
    });
    expect(hostile).toEqual({ status: 0, stdout: "ok", stderr: "" });
    expect(runWrapper(EXEC_WRAPPER, { id: "e4", mode: "--", argv: ["printf", "ok"] })).toEqual({
      status: 0,
      stdout: "ok",
      stderr: "",
    });
    const missing = runWrapper(EXEC_WRAPPER, {
      id: "e5",
      mode: "--env",
      argv: ["/nonexistent/cmd"],
      stdin: pairs({ K: "v" }),
    });
    expect(missing.status).toBe(127);
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
    expect(call?.args[call.args.indexOf("psyche-exec") + 3]).toBe("--env");
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
