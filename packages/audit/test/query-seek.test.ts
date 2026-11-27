import {
  appendFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditEntry } from "@psyche/protocol";
import { FakeClock } from "@psyche/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

// Count reads of the audit month files.
const reads = vi.hoisted(() => ({ whole: 0, bytes: 0, enabled: false }));
vi.mock("node:fs", async (orig) => {
  const real = await orig<typeof import("node:fs")>();
  return {
    ...real,
    readFileSync: ((...a: Parameters<typeof real.readFileSync>) => {
      if (reads.enabled && String(a[0]).endsWith(".jsonl")) reads.whole += 1;
      return real.readFileSync(...a);
    }) as typeof real.readFileSync,
    readSync: ((...a: Parameters<typeof real.readSync>) => {
      const n = real.readSync(...a);
      if (reads.enabled) reads.bytes += n;
      return n;
    }) as typeof real.readSync,
  };
});

import {
  type AuditQuery,
  createAuditLog,
  FileAuditStore,
  type HashChainAuditLog,
  listChanges,
} from "../src/index.ts";

const dirs: string[] = [];
afterEach(() => {
  reads.enabled = false;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "psyche-audit-seek-"));
  dirs.push(d);
  return d;
}

/** The pre-G3 implementation: the oracle every new result must equal. */
function oldQuery(log: HashChainAuditLog, q: AuditQuery): AuditEntry[] {
  const kinds = q.kinds === undefined ? undefined : new Set(q.kinds);
  const since = q.since === undefined ? undefined : Date.parse(q.since);
  const until = q.until === undefined ? undefined : Date.parse(q.until);
  const out: AuditEntry[] = [];
  for (const line of log.store.entries()) {
    if (!line.ok) continue;
    const e = line.entry;
    if (q.kind !== undefined && e.kind !== q.kind) continue;
    if (kinds !== undefined && !kinds.has(e.kind)) continue;
    if (q.kindPrefix !== undefined && !e.kind.startsWith(q.kindPrefix)) continue;
    if (q.actorType !== undefined && e.actor.type !== q.actorType) continue;
    if (q.deviceId !== undefined && e.actor.deviceId !== q.deviceId) continue;
    if (q.runId !== undefined && e.actor.runId !== q.runId) continue;
    if (q.sinceSeq !== undefined && e.seq < q.sinceSeq) continue;
    if (q.untilSeq !== undefined && e.seq >= q.untilSeq) continue;
    const ts = Date.parse(e.ts);
    if (since !== undefined && ts < since) continue;
    if (until !== undefined && ts >= until) continue;
    if (q.subject !== undefined) {
      const subject = e.subject ?? {};
      if (Object.entries(q.subject).some(([k, v]) => subject[k] !== v)) continue;
    }
    if (q.where !== undefined && !q.where(e)) continue;
    out.push(e);
  }
  if (q.order === "desc") out.reverse();
  return out.slice(0, q.limit ?? Number.POSITIVE_INFINITY);
}

const KINDS = ["a.one", "a.two", "b.one", "change.applied"];
const STEP_MS = 1000 * 60 * 60 * 7;
async function fill(log: HashChainAuditLog, clock: FakeClock, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    clock.advance(STEP_MS); // about 7 h per entry: several months overall
    await log.append({
      kind: KINDS[i % KINDS.length] ?? "a.one",
      actor: { type: i % 3 === 0 ? "user" : "agent", runId: `run_${i % 5}`, deviceId: `d${i % 2}` },
      data: { i, note: "é".repeat(i % 7) },
      subject: { threadId: `t${i % 4}` },
    });
  }
}

function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

function size(dir: string): number {
  return readdirSync(dir).reduce((n, f) => n + readFileSync(join(dir, f)).length, 0);
}

const START = Date.UTC(2026, 0, 3);
function newLog(dir: string, clock: FakeClock): HashChainAuditLog {
  return createAuditLog({ clock, store: new FileAuditStore(dir, { fsync: false }) });
}

