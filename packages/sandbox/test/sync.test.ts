import { PsycheError } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { clampDim, encodeFrame, resizePayload, TailBuffer } from "../src/pty.ts";
import { AsyncQueue, Semaphore } from "../src/sync.ts";

describe("Semaphore", () => {
  it("never exceeds its permits and releases in FIFO order", async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let peak = 0;
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 6 }, async (_, i) => {
        const release = await sem.acquire();
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        order.push(i);
        active -= 1;
        release();
      }),
    );
    expect(peak).toBe(2);
    expect(order).toHaveLength(6);
  });

  it("rejects a waiter whose signal aborts with cancelled", async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire();
    const ac = new AbortController();
    const waiting = sem.acquire(ac.signal);
    ac.abort();
    const err = await waiting.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PsycheError);
    expect((err as PsycheError).code).toBe("cancelled");
    expect(sem.waiting).toBe(0);
    release();
    const again = await sem.acquire();
    again();
  });

  it("double release is harmless", async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire();
    release();
    release();
    const a = await sem.acquire();
    let second = false;
    void sem.acquire().then(() => {
      second = true;
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(second).toBe(false);
    a();
  });
});

describe("AsyncQueue", () => {
  it("yields pushed items in order and ends", async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    setTimeout(() => {
      q.push(2);
      q.end();
    }, 1);
    const out: number[] = [];
    for await (const n of q) out.push(n);
    expect(out).toEqual([1, 2]);
  });

  it("signals backpressure above the high-water mark", async () => {
    const events: boolean[] = [];
    const q = new AsyncQueue<number>({ highWater: 4, onPressure: (p) => events.push(p) });
    for (let i = 0; i < 5; i++) q.push(i);
    q.end();
    for await (const _ of q) {
      // drain
    }
    expect(events).toEqual([true, false]);
  });
});

describe("PTY framing", () => {
  it("encodes type, big-endian length and payload", () => {
    const f = encodeFrame(0, Buffer.from("hi"));
    expect([...f]).toEqual([0, 0, 0, 0, 2, 104, 105]);
    expect([...resizePayload(100, 30)]).toEqual([0, 100, 0, 30]);
    expect(clampDim(0)).toBe(1);
    expect(clampDim(5000)).toBe(1000);
  });

  it("the transcript keeps only the newest bytes", () => {
    const t = new TailBuffer(5);
    t.push(Buffer.from("abc"));
    t.push(Buffer.from("defg"));
    expect(t.toString()).toBe("cdefg");
  });
});
