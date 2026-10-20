import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type DevServerEvent, parseProbe } from "../src/devservers.ts";
import { ContainerSandboxRunner, type ContainerSandboxRunnerOptions } from "../src/runner.ts";
import { LISTENERS, PORT_RELAY } from "../src/scripts.ts";
import { FakeDriver } from "./fake-driver.ts";

const scope = { kind: "task" as const, id: "t1" };

interface Probe {
  sid: number | null;
  alive: boolean;
  listeners: { port: number; addr: string; pid: number }[];
}

/** A fake container whose listener probe answers from `state`. */
function setup(options: Partial<ContainerSandboxRunnerOptions> = {}) {
  const driver = new FakeDriver();
  const events: DevServerEvent[] = [];
  const state: { probe: Probe; probes: string[][] } = {
    probe: { sid: null, alive: false, listeners: [] },
    probes: [],
  };
  driver.respond = (args) => {
    if (args[0] === "inspect" || (args[0] === "volume" && args[1] === "inspect")) {
      return { exitCode: 1 };
    }
    const at = args.indexOf(LISTENERS);
    if (at >= 0) {
      state.probes.push(args.slice(at + 1));
      return { stdout: Buffer.from(JSON.stringify(state.probe)) };
    }
    return undefined;
  };
  const runner = new ContainerSandboxRunner({
    driver,
    detect: async () => [{ kind: "docker", cli: "/usr/bin/docker", version: "29" }],
    image: "psyche-sandbox:core-dev",
    idleTimeoutMs: 0,
    onDevServer: (e) => events.push(e),
    devServers: { probeDelaysMs: [10, 20, 40], pollMs: 15 },
    ...options,
  });
  return { driver, runner, events, state };
}

const exec = (runner: ContainerSandboxRunner, id: string, argv: string[]) =>
  runner.exec({ sandboxId: id, argv, cwd: "/workspace/app", timeoutMs: 1000 });

const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
};

const runners: ContainerSandboxRunner[] = [];
afterEach(async () => {
  for (const r of runners.splice(0)) await r.dispose();
});

