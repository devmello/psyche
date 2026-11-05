import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRun, openDb, updateDevice } from "@psyche/db";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { updateHandlers } from "../src/compose/update.ts";
import { resolveConfig } from "../src/config.ts";
import { silentLogger } from "../src/log.ts";
import { BusySources, UpdateGate } from "../src/update-gate.ts";
import {
  adminClient,
  desktopClient,
  handshake,
  ik,
  newDeviceKey,
  startTestGateway,
  TestClient,
  type TestGateway,
  verified,
  wsUrlOf,
} from "./helpers.ts";

/**
 * `gateway.prepareUpdate` (updates design §2.2, §2.6): stops new work, waits for running work,
 * reports what is busy, and gives the door back if no update follows.
 */

interface Report {
  state: "open" | "draining" | "ready";
  ready: boolean;
  deadline: string | null;
  busy: {
    runningTasks: number;
    activeChats: number;
    pendingApprovals: number;
    recordings: number;
    tasks: { id: string; title: string }[];
    chats: { threadId: string; runId: string }[];
  };
  checkpointed: { tasks: number; chats: number };
}

const open: TestClient[] = [];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of open.splice(0)) c.close();
  for (const fn of cleanups.splice(0)) await fn();
});

const track = <T extends TestClient>(c: T): T => {
  open.push(c);
  return c;
};

/** A gateway with the update handlers over fake task and approval sources. */
async function start(
  opts: { running?: () => { id: string; title: string }[]; config?: Record<string, unknown> } = {},
) {
  const db = openDb(":memory:");
  const gate = new UpdateGate();
  const busy = new BusySources();
  let approvals = 0;
  const waits: number[] = [];
  const t: TestGateway = await startTestGateway({
    db,
    updateGate: gate,
    handlers: updateHandlers({
      db,
      gate,
      runningTasks: async () => opts.running?.() ?? [],
      broker: { list: async () => Array.from({ length: approvals }, () => ({}) as never) },
      busy,
      sleep: async (ms) => {
        waits.push(ms);
        await new Promise((r) => setTimeout(r, 1));
      },
    }),
    ...(opts.config === undefined ? {} : { config: opts.config }),
  });
  cleanups.push(() => t.cleanup());
  const owner = track(await adminClient(t.gateway));
  return {
    t,
    db,
    gate,
    busy,
    owner,
    waits,
    setApprovals: (n: number) => {
      approvals = n;
    },
    prepare: (params: Record<string, unknown> = {}) =>
      owner.call<Report>("gateway.prepareUpdate", params),
  };
}

describe("who may call it", () => {
  it("is refused to a paired remote admin, and to an admin without the handshake secret", async () => {
    const publicOrigin = "https://studio-mac.tail1234.ts.net";
    const s = await start({ config: { publicOrigin, allowedOrigins: [publicOrigin] } });
    // Paired once as the desktop, granted admin, then back without the secret: not the shell.
    const key = newDeviceKey();
    const deviceId = "admin-no-secret";
    (await desktopClient(s.t.gateway, key, deviceId)).close();
    updateDevice(s.db, deviceId, {
      scopes: ["operator.read", "operator.write", "operator.admin"],
    });
    const plain = track(await TestClient.open(wsUrlOf(s.t.gateway)));
    const paired = await handshake(plain, s.t.gateway.origin, { key, deviceId });
    expect(verified<{ phase?: string }>(paired)?.phase).toBe("paired");
    expect(await plain.request("gateway.prepareUpdate", {})).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
    // The same admin from another computer, through a proxy: not the Host's shell either.
    const proxied = track(
      await TestClient.open(wsUrlOf(s.t.gateway), { "x-forwarded-for": "100.64.0.9" }),
    );
    const remote = await handshake(proxied, publicOrigin, {
      key,
      deviceId,
      gatewayKey: s.t.gateway.context.identity.publicKey,
    });
    expect(verified<{ phase?: string }>(remote)?.phase).toBe("paired");
    expect(await proxied.request("gateway.prepareUpdate", {})).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
    expect(s.gate.state).toBe("open");
  });

  it("is refused to a desktop that lacks the admin scope", async () => {
    const s = await start();
    const plainDesktop = track(await desktopClient(s.t.gateway));
    expect(await plainDesktop.request("gateway.prepareUpdate", {})).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
    expect(s.gate.state).toBe("open");
  });
});

