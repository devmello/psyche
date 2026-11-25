import { AgentToolRegistry, paramsHash } from "@psyche/agent-core";
import { listNights, listStagedActions, openDb, setSetting } from "@psyche/db";
import type { StagedAction, Staging } from "@psyche/protocol";
import { toolCallBindingHash } from "@psyche/protocol/binding";
import { FakeClock } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import { DEVICE, makeBroker } from "../../../packages/permissions/test/helpers.ts";
import { composeNightShift } from "../src/compose/night-shift.ts";
import { connectorToolLookup } from "../src/compose/proactive.ts";
import type { Call } from "../src/context.ts";

/**
 * Night shift end to end in the Gateway (W5): a manual night stages reminders through the real
 * stager and the real reminders adapter, the owner applies some of them with one staged_apply
 * approval through `nightShift.apply`, the review settles `partial`, and one is undone through
 * `nightShift.undo`, which deletes exactly what the apply created.
 */

const START = Date.parse("2026-11-25T01:00:00Z");
const GOOD = {
  onAc: true,
  batteryPct: 100,
  lowPowerMode: false,
  thermal: "nominal" as const,
  idleMinutes: 60,
};

function rig() {
  const clock = new FakeClock(START);
  const db = openDb(":memory:", { now: () => new Date(clock.now()).toISOString() });
  setSetting(db, "nightShift.enabled", true);
  const h = makeBroker({}, clock);
  const registry = new AgentToolRegistry();
  const reminders: {
    id: string;
    listId: string;
    title: string;
    completed: boolean;
    modifiedAt: string;
  }[] = [];
  const ran: { tool: string; callId: string; params: Record<string, unknown> }[] = [];
  let made = 0;
  const reg = (name: string, sideEffect: string, run: (p: Record<string, unknown>) => unknown) =>
    registry.register({
      spec: {
        name: `mcp__apple__${name}`,
        description: name,
        inputSchema: { type: "object" },
        sideEffect,
        provenanceOut: "trusted",
      },
      execute: async (callId: string, params: Record<string, unknown>) => {
        if (sideEffect !== "read") ran.push({ tool: name, callId, params });
        return { output: run(params), provenance: "trusted" };
      },
    } as never);
  reg("reminders_list", "read", () => reminders.map((r) => ({ ...r })));
  reg("reminders_create", "write", (p) => {
    const r = {
      id: `rem_${++made}`,
      listId: String(p.listId ?? "L"),
      title: String(p.title),
      completed: false,
      modifiedAt: new Date(clock.now()).toISOString(),
    };
    reminders.push(r);
    return { id: r.id };
  });
  reg("reminders_delete", "destructive", (p) => {
    const i = reminders.findIndex((r) => r.id === p.id);
    if (i >= 0) reminders.splice(i, 1);
    return { deleted: i >= 0 };
  });

  let ns: ReturnType<typeof composeNightShift> | undefined;
  let task = 0;
  const staged = new Map<string, Staging>();
  ns = composeNightShift({
    db,
    clock,
    scheduler: {
      list: async () => [],
      get: async () => undefined,
      create: async () => ({}) as never,
      update: async () => ({}) as never,
      remove: async () => {},
    },
    notifier: { notify: async () => ({}) as never },
    tasks: {
      create: async (i: { staging: Staging; goal: string }) => {
        const id = `task_${++task}`;
        staged.set(id, i.staging);
        return { id } as never;
      },
      // The job "runs" when the service looks it up: it stages one reminder, as the loop would.
      get: async (id: string) => {
        const staging = staged.get(id);
        if (staging !== undefined && ns !== undefined) {
          staged.delete(id);
          const tool = "mcp__apple__reminders_create";
          const params = { title: `Follow up ${id}`, listId: "L" };
          await ns.sinkFor(staging)?.stage({
            staging,
            runId: `run_${id}`,
            taskId: id,
            toolCallId: `call_${id}`,
            tool,
            connector: { id: "apple", action: "reminders.write" },
            sideEffect: "write",
            params,
            paramsHash: paramsHash(params),
            bindingHash: toolCallBindingHash(tool, params, undefined),
            summary: `Remind: Follow up ${id}`,
            decisionRule: "ask",
            taint: false,
            taintSources: [],
          } as never);
        }
        return { id, status: "done" } as never;
      },
      cancel: async () => undefined,
      subscribe: () => () => {},
    },
    poke: () => {},
    registry,
    lookup: () => connectorToolLookup(registry),
    keepAwake: { acquire: () => () => undefined },
    readState: async () => GOOD,
    timeZone: () => "UTC",
    connectors: async () => [{ id: "apple", type: "apple" }],
    folders: () => [],
    mailCandidates: async () => [],
    followups: { list: () => [] } as never,
    promiseCandidates: () =>
      ["a", "b", "c"].map((k) => ({
        id: `f_${k}`,
        text: `Send the deck to ${k}`,
        source: "chat",
        dueAt: new Date(START + 6 * 3_600_000).toISOString(),
      })) as never,
    broker: h.broker as never,
    surfaceOf: () => "desktop",
    pollMs: 1,
  });
  const call = {
    identity: { deviceId: "dev_mac", scopes: ["operator.approvals"] },
  } as unknown as Call;
  const run = (method: string, params: unknown) => {
    const def = ns?.defs[method];
    if (def === undefined) throw new Error(`no handler ${method}`);
    return (def.run as (c: Call, p: unknown) => Promise<unknown>)(call, params);
  };
  return { ns, db, h, clock, reminders, ran, run };
}

