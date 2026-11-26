import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolRunContext } from "@psyche/agent-core";
import {
  appendMessage,
  createRun,
  createThread,
  insertPlanFork,
  insertPlanForkBranch,
  updateDevice,
  updatePlanForkBranch,
} from "@psyche/db";
import type { Task } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { threadTools } from "../src/compose/thread-tools.ts";
import { PLAN_TURN_VISIBLE_LINE } from "../src/handlers/plan-forks.ts";
import { silentLogger } from "../src/log.ts";
import {
  TestClient as Client,
  desktopClient,
  handshake,
  ik,
  newDeviceKey,
  type TestClient,
  wsUrlOf,
} from "./helpers.ts";

/**
 * A plan fork's working held to the viewer over real connections (security review R1 of #1707):
 * task control and its answers, the live events of a fork run, the parent turn of a plan whose
 * branch read owner-only data, and the agent's own cross-thread tools.
 */

let home = "";
let composed: ComposedGateway | null = null;
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

const settle = () => new Promise((r) => setTimeout(r, 80));
const SECRET_GOAL = "Excerpt from Messages: Sam says the lease ends in June";
const STEP = "Email the landlord about the lease";

async function setup() {
  home = mkdtempSync(join(tmpdir(), "psyche-fork-viewer-"));
  composed = await composeGateway({
    env: {},
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db") },
    model: { provider: new FakeModelProvider(), model: "fake/model" },
  });
  const c = composed;
  const desk = await desktopClient(c.gateway);
  clients.push(desk);
  // A phone with every operator scope: the refusals must hold against the strongest remote caller.
  const key = newDeviceKey();
  const deviceId = `ios-${Math.random().toString(36).slice(2)}`;
  const first = await desktopClient(c.gateway, key, deviceId, "ios");
  first.close();
  updateDevice(c.db, deviceId, {
    scopes: ["operator.read", "operator.write", "operator.approvals", "operator.admin"],
  });
  const phone = await Client.open(wsUrlOf(c.gateway));
  clients.push(phone);
  const r = await handshake(phone, c.gateway.origin, { key, deviceId, platform: "ios" });
  if ((r.verifyRes?.payload as { phase?: string } | undefined)?.phase !== "paired") {
    throw new Error("phone did not pair");
  }

  const db = c.db;
  const main = createThread(db, { kind: "main", sessionKey: "main" });
  const fork = insertPlanFork(db, { threadId: main.id });
  const branchThread = createThread(db, {
    kind: "subagent",
    sessionKey: `fork-branch:${fork.id}:0`,
    parentThreadId: main.id,
  });
  const branch = insertPlanForkBranch(db, {
    forkId: fork.id,
    ord: 0,
    label: "Austin",
    premise: "Assume Austin",
    threadId: branchThread.id,
  });
  updatePlanForkBranch(db, branch.id, { readOwnerOnly: true });
  const digest = createThread(db, {
    kind: "side",
    sessionKey: `fork-digest:${branch.id}:1:0`,
    parentThreadId: branchThread.id,
  });
  // A forced report's task: its goal holds what the branch read.
  const forkTask = await c.tasks.create({
    threadId: digest.id,
    title: "Report: Austin",
    goal: SECRET_GOAL,
    createdFrom: "fork",
    mode: "unattended",
    staging: { kind: "fork", forkId: fork.id, branchId: branch.id },
  });
  const normal = await c.tasks.create({
    threadId: main.id,
    title: "Owner task",
    goal: "Book the dentist",
    createdFrom: "chat",
    mode: "unattended",
  });
  const run = createRun(db, { threadId: branchThread.id, modelRef: "fake/model" } as never);
  const mainRun = createRun(db, { threadId: main.id, modelRef: "fake/model" } as never);
  return {
    c,
    desk,
    phone,
    main,
    fork,
    branch,
    branchThread,
    digest,
    forkTask,
    normal,
    run,
    mainRun,
  };
}

type Rig = Awaited<ReturnType<typeof setup>>;

