import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { VM_SETTING_KEYS, type VmGuest, type VmStatus } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { type ComposedMcp, composeMcp } from "../src/compose/mcp.ts";
import { sandboxPcStatus } from "../src/compose/sandbox.ts";
import { type ComposedVm, composeVm, GUEST_SESSION_CAPABILITY } from "../src/compose/vm.ts";
import { silentLogger } from "../src/log.ts";
import { FakeNode, type FakeNodeHandler, pairNodeDevice } from "./fake-node.ts";
import { adminClient, ik, newDeviceKey, type TestClient } from "./helpers.ts";

/**
 * srt's features in the sandbox guest, Gateway side (the sandbox PC on Windows): `VmRunner.run`
 * (stdin, staged files, network policy, a throwaway folder), `openStdio` (long-lived pipes over
 * the guest node's `exec.session.*`), shares for granted folders, and a stdio MCP server end to
 * end through the VM launcher. The helper and the guest's psyche-node are fakes on the real
 * node and guest sockets; the fake guest runs session processes locally, as the guest would.
 */

const PROBE = fileURLToPath(
  new URL("../../../packages/mcp-host/test/fixtures/probe-server.mjs", import.meta.url),
);

const guestOf = (shares: VmGuest["shares"]): VmGuest => ({
  name: "sandbox",
  phase: "running",
  provisioned: true,
  cpus: 4,
  memoryGB: 8,
  diskGB: 80,
  guestOS: "Linux",
  username: "psyche",
  shares,
  vsock: { hostCid: 2, gatewayNodePort: 7980 },
});

let home = "";
let composed: ComposedGateway | null = null;
const nodes: FakeNode[] = [];
const clients: TestClient[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const c of children.splice(0)) c.kill("SIGKILL");
  for (const c of clients.splice(0)) c.close();
  for (const n of nodes.splice(0)) await n.close();
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

/** The guest node's session capabilities, backed by local processes (`run` picks what runs). */
function sessionHandlers(run: (argv: string[]) => ChildProcess) {
  const open = new Map<string, ChildProcess>();
  const writes: { sessionId: string; data?: string; end?: boolean }[] = [];
  const closes: { sessionId: string; signal?: string }[] = [];
  const opened: Record<string, unknown>[] = [];
  const handlers: FakeNodeHandler[] = [
    {
      capability: { name: "exec.session.open", sideEffect: "write", streaming: true },
      run: (params, emit) => {
        const p = params as { sessionId: string; argv: string[] };
        opened.push(params as Record<string, unknown>);
        const child = run(p.argv);
        children.push(child);
        open.set(p.sessionId, child);
        emit({ phase: "started", sessionId: p.sessionId });
        child.stdout?.on("data", (d: Buffer) =>
          emit({ stream: "stdout", data: Buffer.from(d).toString("base64") }),
        );
        child.stderr?.on("data", (d: Buffer) =>
          emit({ stream: "stderr", data: Buffer.from(d).toString("base64") }),
        );
        return new Promise((resolve) =>
          child.once("close", (exitCode, signal) => {
            open.delete(p.sessionId);
            resolve({ exitCode, signal, durationMs: 1 });
          }),
        );
      },
      receipt: { outcome: "ok", summary: "session ended" },
    },
    {
      capability: { name: "exec.session.write", sideEffect: "write", streaming: false },
      run: (params) => {
        const p = params as { sessionId: string; data?: string; end?: boolean };
        writes.push(p);
        const child = open.get(p.sessionId);
        if (child === undefined)
          throw Object.assign(new Error("no such session"), { code: "not_found" });
        if (p.data) child.stdin?.write(Buffer.from(p.data, "base64"));
        if (p.end) child.stdin?.end();
        return { bytes: p.data ? Buffer.from(p.data, "base64").length : 0 };
      },
    },
    {
      capability: { name: "exec.session.close", sideEffect: "write", streaming: false },
      run: (params) => {
        const p = params as { sessionId: string; signal?: string };
        closes.push(p);
        open.get(p.sessionId)?.kill(p.signal === "KILL" ? "SIGKILL" : "SIGTERM");
        return { closed: true };
      },
    },
  ];
  return { handlers, writes, closes, opened };
}