async function settle(r: ReturnType<typeof rig>) {
  for (let i = 0; i < 5; i++) {
    await new Promise((res) => setTimeout(res, 0));
    await r.ns.applier?.idle();
  }
}

async function approve(
  r: ReturnType<typeof rig>,
  out: { approval?: { id: string }; answerToken?: string },
) {
  r.clock.advance(500);
  await r.h.broker.answer({
    approvalId: out.approval?.id ?? "",
    answerToken: out.answerToken ?? "",
    decision: "approve",
    scope: "once",
    decidedBy: DEVICE,
  });
  await settle(r);
}

describe("Night shift apply, undo and dismiss through the Gateway (W5)", () => {
  it("stages a night, applies two of three with one approval, settles partial, and undoes one", async () => {
    const r = rig();
    await r.ns.start();
    await r.ns.service.run({ manual: true });
    const [night] = listNights(r.db).filter((n) => n.reviewStatus === "ready");
    if (night === undefined) throw new Error("no review");
    const items = listStagedActions(r.db, night.id).filter((i) => i.status === "ready");
    expect(items).toHaveLength(3);
    // Nothing ran overnight.
    expect(r.ran).toEqual([]);

    const [a, b, c] = items as [StagedAction, StagedAction, StagedAction];
    const out = (await r.run("nightShift.apply", {
      reviewId: night.id,
      items: [a, b].map((i) => ({ itemId: i.id, bindingHash: i.bindingHash })),
      sends: [],
    })) as {
      approval?: { id: string; kind: string; details: { items: unknown[] } };
      answerToken?: string;
      refused: unknown[];
    };
    expect(out.refused).toEqual([]);
    expect(out.approval?.kind).toBe("staged_apply");
    // The approval lists exactly the ticked items' hashes (what W6/W7 compare before answering).
    expect(
      ((out.approval?.details.items ?? []) as { itemId: string; bindingHash: string }[]).map(
        (x) => [x.itemId, x.bindingHash],
      ),
    ).toEqual([a, b].map((i) => [i.id, i.bindingHash]));
    await approve(r, out);

    expect(r.ran.map((x) => [x.tool, x.callId])).toEqual([
      ["reminders_create", a.id],
      ["reminders_create", b.id],
    ]);
    const now = (id: string) => listStagedActions(r.db, night.id).find((i) => i.id === id);
    expect(now(a.id)?.status).toBe("applied");
    expect(now(b.id)?.status).toBe("applied");
    expect(now(c.id)?.status).toBe("ready");
    expect(listNights(r.db).find((n) => n.id === night.id)?.reviewStatus).toBe("partial");

    // Undo one: the same path, a staged_apply card, deleting exactly the created id.
    await settle(r);
    const undo = (await r.run("nightShift.undo", { itemIds: [a.id] })) as {
      approval?: { id: string; kind: string };
      answerToken?: string;
      refused: unknown[];
    };
    expect(undo.refused).toEqual([]);
    expect(undo.approval?.kind).toBe("staged_apply");
    await approve(r, undo);
    expect(r.ran.at(-1)).toMatchObject({
      tool: "reminders_delete",
      callId: a.id,
      params: { id: now(a.id)?.result?.refs?.[0] },
    });
    expect(now(a.id)?.status).toBe("undone");
    expect(r.reminders.map((x) => x.title)).toEqual([`Follow up ${b.taskId}`]);

    // Dismiss the rest: the review closes.
    expect(await r.run("nightShift.dismiss", { reviewId: night.id })).toEqual({ dismissed: 1 });
    expect(now(c.id)?.status).toBe("dismissed");
  });

  it("a replayed apply of the same items is refused once they are bound (control: the first issues)", async () => {
    const r = rig();
    await r.ns.start();
    await r.ns.service.run({ manual: true });
    const [night] = listNights(r.db).filter((n) => n.reviewStatus === "ready");
    if (night === undefined) throw new Error("no review");
    const [a] = listStagedActions(r.db, night.id);
    const params = {
      reviewId: night.id,
      items: [{ itemId: a?.id, bindingHash: a?.bindingHash }],
      sends: [],
    };
    const first = (await r.run("nightShift.apply", params)) as { approval?: unknown };
    expect(first.approval).toBeDefined();
    const second = (await r.run("nightShift.apply", params)) as {
      approval?: unknown;
      refused: { reason: string }[];
    };
    expect(second.approval).toBeUndefined();
    expect(second.refused[0]?.reason).toBe("the item is already being applied");
  });
});
