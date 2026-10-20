import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolRegistration, ToolRegistry, ToolResult } from "@psyche/protocol";
import { FakePermissionBroker } from "@psyche/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DevServerRegistry } from "../src/devpreview/gate.ts";
import { type ProbeRunner, systemLoopbackProbes } from "../src/devpreview/probes.ts";
import { FsQuarantineWriter } from "../src/downloads/library.ts";
import { CdpBridgeDriver } from "../src/drivers/cdp.ts";
import { OriginPolicy } from "../src/origin/policy.ts";
import { MockDesktop } from "../src/testing/mock-desktop.ts";
import type { CallContext } from "../src/tools/gate.ts";
import { registerBrowserTools, type SessionKind } from "../src/tools/register.ts";

class Registry implements ToolRegistry {
  readonly tools = new Map<string, ToolRegistration>();
  list() {
    return [...this.tools.values()].map((t) => t.spec);
  }
  get(name: string) {
    return this.tools.get(name);
  }
  register(r: ToolRegistration) {
    this.tools.set(r.spec.name, r);
    return () => this.tools.delete(r.spec.name);
  }
}

describe("dev-server registry (I12, security §3.10)", () => {
  it("allows only loopback servers Psyche started, a launch config names or the owner allowlisted", async () => {
    const reg = new DevServerRegistry({
      ownerPorts: [5173],
      launchConfig: () => [{ name: "api", port: 3000, cwd: "/home/ada/app" }],
    });
    reg.started({ port: 4000, cwd: "/home/ada/web", name: "pnpm dev", taskId: "task_a" });
    reg.started({ port: 4100, name: "shared" });
    await expect(reg.check("http://localhost:5173/", {})).resolves.toMatchObject({
      ok: true,
      origin: "http://localhost:5173",
      server: { source: "owner" },
    });
    await expect(reg.check("http://127.0.0.1:3000/x?y=1", {})).resolves.toMatchObject({
      ok: true,
      server: { source: "launch_config", name: "api", cwd: "/home/ada/app" },
    });
    await expect(
      reg.check("http://app.localhost:4000/", { taskId: "task_a" }),
    ).resolves.toMatchObject({ ok: true, server: { source: "started", taskId: "task_a" } });
    await expect(reg.check("http://localhost:4000/", { taskId: "task_b" })).resolves.toMatchObject({
      ok: false,
      reason: "other_task",
    });
    await expect(reg.check("http://localhost:4100/", { taskId: "task_b" })).resolves.toMatchObject({
      ok: true,
    });
    await expect(reg.check("http://localhost:9999/", {})).resolves.toMatchObject({
      ok: false,
      reason: "unknown_dev_server",
    });
    // A LAN address, the owner's router, or a public site are never dev servers.
    for (const url of [
      "http://192.168.1.10:5173/",
      "https://example.com:5173/",
      "http://10.0.0.1/",
    ]) {
      await expect(reg.check(url, {})).resolves.toMatchObject({
        ok: false,
        reason: "not_loopback",
      });
    }
    await expect(reg.check("file:///etc/passwd", {})).resolves.toMatchObject({
      ok: false,
      reason: "invalid_url",
    });
    reg.stopped(4100);
    await expect(reg.check("http://localhost:4100/", {})).resolves.toMatchObject({
      ok: false,
      reason: "unknown_dev_server",
    });
    expect((await reg.list({ taskId: "task_a" })).map((s) => s.port).sort()).toEqual([
      3000, 4000, 5173,
    ]);
  });

  it("pins a dev-preview policy to its ports", () => {
    const p = new OriginPolicy({ devPreview: true, loopbackPorts: [5173] });
    expect(p.evaluateSync("http://localhost:5173/").action).toBe("allow");
    expect(p.evaluateSync("http://localhost:3000/")).toMatchObject({
      action: "deny",
      reason: "loopback",
    });
    p.allowLoopbackPort(3000);
    expect(p.evaluateSync("http://127.0.0.1:3000/").action).toBe("allow");
    expect(p.loopbackPorts).toEqual([5173, 3000]);
    // Unpinned (M1) dev-preview policies still allow any loopback port.
    const any = new OriginPolicy({ devPreview: true });
    expect(any.evaluateSync("http://localhost:4242/").action).toBe("allow");
    expect(any.loopbackPorts).toBeUndefined();
    // Outside dev preview, pinning changes nothing: loopback stays denied.
    const web = new OriginPolicy({ loopbackPorts: [5173] });
    expect(web.evaluateSync("http://localhost:5173/").action).toBe("deny");
  });
});

