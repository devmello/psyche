import {
  type CatalogueEntry,
  type ConnectorEvent,
  type ConnectorFactory,
  ConnectorRegistry,
} from "@psyche/connectors";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  backoffMs,
  ConnectorSync,
  FAILURES_BEFORE_ERROR,
  MAX_BACKOFF_MS,
} from "../src/compose/connector-sync.ts";
import { connectorStatusNotices } from "../src/compose/connectors.ts";
import type { ComposeServices } from "../src/compose/services.ts";

/** Connector sync rounds: per-connector backoff, timeouts, the error status and its one notice. */

const MIN = 60_000;
const BASE = 3 * MIN;

const entry = (type: string): CatalogueEntry => ({
  type,
  id: type,
  label: `Demo ${type}`,
  description: "test connector",
  category: "first_party",
  vendor: "Psyche",
  auth: "none",
  scopes: { read: ["r"], read_act: ["r"] },
  actions: [{ id: `${type}.read`, title: "Read", sideEffect: "read", defaultRule: "allow" }],
  available: true,
});

type Mode = "ok" | "fail" | "hang";

/** A connector whose sync the test steers; `calls` counts attempts, `aborted` the cut-off ones. */
function steerable(type: string) {
  const state = { mode: "ok" as Mode, calls: 0, aborted: 0 };
  const factory: ConnectorFactory = {
    entry: entry(type),
    create: (record) => ({
      id: record.id,
      type,
      async connect() {
        return { account: "a@example.com", scopes: ["r"] };
      },
      async disconnect() {},
      actions: () => entry(type).actions,
      tools: () => [],
      async sync(cursor, signal) {
        state.calls += 1;
        signal?.addEventListener("abort", () => {
          state.aborted += 1;
        });
        if (state.mode === "fail") throw new Error("provider down");
        // Ignores the signal on purpose: the round must stop waiting on its own.
        if (state.mode === "hang") await new Promise(() => undefined);
        return { changes: 1, full: false, cursor: { ...(cursor ?? {}), n: state.calls } };
      },
      async health() {
        return { ok: true, status: "connected", checkedAt: 0 };
      },
    }),
  };
  return { state, factory };
}

/** An in-memory notifier with the real one's dedupe-by-key and unresolved listing. */
function fakeNotifier() {
  const rows: {
    id: string;
    dedupeKey: string;
    resolvedAt: string | null;
    kind: string;
    message?: { titleKey: string; bodyKey: string; params?: Record<string, unknown> };
    title: string;
    body: string;
    route?: string;
  }[] = [];
  let n = 0;
  return {
    rows,
    notifier: {
      async notify(input: {
        dedupeKey: string;
        kind: string;
        title: string;
        body: string;
        route?: string;
        message?: { titleKey: string; bodyKey: string; params?: Record<string, unknown> };
      }) {
        const open = rows.find((r) => r.dedupeKey === input.dedupeKey && r.resolvedAt === null);
        if (open !== undefined) {
          Object.assign(open, input);
          return open;
        }
        n += 1;
        const row = { id: `n${n}`, resolvedAt: null, ...input };
        rows.push(row);
        return row;
      },
      async list() {
        return rows.filter((r) => r.resolvedAt === null);
      },
      async resolve(id: string) {
        const row = rows.find((r) => r.id === id);
        if (row !== undefined) row.resolvedAt = "now";
        return row;
      },
    },
  };
}

