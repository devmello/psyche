import { forgetTool } from "@psyche/agent-core";
import type { ApprovalCheck } from "@psyche/memory";
import { afterEach, describe, expect, it } from "vitest";
import { makeEnv, type TestEnv } from "../../../packages/memory/test/helpers.ts";

/** The agent's `memory_forget` against the real SqliteMemoryStore (QA item 4, review r1). */

let env: TestEnv | undefined;
afterEach(async () => {
  await env?.cleanup();
  env = undefined;
});

const ctx = (over: Record<string, unknown> = {}) =>
  ({
    callId: "call_1",
    threadId: "thr_1",
    runId: "run_1",
    taint: false,
    permissionMode: "ask",
    mode: "normal",
    ...over,
  }) as never;

const run = async (
  tool: ReturnType<typeof forgetTool>,
  params: Record<string, unknown>,
  c = ctx(),
) => {
  if (tool.run === undefined) throw new Error("no run");
  const r = await tool.run(params, c);
  return r.output as { forgotten: boolean; message: string; files?: string[] };
};

/** An approval check that accepts `id` only for a `memory_forget` card about `subject`. */
const approves =
  (id: string, subject: string): ApprovalCheck =>
  (got, req) =>
    got === id && req.path === "forget:everywhere" && req.subject?.toLowerCase() === subject;

describe("memory_forget on the real store", () => {
  it("forgets a small plain fact with no card, audited as the agent", async () => {
    const audit: { kind: string; actor: { type: string } }[] = [];
    env = await makeEnv({
      audit: {
        append: async (e: never) => {
          audit.push(e);
          return {} as never;
        },
      },
    });
    await env.store.appendDailyNote({ text: "Bought a zebra lamp", provenance: "owner" });
    const tool = forgetTool(env.store);
    const out = await run(tool, { subject: "zebra lamp" });
    expect(out.forgotten).toBe(true);
    expect((await env.store.search("zebra lamp")).length).toBe(0);
    expect(audit.find((e) => e.kind === "memory.retraction")?.actor.type).toBe("agent");
  });

  it("refuses a wide forget (over the row cap) without the owner's card, and says so", async () => {
    env = await makeEnv();
    for (let i = 0; i < 25; i++) {
      await env.store.appendDailyNote({ text: `gizmo number ${i}`, provenance: "owner" });
    }
    const tool = forgetTool(env.store);
    const out = await run(tool, { subject: "gizmo" });
    expect(out).toMatchObject({ forgotten: false });
    expect(out.message).toMatch(/Memory page/);
    expect((await env.store.search("gizmo number", { limit: 50 })).length).toBe(25);
  });

  it("the same wide forget runs once the card for exactly that subject is approved", async () => {
    env = await makeEnv({ approvals: approves("apr_f", "gizmo") });
    for (let i = 0; i < 25; i++) {
      await env.store.appendDailyNote({ text: `gizmo number ${i}`, provenance: "owner" });
    }
    const tool = forgetTool(env.store);
    // A card for another subject does not cover it.
    await run(tool, { subject: "gizmo" }, ctx({ approvalId: "apr_other" }));
    expect((await env.store.search("gizmo number", { limit: 50 })).length).toBe(25);
    const out = await run(tool, { subject: "gizmo" }, ctx({ approvalId: "apr_f" }));
    expect(out.forgotten).toBe(true);
    expect((await env.store.search("gizmo number", { limit: 50 })).length).toBe(0);
    // One card, one forget.
    await env.store.appendDailyNote({ text: "gizmo again", provenance: "owner" });
    for (let i = 0; i < 25; i++) {
      await env.store.appendDailyNote({ text: `gizmo more ${i}`, provenance: "owner" });
    }
    const again = await run(tool, { subject: "gizmo" }, ctx({ approvalId: "apr_f" }));
    expect(again.forgotten).toBe(false);
  });

  it("refuses a phrase under the agent's minimum length", async () => {
    env = await makeEnv({ approvals: () => false });
    await env.store.appendDailyNote({ text: "Pet cat is Tom", provenance: "owner" });
    const tool = forgetTool(env.store);
    const out = await run(tool, { subject: "Tom" }).catch((e: Error) => ({
      forgotten: false,
      message: e.message,
    }));
    expect(out.forgotten).toBe(false);
    expect((await env.store.search("Tom")).length).toBe(1);
  });

  it("refuses in an incognito thread and while memory is paused", async () => {
    env = await makeEnv();
    await env.store.appendDailyNote({ text: "Bought a zebra lamp", provenance: "owner" });
    await expect(
      run(forgetTool(env.store, { isIncognito: () => true }), { subject: "zebra lamp" }),
    ).rejects.toThrow(/incognito/);
    env.store.setPaused(true);
    await expect(run(forgetTool(env.store), { subject: "zebra lamp" })).rejects.toThrow(/paused/);
    env.store.setPaused(false);
    expect((await env.store.search("zebra lamp")).length).toBe(1);
  });

  it("USER.md needs the card: refused without it, removed with it", async () => {
    env = await makeEnv({ approvals: approves("apr_u", "tabs over spaces") });
    const user = (await env.store.readFile("USER.md"))?.content ?? "";
    await env.store.writeFileAsOwner(
      "USER.md",
      `${user}\n- Prefers tabs over spaces in code <!--lf_abc123def 2026-11-20 thread:t0 preference-->\n`,
    );
    const tool = forgetTool(env.store);
    const no = await run(tool, { subject: "tabs over spaces" });
    expect(no.forgotten).toBe(false);
    expect((await env.store.readFile("USER.md"))?.content).toContain("tabs over spaces");
    const yes = await run(tool, { subject: "Tabs over  spaces" }, ctx({ approvalId: "apr_u" }));
    expect(yes.forgotten).toBe(true);
    expect((await env.store.readFile("USER.md"))?.content).not.toContain("tabs over spaces");
  });

  it("lists files as untrusted when one is not a protected file or a daily note", async () => {
    env = await makeEnv();
    await env.store.writeFileAsOwner("notes/trip.md", "# Trip\n\nSee the zebra lamp shop\n");
    const tool = forgetTool(env.store);
    if (tool.run === undefined) throw new Error("no run");
    const r = await tool.run({ subject: "zebra lamp", dry_run: true }, ctx());
    expect(r.provenance).toBe("untrusted");
  });
});
