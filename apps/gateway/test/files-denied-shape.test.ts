import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentLoop } from "@psyche/agent-core";
import { createRun, createThread, openDb, upsertToolCall } from "@psyche/db";
import { fileTools } from "@psyche/files";
import { createPermissionBroker } from "@psyche/permissions";
import type { AgentEvent, ModelEvent } from "@psyche/protocol";
import {
  createIdGenerator,
  FakeClock,
  FakeMemoryStore,
  FakeModelProvider,
  FakeNotifier,
  FakeScheduler,
  FakeSkillLoader,
  FakeTaskEngine,
} from "@psyche/testing";
import { expect, it } from "vitest";

/**
 * What the chat's "Share this folder" button reads. A real loop, broker and file tools deny a
 * `read_file` outside every granted folder; the events are stored the way the session controller
 * stores them (`upsertToolCall` with the event's details). The UI matches on these ToolCall
 * fields, so this pins the production shape: blocked, `folder:not_granted`, the path as target.
 */

it("a denied read_file is stored as blocked + folder:not_granted + the path target", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "psy-denied-")));
  const home = join(root, "home");
  const outside = join(home, "Downloads", "invoice.pdf");
  mkdirSync(join(home, "Downloads"), { recursive: true });
  writeFileSync(outside, "x");

  const clock = new FakeClock();
  const ids = createIdGenerator();
  const broker = createPermissionBroker({
    clock,
    armDelayMs: 0,
    approvers: {
      device: async () => ({ scopes: ["operator.read", "operator.approvals"] }),
      isOwnerSender: async () => false,
    },
  });
  const provider = new FakeModelProvider();
  const loop = createAgentLoop({
    provider,
    model: "fake/main",
    utilityModel: "fake/utility",
    broker,
    memory: new FakeMemoryStore({ clock, ids }),
    tasks: new FakeTaskEngine({ clock, ids }),
    notifier: new FakeNotifier({ clock, ids }),
    scheduler: new FakeScheduler({ clock, ids }),
    skills: new FakeSkillLoader({ ids }),
    clock,
    ids,
    evaluator: { enabled: false },
  });
  for (const t of fileTools({
    folders: (scope) => [
      ...(broker.policy.folders ?? []),
      ...(scope ? broker.sessionFolders(scope.threadId) : []),
    ],
  })) {
    if (t.spec.name === "read_file") loop.registry.register(t);
  }
  const script: ModelEvent[][] = [
    [
      { type: "tool_call", id: "c1", name: "read_file", input: { path: outside } },
      { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } as never },
      { type: "finish", reason: "tool_calls" },
    ],
    [
      { type: "text_delta", text: "I can't read that." },
      { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } as never },
      { type: "finish", reason: "stop" },
    ],
  ];
  provider.script(script);

  const db = openDb(":memory:");
  const thread = createThread(db, { kind: "main", sessionKey: "owner:main" });
  const run = createRun(db, { threadId: thread.id, modelRef: "fake/main" });
  const events: AgentEvent[] = [];
  for await (const e of loop.startTurn({
    threadId: thread.id,
    runId: run.id,
    input: { text: "read my invoice" },
    mode: "attended",
    permissionMode: "balanced",
  })) {
    events.push(e);
  }

  let stored: ReturnType<typeof upsertToolCall> | undefined;
  for (const e of events) {
    if (e.type !== "tool_call" || e.tool !== "read_file") continue;
    stored = upsertToolCall(db, {
      id: e.toolCallId,
      runId: run.id,
      tool: e.tool,
      status: e.status,
      ...(e.details ?? {}),
    });
  }
  expect(stored).toMatchObject({
    tool: "read_file",
    status: "blocked",
    decisionRule: "folder:not_granted",
    target: { kind: "path", value: outside },
  });
});
