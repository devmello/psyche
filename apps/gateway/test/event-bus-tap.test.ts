import { eventFrame } from "@psyche/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventBus, SKIP_EVENT } from "../src/event-bus.ts";

/** In-process taps (G1): no serialization, filtered by name, read as the least trusted reader. */

function bus(options: ConstructorParameters<typeof EventBus>[2] = {}) {
  return new EventBus(7, () => {}, options);
}
const delta = { threadId: "t", messageId: "m", text: "hi" } as never;
const promise = { promise: { id: "p", text: "third-party quote" } } as never;

afterEach(() => vi.restoreAllMocks());

describe("EventBus.tap", () => {
  it("hands over the payload object with no JSON round trip, for any number of taps", () => {
    const b = bus();
    const seen: unknown[] = [];
    for (let i = 0; i < 20; i++) b.tap(["chat.delta"], (_e, p) => seen.push(p));
    const parse = vi.spyOn(JSON, "parse");
    const stringify = vi.spyOn(JSON, "stringify");
    b.publish("chat.delta", delta, "t");
    expect(seen).toHaveLength(20);
    expect(seen.every((p) => p === delta)).toBe(true);
    expect(parse).not.toHaveBeenCalled();
    expect(stringify).not.toHaveBeenCalled();
  });

  it("does not run the personalizer for an event no tap wants", () => {
    const b = bus();
    const personalizer = vi.fn(() => undefined);
    b.setPersonalizer(personalizer);
    for (let i = 0; i < 20; i++) b.tap(["settings.changed"], () => {});
    b.publish("chat.delta", delta, "t");
    expect(personalizer).not.toHaveBeenCalled();
  });

  it("filters by exact name, prefix and *", () => {
    const b = bus();
    const exact: string[] = [];
    const prefix: string[] = [];
    const all: string[] = [];
    b.tap(["run.updated"], (e) => exact.push(e));
    b.tap(["memory.entity.*"], (e) => prefix.push(e));
    b.tap("*", (e) => all.push(e));
    b.publish("run.updated", {} as never);
    b.publish("memory.entity.updated" as never, {} as never);
    b.publish("memory.graph.updated" as never, {} as never);
    expect(exact).toEqual(["run.updated"]);
    expect(prefix).toEqual(["memory.entity.updated"]);
    expect(all).toEqual(["run.updated", "memory.entity.updated", "memory.graph.updated"]);
  });

  it("stops delivering after unsubscribe", () => {
    const b = bus();
    const seen: string[] = [];
    const off = b.tap(["run.updated"], (e) => seen.push(e));
    b.publish("run.updated", {} as never);
    off();
    b.publish("run.updated", {} as never);
    expect(seen).toHaveLength(1);
  });

  it("keeps publish order", () => {
    const b = bus();
    const seen: number[] = [];
    b.tap(["run.updated"], (_e, p) => seen.push((p as { n: number }).n));
    for (const n of [1, 2, 3]) b.publish("run.updated", { n } as never);
    expect(seen).toEqual([1, 2, 3]);
  });

  it("applies scope rules: an admin event does not reach a default tap", () => {
    const b = bus();
    const def: string[] = [];
    const admin: string[] = [];
    b.tap(["device.updated"], (e) => def.push(e));
    b.tap(["device.updated"], (e) => admin.push(e), {
      scopes: ["operator.read", "operator.admin"],
    });
    b.publish("device.updated", {} as never);
    expect(def).toEqual([]);
    expect(admin).toEqual(["device.updated"]);
  });

  it("redacts settings.changed before a tap sees it", () => {
    const b = bus();
    let got: unknown;
    b.tap(["settings.changed"], (_e, p) => {
      got = p;
    });
    b.publish("settings.changed", {
      entries: [
        { key: "mcp.servers", value: [{ id: "s", transport: { env: { TOKEN: "sekret-value" } } }] },
      ],
    } as never);
    expect(JSON.stringify(got)).not.toContain("sekret-value");
  });

  it("a throwing tap, sync or async, does not stop the others or the remote sinks", async () => {
    const errors: string[] = [];
    const b = bus({ onTapError: (e) => errors.push(e) });
    const seen: string[] = [];
    const frames: string[] = [];
    b.tap(["run.updated"], () => {
      throw new Error("boom");
    });
    b.tap(["run.updated"], async () => {
      throw new Error("async boom");
    });
    b.tap(["run.updated"], (e) => seen.push(e));
    b.subscribe(["operator.read"], (f) => frames.push(f));
    expect(() => b.publish("run.updated", {} as never)).not.toThrow();
    await Promise.resolve();
    expect(seen).toEqual(["run.updated"]);
    expect(frames).toHaveLength(1);
    expect(errors).toEqual(["run.updated", "run.updated"]);
  });

  it("hands a frozen copy when freezeTaps is on, so a mutating tap fails", () => {
    const b = bus({ freezeTaps: true });
    const outcomes: string[] = [];
    b.tap(["run.updated"], (_e, p) => {
      try {
        (p as { run: { status: string } }).run.status = "x";
        outcomes.push("mutated");
      } catch {
        outcomes.push("frozen");
      }
    });
    const payload = { run: { status: "done" } } as never;
    b.publish("run.updated", payload);
    expect(outcomes).toEqual(["frozen"]);
    expect((payload as { run: { status: string } }).run.status).toBe("done");
  });
});

