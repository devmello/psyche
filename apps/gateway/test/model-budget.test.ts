import { afterEach, describe, expect, it } from "vitest";
import type { HandlerDef } from "../src/context.ts";
import { HANDLERS } from "../src/handlers/index.ts";
import {
  desktopClient,
  ik,
  newDeviceKey,
  remoteClient,
  startTestGateway,
  type TestClient,
  type TestGateway,
} from "./helpers.ts";

let t: TestGateway;
const clients: TestClient[] = [];
let clock = Date.parse("2026-10-20T12:00:00.000Z");

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await t?.cleanup();
});

const BUDGET = { burstCalls: 3, burstWindowMs: 60_000, hourlyCalls: 5, hourlyWindowMs: 3_600_000 };

/** The methods the table below calls, answered by a stub so the budget is all that is tested. */
const STUBBED = [
  "goals.suggest",
  "widgets.act",
  "spaces.trackers.refresh",
  "meetings.record.stop",
  "tasks.resume",
  "tasks.update",
  "search.query",
  "voice.memo.save",
  "memory.persona.edit",
];
const stubs = (): Record<string, HandlerDef> =>
  Object.fromEntries(
    STUBBED.filter((m) => !Object.hasOwn(HANDLERS, m)).map((m) => [m, { run: () => ({}) }]),
  );

async function setup(modelBudget = BUDGET) {
  clock = Date.parse("2026-10-20T12:00:00.000Z");
  t = await startTestGateway({
    now: () => new Date(clock),
    limits: { modelBudget },
    handlers: stubs(),
  });
}

/** A model-calling method; the answer may be anything but `rate_limited` while under budget. */
const suggest = (c: TestClient) => c.request("goals.suggest", { goalId: "g1" }, ik());

const limited = (r: Awaited<ReturnType<typeof suggest>>) =>
  !r.ok && (r.error as { code?: string }).code === "rate_limited";

describe("per-device model budget", () => {
  it("limits a paired device after the burst and says when to retry", async () => {
    await setup();
    const phone = await remoteClient(t.gateway);
    clients.push(phone);
    for (let i = 0; i < 3; i++) expect(limited(await suggest(phone))).toBe(false);
    const res = await suggest(phone);
    expect(res).toMatchObject({
      ok: false,
      error: {
        code: "rate_limited",
        retryable: true,
        details: { scope: "model_calls", reason: "model_budget", retryAfterMs: 60_000 },
      },
    });
    expect(!res.ok && (res.error as { message?: string }).message).toBe(
      "Too many requests from this device. Try again in 1 minute.",
    );
  });

  it("refills as the window slides and does not count refused calls", async () => {
    await setup();
    const phone = await remoteClient(t.gateway);
    clients.push(phone);
    for (let i = 0; i < 3; i++) await suggest(phone);
    expect(limited(await suggest(phone))).toBe(true);
    expect(limited(await suggest(phone))).toBe(true);
    clock += 61_000;
    expect(limited(await suggest(phone))).toBe(false);
  });

  it("holds a loop to the hourly cap and then recovers, never longer than the window", async () => {
    await setup();
    const phone = await remoteClient(t.gateway);
    clients.push(phone);
    let admitted = 0;
    // One call every 61 seconds never trips the burst, so only the hourly cap can stop it.
    for (let i = 0; i < 8; i++) {
      if (!limited(await suggest(phone))) admitted++;
      clock += 61_000;
    }
    expect(admitted).toBe(5);
    const res = await suggest(phone);
    expect(res.ok).toBe(false);
    const ms = (res as { error: { details: { retryAfterMs: number } } }).error.details.retryAfterMs;
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(3_600_000);
    clock += ms + 1000;
    expect(limited(await suggest(phone))).toBe(false);
  });

  it("gives each device its own budget", async () => {
    await setup();
    const a = await remoteClient(t.gateway);
    const b = await remoteClient(t.gateway);
    clients.push(a, b);
    for (let i = 0; i < 3; i++) await suggest(a);
    expect(limited(await suggest(a))).toBe(true);
    expect(limited(await suggest(b))).toBe(false);
  });

  it("shares one budget across a device's connections", async () => {
    await setup();
    const key = newDeviceKey();
    const a = await remoteClient(t.gateway, key, "phone");
    const b = await remoteClient(t.gateway, key, "phone");
    clients.push(a, b);
    for (let i = 0; i < 2; i++) await suggest(a);
    await suggest(b);
    expect(limited(await suggest(a))).toBe(true);
  });

  it("never limits the local desktop app", async () => {
    await setup();
    const desk = await desktopClient(t.gateway);
    clients.push(desk);
    for (let i = 0; i < 12; i++) expect(limited(await suggest(desk))).toBe(false);
  });

  it("does not count methods that do not call a model", async () => {
    await setup();
    const phone = await remoteClient(t.gateway);
    clients.push(phone);
    for (let i = 0; i < 20; i++) {
      const r = await phone.request("threads.list", {});
      expect(r.ok).toBe(true);
    }
    // The budget is untouched.
    for (let i = 0; i < 3; i++) expect(limited(await suggest(phone))).toBe(false);
  });

  it("uses the shipped numbers by default", async () => {
    t = await startTestGateway({ now: () => new Date(clock), handlers: stubs() });
    const phone = await remoteClient(t.gateway);
    clients.push(phone);
    for (let i = 0; i < 20; i++) expect(limited(await suggest(phone))).toBe(false);
    expect(limited(await suggest(phone))).toBe(true);
  });
});