async function setup(types: string[]) {
  const steer = Object.fromEntries(types.map((t) => [t, steerable(t)]));
  const { rows, notifier } = fakeNotifier();
  const services = { notifier, logger: undefined } as unknown as ComposeServices;
  const events: ConnectorEvent[] = [];
  const pending: Promise<void>[] = [];
  let ids = 0;
  const registry: ConnectorRegistry = new ConnectorRegistry({
    factories: types.map((t) => (steer[t] as ReturnType<typeof steerable>).factory),
    context: {
      clock: { now: () => Date.now() } as never,
      fetch,
      tokens: { load: async () => undefined, save: async () => {}, clear: async () => {} },
    },
    onEvent: (e) => {
      events.push(e);
      pending.push(connectorStatusNotices(services, registry, e));
    },
    newId: () => {
      ids += 1;
      return `c${ids}`;
    },
  });
  for (const t of types) await registry.connect({ catalogueId: t, scopeMode: "read" });
  const logs: string[] = [];
  const sync = new ConnectorSync({
    registry,
    now: () => Date.now(),
    intervalMs: BASE,
    log: (message, fields) => logs.push(`${message} ${JSON.stringify(fields)}`),
  });
  const settle = async () => {
    await vi.advanceTimersByTimeAsync(0);
    await Promise.all(pending);
    await vi.advanceTimersByTimeAsync(0);
  };
  return { steer, registry, sync, rows, events, logs, settle };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-24T10:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("backoff", () => {
  it("doubles from the interval and stops at one hour", () => {
    const seq = [1, 2, 3, 4, 5, 6, 7, 30].map((n) => backoffMs(n, BASE) / MIN);
    expect(seq).toEqual([3, 6, 12, 24, 48, 60, 60, 60]);
    expect(backoffMs(0, BASE)).toBe(0);
    expect(MAX_BACKOFF_MS).toBe(60 * MIN);
  });

  it("holds a failing connector back by its own backoff and resets on success", async () => {
    const { steer, sync, settle } = await setup(["demo"]);
    const d = (steer.demo as ReturnType<typeof steerable>).state;
    d.mode = "fail";
    await sync.runOnce(); // failure 1 at t0: next try in 3 min
    expect(d.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(2 * MIN);
    await sync.runOnce();
    expect(d.calls).toBe(1); // too early
    await vi.advanceTimersByTimeAsync(1 * MIN);
    await sync.runOnce(); // failure 2: next in 6 min
    expect(d.calls).toBe(2);
    await vi.advanceTimersByTimeAsync(5 * MIN);
    await sync.runOnce();
    expect(d.calls).toBe(2);
    await vi.advanceTimersByTimeAsync(1 * MIN);
    await sync.runOnce(); // failure 3: next in 12 min
    expect(d.calls).toBe(3);
    expect(sync.failures("c1")).toBe(3);
    d.mode = "ok";
    await vi.advanceTimersByTimeAsync(12 * MIN);
    await sync.runOnce();
    expect(d.calls).toBe(4);
    expect(sync.failures("c1")).toBe(0); // reset: the next round runs at once
    await sync.runOnce();
    expect(d.calls).toBe(5);
    await settle();
  });

  it("keeps one connector's failures away from another", async () => {
    const { steer, sync } = await setup(["bad", "good"]);
    const bad = (steer.bad as ReturnType<typeof steerable>).state;
    const good = (steer.good as ReturnType<typeof steerable>).state;
    bad.mode = "fail";
    await sync.runOnce();
    await vi.advanceTimersByTimeAsync(BASE);
    await sync.runOnce();
    expect(good.calls).toBe(2); // synced every round
    expect(bad.calls).toBe(2);
    await sync.runOnce(); // bad is in its 6 minute backoff
    expect(good.calls).toBe(3);
    expect(bad.calls).toBe(2);
  });
});

describe("timeout", () => {
  it("cuts off a hung sync, aborts its signal and still syncs the others", async () => {
    const { steer, sync, logs } = await setup(["stuck", "fine"]);
    const stuck = (steer.stuck as ReturnType<typeof steerable>).state;
    const fine = (steer.fine as ReturnType<typeof steerable>).state;
    stuck.mode = "hang";
    const round = sync.runOnce();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(fine.calls).toBe(0); // still waiting on the stuck one
    await vi.advanceTimersByTimeAsync(1_000);
    await round;
    expect(stuck.aborted).toBe(1);
    expect(fine.calls).toBe(1);
    expect(sync.failures("c1")).toBe(1);
    expect(logs.join("\n")).toContain('"code":"timeout"');
    // The round is over, so the next one is not skipped as "still running".
    stuck.mode = "ok";
    await vi.advanceTimersByTimeAsync(BASE);
    await sync.runOnce();
    expect(fine.calls).toBe(2);
  });
});

describe("error status and the owner's notice", () => {
  it("turns error after five failures in a row, notifies once and resolves on recovery", async () => {
    const { steer, registry, sync, rows, settle } = await setup(["demo"]);
    const d = (steer.demo as ReturnType<typeof steerable>).state;
    d.mode = "fail";
    for (let i = 1; i <= FAILURES_BEFORE_ERROR; i++) {
      await vi.advanceTimersByTimeAsync(backoffMs(i - 1, BASE));
      await sync.runOnce();
      await settle();
      const status = (await registry.get("c1")).status;
      expect(status).toBe(i < FAILURES_BEFORE_ERROR ? "connected" : "error");
    }
    const record = await registry.get("c1");
    expect(record.lastSync).toMatchObject({ error: "internal", syncFailing: true });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "system",
      route: "/settings/connectors",
      dedupeKey: "connector:c1:sync_failing",
      message: {
        titleKey: "notice.connector.syncFailing.title",
        bodyKey: "notice.connector.syncFailing.body",
        params: { connectorId: "c1", name: "Demo demo", reason: "internal" },
      },
    });

    // A parked connector is still retried, at the slowest pace, and no second notice appears.
    await vi.advanceTimersByTimeAsync(MAX_BACKOFF_MS);
    await sync.runOnce();
    await settle();
    expect(d.calls).toBe(FAILURES_BEFORE_ERROR + 1);
    expect(rows).toHaveLength(1);
    expect((await registry.get("c1")).status).toBe("error");

    d.mode = "ok";
    await vi.advanceTimersByTimeAsync(MAX_BACKOFF_MS);
    await sync.runOnce();
    await settle();
    const healed = await registry.get("c1");
    expect(healed.status).toBe("connected");
    expect(healed.lastSync).not.toHaveProperty("syncFailing");
    expect(rows[0]?.resolvedAt).not.toBeNull();
  });

  it("names a timeout as the reason when that is what kept failing", async () => {
    const { steer, registry, sync, settle } = await setup(["demo"]);
    (steer.demo as ReturnType<typeof steerable>).state.mode = "hang";
    for (let i = 0; i < FAILURES_BEFORE_ERROR; i++) {
      await vi.advanceTimersByTimeAsync(backoffMs(i, BASE));
      const round = sync.runOnce();
      await vi.advanceTimersByTimeAsync(60_000);
      await round;
    }
    await settle();
    expect((await registry.get("c1")).lastSync).toMatchObject({ error: "timeout" });
  });
});

