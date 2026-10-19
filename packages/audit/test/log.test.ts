import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUDIT_GENESIS_HASH } from "@psyche/protocol";
import { FakeClock } from "@psyche/testing";
import { describeAuditLogConformance } from "@psyche/testing/conformance";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AnchorSigner,
  type AnchorVerifier,
  createAuditLog,
  FileAuditStore,
  MemoryAuditStore,
  sha256,
} from "../src/index.ts";

describeAuditLogConformance("HashChainAuditLog (memory)", ({ clock }) => createAuditLog({ clock }));

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "psyche-audit-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describeAuditLogConformance("HashChainAuditLog (files)", ({ clock }) =>
  createAuditLog({ clock, store: new FileAuditStore(join(tempDir(), "audit"), { fsync: false }) }),
);

const actor = { type: "agent" as const, runId: "run_1" };

describe("file store", () => {
  it("writes one JSONL file per month with 0600 files in a 0700 directory", async () => {
    const dir = join(tempDir(), "audit");
    const clock = new FakeClock(Date.UTC(2026, 9, 31, 23, 59, 0));
    const log = createAuditLog({ clock, dir });
    await log.append({ kind: "thread.created", actor, data: { n: 1 } });
    clock.advance(120_000); // into November
    const nov = await log.append({ kind: "thread.created", actor, data: { n: 2 } });
    expect(readdirSync(dir).sort()).toEqual(["2026-10.jsonl", "2026-11.jsonl"]);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "2026-10.jsonl")).mode & 0o777).toBe(0o600);
    // The first entry of a month carries the previous month's last hash.
    const oct = JSON.parse(readFileSync(join(dir, "2026-10.jsonl"), "utf8").trim());
    expect(nov.prev).toBe(oct.hash);
    expect(await log.verify()).toEqual({ ok: true, count: 2 });
  });

  it("continues the chain after a restart", async () => {
    const dir = join(tempDir(), "audit");
    const clock = new FakeClock();
    const a = createAuditLog({ clock, dir });
    const first = await a.append({ kind: "thread.created", actor, data: {} });
    const b = createAuditLog({ clock, dir });
    const second = await b.append({ kind: "thread.created", actor, data: {} });
    expect(second.seq).toBe(1);
    expect(second.prev).toBe(first.hash);
    expect(await b.verify()).toEqual({ ok: true, count: 2 });
  });

  it("never lets ts run backwards when the wall clock does", async () => {
    let now = Date.UTC(2026, 10, 1, 0, 0, 1);
    const log = createAuditLog({ clock: { now: () => now }, dir: join(tempDir(), "audit") });
    const a = await log.append({ kind: "thread.created", actor, data: {} });
    now -= 60_000;
    const b = await log.append({ kind: "thread.created", actor, data: {} });
    expect(Date.parse(b.ts)).toBeGreaterThanOrEqual(Date.parse(a.ts));
    expect(await log.verify()).toEqual({ ok: true, count: 2 });
  });

  it("starts a torn last line's successor on its own line, and verify reports the torn line", async () => {
    const dir = join(tempDir(), "audit");
    const clock = new FakeClock();
    const log = createAuditLog({ clock, dir });
    await log.append({ kind: "thread.created", actor, data: {} });
    const file = join(dir, readdirSync(dir)[0] ?? "");
    writeFileSync(file, `${readFileSync(file, "utf8")}{"seq":1,"ts":"2026-`, { flag: "w" });
    const reopened = createAuditLog({ clock, dir });
    const next = await reopened.append({ kind: "thread.created", actor, data: {} });
    expect(next.seq).toBe(1);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    const v = await reopened.verifyDetailed();
    expect(v).toMatchObject({ ok: false, reason: "unparsable", brokenAtSeq: 1, line: 2 });
  });
});

