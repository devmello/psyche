import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditChange, ModelEvent, ModelProvider, ModelRequest } from "@psyche/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { toolEffectChange } from "../src/compose/changes.ts";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { LEARN_DOC_SYSTEM, LEARN_SYSTEM } from "../src/compose/user-profile.ts";
import { silentLogger } from "../src/log.ts";
import { adminClient, ik, type TestClient } from "./helpers.ts";

/**
 * Owner-data change records: the post-turn profile-learning pass writes USER.md and leaves a
 * hash-chained record linked to the thread and turn, with a stored diff. Owner edits, settings
 * and tool effects are recorded too; the view filters, exports and detects tampering.
 */

let home = "";
let composed: ComposedGateway | null = null;
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

const reply = (text: string): ModelEvent[] => [
  { type: "text_delta", text },
  {
    type: "usage",
    usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 },
  },
  { type: "finish", reason: "stop" },
];

/** The main model just answers; the learn prompt answers from what the owner said. */
function scripted(): ModelProvider & { learnCalls: string[]; docCalls: string[] } {
  const p = {
    id: "scripted",
    learnCalls: [] as string[],
    docCalls: [] as string[],
    capabilities: async () => ({ contextWindow: 64_000 }) as never,
    async *stream(req: ModelRequest) {
      if (req.system === LEARN_DOC_SYSTEM) {
        const part = req.messages[0]?.parts[0];
        const text = part?.type === "text" ? part.text : "";
        p.docCalls.push(text);
        // A distilled resume; whatever else the document says is ignored.
        const facts = text.includes("PRIYA PATEL")
          ? [
              { text: "Goes by Priya", kind: "name", field: "name", value: "Priya" },
              {
                text: "Software engineer at Acme Robotics",
                kind: "other",
                field: "work",
                value: "Software engineer at Acme Robotics",
              },
              { text: "B.S. Computer Science, UC Santa Cruz (2024)", section: "education" },
              { text: "Software engineer, Acme Robotics, 2024-present", section: "experience" },
              { text: "TypeScript, Python, ROS", section: "skills" },
            ]
          : [{ text: "Name is Mallory", kind: "name", field: "name", value: "Mallory" }];
        yield* reply(JSON.stringify({ facts }));
        return;
      }
      if (req.system === LEARN_SYSTEM) {
        const part = req.messages[0]?.parts[0];
        const text = part?.type === "text" ? part.text : "";
        p.learnCalls.push(text);
        const facts = text.includes("Avery")
          ? [
              { text: "Goes by Avery", kind: "name", field: "name", value: "Avery" },
              {
                text: "Timezone is Pacific time",
                kind: "preference",
                field: "timezone",
                value: "America/Los_Angeles",
              },
              { text: "Prefers tea over coffee", kind: "preference" },
              // A health detail the model should not have proposed: memory refuses it.
              { text: "Takes insulin every morning", kind: "routine" },
            ]
          : [{ text: "Has a sister named Maya", kind: "person" }];
        yield* reply(JSON.stringify({ facts }));
        return;
      }
      yield* reply("Got it.");
    },
  };
  return p;
}

