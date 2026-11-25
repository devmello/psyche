import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryCursorStore } from "@psyche/channels";
import { createThread, getSetting, setSetting } from "@psyche/db";
import type { ModelEvent } from "@psyche/protocol";
import { FakeMessagesNode, FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ComposedChannels, composeChannels } from "../src/compose/channels.ts";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import type { ComposeServices } from "../src/compose/services.ts";
import { silentLogger } from "../src/log.ts";
import { adminClient, ik, type TestClient } from "./helpers.ts";

/** Approval routing through the composed Gateway (decision D3): where a run's card goes. */

const ACCOUNT = "psyche@icloud.com";
const OWNER = "+15550001111";
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 };
const say = (text: string): ModelEvent[] => [
  { type: "text_delta", text },
  { type: "usage", usage },
  { type: "finish", reason: "stop" },
];
const BASE = Date.parse("2026-10-19T12:00:00.000Z");
const started = Date.now();
const clock = { now: () => BASE + (Date.now() - started) };

let home = "";
let composed: ComposedGateway | null = null;
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

async function setup() {
  home = mkdtempSync(join(tmpdir(), "psyche-approval-routing-"));
  const node = new FakeMessagesNode();
  let channels: ComposedChannels | undefined;
  let services: ComposeServices | undefined;
  composed = await composeGateway({
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    clock,
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    model: { provider: FakeModelProvider.script([say("Hello.")]), model: "fake/model" },
    parts: [
      (s) => {
        services = s;
        channels = composeChannels(s, {
          imessage: { account: ACCOUNT, node: () => node, cursor: new MemoryCursorStore() },
          healthIntervalMs: 0,
        });
        return channels;
      },
    ],
  });
  const owner = await adminClient(composed.gateway);
  clients.push(owner);
  await owner.call(
    "channels.configure",
    {
      type: "imessage",
      account: ACCOUNT,
      dmPolicy: "allowlist",
      allowFrom: [OWNER],
      ownerIds: [OWNER],
    },
    ik(),
  );
  await vi.waitFor(() =>
    expect(node.invocations.some((i) => i.capability === "messages.watch")).toBe(true),
  );
  // The owner writes from the chat: the channel thread and a run on it exist.
  node.receive({ from: OWNER, text: "hi there" });
  await vi.waitFor(() => expect(node.sends).toHaveLength(1), { timeout: 5000 });
  const svc = services as ComposeServices;
  const chatThread = svc.db.sqlite
    .prepare("SELECT id FROM threads WHERE kind = 'channel'")
    .get() as { id: string };
  const chatRun = svc.db.sqlite
    .prepare("SELECT id FROM runs WHERE thread_id = ?")
    .get(chatThread.id) as { id: string };
  return { channels: channels as ComposedChannels, services: svc, chatThread, chatRun };
}

const CHAT = `imessage:${OWNER}`;
const by = (over: Record<string, unknown>) =>
  ({ runId: null, taskId: null, threadId: null, ...over }) as never;

describe("which chat gets an approval card", () => {
  it("a run, a specialist of that run, a task and a request on a chat thread each ask in that chat", async () => {
    const { channels, composed: _c, ...ctx } = await withTask();
    const relay = channels.relay;
    // The run itself (finished, so no turn is held: its thread names the chat).
    expect(relay?.approvalSurfaces?.(by({ runId: ctx.chatRun.id }))).toEqual([CHAT]);
    // A specialist has a run of its own: its parent's chat is the origin.
    expect(
      relay?.approvalSurfaces?.(by({ runId: "run_specialist", parentRunId: ctx.chatRun.id })),
    ).toEqual([CHAT]);
    // A request that carries only the chat thread.
    expect(relay?.approvalSurfaces?.(by({ threadId: ctx.chatThread.id }))).toEqual([CHAT]);
    // A background task started from the chat, whose approval names only the task.
    expect(relay?.approvalSurfaces?.(by({ taskId: ctx.taskId }))).toEqual([CHAT]);
  });

  it("a task started on the Mac, and a Mac thread, reach no chat while no away chat is set", async () => {
    const { channels, services, macTaskId } = await withTask();
    const macThread = createThread(services.db, { kind: "side", sessionKey: "side:mac" });
    const relay = channels.relay;
    expect(relay?.approvalSurfaces?.(by({ threadId: macThread.id }))).toEqual([]);
    expect(relay?.approvalSurfaces?.(by({ taskId: macTaskId }))).toEqual([]);
    expect(relay?.approvalSurfaces?.(by({ runId: "run_unknown" }))).toEqual([]);
  });

  it("with an away chat picked, a Mac run is given that chat's surface (held until the owner is away)", async () => {
    const { channels, services } = await withTask();
    const channel = services.db.sqlite
      .prepare("SELECT id FROM channels WHERE type = 'imessage'")
      .get() as { id: string };
    setSetting(services.db, "notifications.approvals.awayChannel", channel.id);
    expect(getSetting(services.db, "notifications.approvals.awayChannel")?.value).toBe(channel.id);
    const macThread = createThread(services.db, { kind: "side", sessionKey: "side:mac" });
    expect(channels.relay?.approvalSurfaces?.(by({ threadId: macThread.id }))).toEqual([CHAT]);
  });
});

async function withTask() {
  const base = await setup();
  const engine = (composed as ComposedGateway).tasks;
  const chatTask = await engine.create({
    threadId: base.chatThread.id,
    title: "from chat",
    goal: "g",
    createdFrom: "channel",
    mode: "unattended",
  });
  const macThread = createThread(base.services.db, { kind: "side", sessionKey: "side:mac-task" });
  const macTask = await engine.create({
    threadId: macThread.id,
    title: "from the Mac",
    goal: "g",
    createdFrom: "chat",
    mode: "unattended",
  });
  return { ...base, composed, taskId: chatTask.id, macTaskId: macTask.id };
}
