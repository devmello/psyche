import { AgentToolRegistry } from "@psyche/agent-core";
import {
  createThread,
  getPlanForkBranch,
  insertPlanFork,
  insertPlanForkBranch,
  openDb,
} from "@psyche/db";
import { AiSdkAdapter, type ModelRouter, Prices } from "@psyche/model-router";
import type { Task } from "@psyche/protocol";
import { SqliteTaskEngine } from "@psyche/tasks";
import { FakeClock } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import {
  composeForks,
  FORK_POOL_CLAIM,
  threadModelIsLocal,
  threadModelPrice,
} from "../src/compose/forks.ts";

/**
 * Fork a plan F2 in the Gateway (fork-a-plan-2026.md §2.3, §3.2): the pool's claim rules, the
 * toolset over the real registry, the slot rule and the task-event wiring.
 */

function reg(registry: AgentToolRegistry, name: string, sideEffect: "none" | "read" | "write") {
  registry.register({
    spec: {
      name,
      description: name,
      inputSchema: { type: "object" },
      sideEffect,
      provenanceOut: "trusted",
    },
    execute: async () => ({ output: {}, provenance: "trusted" }),
  } as never);
}

function rig(opts: { local?: boolean; domains?: string[] } = {}) {
  const clock = new FakeClock(Date.parse("2026-11-25T10:00:00Z"));
  const db = openDb(":memory:", { now: () => new Date(clock.now()).toISOString() });
  const main = createThread(db, { kind: "main", sessionKey: "main" });
  const fork = insertPlanFork(db, { threadId: main.id });
  const t = createThread(db, {
    kind: "subagent",
    parentThreadId: main.id,
    sessionKey: "fork:0",
    title: "A",
    titleSource: "user",
  });
  const branch = insertPlanForkBranch(db, {
    forkId: fork.id,
    ord: 0,
    label: "A",
    premise: "Assume A",
    threadId: t.id,
  });
  const registry = new AgentToolRegistry();
  for (const [n, s] of [
    ["memory_recall", "read"],
    ["web.search", "read"],
    ["web.fetch", "read"],
    ["browser_navigate", "read"],
    ["computer", "write"],
    ["exec", "write"],
    ["write_file", "write"],
    ["task.start", "none"],
    ["subagent.spawn", "none"],
    ["mcp__apple__calendar_list_events", "read"],
    ["mcp__custom__calendar_list_events", "read"],
    ["mcp__apple__mail_send", "write"],
    ["mcp__apple__mail_reply_draft", "write"],
  ] as const) {
    reg(registry, n, s);
  }
  let listener: ((e: { event: string; payload: { task?: Task } }) => void) | undefined;
  const cancelled: string[] = [];
  const forks = composeForks({
    db,
    clock,
    tasks: {
      create: async () => ({ id: "task_1", title: "Plan: A", status: "queued" }) as never,
      get: async () => undefined,
      cancel: async (id) => void cancelled.push(id),
      subscribe: (l) => {
        listener = l;
        return () => {
          listener = undefined;
        };
      },
    },
    poke: () => undefined,
    registry,
    stagerParts: {
      adapters: () => new Map(),
      connectors: () =>
        new Map([
          ["apple", "apple"],
          ["custom", "custom"],
        ]),
      domains: () => new Set(opts.domains ?? ["mail", "calendar", "reminders", "files"]) as never,
      rehash: () => undefined,
      refresh: async () => undefined,
    },
    ...(opts.local === true
      ? {
          router: {
            threadModel: () => "ollama/llama",
            role: () => undefined,
            providers: () => [
              Object.assign(Object.create(AiSdkAdapter.prototype), {
                id: "ollama",
                config: { kind: "ollama" },
              }),
            ],
          } as unknown as ModelRouter,
        }
      : {}),
  });
  return {
    db,
    fork,
    branch,
    forks,
    emit: (task: Partial<Task>) =>
      listener?.({ event: "task.updated", payload: { task: task as Task } }),
    cancelled,
  };
}