describe("the busy report", () => {
  it("counts running tasks, active chats, pending approvals and recordings", async () => {
    const tasks = [{ id: "task-1", title: "Book a table" }];
    const s = await start({ running: () => tasks });
    const { thread } = await s.owner.call<{ thread: { id: string } }>(
      "threads.create",
      { kind: "main" },
      ik(),
    );
    const chat = createRun(s.db, { threadId: thread.id, modelRef: "fake/m", kind: "chat" });
    // Not counted: a task's own turn, a helper's, one parked on an approval, one that ended.
    createRun(s.db, { threadId: thread.id, modelRef: "fake/m", kind: "task", taskId: "task-1" });
    createRun(s.db, {
      threadId: thread.id,
      modelRef: "fake/m",
      kind: "subagent",
      parentRunId: chat.id,
    });
    createRun(s.db, { threadId: thread.id, modelRef: "fake/m", status: "awaiting_approval" });
    createRun(s.db, { threadId: thread.id, modelRef: "fake/m", status: "done" });
    s.setApprovals(2);
    s.busy.add("recordings", () => 1);

    const report = await s.prepare({ mode: "check" });
    expect(report.state).toBe("open");
    expect(report.ready).toBe(false);
    expect(report.busy).toEqual({
      runningTasks: 1,
      activeChats: 1,
      pendingApprovals: 2,
      recordings: 1,
      tasks,
      chats: [{ threadId: thread.id, runId: chat.id }],
    });
    // Looking changes nothing.
    expect(s.gate.state).toBe("open");
  });
});

describe("prepare", () => {
  it("stops new turns, answers ready at once when nothing runs, and cancel resumes service", async () => {
    const s = await start();
    const { thread } = await s.owner.call<{ thread: { id: string } }>(
      "threads.create",
      { kind: "main" },
      ik(),
    );
    const report = await s.prepare();
    expect(report).toMatchObject({
      state: "ready",
      ready: true,
      busy: { runningTasks: 0, activeChats: 0 },
      checkpointed: { tasks: 0, chats: 0 },
    });
    expect(Date.parse(report.deadline ?? "")).toBeGreaterThan(Date.now());

    // A message that would start a turn is refused, retryable, with the reason the UI words.
    const refused = await s.owner.request(
      "chat.send",
      { threadId: thread.id, content: "hello" },
      ik(),
    );
    expect(refused).toMatchObject({
      ok: false,
      error: { code: "unavailable", retryable: true, details: { reason: "updating" } },
    });

    const back = await s.prepare({ mode: "cancel" });
    expect(back).toMatchObject({ state: "open", ready: false, deadline: null });
    const sent = await s.owner.request(
      "chat.send",
      { threadId: thread.id, content: "hello again" },
      ik(),
    );
    expect(sent).toMatchObject({ ok: true });
  });

  it("waits for running work, then answers ready", async () => {
    let running = [{ id: "task-1", title: "Book a table" }];
    const s = await start({ running: () => running });
    // The task finishes on the third look.
    let looks = 0;
    const original = s.waits;
    const watcher = setInterval(() => {
      looks = original.length;
      if (looks >= 2) running = [];
    }, 1);
    try {
      const report = await s.prepare({ waitMs: 20_000 });
      expect(report.ready).toBe(true);
      expect(report.busy.runningTasks).toBe(0);
      expect(report.checkpointed).toEqual({ tasks: 0, chats: 0 });
      expect(s.waits.length).toBeGreaterThanOrEqual(2);
    } finally {
      clearInterval(watcher);
    }
  });

  it("answers ready when the wait ends, naming what it left running", async () => {
    const s = await start({ running: () => [{ id: "task-1", title: "Book a table" }] });
    const report = await s.prepare({ waitMs: 0 });
    expect(report).toMatchObject({
      state: "ready",
      ready: true,
      busy: { runningTasks: 1, tasks: [{ id: "task-1", title: "Book a table" }] },
      checkpointed: { tasks: 1, chats: 0 },
    });
  });

  it("lets a message to a busy chat queue, and steering still works", async () => {
    const s = await start();
    const { thread } = await s.owner.call<{ thread: { id: string } }>(
      "threads.create",
      { kind: "main" },
      ik(),
    );
    // The chat is mid-turn (a writer holds it).
    const run = createRun(s.db, { threadId: thread.id, modelRef: "fake/m", kind: "chat" });
    s.db.sqlite
      .prepare("UPDATE threads SET active_writer_run_id = ? WHERE id = ?")
      .run(run.id, thread.id);
    await s.prepare({ waitMs: 0 });
    const queued = await s.owner.request(
      "chat.send",
      { threadId: thread.id, content: "after the update", mode: "followUp" },
      ik(),
    );
    expect(queued).toMatchObject({ ok: true, payload: { queued: true } });
    // But interrupting would start a new turn: not while updating.
    expect(
      await s.owner.request(
        "chat.send",
        { threadId: thread.id, content: "now!", mode: "interrupt" },
        ik(),
      ),
    ).toMatchObject({ ok: false, error: { details: { reason: "updating" } } });
  });

  it("resumes normal service by itself when no update follows", async () => {
    const timers: { fn: () => void; ms: number }[] = [];
    const gate = new UpdateGate({
      setTimer: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length;
      },
      clearTimer: () => undefined,
    });
    const db = openDb(":memory:");
    const t = await startTestGateway({
      db,
      updateGate: gate,
      handlers: updateHandlers({
        db,
        gate,
        runningTasks: async () => [],
        broker: { list: async () => [] },
        busy: new BusySources(),
      }),
    });
    cleanups.push(() => t.cleanup());
    const owner = track(await adminClient(t.gateway));
    const { thread } = await owner.call<{ thread: { id: string } }>(
      "threads.create",
      { kind: "main" },
      ik(),
    );
    const ready = await owner.call<Report>("gateway.prepareUpdate", { timeoutMs: 45_000 });
    expect(ready.ready).toBe(true);
    // The deadline is the timeout asked for, the gate shuts the door until then...
    const timer = timers.at(-1);
    expect(timer?.ms).toBe(45_000);
    expect(
      await owner.request("chat.send", { threadId: thread.id, content: "hi" }, ik()),
    ).toMatchObject({ ok: false, error: { details: { reason: "updating" } } });
    // ...and when it passes with no update, service is back.
    timer?.fn();
    expect(gate.state).toBe("open");
    expect(
      await owner.request("chat.send", { threadId: thread.id, content: "hi" }, ik()),
    ).toMatchObject({ ok: true });
    const status = await owner.call<Report>("gateway.prepareUpdate", { mode: "check" });
    expect(status).toMatchObject({ state: "open", ready: false, deadline: null });
  });

  it("is not ready if it was cancelled while waiting", async () => {
    let running = [{ id: "task-1", title: "Book a table" }];
    const s = await start({ running: () => running });
    const waiting = s.prepare({ waitMs: 20_000 });
    // Cancel from a second call while the first waits.
    await new Promise((r) => setTimeout(r, 30));
    await s.prepare({ mode: "cancel" });
    running = [];
    const report = await waiting;
    expect(report).toMatchObject({ state: "open", ready: false });
  });
});