/** Methods a device can call that start model work: always, or only for some params. */
const CASES: {
  method: string;
  /** Starts model work: counts. */
  counted: Record<string, unknown>;
  /** Same method without model work: free. Absent for a method that always counts. */
  free?: Record<string, unknown>;
}[] = [
  { method: "widgets.act", counted: { widgetId: "w1", nodeId: "n1" } },
  { method: "spaces.trackers.refresh", counted: { spaceId: "s1", widgetId: "w1" } },
  { method: "meetings.record.stop", counted: {} },
  { method: "tasks.resume", counted: { taskId: "t1" } },
  {
    method: "tasks.update",
    counted: { taskId: "t1", budget: { tokens: 5000 } },
    free: { taskId: "t1" },
  },
  {
    method: "tasks.update",
    counted: { taskId: "t1", deadline: "2030-01-01T00:00:00.000Z" },
  },
  {
    method: "search.query",
    counted: { query: "what did Sam say", smart: true },
    free: { query: "what did Sam say", smart: false },
  },
  {
    method: "voice.memo.save",
    counted: { sessionId: "v1", task: "always" },
    free: { sessionId: "v1", task: "never" },
  },
  {
    method: "memory.persona.edit",
    counted: { instruction: "be shorter" },
    free: { fields: {} },
  },
];

describe("methods that start model work are budgeted", () => {
  for (const c of CASES) {
    const call = (client: TestClient, params: Record<string, unknown>) =>
      client.request(c.method as never, params as never, ik());

    it(`${c.method}: counted when it starts model work`, async () => {
      await setup();
      const phone = await remoteClient(t.gateway);
      clients.push(phone);
      for (let i = 0; i < 3; i++) expect(limited(await call(phone, c.counted))).toBe(false);
      expect(limited(await call(phone, c.counted))).toBe(true);
      // The desktop shell is never held to it.
      const desk = await desktopClient(t.gateway);
      clients.push(desk);
      for (let i = 0; i < 6; i++) expect(limited(await call(desk, c.counted))).toBe(false);
    });

    if (c.free !== undefined) {
      const free = c.free;
      it(`${c.method}: free when it starts none`, async () => {
        await setup();
        const phone = await remoteClient(t.gateway);
        clients.push(phone);
        for (let i = 0; i < 12; i++) expect(limited(await call(phone, free))).toBe(false);
        // Nothing was spent: the counted form still has its whole burst.
        for (let i = 0; i < 3; i++) expect(limited(await call(phone, c.counted))).toBe(false);
      });
    }
  }

  it("does not charge a call refused for its params or an unknown method", async () => {
    await setup();
    const phone = await remoteClient(t.gateway);
    clients.push(phone);
    for (let i = 0; i < 10; i++) {
      const bad = await phone.request("goals.suggest", {} as never, ik());
      expect(limited(bad)).toBe(false);
    }
    for (let i = 0; i < 3; i++) expect(limited(await suggest(phone))).toBe(false);
  });

  it("does not charge an idempotent replay", async () => {
    await setup();
    const phone = await remoteClient(t.gateway);
    clients.push(phone);
    const key = ik();
    for (let i = 0; i < 8; i++) {
      const r = await phone.request("goals.suggest", { goalId: "g1" }, key);
      expect(limited(r)).toBe(false);
    }
  });
});
