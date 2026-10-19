import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { extractAndVerify } from "@psyche/backup";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { composeBackup } from "../src/compose/backup.ts";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { silentLogger } from "../src/log.ts";
import { adminClient, desktopClient, ik, type TestClient } from "./helpers.ts";

/**
 * `backup.*` and `logs.tail` on the real composed Gateway: archives are written while the
 * Gateway keeps running (SQLite online backup), verified, listed and deleted; scopes follow the
 * protocol; log lines are redacted.
 */

let composed: ComposedGateway | null = null;
let home = "";
const clients: TestClient[] = [];
const PASS = "correct horse battery staple";

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

async function setup(): Promise<ComposedGateway> {
  home = mkdtempSync(join(tmpdir(), "psyche-bk-"));
  composed = await composeGateway({
    env: {},
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, webRoot: null },
    model: { provider: new FakeModelProvider(), model: "fake/model" },
    parts: [(s) => composeBackup(s)],
  });
  mkdirSync(join(home, "workspace"), { recursive: true });
  writeFileSync(join(home, "workspace", "MEMORY.md"), "# Memory\n");
  return composed;
}

interface Info {
  file: string;
  encrypted: boolean;
  verifiedAt: string | null;
  bytes: number;
}

describe("backup.* on the running Gateway", () => {
  it("creates a consistent archive without stopping, then lists, verifies and deletes it", async () => {
    const c = await setup();
    const admin = await adminClient(c.gateway);
    clients.push(admin);
    // Something to find in the snapshot: a setting written through the API.
    await admin.call("settings.set", { key: "appearance.theme", value: "dark" }, ik());

    const created = await admin.call<{ backup: Info; files: number }>(
      "backup.create",
      { passphrase: PASS },
      ik(),
    );
    expect(created.backup).toMatchObject({ encrypted: true, verifiedAt: null });
    expect(created.backup.file).toMatch(/^psyche-.*\.tar\.gz\.age$/);
    expect(created.files).toBeGreaterThanOrEqual(2);
    // The Gateway is still serving.
    expect(await admin.call("settings.get", { keys: ["appearance.theme"] })).toMatchObject({
      settings: { "appearance.theme": "dark" },
    });

    // The archived database is a complete SQLite file holding the setting.
    const archive = join(home, "backups", created.backup.file);
    const { dir, problems } = await extractAndVerify(
      archive,
      { kind: "passphrase", passphrase: PASS },
      home,
    );
    expect(problems).toEqual([]);
    const db = new DatabaseSync(join(dir, "state", "psyche.sqlite"), { readOnly: true });
    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    db.close();
    rmSync(dir, { recursive: true, force: true });

    const list = await admin.call<{ backups: Info[]; dir: string }>("backup.list", {});
    expect(list.dir).toBe(join(home, "backups"));
    expect(list.backups.map((b) => b.file)).toEqual([created.backup.file]);

    const bad = await admin.request("backup.verify", {
      file: created.backup.file,
      passphrase: "wrong passphrase",
    });
    expect(bad).toMatchObject({ ok: false, error: { code: "invalid_params" } });
    const verified = await admin.call<{ ok: boolean; problems: string[]; backup: Info }>(
      "backup.verify",
      {
        file: created.backup.file,
        passphrase: PASS,
      },
    );
    expect(verified).toMatchObject({ ok: true, problems: [] });
    expect(verified.backup.verifiedAt).not.toBeNull();

    expect(await admin.call("backup.delete", { file: created.backup.file }, ik())).toEqual({
      ok: true,
    });
    expect((await admin.call<{ backups: Info[] }>("backup.list", {})).backups).toEqual([]);
  });

  it("refuses to create without an encryption choice, and allows an explicit unencrypted archive", async () => {
    const c = await setup();
    const admin = await adminClient(c.gateway);
    clients.push(admin);
    expect(await admin.request("backup.create", {}, ik())).toMatchObject({
      ok: false,
      error: { code: "invalid_params" },
    });
    const plain = await admin.call<{ backup: Info }>("backup.create", { unencrypted: true }, ik());
    expect(plain.backup).toMatchObject({ encrypted: false });
    expect(plain.backup.file).toMatch(/\.tar\.gz$/);
    expect(await admin.call("backup.verify", { file: plain.backup.file })).toMatchObject({
      ok: true,
    });
    // An encrypted archive needs its passphrase.
    const enc = await admin.call<{ backup: Info }>("backup.create", { passphrase: PASS }, ik());
    expect(await admin.request("backup.verify", { file: enc.backup.file })).toMatchObject({
      ok: false,
      error: { code: "invalid_params" },
    });
  });

  it("addresses archives by file name only", async () => {
    const c = await setup();
    const admin = await adminClient(c.gateway);
    clients.push(admin);
    for (const file of ["../state/psyche.sqlite", "psyche-x.tar.gz/../../y", "config.json"]) {
      const r = await admin.request("backup.delete", { file }, ik());
      expect(r).toMatchObject({ ok: false });
    }
    expect(
      await admin.request("backup.delete", { file: "psyche-none.tar.gz" }, ik()),
    ).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });

  it("needs operator.admin to create, verify and delete; operator.read lists", async () => {
    const c = await setup();
    const desk = await desktopClient(c.gateway);
    clients.push(desk);
    expect(await desk.call("backup.list", {})).toMatchObject({ backups: [] });
    for (const [method, params] of [
      ["backup.create", { unencrypted: true }],
      ["backup.verify", { file: "psyche-a.tar.gz" }],
      ["backup.delete", { file: "psyche-a.tar.gz" }],
    ] as const) {
      expect(await desk.request(method, params, ik())).toMatchObject({
        ok: false,
        error: { code: "forbidden" },
      });
    }
  });
});