async function stack(options: { sessions?: boolean; mcp?: boolean } = {}) {
  home = mkdtempSync(join(tmpdir(), "psyche-vmiso-"));
  let vm: ComposedVm | undefined;
  let mcp: ComposedMcp | undefined;
  composed = await composeGateway({
    env: {},
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    model: { provider: new FakeModelProvider(), model: "fake/model" },
    parts: [
      (s) => {
        vm = composeVm(s, { pollMs: 0 });
        return vm;
      },
      ...(options.mcp === true
        ? [
            (s: Parameters<typeof composeMcp>[0]) => {
              const runner = (vm as ComposedVm).runner;
              mcp = composeMcp(s, {
                vm: {
                  ready: () => runner.canIsolate(),
                  ensureSandbox: (scope) => runner.ensureSandbox(scope),
                  openStdio: (id, o) => runner.openStdio(id, o),
                },
              });
              return mcp;
            },
          ]
        : []),
    ],
  });
  const c = composed;
  let shares: VmGuest["shares"] = [];
  const shareCalls: Record<string, unknown>[] = [];
  const helper = await FakeNode.connect(c.gateway.config.nodeSocketPath, {
    origin: c.gateway.origin,
    secret: c.gateway.handshakeSecret,
    deviceFamily: process.platform === "win32" ? "win-helper" : "mac-helper",
    handlers: [
      {
        capability: { name: "vm.status", sideEffect: "read", streaming: false },
        run: (): VmStatus => ({
          guests: [guestOf(shares)],
          active: 1,
          maxActive: 2,
          supportsGuestProvisioning: true,
        }),
      },
      {
        capability: { name: "vm.share_add", sideEffect: "write", streaming: false },
        run: (params) => {
          const p = params as { share: string; path: string; readOnly: boolean };
          shareCalls.push(params as Record<string, unknown>);
          shares = [
            ...shares,
            {
              name: p.share,
              hostPath: p.path,
              readOnly: p.readOnly,
              guestPath: `/mnt/psyche/${p.share}`,
            },
          ];
          return guestOf(shares);
        },
      },
    ],
  });
  const ran: Record<string, unknown>[] = [];
  const sessions = sessionHandlers((argv) =>
    // The "guest image": the MCP probe server for MCP tests, else an upper-casing echo.
    argv.includes("probe")
      ? spawn(process.execPath, [PROBE], { stdio: ["pipe", "pipe", "pipe"], env: {} })
      : spawn(
          process.execPath,
          [
            "-e",
            "process.stdin.on('data',d=>process.stdout.write(String(d).toUpperCase()));process.stderr.write('ready')",
          ],
          { stdio: ["pipe", "pipe", "pipe"] },
        ),
  );
  const guestKey = newDeviceKey();
  pairNodeDevice(c.gateway, "guest-psyche-node", guestKey);
  const guestNode = await FakeNode.connect(c.gateway.config.guestSocketPath as string, {
    origin: c.gateway.origin,
    secret: c.gateway.handshakeSecret,
    deviceId: "guest-psyche-node",
    key: guestKey,
    deviceFamily: "vm-guest",
    handlers: [
      {
        capability: { name: "exec", sideEffect: "write", streaming: true },
        run: (params) => {
          ran.push(params as Record<string, unknown>);
          const p = params as { stdin?: string };
          return {
            exitCode: 0,
            stdout: `got ${p.stdin ?? ""}`,
            stderr: "",
            durationMs: 3,
            truncated: false,
            filesChanged: [],
            timedOut: false,
            outcome: "ok",
          };
        },
        receipt: { outcome: "ok", summary: "node exited 0" },
      },
      ...(options.sessions === false ? [] : sessions.handlers),
    ],
  });
  nodes.push(helper, guestNode);
  const owner = await adminClient(c.gateway);
  clients.push(owner);
  await owner.call("settings.set", { key: VM_SETTING_KEYS.enabled, value: true }, ik());
  await owner.call(
    "settings.set",
    { key: VM_SETTING_KEYS.guestNodeId, value: guestNode.nodeId },
    ik(),
  );
  const v = vm as ComposedVm;
  await v.refresh();
  return { c, owner, vm: v, ran, sessions, shareCalls, mcp };
}