describe("loopback probes for the broker's localhost rule (S23 design-03)", () => {
  it("resolves, finds one listener and walks parents to a registered root, failing closed", async () => {
    const parents: Record<number, number> = { 900: 800, 800: 700, 700: 1 };
    const calls: string[][] = [];
    const run: ProbeRunner = async (file, args) => {
      calls.push([file, ...args]);
      if (file === "lsof") {
        const port = args.find((a) => a.startsWith("-iTCP:"))?.slice(6);
        if (port === "5173") return "900\n900\n";
        if (port === "6000") return "900\n901\n";
        throw new Error("exit 1");
      }
      if (file === "ps") {
        const ppid = parents[Number(args.at(-1))];
        if (ppid === undefined) throw new Error("no such process");
        return `  ${ppid}\n`;
      }
      throw new Error(`unexpected ${file}`);
    };
    const roots = new Set<number>([800]);
    const probes = systemLoopbackProbes({
      roots: () => roots,
      psychePorts: [7979],
      run,
      lookup: async (host) => (host === "app.localhost" ? ["127.0.0.1"] : ["93.184.216.34"]),
    });
    expect(probes.psychePorts).toEqual([7979]);
    expect(await probes.resolve("[::1]")).toEqual(["::1"]);
    expect(await probes.resolve("127.0.0.1")).toEqual(["127.0.0.1"]);
    expect(await probes.resolve("app.localhost")).toEqual(["127.0.0.1"]);
    // The name is never trusted: a wildcard-DNS name resolves to wherever it says.
    expect(await probes.resolve("127.0.0.1.nip.io")).toEqual(["93.184.216.34"]);
    expect(await probes.listenerPid(5173)).toBe(900);
    expect(await probes.listenerPid(6000)).toBeUndefined();
    expect(await probes.listenerPid(4242)).toBeUndefined();
    expect(await probes.listenerPid(70_000)).toBeUndefined();
    expect(await probes.spawnedByPsyche(900)).toBe(true);
    expect(await probes.spawnedByPsyche(700)).toBe(false);
    expect(await probes.spawnedByPsyche(12345)).toBe(false);
    roots.clear();
    expect(await probes.spawnedByPsyche(900)).toBe(false);
    // Fixed binaries with argument arrays only.
    expect(calls.every(([file]) => file === "lsof" || file === "ps")).toBe(true);
    expect(calls.find(([f]) => f === "lsof")).toEqual([
      "lsof",
      "-nP",
      "-iTCP:5173",
      "-sTCP:LISTEN",
      "-t",
    ]);
  });

  const lsof = ["/usr/sbin/lsof", "/usr/bin/lsof", "/bin/lsof"].some((p) => existsSync(p));
  it.skipIf(!lsof || process.platform === "win32")(
    "recognises a server Psyche spawned, and not one it did not (real lsof and ps)",
    async () => {
      const child: ChildProcess = spawn(
        process.execPath,
        [
          "-e",
          "const s=require('node:http').createServer((q,r)=>r.end('ok'));s.listen(0,'127.0.0.1',()=>console.log(s.address().port))",
        ],
        { stdio: ["ignore", "pipe", "inherit"] },
      );
      try {
        const port = await new Promise<number>((resolve, reject) => {
          child.stdout?.once("data", (d) => resolve(Number(String(d).trim())));
          child.once("error", reject);
        });
        const registry = new DevServerRegistry();
        const probes = systemLoopbackProbes({ roots: () => registry.spawnedPids() });
        expect(await probes.listenerPid(port)).toBe(child.pid);
        expect(await probes.spawnedByPsyche(child.pid ?? 0)).toBe(false);
        registry.started({ port, pid: child.pid ?? 0, name: "node dev server" });
        expect(registry.spawnedPids()).toEqual([child.pid]);
        expect(await probes.spawnedByPsyche(child.pid ?? 0)).toBe(true);
        // A listener in this test process (not under the registered root) is not the owner's.
        const own = createServer(() => undefined);
        await new Promise<void>((r) => own.listen(0, "127.0.0.1", r));
        const ownPort = (own.address() as AddressInfo).port;
        const ownPid = await probes.listenerPid(ownPort);
        expect(ownPid).toBe(process.pid);
        expect(await probes.spawnedByPsyche(ownPid ?? 0)).toBe(false);
        await new Promise<void>((r) => own.close(() => r()));
        registry.stopped(port);
        expect(await probes.spawnedByPsyche(child.pid ?? 0)).toBe(false);
      } finally {
        child.kill();
      }
    },
    20_000,
  );
});

