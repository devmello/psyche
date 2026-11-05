import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type PsycheDb } from "@psyche/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ALERT_RENOTIFY_MS,
  AlertBook,
  alertNotice,
  alertNotifyDecision,
  cleanLabel,
  cleanText,
} from "../src/security/alerts.ts";

/** Security alerts (security-state-integrity §7.3): coalescing, names, notifications. */

let home = "";
let db: PsycheDb;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "psyche-alerts-"));
  db = openDb(join(home, "state.sqlite"));
});

afterEach(() => {
  db.close();
  rmSync(home, { recursive: true, force: true });
});

describe("AlertBook", () => {
  it("keeps one open changed-outside alert and counts repeats", () => {
    const book = new AlertBook(db, () => new Date());
    const told: number[] = [];
    book.onAlert((a) => told.push(a.details.occurrences ?? 1));
    book.add("state_changed_outside", {
      changes: [{ table: "devices", change: "added", name: "a" }],
    });
    book.add("state_changed_outside", { changes: [{ table: "grants", change: "added" }] });
    const open = book.open();
    expect(open).toHaveLength(1);
    expect(open[0]?.details.occurrences).toBe(2);
    expect(open[0]?.details.changes).toHaveLength(2);
    expect(told).toEqual([1, 2]);
    expect(alertNotice(open[0] as never).body).toMatch(/2 security records .* 2 times so far/);
  });

  it("caps the listed changes and counts the rest", () => {
    const book = new AlertBook(db, () => new Date());
    const many = Array.from({ length: 30 }, (_, i) => ({
      table: "devices",
      change: "added" as const,
      name: `d${i}`,
    }));
    book.add("state_changed_outside", { changes: many });
    book.add("state_changed_outside", { changes: many.slice(0, 5) });
    const [a] = book.open();
    expect(a?.details.changes).toHaveLength(20);
    expect(a?.details.more).toBe(15);
  });

  it("cleans device names and reasons another program chose", () => {
    const book = new AlertBook(db, () => new Date());
    const a = book.add("local_first_admin", {
      deviceName: "Owner‮⁦'s iPhone\u0007",
      reason: "x\u001b[2Jy",
    });
    expect(a.details.deviceName).toBe("Owner's iPhone");
    expect(a.details.reason).toBe("x[2Jy");
  });
});

describe("cleanLabel / cleanText", () => {
  it("strips control, bidi, Arabic letter mark, Mongolian vowel separator and tag characters", () => {
    expect(cleanLabel("a؜b᠎c\u{e0041}d‏e")).toBe("abcde");
  });

  it("truncates by code point, never inside a surrogate pair", () => {
    const s = cleanLabel("😀".repeat(70));
    expect([...s]).toHaveLength(64);
    expect(s.endsWith("…")).toBe(true);
    expect(cleanText("x".repeat(400))).toHaveLength(300);
  });
});

describe("alertNotifyDecision", () => {
  it("sends the first time, breaking quiet hours only for a warning", () => {
    expect(alertNotifyDecision({ severity: "warning" }, null, 0)).toEqual({
      send: true,
      breakQuietHours: true,
    });
    expect(alertNotifyDecision({ severity: "info" }, null, 0)).toEqual({
      send: true,
      breakQuietHours: false,
    });
  });

  it("repeats at most every 10 minutes, never through quiet hours, from the stored time", () => {
    const at = "2026-11-05T10:00:00.000Z";
    const t = Date.parse(at);
    expect(alertNotifyDecision({ severity: "warning" }, at, t + 60_000).send).toBe(false);
    expect(alertNotifyDecision({ severity: "warning" }, at, t + ALERT_RENOTIFY_MS)).toEqual({
      send: true,
      breakQuietHours: false,
    });
  });

  it("notified_at is sealed state: it survives a new AlertBook (a restart)", () => {
    const book = new AlertBook(db, () => new Date("2026-11-05T10:00:00.000Z"));
    const a = book.add("state_untrusted", { reason: "ledger_mismatch" });
    book.markNotified(a.id);
    const again = new AlertBook(db, () => new Date());
    expect(again.notifiedAt(a.id)).toBe("2026-11-05T10:00:00.000Z");
  });
});
