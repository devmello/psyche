import type { DailyFollowup } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import {
  FOLLOWUPS_MIGRATED_KEY,
  type FollowupLedgerSink,
  migrateFollowupsToLedger,
} from "../src/daily/followups.ts";
import { FOLLOWUPS_KEY, type KeyValue } from "../src/daily/settings.ts";

const item = (id: string, o: Partial<DailyFollowup> = {}): DailyFollowup => ({
  id,
  text: `do ${id}`,
  source: "sent_mail",
  status: "open",
  createdAt: "2026-11-10T10:00:00.000Z",
  ...o,
});

function kv(initial: Record<string, unknown> = {}): KeyValue & { data: Map<string, unknown> } {
  const data = new Map(Object.entries(initial));
  return { data, get: (k) => data.get(k), set: (k, v) => void data.set(k, v) };
}

/** A sink that remembers ids, as the ledger's dedupe key does. */
function sink(skip: string[] = []): FollowupLedgerSink & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    importFollowup(i) {
      if (skip.includes(i.id)) return "skipped";
      if (seen.includes(i.id)) return "exists";
      seen.push(i.id);
      return "added";
    },
  };
}

describe("daily.followups migration into the promise ledger", () => {
  it("moves every item, sets the marker, and leaves the old list in place", () => {
    const items = [
      item("a"),
      item("b", { status: "done" }),
      item("c", { source: "awaiting_reply" }),
    ];
    const store = kv({ [FOLLOWUPS_KEY]: items });
    const s = sink();
    expect(migrateFollowupsToLedger(store, s)).toEqual({
      alreadyMigrated: false,
      added: 3,
      existing: 0,
      skipped: 0,
    });
    expect(s.seen).toEqual(["a", "b", "c"]);
    expect(store.get(FOLLOWUPS_MIGRATED_KEY)).toBe(true);
    expect(store.get(FOLLOWUPS_KEY)).toBe(items);
  });

  it("is a no-op the second time, and safe even if the marker is lost", () => {
    const store = kv({ [FOLLOWUPS_KEY]: [item("a"), item("b")] });
    const s = sink();
    migrateFollowupsToLedger(store, s);
    expect(migrateFollowupsToLedger(store, s)).toMatchObject({ alreadyMigrated: true, added: 0 });
    store.data.delete(FOLLOWUPS_MIGRATED_KEY);
    expect(migrateFollowupsToLedger(store, s)).toEqual({
      alreadyMigrated: false,
      added: 0,
      existing: 2,
      skipped: 0,
    });
    expect(s.seen).toEqual(["a", "b"]);
  });

  it("sets no marker when the import throws, and the next run finishes without duplicates", () => {
    const store = kv({ [FOLLOWUPS_KEY]: [item("a"), item("b"), item("c")] });
    const seen: string[] = [];
    let blow = true;
    const flaky: FollowupLedgerSink = {
      importFollowup(i) {
        if (i.id === "b" && blow) throw new Error("disk full");
        if (seen.includes(i.id)) return "exists";
        seen.push(i.id);
        return "added";
      },
    };
    expect(() => migrateFollowupsToLedger(store, flaky)).toThrow("disk full");
    expect(store.get(FOLLOWUPS_MIGRATED_KEY)).toBeUndefined();
    blow = false;
    expect(migrateFollowupsToLedger(store, flaky)).toMatchObject({ added: 2, existing: 1 });
    expect(seen).toEqual(["a", "b", "c"]);
  });

  it("counts skipped items and copes with a missing or malformed list", () => {
    expect(
      migrateFollowupsToLedger(kv({ [FOLLOWUPS_KEY]: [item("a"), item("b")] }), sink(["b"])),
    ).toMatchObject({
      added: 1,
      skipped: 1,
    });
    const empty = kv();
    expect(migrateFollowupsToLedger(empty, sink())).toMatchObject({ added: 0 });
    expect(empty.get(FOLLOWUPS_MIGRATED_KEY)).toBe(true);
    expect(migrateFollowupsToLedger(kv({ [FOLLOWUPS_KEY]: "nope" }), sink())).toMatchObject({
      added: 0,
    });
  });
});