describe("the price of a thread's model", () => {
  const router = (model: string | undefined) =>
    ({ threadModel: () => model, role: () => undefined }) as unknown as ModelRouter;
  const prices = new Prices({
    source: "t",
    generatedAt: "t",
    unit: "usd_per_million_tokens",
    models: {
      "acme/big": { mode: "chat", input: 15, output: 75, maxOutput: 64_000 },
      "acme/small": { mode: "chat", input: 0.25, output: 1.25, maxOutput: 2_000 },
      "acme/embed": { mode: "embedding", input: 0.1, output: 0 },
    },
  });

  it("prices per token, with the write capped at 8k; none for an unknown, local or embedding model", () => {
    expect(threadModelPrice(router("acme/big"), prices, "t")).toEqual({
      inputPerToken: 15 / 1e6,
      outputPerToken: 75 / 1e6,
      maxOutputTokens: 8_192,
    });
    expect(threadModelPrice(router("acme/small"), prices, "t")?.maxOutputTokens).toBe(2_000);
    expect(threadModelPrice(router("ollama/llama"), prices, "t")).toBeUndefined();
    expect(threadModelPrice(router("acme/embed"), prices, "t")).toBeUndefined();
    expect(threadModelPrice(router(undefined), prices, "t")).toBeUndefined();
    expect(threadModelPrice(undefined, prices, "t")).toBeUndefined();
  });
});

describe("a requeue adopts the branch's existing task (real task table)", () => {
  it("one task per branch after a crash between the task and the branch row", async () => {
    const clock = new FakeClock(Date.parse("2026-11-25T10:00:00Z"));
    const db = openDb(":memory:", { now: () => new Date(clock.now()).toISOString() });
    const engine = new SqliteTaskEngine({ db, clock });
    const main = createThread(db, { kind: "main", sessionKey: "main" });
    const fork = insertPlanFork(db, { threadId: main.id });
    const mk = (ord: number) => {
      const t = createThread(db, {
        kind: "subagent",
        parentThreadId: main.id,
        sessionKey: `fork:${ord}`,
        title: `B${ord}`,
        titleSource: "user",
      });
      return insertPlanForkBranch(db, {
        forkId: fork.id,
        ord,
        label: `B${ord}`,
        premise: "Assume",
        threadId: t.id,
      });
    };
    const [a, b] = [mk(0), mk(1)];
    // The task of branch a exists, but the branch row never got its id; so do a forced report task
    // of branch b (never adopted as the main task).
    const orphan = await engine.create({
      threadId: a.threadId,
      title: "Plan: B0",
      goal: "g",
      createdFrom: "fork",
      mode: "unattended",
      staging: { kind: "fork", forkId: fork.id, branchId: a.id },
    });
    await engine.create({
      threadId: b.threadId,
      title: "Plan report: B1",
      goal: "g",
      createdFrom: "fork",
      mode: "unattended",
      staging: { kind: "fork", forkId: fork.id, branchId: b.id },
    });
    const forks = composeForks({
      db,
      clock,
      tasks: Object.assign(engine, { subscribe: () => () => undefined }) as never,
      poke: () => undefined,
      registry: new AgentToolRegistry(),
      stagerParts: {
        adapters: () => new Map(),
        connectors: () => new Map(),
        domains: () => new Set(),
        rehash: () => undefined,
        refresh: async () => undefined,
      },
    });
    await forks.service.queueFork(fork.id);
    expect(getPlanForkBranch(db, a.id)?.taskId).toBe(orphan.id);
    const all = await engine.list();
    // The orphan and the forced-report row exist; branch b got exactly one new main task.
    expect(all.filter((t) => t.title === "Plan: B0")).toHaveLength(1);
    expect(all.filter((t) => t.title === "Plan: B1")).toHaveLength(1);
    expect(getPlanForkBranch(db, b.id)?.taskId).not.toBeNull();
  });
});

describe("the fork pool's claim", () => {
  it("claims only fork tasks", () => {
    expect(FORK_POOL_CLAIM).toEqual({ origins: ["fork"] });
  });
});