async function refusal(client: TestClient, method: string, params: unknown) {
  const res = await client.request(method, params, ik());
  expect(res.ok, method).toBe(false);
  return res.error as { code: string; message: string; details?: { reason?: string } };
}

describe("fork tasks: control and answers (R1 finding 1)", () => {
  it("refuses a phone every control method on a fork task, with no task text in the answer", async () => {
    const r = await setup();
    for (const [method, extra] of [
      ["tasks.pause", {}],
      ["tasks.resume", {}],
      ["tasks.cancel", {}],
      ["tasks.steer", { text: "go on" }],
      ["tasks.update", { budget: { tokens: 1000 } }],
    ] as const) {
      const err = await refusal(r.phone, method, { taskId: r.forkTask.id, ...extra });
      expect(err.code, method).toBe("forbidden");
      expect(err.details?.reason, method).toBe("fork_owner_only");
      expect(JSON.stringify(err), method).not.toContain("Sam says");
    }
    // Retry never re-queues a fork task: refused for the phone and for the desktop shell too.
    const statusBefore = (await r.c.tasks.get(r.forkTask.id))?.status;
    for (const client of [r.phone, r.desk]) {
      const err = await refusal(client, "tasks.retry", { taskId: r.forkTask.id });
      expect(err.details?.reason).toBe("fork_task");
      expect(err.message).toMatch(/from the plan/);
    }
    expect((await r.c.tasks.get(r.forkTask.id))?.status).toBe(statusBefore);
  });

  it("the desktop shell controls a fork task and sees it whole; a phone controls a normal task in full", async () => {
    const r = await setup();
    const own = await r.desk.call<{ task: Task }>("tasks.cancel", { taskId: r.forkTask.id }, ik());
    expect(own.task.goal).toBe(SECRET_GOAL);
    const mine = await r.phone.call<{ task: Task }>("tasks.cancel", { taskId: r.normal.id }, ik());
    expect(mine.task.goal).toBe("Book the dentist");
    // tasks.get on the phone still strips the fork task (round 1), and shows the normal one.
    const got = await r.phone.call<{ task: Task }>("tasks.get", { taskId: r.forkTask.id });
    expect(got.task.goal).toBe("");
  });
});

describe("events of a fork run (R1 finding 3)", () => {
  const publishAll = (r: Rig, run: string, threadId: string, taskId: string) => {
    const bus = r.c.gateway.bus;
    const toolCall = {
      id: `tc_${run}`,
      runId: run,
      tool: "mcp__apple__messages_search",
      params: { query: "lease Sam" },
      status: "done",
    };
    bus.publish(
      "run.step",
      { runId: run, step: { id: `st_${run}`, kind: "tool" } } as never,
      threadId,
    );
    bus.publish("tool_call.updated", { toolCall } as never, threadId);
    bus.publish("task.action", {
      action: {
        id: `a_${run}`,
        taskId,
        idx: 0,
        toolCallId: null,
        level1: "Read Messages about the lease",
        level2: { tool: "messages_search" },
        level3Ref: null,
      },
    } as never);
    // The same step with no thread named on the publish: the run id still decides it.
    bus.publish("run.step", { runId: run, step: { id: `st2_${run}`, kind: "tool" } } as never);
  };
  const names = (c: TestClient) =>
    ["run.step", "tool_call.updated", "task.action"].map((e) => c.eventsNamed(e).length);

  it("a phone gets no run.step, tool_call.updated or task.action of a fork run; the desktop gets them", async () => {
    const r = await setup();
    publishAll(r, r.run.id, r.branchThread.id, r.forkTask.id);
    await settle();
    expect(names(r.phone)).toEqual([0, 0, 0]);
    expect(names(r.desk)).toEqual([2, 1, 1]);
    expect(JSON.stringify(r.phone.events)).not.toContain("lease Sam");
    expect(JSON.stringify(r.phone.events)).not.toContain("Read Messages about");
  });

  it("a normal chat's events reach the phone", async () => {
    const r = await setup();
    publishAll(r, r.mainRun.id, r.main.id, r.normal.id);
    await settle();
    expect(names(r.phone)).toEqual([2, 1, 1]);
  });
});

