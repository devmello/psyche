import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentLoop } from "@psyche/agent-core";
import { fileTools } from "@psyche/files";
import { createPermissionBroker, type PsychePermissionBroker } from "@psyche/permissions";
import type {
  AgentEvent,
  ApprovalRequestInput,
  IssuedApproval,
  ModelEvent,
} from "@psyche/protocol";
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
import { beforeEach, describe, expect, it } from "vitest";
import { requestFolderAccessTool } from "../src/compose/folder-access.ts";

/**
 * The owner's complaint: "right now it sends the permission and then quits". A real agent loop
 * and broker, a scripted model: the request waits for the card, and the same turn goes on to read
 * the folder (even when the model put `list_dir` in the same response), or ends with a short
 * message after a denial.
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), "psy-fat-")));
const home = join(root, "home");
const downloads = join(home, "Downloads");
mkdirSync(downloads, { recursive: true });
writeFileSync(join(downloads, "invoice.pdf"), "x");

const call = (id: string, name: string, input: unknown): ModelEvent[] => [
  { type: "tool_call", id, name, input },
  { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } as never },
  { type: "finish", reason: "tool_calls" },
];
const say = (text: string): ModelEvent[] => [
  { type: "text_delta", text },
  { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } as never },
  { type: "finish", reason: "stop" },
];
const two = (a: ModelEvent[], b: ModelEvent[]): ModelEvent[] => [
  ...a.filter((e) => e.type === "tool_call"),
  ...b.filter((e) => e.type === "tool_call"),
  { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } as never },
  { type: "finish", reason: "tool_calls" },
];

async function until(pred: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setImmediate(r));
  }
}

let broker: PsychePermissionBroker;
let issued: IssuedApproval[];
let provider: FakeModelProvider;
let loop: ReturnType<typeof createAgentLoop>;
let listed: string[];

beforeEach(() => {
  const clock = new FakeClock();
  const ids = createIdGenerator();
  issued = [];
  listed = [];
  broker = createPermissionBroker({
    clock,
    armDelayMs: 0,
    approvers: {
      device: async () => ({ scopes: ["operator.read", "operator.approvals"] }),
      isOwnerSender: async () => false,
    },
    folderAccess: {
      env: () => ({ home, psycheHome: join(home, ".psyche") }),
      persist: async () => {},
    },
  });
  const requestApproval = broker.requestApproval.bind(broker);
  broker.requestApproval = async (input: ApprovalRequestInput) => {
    const out = await requestApproval(input);
    issued.push(out);
    return out;
  };
  provider = new FakeModelProvider();
  loop = createAgentLoop({
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
  loop.registry.register(
    requestFolderAccessTool({
      broker,
      surfaces: ["desktop"],
      folderEnv: () => ({ home, psycheHome: join(home, ".psyche") }),
    }),
  );
  for (const t of fileTools({
    folders: (scope) => [
      ...(broker.policy.folders ?? []),
      ...(scope ? broker.sessionFolders(scope.threadId) : []),
    ],
  })) {
    if (t.spec.name !== "list_dir") continue;
    loop.registry.register({
      ...t,
      run: async (p, ctx) => {
        listed.push((p as { path: string }).path);
        if (t.run === undefined) throw new Error("no run");
        return t.run(p, ctx);
      },
    });
  }
});

async function turn(script: ModelEvent[][], answer: "approve" | "deny") {
  provider.script(script);
  const events: AgentEvent[] = [];
  const done = (async () => {
    for await (const e of loop.startTurn({
      threadId: "thr_1",
      runId: "run_1",
      input: { text: "check what's in my Downloads folder" },
      mode: "attended",
      permissionMode: "balanced",
    })) {
      events.push(e);
    }
  })();
  await until(() => issued.length === 1, "the folder card");
  // The turn is parked on the card, not finished.
  expect(events.some((e) => e.type === "end")).toBe(false);
  const card = issued[0];
  await broker.answer({
    approvalId: card?.approval.id ?? "",
    answerToken: card?.answerTokens.desktop ?? "",
    decision: answer,
    ...(answer === "approve" ? { scope: "once" as const, folderPath: downloads } : {}),
    decidedBy: { deviceId: "dev_owner", surface: "desktop" },
  });
  await done;
  return events;
}

const ask = call("c1", "request_folder_access", {
  path: downloads,
  reason: "You asked me to check your Downloads folder.",
  access: "read",
});

describe("request_folder_access inside a turn", () => {
  it("grant: the same turn goes on and lists the granted folder", async () => {
    const events = await turn(
      [ask, call("c2", "list_dir", { path: downloads }), say("Downloads has invoice.pdf.")],
      "approve",
    );
    expect(listed).toEqual([downloads]);
    expect(events.find((e) => e.type === "end")).toMatchObject({ outcome: "final" });
    expect(JSON.stringify(events)).toContain("invoice.pdf");
  });

  it("grant: a list_dir the model put in the same response waits for the answer", async () => {
    const events = await turn(
      [two(ask, call("c2", "list_dir", { path: downloads })), say("Downloads has invoice.pdf.")],
      "approve",
    );
    expect(listed).toEqual([downloads]);
    // It succeeded: the folder was granted before it ran.
    expect(JSON.stringify(events)).toContain("invoice.pdf");
    expect(events.find((e) => e.type === "end")).toMatchObject({ outcome: "final" });
  });

  it("deny: the turn ends with a short message and nothing is listed", async () => {
    const events = await turn([ask, say("Okay, I won't look at Downloads.")], "deny");
    expect(listed).toEqual([]);
    expect(broker.sessionFolders("thr_1")).toEqual([]);
    expect(events.find((e) => e.type === "end")).toMatchObject({ outcome: "final" });
    expect(JSON.stringify(events)).toContain("I won't look at Downloads");
  });
});
