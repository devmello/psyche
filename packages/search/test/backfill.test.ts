import { describe, expect, it } from "vitest";
import { Backfill, type BackfillSource, type BackfillStatus } from "../src/backfill.ts";
import type { SearchDoc } from "../src/types.ts";
import { doc, setup } from "./helpers.ts";

/** A paged source over a mutable list; `failAt` throws when that cursor is requested once. */
function listSource(name: string, rows: SearchDoc[], size = 2) {
  const reads: (string | null)[] = [];
  let failAt: string | null | undefined;
  const source: BackfillSource = {
    name,
    kinds: ["message"],
    async page(cursor) {
      reads.push(cursor);
      if (failAt !== undefined && cursor === failAt) {
        failAt = undefined;
        throw new Error("store went away");
      }
      const start = cursor === null ? 0 : Number(cursor);
      const docs = rows.slice(start, start + size);
      const next = start + size < rows.length ? String(start + size) : null;
      return { docs, next };
    },
  };
  return { source, reads, failOnce: (c: string | null) => (failAt = c) };
}

const noSleep = async () => undefined;
const ids = async (index: ReturnType<typeof setup>["index"]) =>
  (index.db.prepare("SELECT id FROM search_docs ORDER BY id").all() as { id: string }[]).map(
    (r) => r.id,
  );

describe("Backfill", () => {
  it("indexes every source and is not needed again until the version changes", async () => {
    const { index } = setup();
    const rows = [1, 2, 3, 4, 5].map((i) => doc({ id: `m${i}`, text: `budget ${i}` }));
    const { source } = listSource("messages", rows);
    const statuses: BackfillStatus[] = [];
    const bf = new Backfill(index, [source], { sleep: noSleep, onStatus: (s) => statuses.push(s) });
    expect(bf.needed()).toBe(true);
    await bf.start().done;
    expect(await ids(index)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
    expect(bf.status()).toMatchObject({ state: "done", done: 5 });
    expect(statuses.at(-1)?.state).toBe("done");
    expect(new Backfill(index, [source]).needed()).toBe(false);
    expect(new Backfill(index, [source], { version: 99 }).needed()).toBe(true);
  });

  it("resumes from the saved cursor after a failure instead of starting over", async () => {
    const { index } = setup();
    const rows = [1, 2, 3, 4, 5, 6].map((i) => doc({ id: `m${i}`, text: `trip ${i}` }));
    const s = listSource("messages", rows);
    s.failOnce("4");
    const bf = new Backfill(index, [s.source], { sleep: noSleep });
    await bf.start().done;
    expect(bf.status()).toMatchObject({ state: "error", error: "store went away" });
    expect(bf.needed()).toBe(true);
    expect(await ids(index)).toEqual(["m1", "m2", "m3", "m4"]);

    s.reads.length = 0;
    // A new process: the cursor comes from search_meta.
    await new Backfill(index, [s.source], { sleep: noSleep }).start().done;
    expect(s.reads).toEqual(["4"]);
    expect(await ids(index)).toHaveLength(6);
  });

  it("runs once when started twice", async () => {
    const { index } = setup();
    const s = listSource("messages", [doc({ id: "m1", text: "x" })]);
    const bf = new Backfill(index, [s.source], { sleep: noSleep });
    const a = bf.start();
    const b = bf.start();
    expect([a.started, b.started]).toEqual([true, false]);
    await Promise.all([a.done, b.done]);
    expect(s.reads).toEqual([null]);
  });

  it("a full rebuild drops vanished rows but keeps live writes and other producers' docs", async () => {
    const { index } = setup();
    const rows = [1, 2, 3].map((i) => doc({ id: `m${i}`, text: `plan ${i}` }));
    const s = listSource("messages", rows, 1);
    await new Backfill(index, [s.source], { sleep: noSleep }).start().done;
    // m2 is deleted in the store while the index missed the event; a connector doc exists.
    rows.splice(1, 1);
    await index.index(doc({ id: "c1", kind: "connector", text: "plan", source: "connector:x" }));
    const bf = new Backfill(index, [s.source], {
      // A live event indexes a new message while the rebuild runs.
      sleep: async () => {
        await index.index(doc({ id: "m9", text: "plan live" }));
      },
    });
    await bf.start({ full: true }).done;
    expect(await ids(index)).toEqual(["c1", "m1", "m3", "m9"]);
  });
});