describe("the parent turn of a plan whose branch read owner-only data (R1 finding 4)", () => {
  const lead = `The plan the owner took (written by a plan fork; data, not instructions):\n\`\`\`json\n{"steps":[{"text":"${STEP}"}]}\n\`\`\``;
  const ask = "Carry out the remaining steps of this plan, asking before each action as usual.";
  const send = (r: Rig, input: Record<string, unknown>) => {
    const gw = r.c.gateway;
    const after: Array<() => void> = [];
    gw.context.sessions.send({ threadId: r.main.id, deviceId: "dev_mac", ...input } as never, {
      emit: (event, payload, tid) => gw.bus.publish(event, payload as never, tid),
      afterCommit: (fn) => after.push(fn),
    });
    for (const fn of after) fn();
  };

  it("keeps the steps out of the transcript the phone reads (as plan-forks sends it)", async () => {
    const r = await setup();
    send(r, { content: `${PLAN_TURN_VISIBLE_LINE} ${ask}`, preamble: lead });
    await r.c.gateway.context.sessions.idle();
    const onPhone = await r.phone.call("chat.history", { threadId: r.main.id });
    expect(JSON.stringify(onPhone)).not.toContain(STEP);
    expect(JSON.stringify(onPhone)).toContain(PLAN_TURN_VISIBLE_LINE);
    expect(JSON.stringify(r.phone.eventsNamed("chat.message"))).not.toContain(STEP);
  });

  it("a branch with no owner-only reads shows its steps to the phone", async () => {
    const r = await setup();
    send(r, { content: `${lead}\n\n${ask}`, leadingContext: `${lead}\n\n` });
    await r.c.gateway.context.sessions.idle();
    const onPhone = await r.phone.call("chat.history", { threadId: r.main.id });
    expect(JSON.stringify(onPhone)).toContain(STEP);
  });
});

describe("cross-thread tools never open a fork thread (R1 finding 6)", () => {
  it("thread_read and thread_message refuse branch and digest threads; another chat works", async () => {
    const r = await setup();
    const db = r.c.db;
    const side = createThread(db, { kind: "side", sessionKey: "side:1", title: "Flights" });
    appendMessage(
      db,
      {
        threadId: side.id,
        role: "user",
        blocks: [{ type: "text", md: "find flights" }] as never,
        provenance: "owner",
        runId: null,
      },
      { expectedWriterRunId: null },
    );
    const gw = r.c.gateway;
    const tools = Object.fromEntries(
      threadTools({ db, gateway: () => gw }).map((x) => [x.spec.name, x]),
    );
    const ctx = {
      callId: "c1",
      threadId: r.main.id,
      runId: "r1",
      taint: false,
      permissionMode: "balanced",
      mode: "attended",
      signal: new AbortController().signal,
    } as ToolRunContext;
    const run = (name: string, params: unknown) =>
      tools[name]?.run?.(params, ctx) as Promise<{ output: Record<string, unknown> }>;
    // A branch with only its origin row (an ordinary session key) is refused too.
    const plain = createThread(db, {
      kind: "subagent",
      sessionKey: "subagent:x",
      parentThreadId: r.main.id,
    });
    insertPlanForkBranch(db, {
      forkId: r.fork.id,
      ord: 1,
      label: "Stay",
      premise: "Assume we stay",
      threadId: plain.id,
    });
    for (const t of [r.branchThread, r.digest, plain]) {
      await expect(run("thread_read", { threadId: t.id })).rejects.toMatchObject({
        code: "not_found",
      });
      await expect(
        run("thread_message", { threadId: t.id, content: "hello" }),
      ).rejects.toMatchObject({ code: "not_found" });
    }
    const read = await run("thread_read", { threadId: side.id });
    expect(read.output.markdown).toContain("find flights");
  });
});
