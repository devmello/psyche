import type { AgentToolRegistration, ToolRunContext } from "@psyche/agent-core";
import { listAllMessages } from "@psyche/db";
import { isAdminSettingKey, type Thread } from "@psyche/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CROSS_THREAD_SETTING,
  crossThreadToggle,
  threadTools,
} from "../src/compose/thread-tools.ts";
import { GatedAgentLoop } from "./agent.ts";
import {
  desktopClient,
  ik,
  startTestGateway,
  type TestClient,
  type TestGateway,
} from "./helpers.ts";

let t: TestGateway;
let agent: GatedAgentLoop;
let desk: TestClient;
let tools: Record<string, AgentToolRegistration>;

afterEach(async () => {
  desk?.close();
  await t?.cleanup();
});

async function setup() {
  agent = new GatedAgentLoop();
  t = await startTestGateway({ agent });
  desk = await desktopClient(t.gateway);
  const gw = t.gateway;
  tools = Object.fromEntries(
    threadTools({ db: gw.context.db, gateway: () => gw }).map((x) => [x.spec.name, x]),
  );
}

const create = async (params: Record<string, unknown>) =>
  (await desk.call<{ thread: Thread }>("threads.create", params, ik())).thread;

function ctx(threadId: string, taint = false): ToolRunContext {
  return {
    callId: "c1",
    threadId,
    runId: "r1",
    taint,
    permissionMode: "balanced",
    mode: "attended",
    signal: new AbortController().signal,
  } as ToolRunContext;
}

const run = (name: string, params: unknown, c: ToolRunContext) =>
  tools[name]?.run?.(params, c) as Promise<{ output: Record<string, unknown>; provenance: string }>;

describe("cross-thread awareness (E12)", () => {
  it("is opt-in through an admin-only setting", () => {
    expect(isAdminSettingKey(CROSS_THREAD_SETTING)).toBe(true);
    const register = vi.fn(() => () => {});
    const toggle = crossThreadToggle(register, [{ spec: { name: "a" } } as AgentToolRegistration]);
    toggle.sync(undefined);
    expect(register).not.toHaveBeenCalled();
    toggle.sync(true);
    toggle.sync(true);
    expect(register).toHaveBeenCalledTimes(1);
    toggle.sync(false);
    expect(toggle.enabled()).toBe(false);
  });

  it("lists and reads other threads as untrusted data, never incognito ones or the caller", async () => {
    await setup();
    const main = await create({ kind: "main" });
    const side = await create({ kind: "side", title: "Flight search" });
    const secret = await create({ kind: "incognito", title: "Private" });
    await desk.call("chat.send", { threadId: side.id, content: "find flights" }, ik());
    await t.gateway.context.sessions.idle();

    const listed = await run("threads_list", {}, ctx(main.id));
    expect(listed.provenance).toBe("untrusted");
    const ids = (listed.output.threads as { threadId: string }[]).map((x) => x.threadId);
    expect(ids).toContain(side.id);
    expect(ids).not.toContain(secret.id);
    expect(ids).not.toContain(main.id);

    const read = await run("thread_read", { threadId: side.id }, ctx(main.id));
    expect(read.provenance).toBe("untrusted");
    expect(read.output.markdown).toContain("find flights");
    await expect(run("thread_read", { threadId: secret.id }, ctx(main.id))).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(run("thread_read", { threadId: main.id }, ctx(main.id))).rejects.toMatchObject({
      code: "invalid_params",
    });
  });

  it("messages another thread as the agent: queued behind its turn, provenance agent", async () => {
    await setup();
    const main = await create({ kind: "main" });
    const side = await create({ kind: "side", title: "Booking" });
    agent.script([
      { type: "wait", gate: "g" },
      { type: "chat.delta", messageId: "a1", delta: "working" },
    ]);
    await desk.call("chat.send", { threadId: side.id, content: "start booking" }, ik());
    await agent.started(1);

    const sent = await run(
      "thread_message",
      { threadId: side.id, content: "Resume with the 7:05 flight" },
      ctx(main.id),
    );
    expect(sent.output).toMatchObject({ queued: true, runId: null });
    agent.open("g");
    await t.gateway.context.sessions.idle();

    const messages = listAllMessages(t.gateway.context.db, side.id);
    const fromAgent = messages.find((m) => m.provenance === "agent" && m.role === "user");
    expect(fromAgent?.blocks[0]).toMatchObject({ type: "text" });
    expect((fromAgent?.blocks[0] as { md?: string } | undefined)?.md).toMatch(
      /^From another thread:|^From the ".*" thread:/,
    );
    expect(agent.turns.map((x) => x.input.text).at(-1)).toContain("Resume with the 7:05 flight");
  });

  it("refuses to message from a tainted turn, into incognito or archived threads", async () => {
    await setup();
    const main = await create({ kind: "main" });
    const side = await create({ kind: "side" });
    const secret = await create({ kind: "incognito" });
    await expect(
      run("thread_message", { threadId: side.id, content: "x" }, ctx(main.id, true)),
    ).rejects.toMatchObject({
      code: "taint_blocked",
    });
    await expect(
      run("thread_message", { threadId: secret.id, content: "x" }, ctx(main.id)),
    ).rejects.toMatchObject({
      code: "not_found",
    });
    await desk.call("threads.archive", { threadId: side.id });
    await expect(
      run("thread_message", { threadId: side.id, content: "x" }, ctx(main.id)),
    ).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("archives another thread through an always-ask tool and tells clients", async () => {
    await setup();
    const main = await create({ kind: "main" });
    const side = await create({ kind: "side" });
    const archive = tools.thread_archive as AgentToolRegistration;
    expect(archive.spec.sideEffect).toBe("destructive");
    expect(archive.describeCall?.({ threadId: side.id })).toMatchObject({ kind: "archive_thread" });
    const res = await run("thread_archive", { threadId: side.id }, ctx(main.id));
    expect(res.output.archivedAt).toBeTruthy();
    await desk.waitForEvent(
      (e) =>
        e.event === "thread.updated" &&
        (e.payload as { thread: Thread }).thread.archivedAt !== null,
    );
  });
});
