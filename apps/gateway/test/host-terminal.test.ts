import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateDevice } from "@psyche/db";
import { type PresenceVerifier, presenceChallenge } from "@psyche/permissions";
import type { ApprovalRequest } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import type {
  HostTerminalOptions,
  PtyProcess,
  PtySpawnOptions,
} from "../src/compose/host-terminal.ts";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { silentLogger } from "../src/log.ts";
import { adminClient, handshake, ik, newDeviceKey, TestClient, wsUrlOf } from "./helpers.ts";

/** The shell the target names: `/bin/sh`, or on Windows `cmd.exe` (always there; no `-l`). */
const WIN = process.platform === "win32";
const SHELL = WIN
  ? (process.env.ComSpec ?? `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\cmd.exe`)
  : "/bin/sh";

/**
 * A terminal on the Host (remote-gateway design §4.2, R4): the Gateway runs the PTY, one device
 * owns each session. Every PTY here is a fake; nothing is spawned.
 */

class FakePty implements PtyProcess {
  readonly written: string[] = [];
  readonly resized: Array<[number, number]> = [];
  killed = false;
  paused = false;
  pauseCalls = 0;
  #data = new Set<(d: string) => void>();
  #exit = new Set<(e: { exitCode: number }) => void>();
  readonly file: string;
  readonly args: string[];
  readonly options: PtySpawnOptions;
  constructor(file: string, args: string[], options: PtySpawnOptions) {
    this.file = file;
    this.args = args;
    this.options = options;
  }
  onData(l: (d: string) => void) {
    this.#data.add(l);
    return { dispose: () => this.#data.delete(l) };
  }
  onExit(l: (e: { exitCode: number }) => void) {
    this.#exit.add(l);
    return { dispose: () => this.#exit.delete(l) };
  }
  write(d: string) {
    this.written.push(d);
  }
  resize(c: number, r: number) {
    this.resized.push([c, r]);
  }
  kill() {
    this.killed = true;
  }
  pause() {
    this.paused = true;
    this.pauseCalls += 1;
  }
  resume() {
    this.paused = false;
  }
  emit(d: string) {
    for (const l of this.#data) l(d);
  }
  exit(exitCode: number) {
    for (const l of this.#exit) l({ exitCode });
  }
}

let composed: ComposedGateway | null = null;
let home = "";
let work = "";
const clients: TestClient[] = [];
let ptys: FakePty[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
  home = "";
  ptys = [];
});

const touchId: PresenceVerifier = {
  verify: async (assertion, challenge) => assertion.signature === `signed:${challenge}`,
};

async function boot(
  hostTerminal: HostTerminalOptions = {},
  extra: { presence?: PresenceVerifier; limits?: { deviceRequestsPerMinute: number } } = {},
) {
  home = mkdtempSync(join(tmpdir(), "psyche-hostterm-"));
  work = join(home, "work");
  mkdirSync(work);
  composed = await composeGateway({
    env: {},
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    model: { provider: new FakeModelProvider(), model: "fake/model" },
    ...(extra.presence ? { presence: extra.presence } : {}),
    ...(extra.limits ? { limits: extra.limits } : {}),
    hostTerminal: {
      spawn: (file, args, options) => {
        const p = new FakePty(file, args, options);
        ptys.push(p);
        return p;
      },
      hostName: () => "test-host",
      target: () => ({
        home,
        userShell: SHELL,
        env: {
          ...(WIN ? { SystemRoot: process.env.SystemRoot, Path: "C:\\Windows\\System32" } : {}),
          PATH: "/usr/bin:/bin",
          LANG: "en_US.UTF-8",
          PSYCHE_HANDSHAKE_SECRET: "must-not-leak",
          ANTHROPIC_API_KEY: "must-not-leak",
        },
        user: "owner",
      }),
      limits: { flushMs: 0, sweepMs: 60_000 },
      ...hostTerminal,
    },
  });
  return composed;
}

/** A paired device that is not the desktop shell: admin (or not) as the test needs. */
async function remoteDevice(
  c: ComposedGateway,
  deviceId: string,
  scopes: Array<"operator.read" | "operator.write" | "operator.approvals" | "operator.admin">,
  key = newDeviceKey(),
): Promise<{ client: TestClient; key: ReturnType<typeof newDeviceKey> }> {
  const first = await TestClient.open(wsUrlOf(c.gateway));
  await handshake(first, c.gateway.origin, { key, deviceId, deviceFamily: "cli" });
  first.close();
  updateDevice(c.db, deviceId, { scopes, pairedAt: new Date().toISOString() });
  return { client: await reconnect(c, deviceId, key), key };
}

async function reconnect(
  c: ComposedGateway,
  deviceId: string,
  key: ReturnType<typeof newDeviceKey>,
): Promise<TestClient> {
  const client = await TestClient.open(wsUrlOf(c.gateway));
  clients.push(client);
  const r = await handshake(client, c.gateway.origin, { key, deviceId, deviceFamily: "cli" });
  expect((r.verifyRes?.payload as { phase?: string } | undefined)?.phase).toBe("paired");
  return client;
}

const ADMIN = ["operator.read", "operator.write", "operator.approvals", "operator.admin"] as const;
const open = (c: TestClient, extra: Record<string, unknown> = {}) =>
  c.call<{ sessionId: string; target: string; label: string }>(
    "terminal.session.open",
    { cols: 80, rows: 24, ...extra },
    ik(),
  );
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe("a terminal on the Host: the round trip", () => {
  it("opens, takes input and resizes, streams output with an end, acks and reports the exit", async () => {
    const c = await boot();
    const desk = await adminClient(c.gateway);
    clients.push(desk);
    const s = await open(desk, { cwd: work });
    expect(s.target).toBe("host");
    expect(s.label).toContain(WIN ? "cmd.exe" : "sh");
    const pty = ptys[0] as FakePty;
    // The Host's own shell in the folder asked for, with a fixed environment.
    expect(pty.file).toBe(SHELL);
    expect(pty.args).toEqual(WIN ? [] : ["-l"]);
    expect(pty.options.cwd).toContain("work");
    expect(pty.options).toMatchObject({ cols: 80, rows: 24 });
    expect(Object.keys(pty.options.env).sort()).toEqual(
      (WIN
        ? // Windows: the system and profile variables the target has, never the rest.
          ["COLORTERM", "HOME", "Path", "SystemRoot", "TEMP", "TERM", "TMP"]
        : ["COLORTERM", "HOME", "LANG", "LOGNAME", "PATH", "SHELL", "TERM", "TMPDIR", "USER"]
      ).sort(),
    );
    expect(JSON.stringify(pty.options.env)).not.toContain("must-not-leak");

    await desk.call("terminal.session.write", { sessionId: s.sessionId, data: "echo hi\r" });
    expect(pty.written).toEqual(["echo hi\r"]);
    await desk.call("terminal.session.resize", { sessionId: s.sessionId, cols: 100, rows: 30 });
    expect(pty.resized).toEqual([[100, 30]]);

    pty.emit("hi\r\n");
    const out = await desk.waitForEvent((e) => e.event === "terminal.output");
    expect(out.payload).toEqual({ sessionId: s.sessionId, data: "hi\r\n", end: 4 });
    await desk.call("terminal.session.ack", { sessionId: s.sessionId, end: 4 });

    pty.exit(3);
    const exit = await desk.waitForEvent((e) => e.event === "terminal.exit");
    expect(exit.payload).toEqual({ sessionId: s.sessionId, exitCode: 3, reason: "exited" });
    // The session is gone.
    await expect(
      desk.call("terminal.session.write", { sessionId: s.sessionId, data: "x" }),
    ).rejects.toThrow(/not_found/);
  });

  it("close kills the shell and is idempotent", async () => {
    const c = await boot();
    const desk = await adminClient(c.gateway);
    clients.push(desk);
    const s = await open(desk);
    expect(await desk.call("terminal.session.close", { sessionId: s.sessionId })).toEqual({
      closed: true,
    });
    expect((ptys[0] as FakePty).killed).toBe(true);
    expect(await desk.call("terminal.session.close", { sessionId: s.sessionId })).toEqual({
      closed: false,
    });
  });

  it("audits the open and the close with sizes only, never the contents", async () => {
    const c = await boot();
    const desk = await adminClient(c.gateway);
    clients.push(desk);
    const s = await open(desk, { cwd: work });
    const pty = ptys[0] as FakePty;
    await desk.call("terminal.session.write", { sessionId: s.sessionId, data: "secret-typed\r" });
    pty.emit("secret-output\r\n");
    await desk.waitForEvent((e) => e.event === "terminal.output");
    await desk.call("terminal.session.close", { sessionId: s.sessionId });
    await tick();
    const opened = await c.audit.list({ kind: "terminal.session.open" });
    const closed = await c.audit.list({ kind: "terminal.session.close" });
    expect(opened).toHaveLength(1);
    expect(closed).toHaveLength(1);
    expect(opened[0]?.data).toMatchObject({ sessionId: s.sessionId, shell: SHELL });
    expect(closed[0]?.data).toMatchObject({
      sessionId: s.sessionId,
      reason: "closed",
      outputChars: 15,
      inputChars: 13,
    });
    expect(JSON.stringify([...opened, ...closed])).not.toContain("secret");
  });

  it("refuses a folder that does not exist and a relative one", async () => {
    const c = await boot();
    const desk = await adminClient(c.gateway);
    clients.push(desk);
    await expect(open(desk, { cwd: join(work, "nope") })).rejects.toThrow(/doesn't exist/);
    await expect(open(desk, { cwd: "relative/dir" })).rejects.toThrow(/absolute/);
    expect(ptys).toHaveLength(0);
  });

  it("splits a very long write into chunks no larger than the 64 KB write cap", async () => {
    const c = await boot();
    const desk = await adminClient(c.gateway);
    clients.push(desk);
    const s = await open(desk);
    const big = "a".repeat(64 * 1024);
    await desk.call("terminal.session.write", { sessionId: s.sessionId, data: big });
    expect((ptys[0] as FakePty).written.join("").length).toBe(64 * 1024);
    const tooBig = await desk.request("terminal.session.write", {
      sessionId: s.sessionId,
      data: "é".repeat(40 * 1024), // 80 KB of UTF-8 under the character cap
    });
    expect(tooBig).toMatchObject({ ok: false, error: { code: "invalid_params" } });
  });
});

describe("who may open a Host terminal", () => {
  it("refuses a device without admin", async () => {
    const c = await boot();
    const { client } = await remoteDevice(c, "reader", [
      "operator.read",
      "operator.write",
      "operator.approvals",
    ]);
    const res = await client.request("terminal.session.open", { cols: 80, rows: 24 }, ik());
    expect(res).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(JSON.stringify(res)).toContain("operator.admin");
    expect(ptys).toHaveLength(0);
  });

  it("tells an admin device that is not the desktop shell to open it on the Host, until a presence verifier exists", async () => {
    const c = await boot();
    const { client } = await remoteDevice(c, "remote-admin", [...ADMIN]);
    const res = await client.request("terminal.session.open", { cols: 80, rows: 24 }, ik());
    expect(res).toMatchObject({
      ok: false,
      error: {
        code: "forbidden",
        message: "Open the terminal on test-host",
        details: { reason: "host_terminal_needs_presence" },
      },
    });
    expect(ptys).toHaveLength(0);
  });

  it("lets a presence verifier plug in: an injected check decides, before anything is spawned", async () => {
    const seen: Array<{ cwd: string | undefined }> = [];
    const c = await boot({
      presence: {
        check: async (call, input) => {
          seen.push({ cwd: input.cwd });
          if (call.identity.deviceId !== "passkey-admin") {
            throw Object.assign(new Error("no"), { code: "forbidden" });
          }
        },
      },
    });
    const { client } = await remoteDevice(c, "passkey-admin", [...ADMIN]);
    const s = await open(client, { cwd: work });
    expect(s.target).toBe("host");
    expect(seen).toEqual([{ cwd: work }]);
    const { client: other } = await remoteDevice(c, "other-admin", [...ADMIN]);
    expect(await other.request("terminal.session.open", { cols: 1, rows: 1 }, ik())).toMatchObject({
      ok: false,
    });
    expect(ptys).toHaveLength(1);
  });

  it("with a verifier ready, asks for a card first (a tap, no presence) and opens only after it is approved", async () => {
    const c = await boot({}, { presence: touchId });
    const { client } = await remoteDevice(c, "remote-admin", [...ADMIN]);
    const first = await client.request("terminal.session.open", { cols: 80, rows: 24 }, ik());
    expect(first).toMatchObject({ ok: false, error: { code: "approval_required" } });
    expect(ptys).toHaveLength(0);
    const approvalId = (first as { error: { details: { approvalId: string } } }).error.details
      .approvalId;
    const got = await client.call<{ approval: ApprovalRequest; answerToken?: string }>(
      "approvals.get",
      { approvalId },
    );
    expect(got.approval).toMatchObject({ kind: "policy_change", requiresAuthentication: false });
    expect(got.approval.summary).toBe("Open a terminal on test-host");
    const token = got.answerToken ?? "";
    await tick(450); // past the arm delay
    expect(
      await client.request(
        "approvals.answer",
        { approvalId, answerToken: token, decision: "approve" },
        ik(),
      ),
    ).toMatchObject({ ok: true });
    const second = await client.request(
      "terminal.session.open",
      { cols: 100, rows: 40, approvalId },
      ik(),
    );
    expect(second).toMatchObject({ ok: true });
    expect(ptys).toHaveLength(1);
    // The approval is single-use: it opens one terminal, not a standing right to more.
    expect(
      await client.request("terminal.session.open", { cols: 80, rows: 24, approvalId }, ik()),
    ).toMatchObject({ ok: false, error: { code: "binding_mismatch" } });
    expect(ptys).toHaveLength(1);
  });
});

describe("a session belongs to the device that opened it", () => {
  it("lets no other device write, resize, ack, close or receive it", async () => {
    // The injected check lets both admins open; ownership is what is under test.
    const c = await boot({ presence: { check: async () => undefined } });
    const a = (await remoteDevice(c, "device-a", [...ADMIN])).client;
    const b = (await remoteDevice(c, "device-b", [...ADMIN])).client;
    const s = await open(a);
    const pty = ptys[0] as FakePty;

    for (const [method, params] of [
      ["terminal.session.write", { sessionId: s.sessionId, data: "rm -rf ~\r" }],
      ["terminal.session.resize", { sessionId: s.sessionId, cols: 1, rows: 1 }],
      ["terminal.session.ack", { sessionId: s.sessionId, end: 0 }],
    ] as const) {
      expect(await b.request(method, params)).toMatchObject({
        ok: false,
        error: { code: "not_found" },
      });
    }
    // Closing someone else's session does nothing, and does not say it exists.
    expect(await b.call("terminal.session.close", { sessionId: s.sessionId })).toEqual({
      closed: false,
    });
    expect(pty.written).toEqual([]);
    expect(pty.resized).toEqual([]);
    expect(pty.killed).toBe(false);

    pty.emit("owner output");
    await a.waitForEvent((e) => e.event === "terminal.output");
    await tick();
    expect(b.eventsNamed("terminal.output")).toEqual([]);
    // The owner still can.
    await a.call("terminal.session.write", { sessionId: s.sessionId, data: "ls\r" });
    expect(pty.written).toEqual(["ls\r"]);
  });
});

describe("how long a session lives", () => {
  it("kills the shell once its device has been gone past the grace period", async () => {
    const c = await boot({ limits: { flushMs: 0, disconnectGraceMs: 80, sweepMs: 60_000 } });
    const desk = await adminClient(c.gateway);
    const s = await open(desk);
    const pty = ptys[0] as FakePty;
    desk.close();
    await tick(30);
    expect(pty.killed).toBe(false); // still inside the grace period
    await tick(200);
    expect(pty.killed).toBe(true);
    const closed = await c.audit.list({ kind: "terminal.session.close" });
    expect(closed[0]?.data).toMatchObject({
      sessionId: s.sessionId,
      reason: "device_disconnected",
    });
  });

  it("keeps the session when the same device comes back inside the grace period", async () => {
    const c = await boot({
      presence: { check: async () => undefined },
      limits: { flushMs: 0, disconnectGraceMs: 150, sweepMs: 60_000 },
    });
    const { client, key } = await remoteDevice(c, "flaky", [...ADMIN]);
    const s = await open(client);
    const pty = ptys[0] as FakePty;
    client.close();
    await tick(40);
    pty.emit("while you were away");
    const back = await reconnect(c, "flaky", key);
    await back.call("terminal.session.write", { sessionId: s.sessionId, data: "ls\r" });
    // What was held while it was away arrives now, and the session outlives the grace period.
    const out = await back.waitForEvent((e) => e.event === "terminal.output");
    expect((out.payload as { data: string }).data).toBe("while you were away");
    await tick(300);
    expect(pty.killed).toBe(false);
    expect(pty.written).toEqual(["ls\r"]);
  });

  it("kills the shell at once when its device is revoked", async () => {
    const c = await boot({ presence: { check: async () => undefined } });
    const { client } = await remoteDevice(c, "doomed", [...ADMIN]);
    const s = await open(client);
    const pty = ptys[0] as FakePty;
    const owner = await adminClient(c.gateway);
    clients.push(owner);
    await owner.call("devices.revoke", { deviceId: "doomed" }, ik());
    await tick(30);
    expect(pty.killed).toBe(true);
    const closed = await c.audit.list({ kind: "terminal.session.close" });
    expect(closed[0]?.data).toMatchObject({ sessionId: s.sessionId, reason: "device_revoked" });
  });

  it("kills the shell when its device loses admin (the sweep)", async () => {
    const c = await boot({
      presence: { check: async () => undefined },
      limits: { flushMs: 0, sweepMs: 40 },
    });
    const { client } = await remoteDevice(c, "demoted", [...ADMIN]);
    await open(client);
    const pty = ptys[0] as FakePty;
    updateDevice(c.db, "demoted", { scopes: ["operator.read"] });
    await tick(150);
    expect(pty.killed).toBe(true);
  });

  it("kills every shell when the Gateway stops", async () => {
    const c = await boot();
    const desk = await adminClient(c.gateway);
    clients.push(desk);
    await open(desk);
    await open(desk);
    await c.stop("test");
    composed = null;
    expect(ptys.every((p) => p.killed)).toBe(true);
  });
});

describe("the presence card is bound to the device that asked", () => {
  async function approve(client: TestClient, first: Record<string, unknown>, deviceId: string) {
    const approvalId = (first as { error: { details: { approvalId: string } } }).error.details
      .approvalId;
    const got = await client.call<{ approval: ApprovalRequest; answerToken?: string }>(
      "approvals.get",
      { approvalId },
    );
    const token = got.answerToken ?? "";
    await tick(450); // past the arm delay
    const challenge = presenceChallenge(approvalId, got.approval.bindingHash, token);
    expect(
      await client.request(
        "approvals.answer",
        {
          approvalId,
          answerToken: token,
          decision: "approve",
          presence: { kind: "webauthn", deviceId, signature: `signed:${challenge}` },
        },
        ik(),
      ),
    ).toMatchObject({ ok: true });
    return approvalId;
  }

  it("refuses another admin device spending an approved terminal card", async () => {
    const c = await boot({}, { presence: touchId });
    const x = (await remoteDevice(c, "admin-x", [...ADMIN])).client;
    const y = (await remoteDevice(c, "admin-y", [...ADMIN])).client;
    const first = await x.request("terminal.session.open", { cols: 80, rows: 24 }, ik());
    const approvalId = await approve(x, first, "admin-x");
    // Y saw the card id on approval.created and presents it.
    expect(
      await y.request("terminal.session.open", { cols: 80, rows: 24, approvalId }, ik()),
    ).toMatchObject({ ok: false, error: { code: "binding_mismatch" } });
    expect(ptys).toHaveLength(0);
    // The owner of the request can still use it: Y's attempt did not consume it.
    expect(
      await x.request("terminal.session.open", { cols: 80, rows: 24, approvalId }, ik()),
    ).toMatchObject({ ok: true });
    expect(ptys).toHaveLength(1);
  });

  it("holds for another presence-gated method too (memory.reset)", async () => {
    const c = await boot({}, { presence: touchId });
    const x = (await remoteDevice(c, "admin-x", [...ADMIN])).client;
    const y = (await remoteDevice(c, "admin-y", [...ADMIN])).client;
    const first = await x.request("memory.reset", {}, ik());
    const approvalId = await approve(x, first, "admin-x");
    expect(await y.request("memory.reset", { approvalId }, ik())).toMatchObject({
      ok: false,
      error: { code: "binding_mismatch" },
    });
    expect(await x.request("memory.reset", { approvalId }, ik())).toMatchObject({ ok: true });
  });
});

describe("sessions that would be orphaned", () => {
  it("starts the grace clock for a session whose socket closed while open was still waiting", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const c = await boot({
      presence: { check: () => gate },
      limits: { flushMs: 0, sweepMs: 60_000, disconnectGraceMs: 60 },
    });
    const { client } = await remoteDevice(c, "slow", [...ADMIN]);
    void client.request("terminal.session.open", { cols: 80, rows: 24 }, ik());
    await tick(30);
    client.close();
    await tick(50);
    release();
    await tick(30);
    const pty = ptys[0] as FakePty;
    expect(pty).toBeDefined();
    await tick(200);
    expect(pty.killed).toBe(true);
  });

  it("kills a session whose device is back online but never spoke again", async () => {
    const c = await boot({
      presence: { check: async () => undefined },
      limits: { flushMs: 0, sweepMs: 60_000, disconnectGraceMs: 80 },
    });
    const { client, key } = await remoteDevice(c, "silent", [...ADMIN]);
    await open(client);
    client.close();
    await tick(20);
    await reconnect(c, "silent", key); // connected, but sends nothing for the session
    await tick(250);
    expect((ptys[0] as FakePty).killed).toBe(true);
    const closed = await c.audit.list({ kind: "terminal.session.close" });
    expect(closed[0]?.data).toMatchObject({ reason: "device_disconnected" });
  });

  it("closes a session with no calls for the idle timeout", async () => {
    // The idle clock is the injected one, so a loaded machine's late timers change nothing: the
    // real 20 ms sweep only looks at it.
    let clock = 1_000_000;
    const c = await boot({
      now: () => clock,
      limits: { flushMs: 0, sweepMs: 20, idleTimeoutMs: 80 },
    });
    const desk = await adminClient(c.gateway);
    clients.push(desk);
    const s = await open(desk);
    clock += 60;
    await tick(60);
    expect((ptys[0] as FakePty).killed).toBe(false);
    // An ack counts as activity.
    await desk.call("terminal.session.ack", { sessionId: s.sessionId, end: 0 });
    clock += 60; // 120 ms since the open, 60 since the ack
    await tick(60);
    expect((ptys[0] as FakePty).killed).toBe(false);
    clock += 30; // 90 ms since the ack

    const exit = await desk.waitForEvent((e) => e.event === "terminal.exit");
    expect(exit.payload).toMatchObject({ sessionId: s.sessionId, reason: "idle" });
    expect((ptys[0] as FakePty).killed).toBe(true);
  });
});

describe("terminal calls and the device request budget", () => {
  it("charges calls naming a session the device does not own to the normal limiter", async () => {
    const c = await boot({}, { limits: { deviceRequestsPerMinute: 8 } });
    const desk = await adminClient(c.gateway);
    clients.push(desk);
    const s = await open(desk);
    // Owned stream calls are exempt from the budget...
    for (let i = 0; i < 20; i++) {
      await desk.call("terminal.session.write", { sessionId: s.sessionId, data: "a" });
    }
    // ...guesses at other ids are not.
    const codes: string[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await desk.request("terminal.session.write", {
        sessionId: `term_guess${i}`,
        data: "x",
      });
      codes.push(String((r.error as { code?: string } | undefined)?.code));
    }
    expect(codes).toContain("rate_limited");
  });

  it("meters resizes and calls per session", async () => {
    const c = await boot({
      limits: {
        flushMs: 0,
        sweepMs: 60_000,
        resizeBurst: 3,
        resizesPerSecond: 0.001,
        callBurst: 8,
        callsPerSecond: 0.001,
      },
    });
    const desk = await adminClient(c.gateway);
    clients.push(desk);
    const s = await open(desk);
    const res = [];
    for (let i = 0; i < 4; i++) {
      res.push(
        await desk.request("terminal.session.resize", {
          sessionId: s.sessionId,
          cols: 80 + i,
          rows: 24,
        }),
      );
    }
    expect(res.map((r) => r.ok)).toEqual([true, true, true, false]);
    expect(res[3]).toMatchObject({ error: { code: "rate_limited" } });
    // Eight calls of any kind in all (the refused resize was charged a call too).
    let refused = 0;
    for (let i = 0; i < 6; i++) {
      const r = await desk.request("terminal.session.write", { sessionId: s.sessionId, data: "a" });
      if (r.ok !== true) refused += 1;
    }
    expect(refused).toBeGreaterThan(0);
  });
});

describe("audit and open ordering", () => {
  it("records the approval, peer and transport on the open, and audits refused opens", async () => {
    const c = await boot({ presence: { check: async () => undefined } });
    const { client } = await remoteDevice(c, "auditee", [...ADMIN]);
    await open(client);
    const opened = await c.audit.list({ kind: "terminal.session.open" });
    expect(opened[0]?.data).toMatchObject({ transport: "ws", approvalId: null });
    expect(opened[0]?.data).toHaveProperty("peerAddress");

    const { client: other } = await remoteDevice(c, "refused-one", [...ADMIN]);
    await other.request("terminal.session.open", { cols: 80, rows: 24, cwd: "relative" }, ik());
    await tick();
    const refused = await c.audit.list({ kind: "terminal.session.refused" });
    expect(refused).toHaveLength(1);
    expect(refused[0]?.data).toMatchObject({ code: "invalid_params" });
  });

  it("opens no shell when the audit record cannot be written (fails closed)", async () => {
    const c = await boot({ presence: { check: async () => undefined } });
    const { client } = await remoteDevice(c, "unaudited", [...ADMIN]);
    const original = c.audit.append.bind(c.audit);
    c.audit.append = async (entry) => {
      if (entry.kind === "terminal.session.open") throw new Error("disk full");
      return original(entry);
    };
    const res = await client.request("terminal.session.open", { cols: 80, rows: 24 }, ik());
    expect(res).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(ptys).toHaveLength(0);
  });

  it("checks the caps before it asks for presence, so a full house spends no approval", async () => {
    let checks = 0;
    const c = await boot({
      presence: {
        check: async () => {
          checks += 1;
        },
      },
      limits: { flushMs: 0, sweepMs: 60_000, maxSessionsPerDevice: 1 },
    });
    const { client } = await remoteDevice(c, "capped", [...ADMIN]);
    await open(client);
    expect(checks).toBe(1);
    const res = await client.request("terminal.session.open", { cols: 80, rows: 24 }, ik());
    expect(res).toMatchObject({ ok: false, error: { code: "rate_limited" } });
    expect(checks).toBe(1);
  });

  it("waits for a socket backlog to clear before sending output", async () => {
    const c = await boot({ limits: { flushMs: 0, sweepMs: 60_000, socketBacklogBytes: -1 } });
    const desk = await adminClient(c.gateway);
    clients.push(desk);
    await open(desk);
    const pty = ptys[0] as FakePty;
    pty.emit("held while the socket is backed up");
    await tick(120);
    expect(desk.eventsNamed("terminal.output")).toEqual([]);
    expect(pty.paused).toBe(true);
  });
});

describe("limits", () => {
  it("caps concurrent sessions per device", async () => {
    const c = await boot({ limits: { flushMs: 0, sweepMs: 60_000, maxSessionsPerDevice: 2 } });
    const desk = await adminClient(c.gateway);
    clients.push(desk);
    const first = await open(desk);
    await open(desk);
    const third = await desk.request("terminal.session.open", { cols: 80, rows: 24 }, ik());
    expect(third).toMatchObject({
      ok: false,
      error: { code: "rate_limited", details: { reason: "terminal_limit" } },
    });
    expect(ptys).toHaveLength(2);
    // Closing one makes room.
    await desk.call("terminal.session.close", { sessionId: first.sessionId });
    expect(await desk.request("terminal.session.open", { cols: 80, rows: 24 }, ik())).toMatchObject(
      { ok: true },
    );
  });

  it("caps concurrent sessions across devices", async () => {
    const c = await boot({
      presence: { check: async () => undefined },
      limits: { flushMs: 0, sweepMs: 60_000, maxSessions: 2, maxSessionsPerDevice: 2 },
    });
    const a = (await remoteDevice(c, "cap-a", [...ADMIN])).client;
    const b = (await remoteDevice(c, "cap-b", [...ADMIN])).client;
    await open(a);
    await open(b);
    expect(await a.request("terminal.session.open", { cols: 80, rows: 24 }, ik())).toMatchObject({
      ok: false,
      error: { code: "rate_limited" },
    });
  });

  it("stops reading the shell while the client is behind, and holds a bounded amount", async () => {
    const c = await boot({
      limits: {
        flushMs: 0,
        sweepMs: 60_000,
        outputWindow: 100,
        chunkChars: 40,
        maxPendingChars: 200,
      },
    });
    const desk = await adminClient(c.gateway);
    clients.push(desk);
    const s = await open(desk);
    const pty = ptys[0] as FakePty;

    // A shell that will not stop talking: 50 KB with no ack from the client.
    for (let i = 0; i < 500; i++) pty.emit("x".repeat(100));
    await tick(50);
    const sentBeforeAck = desk
      .eventsNamed("terminal.output")
      .reduce((n, e) => n + ((e.payload as { data: string }).data.length ?? 0), 0);
    // No more than one window goes out, and the PTY was told to stop.
    expect(sentBeforeAck).toBe(100);
    expect(pty.paused).toBe(true);

    // The client catches up: what is delivered afterwards is at most the held 200 characters,
    // not the 50 KB the shell produced.
    let acked = 0;
    for (let round = 0; round < 20; round++) {
      const last = desk.eventsNamed("terminal.output").at(-1)?.payload as { end: number };
      if (last.end === acked && round > 0) break;
      acked = last.end;
      await desk.call("terminal.session.ack", { sessionId: s.sessionId, end: last.end });
      await tick(20);
    }
    const total = desk
      .eventsNamed("terminal.output")
      .reduce((n, e) => n + (e.payload as { data: string }).data.length, 0);
    expect(total).toBeLessThanOrEqual(100 + 200);
    expect(total).toBeGreaterThan(100);
    // Once drained the shell is read again.
    expect(pty.paused).toBe(false);

    await desk.call("terminal.session.close", { sessionId: s.sessionId });
    await tick();
    const closed = await c.audit.list({ kind: "terminal.session.close" });
    expect(closed[0]?.data).toMatchObject({ reason: "closed" });
    const dropped = Number(closed[0] ? closed[0].data.droppedChars : 0);
    expect(dropped).toBeGreaterThan(40_000);
  });

  it("meters keystrokes per session", async () => {
    const c = await boot({
      limits: {
        flushMs: 0,
        sweepMs: 60_000,
        writeBurstBytes: 1000,
        writeBytesPerSecond: 1,
      },
    });
    const desk = await adminClient(c.gateway);
    clients.push(desk);
    const s = await open(desk);
    await desk.call("terminal.session.write", { sessionId: s.sessionId, data: "a".repeat(900) });
    expect(
      await desk.request("terminal.session.write", {
        sessionId: s.sessionId,
        data: "b".repeat(900),
      }),
    ).toMatchObject({ ok: false, error: { code: "rate_limited" } });
  });
});