describe("tamper detection", () => {
  async function seeded(n = 5) {
    const store = new MemoryAuditStore();
    const log = createAuditLog({ clock: new FakeClock(), store });
    for (let i = 0; i < n; i += 1) {
      await log.append({
        kind: "tool_call.decided",
        actor,
        subject: { toolCallId: `c${i}` },
        data: { i },
      });
    }
    return { store, log };
  }

  it("detects an edited field", async () => {
    const { store, log } = await seeded();
    const e = JSON.parse(store.lines[2] ?? "");
    e.data.i = 99;
    store.lines[2] = JSON.stringify(e);
    expect(await log.verify()).toEqual({ ok: false, brokenAtSeq: 2, reason: "hash_mismatch" });
  });

  it("detects an edited entry whose hash was recomputed (the next prev breaks)", async () => {
    const { store, log } = await seeded();
    const e = JSON.parse(store.lines[2] ?? "");
    e.data.i = 99;
    const { hash: _h, ...rest } = e;
    const { canonicalJSON } = await import("../src/index.ts");
    e.hash = sha256(canonicalJSON(rest));
    store.lines[2] = JSON.stringify(e);
    expect(await log.verify()).toEqual({ ok: false, brokenAtSeq: 3, reason: "prev_mismatch" });
  });

  it("detects a deleted entry", async () => {
    const { store, log } = await seeded();
    store.lines.splice(1, 1);
    expect(await log.verify()).toMatchObject({ ok: false, brokenAtSeq: 1, reason: "seq_gap" });
  });

  it("detects reordered entries", async () => {
    const { store, log } = await seeded();
    const [a, b] = [store.lines[1] ?? "", store.lines[2] ?? ""];
    store.lines[1] = b;
    store.lines[2] = a;
    expect((await log.verify()).ok).toBe(false);
  });

  it("detects a replaced genesis", async () => {
    const { store, log } = await seeded(1);
    const e = JSON.parse(store.lines[0] ?? "");
    expect(e.prev).toBe(AUDIT_GENESIS_HASH);
    e.prev = sha256("forged");
    store.lines[0] = JSON.stringify(e);
    expect(await log.verify()).toEqual({ ok: false, brokenAtSeq: 0, reason: "prev_mismatch" });
  });

  it("detects tampering in a month file on disk", async () => {
    const dir = join(tempDir(), "audit");
    const log = createAuditLog({ clock: new FakeClock(), dir });
    await log.append({ kind: "approval.decided", actor, data: { decision: "deny" } });
    await log.append({ kind: "approval.decided", actor, data: { decision: "deny" } });
    const file = join(dir, readdirSync(dir)[0] ?? "");
    writeFileSync(file, readFileSync(file, "utf8").replace('"deny"', '"allow"'));
    expect(await log.verify()).toEqual({ ok: false, brokenAtSeq: 0, reason: "hash_mismatch" });
  });
});

describe("anchors", () => {
  const signer: AnchorSigner = { keyId: "k1", sign: (m) => sha256(`k1|${m}`) };
  const verifier: AnchorVerifier = { verify: (k, m, s) => s === sha256(`${k}|${m}`) };

  it("signs an anchor every N entries and detects tail truncation", async () => {
    const store = new MemoryAuditStore();
    const log = createAuditLog({ clock: new FakeClock(), store, signer, verifier, anchorEvery: 3 });
    for (let i = 0; i < 7; i += 1) await log.append({ kind: "thread.created", actor, data: { i } });
    expect(store.anchorList.map((a) => a.seq)).toEqual([2, 5]);
    expect(await log.verifyDetailed()).toMatchObject({ ok: true, count: 7, anchors: 2 });
    store.lines.splice(4); // drop seq 4..6: still a valid chain, but anchor 5 is gone
    expect(await log.verifyDetailed()).toMatchObject({
      ok: false,
      reason: "truncated",
      brokenAtSeq: 4,
    });
    expect(await log.verify()).toMatchObject({ ok: false, reason: "seq_gap" });
  });

  it("rejects a forged anchor signature", async () => {
    const store = new MemoryAuditStore();
    const log = createAuditLog({ clock: new FakeClock(), store, signer, verifier, anchorEvery: 2 });
    for (let i = 0; i < 2; i += 1) await log.append({ kind: "thread.created", actor, data: { i } });
    const a = store.anchorList[0];
    if (a !== undefined) a.signature = "forged";
    expect(await log.verifyDetailed()).toMatchObject({
      ok: false,
      reason: "anchor_signature",
      brokenAtSeq: 1,
    });
  });
});