describe("composed Gateway", () => {
  let home = "";
  let composed: ComposedGateway | undefined;
  afterEach(async () => {
    await composed?.stop("test");
    composed = undefined;
    if (home) rmSync(home, { recursive: true, force: true });
    home = "";
  });

  it("serves it with the real task pools, approvals and database behind it", async () => {
    home = mkdtempSync(join(tmpdir(), "psy-prep-"));
    composed = await composeGateway({
      logger: silentLogger,
      retentionIntervalMs: 0,
      background: false,
      config: { ...resolveConfig({ PSYCHE_HOME: home }), port: 0, webRoot: null },
      model: { provider: new FakeModelProvider(), model: "fake/model" },
    });
    const owner = track(await adminClient(composed.gateway));
    const check = await owner.call<Report>("gateway.prepareUpdate", { mode: "check" });
    expect(check).toMatchObject({
      state: "open",
      busy: { runningTasks: 0, activeChats: 0, pendingApprovals: 0, recordings: 0 },
    });
    const { thread } = await owner.call<{ thread: { id: string } }>(
      "threads.create",
      { kind: "main" },
      ik(),
    );
    const ready = await owner.call<Report>("gateway.prepareUpdate", { waitMs: 0 });
    expect(ready.ready).toBe(true);
    expect(composed.gateway.context.updateGate.state).toBe("ready");
    expect(
      await owner.request("chat.send", { threadId: thread.id, content: "hi" }, ik()),
    ).toMatchObject({ ok: false, error: { code: "unavailable" } });
    await owner.call("gateway.prepareUpdate", { mode: "cancel" });
    expect(composed.gateway.context.updateGate.state).toBe("open");
  });
});