describe("srt's features in the sandbox guest (VmRunner)", () => {
  it("run(): stdin, staged files, network policy and a throwaway folder reach the guest's exec", async () => {
    const { c, vm, ran } = await stack();
    expect(vm.runner.canIsolate()).toBe(true);
    expect(sandboxPcStatus(vm, "win32")).toEqual({ enabled: true, ready: true });
    expect(sandboxPcStatus(vm, "darwin")).toBeUndefined();
    const r = await vm.runner.run({
      argv: ["node", "main.mjs"],
      files: [{ path: "main.mjs", content: "console.log(1)" }],
      stdin: '{"a":1}',
      network: "none",
      timeoutMs: 5_000,
    });
    expect(ran).toEqual([
      {
        argv: ["node", "main.mjs"],
        cwd: "/workspace",
        timeoutMs: 5_000,
        scope: { kind: "thread", id: "scripts" },
        network: "none",
        ephemeral: true,
        stdin: '{"a":1}',
        files: [{ path: "main.mjs", content: "console.log(1)" }],
      },
    ]);
    // Only the documented shape comes back, always untrusted.
    expect(r).toMatchObject({ exitCode: 0, stdout: 'got {"a":1}', provenance: "untrusted" });
    const receipts = await c.broker.listReceipts();
    expect(receipts.map((x) => x.kind)).toContain("vm.exec");
  }, 30_000);

  it("openStdio(): ordered stdin writes, streamed stdout and stderr, and a kill that closes it", async () => {
    const { vm, sessions } = await stack();
    const inst = await vm.runner.ensureSandbox({ kind: "task", id: "mcp:echo" });
    const proc = await vm.runner.openStdio(inst.id, {
      argv: ["echo-server"],
      env: { MODE: "x" },
    });
    expect(sessions.opened[0]).toMatchObject({
      argv: ["echo-server"],
      cwd: "/workspace",
      env: { MODE: "x" },
      // Off the network unless asked.
      network: "none",
      scope: { kind: "task", id: "mcp:echo" },
    });
    let out = "";
    let err = "";
    proc.stdout.on("data", (d: Buffer) => {
      out += d.toString("utf8");
    });
    proc.stderr.on("data", (d: Buffer) => {
      err += d.toString("utf8");
    });
    for (const part of ["one ", "two ", "three"]) proc.stdin.write(part);
    const until = Date.now() + 10_000;
    while (out !== "ONE TWO THREE" && Date.now() < until)
      await new Promise((r) => setTimeout(r, 20));
    expect(out).toBe("ONE TWO THREE");
    expect(err).toBe("ready");
    expect(sessions.writes.map((w) => Buffer.from(w.data ?? "", "base64").toString())).toEqual([
      "one ",
      "two ",
      "three",
    ]);
    await proc.kill("TERM");
    const end = await proc.exited;
    expect(end.exitCode === null || typeof end.exitCode === "number").toBe(true);
    expect(sessions.closes).toEqual([
      expect.objectContaining({ signal: "TERM", sessionId: sessions.writes[0]?.sessionId }),
    ]);
  }, 30_000);

  it("a guest without sessions (an older image) cannot isolate: run and openStdio refuse, nothing runs", async () => {
    const { vm, ran } = await stack({ sessions: false });
    expect(vm.runner.ready()).toBe(true);
    expect(vm.runner.canIsolate()).toBe(false);
    expect(sandboxPcStatus(vm, "win32")).toEqual({ enabled: true, ready: false });
    await expect(
      vm.runner.run({ argv: ["node"], network: "none", timeoutMs: 1_000 }),
    ).rejects.toMatchObject({ code: "unavailable", details: { reason: "vm_guest_outdated" } });
    const inst = await vm.runner.ensureSandbox({ kind: "thread", id: "t" });
    await expect(vm.runner.openStdio(inst.id, { argv: ["x"] })).rejects.toMatchObject({
      details: { reason: "vm_guest_outdated", capability: GUEST_SESSION_CAPABILITY },
    });
    expect(ran).toEqual([]);
  }, 30_000);

  it("turned off: canIsolate is false and run refuses (never anywhere else)", async () => {
    const { vm, owner, ran } = await stack();
    await owner.call("settings.set", { key: VM_SETTING_KEYS.enabled, value: false }, ik());
    expect(vm.runner.canIsolate()).toBe(false);
    expect(sandboxPcStatus(vm, "win32")).toEqual({ enabled: false, ready: false });
    await expect(
      vm.runner.run({ argv: ["node"], network: "none", timeoutMs: 1_000 }),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(ran).toEqual([]);
  }, 30_000);

  it("granted folders become guest shares, read-only unless the mount is read-write, reused after", async () => {
    const { vm, shareCalls } = await stack();
    const ro = join(home, "Docs");
    const rw = join(home, "Work");
    mkdirSync(ro);
    mkdirSync(rw);
    const inst = await vm.runner.ensureSandbox(
      { kind: "thread", id: "folders" },
      {
        mounts: [
          { source: ro, target: "/workspace/docs", readOnly: true },
          { source: rw, target: "/workspace/work", readOnly: false },
        ],
      },
    );
    expect(shareCalls).toEqual([
      expect.objectContaining({ path: ro, readOnly: true, name: "sandbox" }),
      expect.objectContaining({ path: rw, readOnly: false, name: "sandbox" }),
    ]);
    expect(
      inst.mounts?.map((m) => [m.source, m.readOnly, m.target.startsWith("/mnt/psyche/")]),
    ).toEqual([
      [ro, true, true],
      [rw, false, true],
    ]);
    // Same folders again: the same sandbox, no new share. Other folders: a conflict.
    await vm.runner.ensureSandbox(
      { kind: "thread", id: "folders" },
      {
        mounts: [
          { source: ro, target: "/workspace/docs", readOnly: true },
          { source: rw, target: "/workspace/work", readOnly: false },
        ],
      },
    );
    expect(shareCalls).toHaveLength(2);
    await expect(
      vm.runner.ensureSandbox(
        { kind: "thread", id: "folders" },
        { mounts: [{ source: ro, target: "/workspace/docs", readOnly: false }] },
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    // A second sandbox sharing a folder the guest already has reuses its share.
    await vm.runner.ensureSandbox(
      { kind: "thread", id: "other" },
      { mounts: [{ source: ro, target: "/workspace/docs", readOnly: true }] },
    );
    expect(shareCalls).toHaveLength(2);
  }, 30_000);

  it("a stdio MCP server runs in the guest end to end through the VM launcher", async () => {
    const { mcp, sessions, owner } = await stack({ mcp: true });
    const m = mcp as ComposedMcp;
    const status = await owner.call<{ launcher: string }>("mcp.status", {});
    expect(status.launcher).toBe("vm");
    const info = await m.host.addServer({
      id: "probe",
      name: "Probe",
      trust: "unknown",
      transport: { kind: "stdio", command: ["node", "probe"], env: { MODE: "test" } },
    });
    expect(info.status).toBe("connected");
    expect(m.host.describe("probe").isolation).toBe("vm");
    expect(sessions.opened[0]).toMatchObject({
      argv: ["node", "probe"],
      env: { MODE: "test" },
      network: "none",
      scope: { kind: "task", id: "mcp:probe" },
    });
    const { tools } = await m.host.listTools("probe");
    expect(tools.length).toBeGreaterThan(0);
    await m.host.removeServer("probe");
    expect(sessions.closes.length).toBeGreaterThan(0);
  }, 30_000);

  it("with the sandbox PC off, command servers and Psyche-made connectors are refused and nothing runs anywhere", async () => {
    const { mcp, sessions, owner } = await stack({ mcp: true });
    const m = mcp as ComposedMcp;
    await owner.call("settings.set", { key: VM_SETTING_KEYS.enabled, value: false }, ik());
    expect((await owner.call<{ launcher: string }>("mcp.status", {})).launcher).toBe("none");
    // The probe → card flow names the fix: the `sandbox` permission (on Windows: turn it on).
    await expect(
      m.adder.test({
        id: "p",
        name: "P",
        trust: "unknown",
        transport: { kind: "stdio", command: ["npx", "-y", "some-server"] },
      }),
    ).rejects.toMatchObject({
      code: "unavailable",
      details: { reason: "no_launcher", missing: { need: "sandbox" } },
    });
    await expect(
      m.adder.test({
        id: "made",
        name: "Made",
        trust: "unknown",
        transport: { kind: "stdio", command: ["node", "server.mjs"] },
        madeBy: "psyche",
      }),
    ).rejects.toMatchObject({ details: { reason: "no_launcher" } });
    // A server already configured does not start on the host either.
    const info = await m.host.addServer({
      id: "probe",
      name: "Probe",
      trust: "unknown",
      transport: { kind: "stdio", command: ["node", "probe"] },
    });
    expect(info.status).not.toBe("connected");
    expect(m.host.describe("probe").error).toContain("Turn on the sandbox PC");
    expect(sessions.opened).toEqual([]);
  }, 30_000);
});