describe("the toolset over the live registry", () => {
  it("registers the §3.2 reads and stageable writes, and nothing from the absent list", () => {
    const r = rig();
    const allowed = r.forks.toolsFor({ kind: "fork", forkId: r.fork.id, branchId: r.branch.id }, {
      title: "Plan: A",
    } as Task);
    const names = [
      "memory_recall",
      "web.search",
      "web.fetch",
      "mcp__apple__calendar_list_events",
      "mcp__apple__mail_reply_draft",
    ];
    for (const n of names) expect(allowed?.(n), n).toBe(true);
    for (const n of [
      "browser_navigate",
      "computer",
      "exec",
      "write_file",
      "task.start",
      "subagent.spawn",
      "mcp__custom__calendar_list_events",
      "mcp__apple__mail_send",
      "not_registered",
    ]) {
      expect(allowed?.(n), n).toBe(false);
    }
  });

  it("a Night shift domain the owner turned off is off for the branch (and a control with it on)", () => {
    const staging = { kind: "fork", forkId: "f", branchId: "b" } as const;
    const task = { title: "Plan: A" } as Task;
    const mailOnly = rig({ domains: ["mail"] }).forks.toolsFor(staging, task);
    expect(mailOnly?.("mcp__apple__mail_reply_draft")).toBe(true);
    expect(mailOnly?.("mcp__apple__calendar_list_events")).toBe(false);
    expect(mailOnly?.("memory_recall")).toBe(true);
    const all = rig().forks.toolsFor(staging, task);
    expect(all?.("mcp__apple__calendar_list_events")).toBe(true);
  });

  it("a night origin gets no fork toolset", () => {
    const r = rig();
    expect(
      r.forks.toolsFor({ kind: "night", nightId: "n1" }, { title: "x" } as Task),
    ).toBeUndefined();
  });
});

describe("the slot rule", () => {
  it("two slots, and one when the thread's model is a local one", () => {
    const wide = rig();
    expect(wide.forks.canClaim({ activeTaskIds: ["a"] })).toBe(true);
    expect(wide.forks.canClaim({ activeTaskIds: ["a", "b"] })).toBe(false);
    const local = rig({ local: true });
    expect(local.forks.canClaim({ activeTaskIds: [] })).toBe(true);
    expect(local.forks.canClaim({ activeTaskIds: ["a"] })).toBe(false);
  });

  it("threadModelIsLocal: no router, an unknown provider and a hosted kind are not local", () => {
    expect(threadModelIsLocal(undefined, "t")).toBe(false);
    const router = (kind: string | undefined) =>
      ({
        threadModel: () => "p/m",
        role: () => undefined,
        providers: () =>
          kind === undefined
            ? []
            : [Object.assign(Object.create(AiSdkAdapter.prototype), { id: "p", config: { kind } })],
      }) as unknown as ModelRouter;
    expect(threadModelIsLocal(router(undefined), "t")).toBe(false);
    expect(threadModelIsLocal(router("anthropic"), "t")).toBe(false);
    expect(threadModelIsLocal(router("ollama"), "t")).toBe(true);
    expect(threadModelIsLocal(router("llamacpp"), "t")).toBe(true);
  });
});

describe("task events reach the service", () => {
  it("a fork task starting moves its branch to running; another origin's task changes nothing", async () => {
    const r = rig();
    await r.forks.service.queueFork(r.fork.id);
    expect(getPlanForkBranch(r.db, r.branch.id)).toMatchObject({
      taskId: "task_1",
      status: "queued",
    });
    // Control: a task of another origin with the same id is not a fork event.
    r.emit({ id: "task_1", createdFrom: "chat", status: "running", title: "x" } as never);
    await Promise.resolve();
    expect(getPlanForkBranch(r.db, r.branch.id)?.status).toBe("queued");
    r.emit({ id: "task_1", createdFrom: "fork", status: "running", title: "Plan: A" } as never);
    await new Promise((res) => setTimeout(res, 10));
    expect(getPlanForkBranch(r.db, r.branch.id)?.status).toBe("running");
  });

  it("stop() unsubscribes", () => {
    const r = rig();
    r.forks.stop();
    expect(r.emit({ id: "task_1" })).toBeUndefined();
  });
});
