import { describe, expect, it } from "vitest";
import { InMemoryThreadStateStore, type ThreadState, type ThreadStateStore } from "../src/state.ts";
import { endOf, harness, runTurn, say } from "./harness.ts";

/** A stored thread (the owner's earlier turns) must survive a turn that never got to read it. */
describe("thread state is not overwritten by a turn that did not load it", () => {
  it("keeps the history when the turn was cancelled before it started", async () => {
    const state = new InMemoryThreadStateStore();
    const h = harness({
      script: [say("Cut Nova to five bullets."), say("never sent")],
      loop: { state },
    });
    await runTurn(h, "review my resume [resume text]");
    const before = await state.load("thr_1");
    expect(JSON.stringify(before?.messages)).toContain("review my resume");

    const abort = new AbortController();
    abort.abort();
    const events = await runTurn(h, "stop", { signal: abort.signal });
    expect(endOf(events).outcome).toBe("cancelled");

    const after = await state.load("thr_1");
    expect(after?.messages).toEqual(before?.messages);
  });

  it("keeps the history when reading it fails, and does not run on an empty thread", async () => {
    const inner = new InMemoryThreadStateStore();
    let failLoad = false;
    const state: ThreadStateStore = {
      load: async (id) => {
        if (failLoad) throw new Error("database is locked");
        return inner.load(id);
      },
      save: (id, s: ThreadState) => inner.save(id, s),
    };
    const h = harness({ script: [say("review done"), say("never sent")], loop: { state } });
    await runTurn(h, "review my resume");
    const before = await inner.load("thr_1");

    failLoad = true;
    const events = await runTurn(h, "yes write a revised version");
    expect(endOf(events).outcome).toBe("failed");
    expect(h.provider.requests).toHaveLength(1); // the second turn never reached the model
    expect(await inner.load("thr_1")).toEqual(before);
  });
});
