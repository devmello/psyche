import { describe, expect, it } from "vitest";
import { createRun, createThread } from "../src/index.ts";
import { memoryDb } from "./helpers.ts";

describe("CHECK and FK constraints", () => {
  const db = memoryDb();
  const thread = createThread(db, { kind: "main", sessionKey: "owner:main" });
  const at = "2026-10-18T22:00:00.000Z";

  it.each([
    [
      "threads.kind",
      "INSERT INTO threads (id, kind, session_key, created_at, updated_at) VALUES ('t2', 'bogus', 's', ?, ?)",
    ],
    [
      "threads.permission_mode",
      "INSERT INTO threads (id, kind, session_key, permission_mode, created_at, updated_at) VALUES ('t3', 'main', 's', 'yolo', ?, ?)",
    ],
    [
      "devices.platform",
      "INSERT INTO devices (id, name, platform, role, public_key, created_at, updated_at) VALUES ('d', 'n', 'windows', 'client', x'00', ?, ?)",
    ],
    [
      "devices.scopes json",
      "INSERT INTO devices (id, name, platform, role, public_key, scopes, created_at, updated_at) VALUES ('d', 'n', 'macos', 'client', x'00', 'not json', ?, ?)",
    ],
    [
      "pairing_requests.status",
      "INSERT INTO pairing_requests (id, kind, code, display, status, expires_at, created_at, updated_at) VALUES ('p', 'device', 'c', 'd', 'maybe', 'x', ?, ?)",
    ],
    [
      "settings.value json",
      "INSERT INTO settings (key, value, created_at, updated_at) VALUES ('k', '{oops', ?, ?)",
    ],
  ])("rejects a bad %s", (_label, statement) => {
    expect(() => db.sqlite.prepare(statement).run(at, at)).toThrow(/CHECK constraint failed/);
  });

  it("rejects a bad message role and provenance", () => {
    const insert = db.sqlite.prepare(
      "INSERT INTO messages (id, thread_id, seq, role, blocks, provenance, created_at) VALUES (?, ?, ?, ?, '[]', ?, ?)",
    );
    expect(() => insert.run("m1", thread.id, 1, "assistant", "owner", at)).toThrow(/CHECK/);
    expect(() => insert.run("m2", thread.id, 2, "user", "web", at)).toThrow(/CHECK/);
    insert.run("m3", thread.id, 3, "user", "owner", at);
    expect(() => insert.run("m4", thread.id, 3, "user", "owner", at)).toThrow(/UNIQUE/);
  });

  it("rejects bad run and tool call enums", () => {
    const run = createRun(db, { threadId: thread.id, modelRef: "anthropic/claude-sonnet-5-5" });
    expect(() =>
      db.sqlite.prepare("UPDATE runs SET status = 'paused' WHERE id = ?").run(run.id),
    ).toThrow(/CHECK/);
    const insert = db.sqlite.prepare(
      "INSERT INTO tool_calls (id, run_id, tool, params_redacted, params_hash, side_effect, decision, provenance_out, started_at, status, created_at, updated_at) VALUES (?, ?, 'exec', '{}', 'h', ?, ?, 'trusted', ?, ?, ?, ?)",
    );
    expect(() => insert.run("c1", run.id, "write", "maybe", at, "ok", at, at)).toThrow(/CHECK/);
    expect(() => insert.run("c2", run.id, "write", "allow", at, "done", at, at)).toThrow(/CHECK/);
    expect(() => insert.run("c3", run.id, "spicy", "allow", at, "ok", at, at)).toThrow(/CHECK/);
    insert.run("c4", run.id, "write", "allow", at, "ok", at, at);
  });

  it("enforces foreign keys", () => {
    expect(() => createRun(db, { threadId: "missing", modelRef: "a/b" })).toThrow(/FOREIGN KEY/);
  });
});