describe("dev-server forwarding (I12)", () => {
  it("does not probe at all without an onDevServer callback", async () => {
    const { runner, driver } = setup({ onDevServer: undefined });
    runners.push(runner);
    const { id } = await runner.ensureSandbox(scope);
    await exec(runner, id, ["npm", "run", "dev"]);
    expect(driver.calls.some((c) => c.args.includes(LISTENERS))).toBe(false);
  });

  it("forwards a listener of the exec's session to a host loopback port it owns", async () => {
    const { runner, driver, events, state } = setup();
    runners.push(runner);
    const { id } = await runner.ensureSandbox(scope);
    state.probe = { sid: 41, alive: true, listeners: [{ port: 5173, addr: "0.0.0.0", pid: 57 }] };
    await exec(runner, id, ["sh", "-c", "npm run dev &"]);

    // The first probe names the exec by id; the runner never guesses the session.
    expect(state.probes[0]?.[0]).toBe("exec");
    expect(events).toHaveLength(1);
    const started = events[0];
    if (started?.type !== "started") throw new Error("expected started");
    expect(started.server).toMatchObject({
      sandboxId: id,
      scope,
      containerPort: 5173,
      pid: 41,
      listenerPid: 57,
      cwd: "/workspace/app",
      argv: ["sh", "-c", "npm run dev &"],
    });
    // The reported port is the runner's own host listener, never the container's number.
    expect(started.server.port).not.toBe(5173);
    expect(started.server.port).toBeGreaterThan(0);

    // A browser connection is relayed into the container, to loopback there.
    const socket = connect(started.server.port, "127.0.0.1");
    await new Promise<void>((r) => socket.once("connect", () => r()));
    await until(() => driver.streams.length === 1);
    const relay = driver.streams[0];
    if (relay === undefined) throw new Error("no relay");
    expect(relay.args.slice(relay.args.indexOf(PORT_RELAY) + 1)).toEqual(["127.0.0.1", "5173"]);
    expect(relay.args).toContain("--user");
    socket.write("GET / HTTP/1.1\r\n\r\n");
    const sent = await new Promise<string>((r) => relay.stdin.once("data", (d) => r(String(d))));
    expect(sent).toBe("GET / HTTP/1.1\r\n\r\n");
    const got = new Promise<string>((r) => socket.once("data", (d) => r(String(d))));
    relay.stdout.write("HTTP/1.1 200 OK\r\n\r\n");
    expect(await got).toBe("HTTP/1.1 200 OK\r\n\r\n");
    socket.destroy();
    await until(() => relay.killed);
  });

  it("re-probes a server that binds after the exec returned", async () => {
    const { runner, events, state } = setup();
    runners.push(runner);
    const { id } = await runner.ensureSandbox(scope);
    state.probe = { sid: 41, alive: true, listeners: [] };
    await exec(runner, id, ["sh", "-c", "npm run dev &"]);
    expect(events).toEqual([]);
    state.probe = { sid: 41, alive: true, listeners: [{ port: 3000, addr: "::", pid: 60 }] };
    await until(() => events.length === 1);
    expect(state.probes.slice(1).every((p) => p[0] === "sid" && p[1] === "41")).toBe(true);
    expect(events[0]?.type).toBe("started");
    expect(events[0]?.server.containerPort).toBe(3000);
  });

  it("reports stopped when the listener goes away, and the host port closes", async () => {
    const { runner, events, state } = setup();
    runners.push(runner);
    const { id } = await runner.ensureSandbox(scope);
    state.probe = { sid: 41, alive: true, listeners: [{ port: 5173, addr: "127.0.0.1", pid: 57 }] };
    await exec(runner, id, ["npm", "run", "dev"]);
    const port = events[0]?.server.port ?? 0;
    state.probe = { sid: 41, alive: false, listeners: [] };
    await until(() => events.length === 2);
    expect(events[1]).toMatchObject({ type: "stopped", reason: "exited" });
    expect(events[1]?.server.port).toBe(port);
    const refused = await new Promise<boolean>((r) => {
      const s = connect(port, "127.0.0.1");
      s.once("error", () => r(true));
      s.once("connect", () => {
        s.destroy();
        r(false);
      });
    });
    expect(refused).toBe(true);
  });

  it("reports stopped with reason sandbox when the container is destroyed", async () => {
    const { runner, events, state } = setup();
    runners.push(runner);
    const { id } = await runner.ensureSandbox(scope);
    state.probe = { sid: 41, alive: true, listeners: [{ port: 5173, addr: "0.0.0.0", pid: 57 }] };
    await exec(runner, id, ["npm", "run", "dev"]);
    await runner.destroy(id);
    expect(events.map((e) => e.type)).toEqual(["started", "stopped"]);
    expect(events[1]).toMatchObject({ reason: "sandbox" });
  });

  it("keeps the container awake while a forwarded server runs", async () => {
    const { runner, driver, state } = setup({ idleTimeoutMs: 20 });
    runners.push(runner);
    const { id } = await runner.ensureSandbox(scope);
    state.probe = { sid: 41, alive: true, listeners: [{ port: 5173, addr: "0.0.0.0", pid: 57 }] };
    await exec(runner, id, ["npm", "run", "dev"]);
    await new Promise((r) => setTimeout(r, 80));
    expect(driver.find("stop")).toHaveLength(0);
  });

  it("ignores listeners it cannot reach on loopback, garbage output and a throwing callback", async () => {
    expect(parseProbe("not json")).toEqual({ sid: null, alive: false, listeners: [] });
    expect(
      parseProbe(
        JSON.stringify({
          sid: 9,
          alive: true,
          listeners: [
            { port: 8080, addr: "10.0.0.5", pid: 20 },
            { port: 0, addr: "0.0.0.0", pid: 20 },
            { port: 70_000, addr: "0.0.0.0", pid: 20 },
            { port: 8081, addr: "0.0.0.0", pid: "x" },
            { port: 8082, addr: "::ffff:127.0.0.1", pid: 21 },
          ],
        }),
      ).listeners,
    ).toEqual([{ port: 8082, addr: "127.0.0.1", pid: 21 }]);

    const { runner, state } = setup({
      onDevServer: () => {
        throw new Error("listener bug");
      },
    });
    runners.push(runner);
    const { id } = await runner.ensureSandbox(scope);
    state.probe = { sid: 41, alive: true, listeners: [{ port: 5173, addr: "0.0.0.0", pid: 57 }] };
    const r = await exec(runner, id, ["npm", "run", "dev"]);
    expect(r.outcome).toBe("ok");
  });
});