async function waitFor<T>(read: () => Promise<T | undefined> | T | undefined, ms = 3_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("owner-data change records (Gateway)", () => {
  it("records the USER.md profile update with its thread, turn and diff, and the owner's own edits", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-change-records-"));
    composed = await composeGateway({
      logger: silentLogger,
      retentionIntervalMs: 0,
      background: false,
      config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
      model: { provider: scripted(), model: "scripted/main", utilityModel: "scripted/utility" },
    });
    const gw = composed;
    const owner = await adminClient(gw.gateway);
    clients.push(owner);
    const { thread } = await owner.call<{ thread: { id: string } }>(
      "threads.create",
      { kind: "main" },
      ik(),
    );
    await owner.call(
      "chat.send",
      { threadId: thread.id, content: "I'm Avery, I prefer tea." },
      ik(),
    );
    await gw.gateway.context.sessions.idle();
    const list = (params: Record<string, unknown> = {}) =>
      owner.call<{ changes: AuditChange[] }>("audit.changes", params, ik());
    const learned = await waitFor(async () => {
      const { changes } = await list({ threadId: thread.id });
      return changes.find((c) => c.target.path === "USER.md");
    });
    expect(learned).toMatchObject({
      actor: { type: "job", name: "profile-learning" },
      category: "memory",
      threadId: thread.id,
      action: "update",
      hasDiff: true,
    });
    expect(learned.runId).toBeTruthy();
    expect(learned.beforeSha256).toMatch(/^sha256:/);
    expect(learned.afterSha256).not.toBe(learned.beforeSha256);
    const detail = await owner.call<{ diff?: string }>("audit.change", { seq: learned.seq }, ik());
    expect(detail.diff).toContain("+");
    expect(detail.diff).toContain("Prefers tea over coffee");

    // The owner edits a file in the editor and changes a setting.
    const file = await gw.memory.readFile("USER.md");
    await owner.call(
      "memory.write",
      { path: "USER.md", content: `${file?.content}\n- Likes jazz\n`, etag: file?.etag },
      ik(),
    );
    await owner.call("settings.set", { key: "ui.test", value: { token: "s3cret-value" } }, ik());
    const all = (await list()).changes;
    const edit = all.find((c) => c.actor.type === "owner" && c.target.path === "USER.md");
    expect(edit).toMatchObject({ category: "memory", hasDiff: true });
    const setting = all.find((c) => c.category === "setting");
    expect(setting).toMatchObject({ target: { object: "ui.test" }, hasDiff: false });
    expect(JSON.stringify(all)).not.toContain("s3cret-value");

    // Filtering by type.
    expect(
      (await list({ categories: ["setting"] })).changes.every((c) => c.category === "setting"),
    ).toBe(true);
    expect((await list({ categories: ["file"] })).changes).toHaveLength(0);
    expect(
      (await list({ threadId: thread.id })).changes.every((c) => c.threadId === thread.id),
    ).toBe(true);

    // Export carries the chain status.
    const md = await owner.call<{ data: string; verified: boolean }>(
      "audit.changesExport",
      { format: "markdown" },
      ik(),
    );
    expect(md.verified).toBe(true);
    expect(md.data).toContain("USER.md");
    expect(md.data).toContain("```diff");
    const json = await owner.call<{ data: string }>(
      "audit.changesExport",
      { format: "json" },
      ik(),
    );
    expect(JSON.parse(json.data).changes.length).toBe(all.length);

    // Verify passes, and fails once a stored record is edited on disk.
    expect(await owner.call("audit.verify", {}, ik())).toMatchObject({ ok: true });
    const dir = join(home, "audit");
    const month = readdirSync(dir).find((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)) ?? "";
    const path = join(dir, month);
    writeFileSync(path, readFileSync(path, "utf8").replace('"profile-learning"', '"someone-else"'));
    expect(await owner.call("audit.verify", {}, ik())).toMatchObject({ ok: false });
  }, 30_000);
});

describe("toolEffectChange", () => {
  const base = { threadId: "t", runId: "r", toolCallId: "c", outcome: "ok" as const, summary: "s" };
  it("classifies commands, skills and connector writes", () => {
    expect(
      toolEffectChange({
        ...base,
        tool: "exec_host",
        kind: "exec_host",
        target: { kind: "command", value: "ls -la" },
      }),
    ).toMatchObject({ category: "command", target: { path: "ls -la" }, threadId: "t", runId: "r" });
    expect(
      toolEffectChange({ ...base, tool: "skill_create", kind: "skill_install" }),
    ).toMatchObject({
      category: "skill",
    });
    expect(
      toolEffectChange({ ...base, tool: "notes_create", kind: "notes.create", approvalId: "ap_1" }),
    ).toMatchObject({
      category: "connector",
      target: { connector: "notes" },
      action: "create",
      approvalId: "ap_1",
    });
  });
  it("leaves file and memory tools to their own richer records", () => {
    expect(toolEffectChange({ ...base, tool: "write_file", kind: "file_write" })).toBeUndefined();
    expect(toolEffectChange({ ...base, tool: "memory", kind: "memory" })).toBeUndefined();
  });
});