describe("logs.tail", () => {
  it("returns filtered, redacted lines oldest first with the subsystems seen", async () => {
    const c = await setup();
    mkdirSync(join(home, "logs"), { recursive: true });
    const secretish = `sk-${"ant-api03-"}${"A".repeat(40)}`;
    const lines = [
      { ts: "2026-10-19T10:00:00.000Z", level: "debug", msg: "tick", subsystem: "scheduler" },
      {
        ts: "2026-10-19T10:00:01.000Z",
        level: "info",
        msg: "gateway listening",
        origin: "http://127.0.0.1:7979",
      },
      {
        ts: "2026-10-19T10:00:02.000Z",
        level: "warn",
        msg: "provider error",
        subsystem: "agent",
        answerToken: "tok_live_123",
        detail: secretish,
      },
      "not json",
      {
        ts: "2026-10-19T10:00:03.000Z",
        level: "error",
        msg: `leaked ${secretish}`,
        subsystem: "agent",
      },
    ];
    writeFileSync(
      join(home, "logs", "gateway.err.log"),
      `${lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n")}\n`,
    );
    const desk = await desktopClient(c.gateway);
    clients.push(desk);

    const all = await desk.call<{
      lines: { msg: string; level: string; fields?: Record<string, unknown> }[];
      subsystems: string[];
      truncated: boolean;
    }>("logs.tail", {});
    expect(all.lines.map((l) => l.msg.split(" ")[0])).toEqual([
      "tick",
      "gateway",
      "provider",
      "leaked",
    ]);
    expect(all.subsystems).toEqual(["agent", "scheduler"]);
    expect(all.truncated).toBe(false);
    const text = JSON.stringify(all);
    expect(text).not.toContain("tok_live_123");
    expect(text).not.toContain(secretish);

    const warn = await desk.call<{ lines: { level: string }[] }>("logs.tail", {
      level: "warn",
      subsystem: "agent",
    });
    expect(warn.lines.map((l) => l.level)).toEqual(["warn", "error"]);
    const last = await desk.call<{ lines: unknown[]; truncated: boolean }>("logs.tail", {
      lines: 1,
    });
    expect(last).toMatchObject({ truncated: true });
    expect(last.lines).toHaveLength(1);
    const found = await desk.call<{ lines: { msg: string }[] }>("logs.tail", {
      search: "LISTENING",
    });
    expect(found.lines.map((l) => l.msg)).toEqual(["gateway listening"]);
    const since = await desk.call<{ lines: unknown[] }>("logs.tail", {
      since: "2026-10-19T10:00:02.000Z",
    });
    expect(since.lines).toHaveLength(2);
  });

  it("answers an empty list when there are no log files (Docker logs to stdout)", async () => {
    const c = await setup();
    const desk = await desktopClient(c.gateway);
    clients.push(desk);
    expect(await desk.call("logs.tail", {})).toEqual({
      lines: [],
      subsystems: [],
      truncated: false,
    });
  });
});