describe("sign-in notices", () => {
  const services = () => {
    const { rows, notifier } = fakeNotifier();
    return { rows, services: { notifier } as unknown as ComposeServices };
  };
  const registry = { get: async () => undefined } as never;
  const flush = () => vi.advanceTimersByTimeAsync(0);

  it("a Testing-mode expiry says how to fix it, once, and resolves after the re-auth", async () => {
    const { rows, services: s } = services();
    const needs = (reason: string): ConnectorEvent => ({
      type: "status",
      connectorId: "google-1",
      status: "needs_auth",
      reason,
    });
    await connectorStatusNotices(s, registry, needs("testing_mode_expired"));
    await connectorStatusNotices(s, registry, needs("testing_mode_expired"));
    await flush();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      route: "/settings/connectors",
      message: {
        titleKey: "notice.connector.testingExpired.title",
        bodyKey: "notice.connector.testingExpired.body",
        params: { connectorId: "google-1" },
      },
    });
    expect(rows[0]?.body).toContain("Publish the OAuth app");
    await connectorStatusNotices(s, registry, {
      type: "status",
      connectorId: "other",
      status: "connected",
    });
    await flush();
    expect(rows[0]?.resolvedAt).toBeNull(); // another connector's recovery leaves it open
    await connectorStatusNotices(s, registry, {
      type: "status",
      connectorId: "google-1",
      status: "connected",
    });
    await flush();
    expect(rows[0]?.resolvedAt).not.toBeNull();
  });

  it("a revoked token gets the plain reconnect notice", async () => {
    const { rows, services: s } = services();
    await connectorStatusNotices(s, registry, {
      type: "status",
      connectorId: "google-1",
      status: "needs_auth",
      reason: "token_revoked",
    });
    await flush();
    expect(rows[0]?.message?.titleKey).toBe("notice.connector.reconnect.title");
  });
});