describe("taps and the scrubbed events", () => {
  const scrubbed = ["promise.updated", "memory.loop.updated", "run.step"] as const;

  it.each(scrubbed)("%s never reaches a tap when nothing personalised it", (event) => {
    const b = bus();
    const seen: string[] = [];
    b.tap("*", (e) => seen.push(e));
    b.publish(event, promise);
    expect(seen).toEqual([]);
  });

  it("a personalised event reaches a tap in the least trusted form, computed once", () => {
    const b = bus();
    const readers: unknown[] = [];
    b.setPersonalizer((_e, _p, sub) => {
      readers.push(sub.reader);
      return { promise: { id: "p", text: "[stripped]" } };
    });
    const got: unknown[] = [];
    for (let i = 0; i < 5; i++) b.tap(["promise.updated"], (_e, p) => got.push(p));
    b.publish("promise.updated", promise);
    expect(readers).toEqual([{ role: null, desktop: false }]);
    expect(got).toHaveLength(5);
    expect(JSON.stringify(got[0])).toContain("[stripped]");
    expect(JSON.stringify(got[0])).not.toContain("third-party quote");
  });

  it("a core scrub answers for a tap as for a reader with no identity", () => {
    const b = bus();
    const readers: unknown[] = [];
    b.setCoreScrub("run.step", (_p, reader) => {
      readers.push(reader);
      return { stripped: true };
    });
    const got: unknown[] = [];
    b.tap(["run.step"], (_e, p) => got.push(p));
    b.publish("run.step", { runId: "r", step: { secret: "x" } } as never);
    expect(got).toEqual([{ stripped: true }]);
    expect(readers).toEqual([{ role: null, desktop: false }]);
  });

  it("a scrub that skips, or throws, delivers nothing to the tap", () => {
    const errors: string[] = [];
    const b = bus({ onTapError: (e) => errors.push(e) });
    const got: string[] = [];
    b.tap(["run.step", "promise.updated"], (e) => got.push(e));
    b.setCoreScrub("run.step", () => SKIP_EVENT);
    b.setPersonalizer((e) => {
      if (e === "promise.updated") throw new Error("scrub failed");
      return undefined;
    });
    b.publish("run.step", {} as never);
    b.publish("promise.updated", promise);
    expect(got).toEqual([]);
    expect(errors).toEqual(["promise.updated"]);
  });

  it("the fork-hidden skip applies to a tap", () => {
    const b = bus();
    b.setPersonalizer(() => SKIP_EVENT);
    const got: string[] = [];
    b.tap(["task.updated"], (e) => got.push(e));
    b.publish("task.updated", { task: { id: "t" } } as never);
    expect(got).toEqual([]);
  });
});

describe("remote frames", () => {
  it("are byte-identical to the frame built the old way, with each viewer's own seq", () => {
    const b = bus();
    const a: string[] = [];
    const c: string[] = [];
    b.subscribe(["operator.read"], (f) => a.push(f));
    const sinkC = (f: string) => c.push(f);
    b.subscribe(["operator.read"], sinkC);
    b.setFilter(sinkC, { threadIds: ["t2"] });
    const p1 = { threadId: "t", messageId: "m", text: 'he said "hi"   é' } as never;
    b.publish("chat.delta", p1, "t");
    b.publish("chat.delta", p1, "t2");
    b.publish("run.updated", undefined as never);
    expect(a[0]).toBe(JSON.stringify(eventFrame("chat.delta", p1, 1, 7)));
    expect(a[1]).toBe(JSON.stringify(eventFrame("chat.delta", p1, 2, 7)));
    expect(a[2]).toBe(JSON.stringify(eventFrame("run.updated", undefined, 3, 7)));
    expect(c[0]).toBe(JSON.stringify(eventFrame("chat.delta", p1, 1, 7)));
  });

  it("serialize a shared payload once for many viewers", () => {
    const b = bus();
    for (let i = 0; i < 10; i++) b.subscribe(["operator.read"], () => {});
    const stringify = vi.spyOn(JSON, "stringify");
    b.publish("chat.delta", delta, "t");
    // One for the payload and one for the event name in the frame head.
    expect(stringify.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("still personalise per viewer: each gets its own form and token", () => {
    const b = bus();
    const calls: (string | null)[] = [];
    b.setPersonalizer((_e, p, sub) => {
      calls.push(sub.deviceId);
      return sub.deviceId === null ? undefined : { ...(p as object), answerToken: sub.deviceId };
    });
    const x: string[] = [];
    const y: string[] = [];
    b.subscribe(["operator.read"], (f) => x.push(f), "dev_x");
    b.subscribe(["operator.read"], (f) => y.push(f), "dev_y");
    b.publish("approval.created", { approval: { id: "a" } } as never);
    expect(calls).toEqual(["dev_x", "dev_y"]);
    expect(x[0]).toBe(
      JSON.stringify(
        eventFrame("approval.created", { approval: { id: "a" }, answerToken: "dev_x" }, 1, 7),
      ),
    );
    expect(y[0]).toContain('"answerToken":"dev_y"');
  });

  it("send a scrubbed event only in the personalised form, and to nobody without one", () => {
    const b = bus();
    const got: string[] = [];
    b.subscribe(["operator.read"], (f) => got.push(f), "dev");
    b.publish("promise.updated", promise);
    expect(got).toEqual([]);
    b.setPersonalizer(() => ({ promise: { id: "p", text: "[stripped]" } }));
    b.publish("promise.updated", promise);
    expect(got).toHaveLength(1);
    expect(got[0]).not.toContain("third-party quote");
  });
});