describe("query and export", () => {
  it("filters by kind prefix, subject, actor, time and order", async () => {
    const clock = new FakeClock();
    const log = createAuditLog({ clock });
    await log.append({ kind: "approval.created", actor, subject: { taskId: "t1" }, data: {} });
    clock.advance(1000);
    await log.append({
      kind: "grant.created",
      actor: { type: "device", deviceId: "dev_1" },
      subject: { taskId: "t2" },
      data: {},
    });
    clock.advance(1000);
    await log.append({
      kind: "approval.decided",
      actor: { type: "device", deviceId: "dev_1" },
      subject: { taskId: "t1" },
      data: {},
    });
    expect((await log.query({ kindPrefix: "approval." })).map((e) => e.seq)).toEqual([0, 2]);
    expect((await log.query({ subject: { taskId: "t1" } })).map((e) => e.seq)).toEqual([0, 2]);
    expect((await log.query({ deviceId: "dev_1" })).map((e) => e.seq)).toEqual([1, 2]);
    expect((await log.query({ since: clock.iso(-1500) })).map((e) => e.seq)).toEqual([1, 2]);
    expect((await log.query({ until: clock.iso(-1500) })).map((e) => e.seq)).toEqual([0]);
    expect((await log.query({ order: "desc", limit: 2 })).map((e) => e.seq)).toEqual([2, 1]);
    expect((await log.query({ kinds: ["grant.created"] })).map((e) => e.seq)).toEqual([1]);
    const jsonl = await log.export({ kindPrefix: "approval." });
    expect(
      jsonl
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l).seq),
    ).toEqual([0, 2]);
    expect(JSON.parse(await log.export({ format: "json" }))).toHaveLength(3);
  });

  it("notifies subscribers after the entry is durable", async () => {
    const log = createAuditLog({ clock: new FakeClock() });
    const seen: number[] = [];
    const off = log.subscribe((e) => seen.push(e.seq));
    await log.append({ kind: "thread.created", actor, data: {} });
    off();
    await log.append({ kind: "thread.created", actor, data: {} });
    expect(seen).toEqual([0]);
  });

  it("serializes concurrent appends into one chain", async () => {
    const log = createAuditLog({ clock: new FakeClock() });
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        log.append({ kind: "thread.created", actor, data: { i } }),
      ),
    );
    expect(await log.verify()).toEqual({ ok: true, count: 20 });
  });

  it("refuses non-dotted kinds when kind validation is on", async () => {
    const log = createAuditLog({ clock: new FakeClock(), validateKinds: true });
    await expect(log.append({ kind: "Bad Kind", actor, data: {} })).rejects.toMatchObject({
      code: "invalid_params",
    });
  });
});

describe("redaction before hashing", () => {
  it("keeps secrets and bodies out of the stored line", async () => {
    const store = new MemoryAuditStore();
    const vaultValue = `hunter-${"2".repeat(8)}`;
    const log = createAuditLog({
      clock: new FakeClock(),
      store,
      redact: (t) => t.split(vaultValue).join("•••"),
    });
    const apiKey = `sk-ant-${"a".repeat(30)}`;
    await log.append({
      kind: "tool_call.finished",
      actor,
      data: {
        tool: "email.send",
        body: "Dear Alice, the code is 1234",
        answerToken: "at_secret",
        note: `token ${apiKey} and ${vaultValue}`,
        nested: { password: "pw", stdout: "lots of output" },
      },
    });
    const line = store.lines[0] ?? "";
    for (const leaked of [
      "Dear Alice",
      "at_secret",
      apiKey,
      vaultValue,
      '"pw"',
      "lots of output",
    ]) {
      expect(line).not.toContain(leaked);
    }
    const e = JSON.parse(line);
    expect(e.data.body).toMatchObject({ redacted: "content", bytes: 28 });
    expect(e.data.body.sha256).toBe(sha256("Dear Alice, the code is 1234"));
    expect(e.data.note).toContain("[redacted:api_key]");
    expect(e.data.note).toContain("•••");
    expect(await log.verify()).toEqual({ ok: true, count: 1 });
  });
});