describe("audit query reads lazily and matches the old implementation", () => {
  it("random queries over a multi-month log equal the oracle", async () => {
    const dir = join(tempDir(), "audit");
    const clock = new FakeClock(START);
    const log = newLog(dir, clock);
    await fill(log, clock, 700);
    expect(readdirSync(dir).length).toBeGreaterThan(5);
    const r = rng(7);
    const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)] as T;
    const span = 700 * STEP_MS;
    for (let i = 0; i < 300; i += 1) {
      const q: AuditQuery = {};
      if (r() < 0.4) q.kind = pick(KINDS);
      if (r() < 0.2) q.kindPrefix = pick(["a.", "b.", "change"]);
      if (r() < 0.2) q.actorType = pick(["user", "agent"] as const);
      if (r() < 0.2) q.runId = `run_${Math.floor(r() * 5)}`;
      if (r() < 0.2) q.subject = { threadId: `t${Math.floor(r() * 4)}` };
      if (r() < 0.4) q.sinceSeq = Math.floor(r() * 750) - 20;
      if (r() < 0.4) q.untilSeq = Math.floor(r() * 750) - 20;
      if (r() < 0.3) q.since = new Date(START + r() * span).toISOString();
      if (r() < 0.3) q.until = new Date(START + r() * span).toISOString();
      if (r() < 0.6) q.limit = pick([0, 1, 2, 5, 50, 400]);
      if (r() < 0.6) q.order = pick(["asc", "desc"] as const);
      if (r() < 0.2) q.where = (e) => e.seq % 3 === 0;
      expect(await log.query(q), JSON.stringify(q)).toEqual(oldQuery(log, q));
    }
  });

  it("matches the oracle over a corrupt line, a blank line and a torn last line", async () => {
    const dir = join(tempDir(), "audit");
    const clock = new FakeClock(START);
    const log = newLog(dir, clock);
    await fill(log, clock, 200);
    const names = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .sort();
    const file = join(dir, names[2] as string);
    const lines = readFileSync(file, "utf8").split("\n");
    lines[3] = "{ not json";
    lines.splice(5, 0, "");
    writeFileSync(file, lines.join("\n").trimEnd()); // also drops the final newline
    appendFileSync(file, '\n{"seq":'); // a torn write
    const queries: AuditQuery[] = [
      {},
      { order: "desc" },
      { order: "desc", limit: 7 },
      { sinceSeq: 40, untilSeq: 120 },
      { sinceSeq: 40, untilSeq: 120, order: "desc", limit: 3 },
      { sinceSeq: 100, limit: 4 },
    ];
    for (const q of queries)
      expect(await log.query(q), JSON.stringify(q)).toEqual(oldQuery(log, q));
    // The corrupt line is still reported by the verifier, which reads every line.
    expect((await log.verifyDetailed()).ok).toBe(false);
  });

  it("matches the oracle on the in-memory store", async () => {
    const clock = new FakeClock(START);
    const mem = createAuditLog({ clock });
    await fill(mem, clock, 30);
    const q: AuditQuery = { order: "desc", limit: 4 };
    expect(await mem.query(q)).toEqual(oldQuery(mem, q));
  });

  it("a single seq lookup reads one small region, never a whole month file", async () => {
    const dir = join(tempDir(), "audit");
    const clock = new FakeClock(START);
    await fill(newLog(dir, clock), clock, 3000);
    const total = size(dir);
    const fresh = newLog(dir, clock);
    reads.whole = 0;
    reads.bytes = 0;
    reads.enabled = true;
    const [one] = await fresh.query({ sinceSeq: 1234, untilSeq: 1235 });
    reads.enabled = false;
    expect(one?.seq).toBe(1234);
    expect(reads.whole).toBe(0);
    expect(reads.bytes).toBeLessThan(total / 10);
    expect([one]).toEqual(oldQuery(fresh, { sinceSeq: 1234, untilSeq: 1235 }));
  });

  it("newest first with a limit reads only the tail of the newest month", async () => {
    const dir = join(tempDir(), "audit");
    const clock = new FakeClock(START);
    const log = newLog(dir, clock);
    await fill(log, clock, 3000);
    const total = size(dir);
    reads.bytes = 0;
    reads.whole = 0;
    reads.enabled = true;
    const got = await log.query({ order: "desc", limit: 5 });
    reads.enabled = false;
    expect(got.map((e) => e.seq)).toEqual([2999, 2998, 2997, 2996, 2995]);
    expect(reads.whole).toBe(0);
    expect(reads.bytes).toBeLessThan(total / 20);
  });

  it("listChanges gives the same items with the early stop as without it", async () => {
    const dir = join(tempDir(), "audit");
    const clock = new FakeClock(START);
    const log = newLog(dir, clock);
    for (let i = 0; i < 60; i += 1) {
      clock.advance(STEP_MS);
      await log.append({
        kind: i % 2 === 0 ? "change.applied" : "a.one",
        actor: { type: "agent", runId: "run_1" },
        data: { i },
        subject: { threadId: "t1" },
      });
    }
    const slow = {
      query: (q: AuditQuery) => log.query({ ...q, limit: undefined, where: undefined }),
    };
    for (const f of [{ limit: 10 }, { limit: 0 }, { limit: 500 }, { beforeSeq: 20, limit: 3 }]) {
      const a = await listChanges(log, f);
      const b = await listChanges(slow, f);
      expect(a.map((i) => i.entry.seq)).toEqual(b.map((i) => i.entry.seq));
    }
  });

  it("an append during a query neither breaks it nor shows up in it, across a month rollover", async () => {
    const dir = join(tempDir(), "audit");
    const clock = new FakeClock(START);
    const log = newLog(dir, clock);
    await fill(log, clock, 50);
    const iter = (log.store.entriesDesc?.() ?? [])[Symbol.iterator]();
    const first = iter.next();
    expect(first.done === false && first.value.ok && first.value.entry.seq).toBe(49);
    clock.advance(1000 * 60 * 60 * 24 * 40); // a new month file too
    await log.append({ kind: "a.one", actor: { type: "user" }, data: {} });
    await log.append({ kind: "a.one", actor: { type: "user" }, data: {} });
    const rest: number[] = [];
    for (let n = iter.next(); !n.done; n = iter.next())
      if (n.value.ok) rest.push(n.value.entry.seq);
    expect(rest[0]).toBe(48);
    expect(rest.length).toBe(49);
    expect((await log.query({ order: "desc", limit: 2 })).map((e) => e.seq)).toEqual([51, 50]);
    const q: AuditQuery = { sinceSeq: 49, untilSeq: 52 };
    expect(await log.query(q)).toEqual(oldQuery(log, q));
  });
});
