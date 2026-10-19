import { Worker } from "node:worker_threads";
import { openDb } from "@psyche/db";
import { FakeClock } from "@psyche/testing";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteTaskEngine } from "../src/index.ts";
import { THREAD, testDb, testEngine, tmpDir } from "./helpers.ts";

const INPUT = { threadId: THREAD, title: "t", goal: "g", createdFrom: "chat" as const };

describe("two-worker lease race", () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  it("two threads with their own connections never win the same task", async () => {
    const tmp = tmpDir();
    cleanup = tmp.cleanup;
    const clock = new FakeClock(Date.now());
    const db = testDb(clock, tmp.file);
    const engine = new SqliteTaskEngine({ db, clock });
    const TASKS = 400;
    for (let i = 0; i < TASKS; i += 1) await engine.create(INPUT);
    db.close();

    const start = new Int32Array(new SharedArrayBuffer(8));
    const run = (owner: string) =>
      new Promise<string[]>((resolve, reject) => {
        const w = new Worker(new URL("./race-worker.ts", import.meta.url), {
          workerData: { file: tmp.file, owner, start },
        });
        w.once("message", resolve);
        w.once("error", reject);
      });
    const results = Promise.all([run("worker-a"), run("worker-b")]);
    while (Atomics.load(start, 1) < 2) await new Promise((r) => setTimeout(r, 10));
    Atomics.store(start, 0, 1);
    Atomics.notify(start, 0);
    const [a, b] = await results;

    const all = [...a, ...b];
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(TASKS);
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);

    const check = openDb(tmp.file, { readonly: true });
    const attempts = check.sqlite.prepare("SELECT attempt, status FROM tasks").all() as {
      attempt: number;
      status: string;
    }[];
    check.close();
    expect(attempts.every((r) => r.attempt === 1 && r.status === "done")).toBe(true);
  }, 30_000);

  it("concurrent claims in one process are exclusive", async () => {
    const { engine } = testEngine();
    for (let i = 0; i < 20; i += 1) await engine.create(INPUT);
    const claims = await Promise.all(
      Array.from({ length: 40 }, (_, i) => engine.claim(`w${i % 2}`, { leaseMs: 60_000 })),
    );
    const won = claims.filter((c) => c !== undefined).map((c) => c.taskId);
    expect(won).toHaveLength(20);
    expect(new Set(won).size).toBe(20);
  });

  it("property: at most one live lease per task under random claim/renew/release/time", async () => {
    type Op =
      | { op: "claim"; w: number }
      | { op: "renew"; w: number }
      | { op: "release"; w: number }
      | { op: "advance"; ms: number };
    const opArb: fc.Arbitrary<Op> = fc.oneof(
      fc.record({ op: fc.constant("claim" as const), w: fc.integer({ min: 0, max: 2 }) }),
      fc.record({ op: fc.constant("renew" as const), w: fc.integer({ min: 0, max: 2 }) }),
      fc.record({ op: fc.constant("release" as const), w: fc.integer({ min: 0, max: 2 }) }),
      fc.record({ op: fc.constant("advance" as const), ms: fc.integer({ min: 0, max: 15_000 }) }),
    );
    const LEASE = 10_000;
    const { engine, clock, db } = testEngine();
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 40 }), async (ops) => {
        const task = await engine.create(INPUT);
        const held = new Map<number, Awaited<ReturnType<typeof engine.claim>>>();
        const tokens = new Set<string>();
        for (const o of ops) {
          if (o.op === "advance") {
            clock.advance(o.ms);
          } else if (o.op === "claim") {
            const l = await engine.claim(`w${o.w}`, { leaseMs: LEASE, taskId: task.id });
            if (l !== undefined) {
              expect(tokens.has(l.token)).toBe(false);
              tokens.add(l.token);
              held.set(o.w, l);
            }
          } else {
            const l = held.get(o.w);
            if (l === undefined) continue;
            if (o.op === "renew") {
              const r = await engine.renew(l, LEASE).catch(() => undefined);
              if (r === undefined) held.delete(o.w);
              else held.set(o.w, r);
            } else {
              await engine.release(l);
              held.delete(o.w);
            }
          }
          // Invariant: the workers whose lease would still renew are at most one, and it is
          // the owner the database names.
          const live: number[] = [];
          for (const [w, l] of held) {
            if (l === undefined) continue;
            const row = db.sqlite
              .prepare("SELECT lease_token, lease_until, lease_owner FROM tasks WHERE id = ?")
              .get(task.id) as { lease_token: string | null; lease_until: string | null };
            if (
              row.lease_token === l.token &&
              row.lease_until !== null &&
              row.lease_until > clock.iso()
            ) {
              live.push(w);
            }
          }
          expect(live.length).toBeLessThanOrEqual(1);
          const t = await engine.get(task.id);
          if (live.length === 1) expect(t?.leaseOwner).toBe(`w${live[0]}`);
        }
      }),
      { numRuns: 200 },
    );
    db.close();
  });
});
