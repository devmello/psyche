import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  ChangeRecorder,
  changesToMarkdown,
  createAuditLog,
  diffFromEntry,
  FileAuditStore,
  listChanges,
  unifiedDiff,
} from "../src/index.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(redact?: (t: string) => string) {
  const dir = mkdtempSync(join(tmpdir(), "psyche-changes-"));
  dirs.push(dir);
  const log = createAuditLog({
    clock: new FakeClock(Date.UTC(2026, 9, 28, 12)),
    store: new FileAuditStore(join(dir, "audit"), { fsync: false }),
  });
  return { dir, log, rec: new ChangeRecorder({ log, ...(redact ? { redact } : {}) }) };
}

describe("unifiedDiff", () => {
  it("shows added and removed lines with context", () => {
    const d = unifiedDiff("a\nb\nc\nd", "a\nb\nX\nd", "USER.md");
    expect(d.added).toBe(1);
    expect(d.removed).toBe(1);
    expect(d.diff).toContain("-c");
    expect(d.diff).toContain("+X");
    expect(d.diff).toContain("--- a/USER.md");
  });
  it("is empty for equal text", () => {
    expect(unifiedDiff("x", "x").diff).toBe("");
  });
});

describe("ChangeRecorder", () => {
  it("stores a thread-linked record with hashes and a compressed diff", async () => {
    const { log, rec } = setup();
    await rec.record({
      actor: { type: "job", name: "profile-learning" },
      category: "memory",
      threadId: "thr_1",
      runId: "run_1",
      tool: "profile-learning",
      target: { path: "USER.md" },
      action: "update",
      before: "# User\n",
      after: "# User\n- likes tea\n",
    });
    const [item] = await listChanges(log, { threadId: "thr_1" });
    expect(item?.record).toMatchObject({
      actor: { type: "job", name: "profile-learning" },
      threadId: "thr_1",
      runId: "run_1",
      target: { path: "USER.md" },
      hasDiff: true,
      stats: { added: 1, removed: 0 },
    });
    expect(item?.record.beforeSha256).toMatch(/^sha256:/);
    expect(item?.record.afterSha256).not.toBe(item?.record.beforeSha256);
    expect(diffFromEntry(item!.entry)).toContain("+- likes tea");
    expect(await log.verify()).toMatchObject({ ok: true });
  });

  it("filters by category and thread", async () => {
    const { log, rec } = setup();
    await rec.record({
      actor: { type: "agent" },
      category: "file",
      threadId: "a",
      tool: "write_file",
      target: { path: "/x" },
      action: "create",
      after: "1",
    });
    await rec.record({
      actor: { type: "agent" },
      category: "command",
      threadId: "b",
      tool: "exec_host",
      target: { path: "ls" },
      action: "exec",
    });
    expect(await listChanges(log, { categories: ["command"] })).toHaveLength(1);
    expect(await listChanges(log, { threadId: "a" })).toHaveLength(1);
    expect(await listChanges(log, {})).toHaveLength(2);
  });

  it("keeps hashes and size only for binary or large content", async () => {
    const { log, rec } = setup();
    await rec.record({
      actor: { type: "agent" },
      category: "file",
      tool: "write_file",
      target: { path: "/b.bin" },
      action: "create",
      after: new Uint8Array([0, 1, 2]),
    });
    await rec.record({
      actor: { type: "agent" },
      category: "file",
      tool: "write_file",
      target: { path: "/big.txt" },
      action: "create",
      after: "x".repeat(600_000),
    });
    const items = await listChanges(log, {});
    expect(items.map((i) => i.record.hasDiff)).toEqual([false, false]);
    expect(items.map((i) => i.record.bytes).sort()).toEqual([3, 600_000]);
  });

  it("caps the stored diff", async () => {
    const { log, rec } = setup();
    const after = Array.from(
      { length: 5_000 },
      (_, i) => `line number ${i} with some padding text`,
    ).join("\n");
    await rec.record({
      actor: { type: "agent" },
      category: "file",
      tool: "write_file",
      target: { path: "/c.txt" },
      action: "create",
      after,
    });
    const [item] = await listChanges(log, {});
    expect(item?.record.diffTruncated).toBe(true);
    expect(diffFromEntry(item!.entry)!.length).toBeLessThan(70_000);
  });

  it("redacts secrets and vault values in diffs and targets", async () => {
    const { dir, log, rec } = setup((t) => t.replaceAll("hunter2-vault-value", "•••"));
    await rec.record({
      actor: { type: "agent" },
      category: "file",
      tool: "write_file",
      target: { path: "/notes.txt" },
      action: "create",
      after: "pw hunter2-vault-value\ncard 4242 4242 4242 4242\n",
    });
    const [item] = await listChanges(log, {});
    const diff = diffFromEntry(item!.entry)!;
    expect(diff).not.toContain("hunter2");
    expect(diff).not.toContain("4242 4242");
    expect(diff).toContain("•••");
    const files = readdirSync(join(dir, "audit")).filter(
      (f) => f.endsWith(".jsonl") && f !== "anchors.jsonl",
    );
    for (const f of files)
      expect(readFileSync(join(dir, "audit", f), "utf8")).not.toContain("hunter2");
  });

  it("verification fails when a stored record is tampered with", async () => {
    const { dir, log, rec } = setup();
    await rec.record({
      actor: { type: "agent" },
      category: "file",
      tool: "write_file",
      target: { path: "/a.txt" },
      action: "create",
      after: "hello",
    });
    await rec.record({
      actor: { type: "agent" },
      category: "file",
      tool: "write_file",
      target: { path: "/b.txt" },
      action: "create",
      after: "world",
    });
    expect((await log.verifyDetailed()).ok).toBe(true);
    const file = readdirSync(join(dir, "audit")).find((f) => /^\d{4}-\d{2}\.jsonl$/.test(f))!;
    const path = join(dir, "audit", file);
    writeFileSync(path, readFileSync(path, "utf8").replace("/a.txt", "/z.txt"));
    const r = await createAuditLog({
      clock: new FakeClock(0),
      store: new FileAuditStore(join(dir, "audit"), { fsync: false }),
    }).verifyDetailed();
    expect(r.ok).toBe(false);
  });

  it("exports Markdown with the chain status and diffs", async () => {
    const { log, rec } = setup();
    await rec.record({
      actor: { type: "owner" },
      category: "memory",
      tool: "memory.write",
      target: { path: "USER.md" },
      action: "update",
      before: "a",
      after: "b",
    });
    const md = changesToMarkdown(await listChanges(log, {}), { ok: true, count: 1 });
    expect(md).toContain("verified");
    expect(md).toContain("```diff");
    expect(md).toContain("USER.md");
  });

  it("never throws when the log fails", async () => {
    const errors: unknown[] = [];
    const rec = new ChangeRecorder({
      log: {
        append: async () => {
          throw new Error("disk full");
        },
      },
      onError: (e) => errors.push(e),
    });
    await expect(
      rec.record({
        actor: { type: "agent" },
        category: "file",
        tool: "t",
        target: {},
        action: "a",
      }),
    ).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });
});
