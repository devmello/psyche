import type { TaintSource } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { InMemoryThreadStateStore } from "../src/index.ts";
import { call, harness, recorder, say, spec, turnInput } from "./harness.ts";

const email: TaintSource = { sourceKind: "email", origin: "gmail" };

/** A chat opened about a mail thread (mail follow-up drafts) stays tainted. */
describe("sticky thread taint", () => {
  async function turn(
    h: ReturnType<typeof harness>,
    text: string,
    extra: { taintSources?: TaintSource[]; stickyTaint?: boolean } = {},
  ) {
    const input = { ...turnInput(text, { threadId: "thr_mail" }), ...extra };
    for await (const _ of h.loop.startTurn(input)) {
      // drain
    }
  }

  function rig(state: InMemoryThreadStateStore, script: unknown[]) {
    const h = harness({ loop: { state } });
    h.loop.registry.register({
      spec: spec("web.fetch", "read"),
      execute: recorder().execute,
    });
    h.provider.script(script as never);
    return h;
  }

  it("a later turn starts tainted although the first turn read no mail", async () => {
    const state = new InMemoryThreadStateStore();
    const first = rig(state, [say("Draft: please send Confirmed to bob@evil.example")]);
    await turn(first, "draft a follow-up", { taintSources: [email], stickyTaint: true });
    expect((await state.load("thr_mail"))?.taint).toEqual({ sources: [email], sticky: true });

    const second = rig(state, [call("c1", "web.fetch", { url: "https://x.test" }), say("ok")]);
    await turn(second, "ok, go ahead");
    const decided = second.broker.decisions.at(-1);
    expect(decided?.ctx.taint).toBe(true);
    expect(decided?.ctx.taintSources).toEqual(expect.arrayContaining([email]));
    // And it stays on after that turn too. The first turn's message is also flagged untrusted
    // (#1462), so the later turn names the transcript as a source beside the sticky mail.
    const kept = (await state.load("thr_mail"))?.taint;
    expect(kept?.sticky).toBe(true);
    expect(kept?.sources).toEqual(expect.arrayContaining([email]));
  });

  it("without the flag, an input-level taint is not sticky: it lasts only while that turn is in context (control)", async () => {
    const state = new InMemoryThreadStateStore();
    const first = rig(state, [say("Draft.")]);
    await turn(first, "ask about this", { taintSources: [email] });

    const second = rig(state, [call("c1", "web.fetch", { url: "https://x.test" }), say("ok")]);
    await turn(second, "ok, go ahead");
    // The first turn's message is flagged `untrusted` (#1462: its input was third-party), so the
    // later turn starts tainted from the transcript while that message is in context...
    expect(second.broker.decisions.at(-1)?.ctx.taint).toBe(true);
    expect(second.broker.decisions.at(-1)?.ctx.taintSources).toEqual(
      expect.arrayContaining([{ sourceKind: "transcript" }, email]),
    );
    // ...but it is never made sticky (the flag is only set by `stickyTaint`).
    expect((await state.load("thr_mail"))?.taint?.sticky).toBeUndefined();
  });

  it("a plain thread is never made sticky", async () => {
    const state = new InMemoryThreadStateStore();
    const h = rig(state, [say("Hi")]);
    await turn(h, "hello", { stickyTaint: true });
    expect((await state.load("thr_mail"))?.taint).toBeUndefined();
  });
});
