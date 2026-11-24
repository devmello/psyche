import { afterEach, describe, expect, it } from "vitest";
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

async function setup(modelBudget = BUDGET) {
  clock = Date.parse("2026-10-20T12:00:00.000Z");
  t = await startTestGateway({ now: () => new Date(clock), limits: { modelBudget } });
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
    t = await startTestGateway({ now: () => new Date(clock) });
    const phone = await remoteClient(t.gateway);
    clients.push(phone);
    for (let i = 0; i < 10; i++) expect(limited(await suggest(phone))).toBe(false);
    expect(limited(await suggest(phone))).toBe(true);
  });
});