describe("browser.dev_preview", () => {
  let dir: string;
  let desktop: MockDesktop;
  let driver: CdpBridgeDriver;
  const registry = new Registry();
  const broker = FakePermissionBroker.policy({ default: "allow" });
  const devServers = new DevServerRegistry();
  const sessions = new Map<SessionKind, string>();
  const ctx: CallContext = {
    toolCallId: "call_1",
    threadId: "thr_1",
    runId: "run_1",
    taskId: "task_dev",
    permissionMode: "balanced",
    taint: false,
  };
  const call = async (name: string, params: unknown): Promise<ToolResult> => {
    const t = registry.get(name);
    if (t === undefined) throw new Error(`no tool ${name}`);
    return t.execute("call_1", params, new AbortController().signal, () => {});
  };
  const output = (r: ToolResult) => r.output as Record<string, never>;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "psyche-s08-dev-"));
    desktop = new MockDesktop({ quarantineDir: dir });
    driver = new CdpBridgeDriver(await desktop.connect(), {
      library: new FsQuarantineWriter(join(dir, "lib")),
    });
    // The web session is an ordinary one: loopback denied, console unread.
    const web = await driver.openSession({ taskId: "task_dev", policy: { readWritable: [] } });
    sessions.set("web", web.id);
    registerBrowserTools(registry, {
      driver,
      broker,
      context: () => ctx,
      session: async (_callId, kind = "web") => {
        let id = sessions.get(kind);
        if (id === undefined) {
          const s = await driver.openSession({
            taskId: "task_dev",
            policy: { devPreview: true, loopbackPorts: [] },
            partition: "clean",
          });
          id = s.id;
          sessions.set(kind, id);
        }
        return id;
      },
      openSessions: async () => [...sessions.values()],
      devPreview: devServers,
    });
  });
  afterAll(async () => {
    driver.dispose();
    desktop.disconnect();
    await rm(dir, { recursive: true, force: true });
  });

  it("refuses unknown ports and the web, then opens an allowed dev server with console and network", async () => {
    const url = desktop.browser.url("a/dev");
    const port = desktop.browser.port;
    const unknown = await call("browser.dev_preview", { url });
    expect(unknown).toMatchObject({
      isError: true,
      output: { error: { code: "policy_denied", details: { reason: "unknown_dev_server" } } },
    });
    const web = await call("browser.dev_preview", { url: "https://example.com/" });
    expect(web).toMatchObject({
      isError: true,
      output: { error: { code: "policy_denied", details: { reason: "not_loopback" } } },
    });
    // The owner's web task cannot open loopback through navigate or open_tab either.
    expect(await call("browser.open_tab", { url })).toMatchObject({
      isError: true,
      output: { error: { code: "policy_denied", details: { reason: "loopback" } } },
    });

    devServers.started({ port, cwd: "/home/ada/app", name: "pnpm dev", taskId: "task_dev" });
    const opened = await call("browser.dev_preview", { url });
    expect(opened.isError).toBeUndefined();
    expect(opened.provenance).toBe("untrusted");
    const { tab, devServer } = output(opened) as unknown as {
      tab: { id: string; partition: string; url: string };
      devServer: { source: string; name: string };
    };
    expect(tab.partition).toBe("clean");
    expect(devServer).toMatchObject({ source: "started", name: "pnpm dev" });
    // The broker was asked once, as a new origin with the dev-preview facts.
    const asked = broker.decisions.find((d) => d.call.tool === "browser.dev_preview");
    expect(asked?.call.kind).toBe("new_origin");
    expect(asked?.call.params).toMatchObject({ devPreview: true, source: "started" });
    // Console and network of the dev tab are readable; it is one of this task's tabs.
    await new Promise((r) => setTimeout(r, 30));
    const console = await call("browser.console", { tabId: tab.id });
    expect(console.isError).toBeUndefined();
    expect(
      (output(console) as unknown as { messages: { text: string }[] }).messages.map((m) => m.text),
    ).toContain("hello from the dev server");
    const net = await call("browser.network", { tabId: tab.id });
    expect(
      (output(net) as unknown as { requests: { url: string }[] }).requests.some((r) =>
        r.url.includes("/dev"),
      ),
    ).toBe(true);
    // The dev session stays pinned: another local port is refused even after approval.
    const devSession = sessions.get("dev_preview") ?? "";
    expect(driver.policy(devSession).loopbackPorts).toEqual([port]);
    const other = await call("browser.navigate", {
      tabId: tab.id,
      url: `http://localhost:${port + 1}/`,
    });
    expect(other).toMatchObject({
      isError: true,
      output: { error: { code: "policy_denied", details: { reason: "loopback" } } },
    });
    // A tab that is not this task's is refused, console included.
    expect(await call("browser.console", { tabId: "mt999" })).toMatchObject({
      isError: true,
      output: { error: { code: "not_found" } },
    });
  });
});
