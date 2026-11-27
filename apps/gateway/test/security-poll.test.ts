import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type PsycheDb } from "@psyche/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SecurityRecoveries } from "../src/security/recoveries.ts";
import { StateSeal } from "../src/security/state-seal.ts";

/** The 1 Hz security poll: no write and no inbox read on a quiet tick, same-tick pickup of a CLI insert. */

let home = "";
let dbPath = "";
const open: PsycheDb[] = [];
let clock = Date.parse("2026-01-01T00:00:00Z");
const DELAY = 5_000;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "psyche-poll-"));
  dbPath = join(home, "psyche.sqlite");
  clock = Date.parse("2026-01-01T00:00:00Z");
});
afterEach(() => {
  for (const d of open.splice(0)) d.close();
  rmSync(home, { recursive: true, force: true });
});

async function setup() {
  const d = openDb(dbPath);
  open.push(d);
  const seal = await StateSeal.open(d, { home });
  const rec = new SecurityRecoveries({
    db: d,
    seal,
    now: () => new Date(clock),
    delayMs: DELAY,
    presence: { state: () => "unavailable", forget: () => undefined },
  });
  const sqls: string[] = [];
  const real = d.sqlite.prepare.bind(d.sqlite);
  d.sqlite.prepare = ((sql: string) => {
    sqls.push(sql);
    return real(sql);
  }) as typeof d.sqlite.prepare;
  return { d, seal, rec, sqls };
}

/** What the CLI does: a second connection inserts a request row. */
function cliInsert(id: string): void {
  const f = openDb(dbPath, { migrate: false });
  try {
    const at = new Date(clock).toISOString();
    f.sqlite
      .prepare(
        "INSERT INTO security_requests (id, op, params, status, created_at, updated_at) VALUES (?, 'presence.reset', '{}', 'new', ?, ?)",
      )
      .run(id, at, at);
  } finally {
    f.close();
  }
}

describe("security poll tick", () => {
  it("a CLI-style insert is processed on the next tick", async () => {
    const { d, rec } = await setup();
    rec.tick();
    cliInsert("r1");
    rec.tick();
    const row = d.sqlite.prepare("SELECT status FROM security_requests WHERE id='r1'").get() as {
      status: string;
    };
    expect(row.status).not.toBe("new");
  });

  it("a quiet tick runs no DELETE and no inbox SELECT", async () => {
    const { rec, sqls } = await setup();
    rec.tick();
    sqls.length = 0;
    clock += 1000;
    rec.tick();
    clock += 1000;
    rec.tick();
    expect(sqls.filter((s) => /security_requests|DELETE|UPDATE|INSERT/.test(s))).toEqual([]);
  });

  it("the backstop rescans after 30 s and the prune runs hourly, not every tick", async () => {
    const { rec, sqls } = await setup();
    rec.tick();
    sqls.length = 0;
    clock += 31_000;
    rec.tick();
    expect(sqls.some((s) => /FROM security_requests WHERE status = 'new'/.test(s))).toBe(true);
    expect(sqls.some((s) => /DELETE FROM security_requests/.test(s))).toBe(false);
    sqls.length = 0;
    clock += 60 * 60 * 1000;
    rec.tick();
    expect(sqls.some((s) => /DELETE FROM security_requests/.test(s))).toBe(true);
  });

  it("a due recovery applies on the tick after not_before, not earlier", async () => {
    const { d, rec } = await setup();
    cliInsert("r2");
    rec.tick();
    expect(rec.waitingCount()).toBe(1);
    clock += DELAY - 1;
    rec.tick();
    expect(rec.waitingCount()).toBe(1);
    clock += 2;
    rec.tick();
    expect(rec.waitingCount()).toBe(0);
    const s = d.sqlite.prepare("SELECT status FROM security_recoveries").get() as {
      status: string;
    };
    expect(s.status).toBe("applied");
  });
});
