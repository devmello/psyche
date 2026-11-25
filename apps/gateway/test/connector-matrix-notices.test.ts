import { describe, expect, it } from "vitest";
import { matrixNotices } from "../src/compose/connector-matrix.ts";

type Row = {
  id: string;
  kind: string;
  message?: { titleKey: string; params?: Record<string, string> };
  resolvedAt: string | null;
};

/** An in-memory notifier with the three calls the notice helper uses. */
function fakeNotifier() {
  const rows: Row[] = [];
  let seq = 0;
  const notifier = {
    notify: async (input: { kind: string; message?: Row["message"] }) => {
      const row: Row = {
        id: `n${++seq}`,
        kind: input.kind,
        message: input.message,
        resolvedAt: null,
      };
      rows.push(row);
      return row;
    },
    list: async () => rows.filter((r) => r.resolvedAt === null),
    resolve: async (id: string) => {
      const row = rows.find((r) => r.id === id);
      if (row) row.resolvedAt = "2026-11-24T10:00:00.000Z";
      return row;
    },
  };
  return { notifier, rows, open: () => rows.filter((r) => r.resolvedAt === null) };
}

const MAIL = { id: "apple-mail", label: "Apple Mail" };

describe("connector rule notices (matrix sync)", () => {
  it("a real refusal raises exactly one notice, even when the pass repeats it", async () => {
    const { notifier, rows } = fakeNotifier();
    const notices = matrixNotices(notifier as never);
    await notices.refused(MAIL, "mail.send", "allow");
    await notices.refused(MAIL, "mail.send", "allow");
    await notices.refused(MAIL, "mail.send", "allow");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.message?.params).toEqual({ action: "mail.send", connector: "Apple Mail" });
  });

  it("matrix first, then the floor lift: the refusal is settled and no notice stays open", async () => {
    const { notifier, open } = fakeNotifier();
    const notices = matrixNotices(notifier as never);
    // Pass 1: the matrix write lands before the lift, so the registry refuses `allow`.
    await notices.refused(MAIL, "mail.send", "allow");
    expect(open()).toHaveLength(1);
    // Pass 2 (after the lift): the rule applies, so the pass settles it.
    await notices.settled(MAIL, "mail.send");
    expect(open()).toHaveLength(0);
  });

  it("lift first, then the matrix: nothing is raised and nothing stays open", async () => {
    const { notifier, open, rows } = fakeNotifier();
    const notices = matrixNotices(notifier as never);
    // The lift is saved first, so the matrix write applies and nothing is refused.
    await notices.settled(MAIL, "mail.send");
    expect(rows).toHaveLength(0);
    expect(open()).toHaveLength(0);
  });

  it("a refusal the owner dismissed does not come back for the same value", async () => {
    const { notifier, rows, open } = fakeNotifier();
    const notices = matrixNotices(notifier as never);
    await notices.refused(MAIL, "mail.send", "allow");
    // The owner dismisses it in the inbox.
    for (const r of open()) r.resolvedAt = "2026-11-24T10:01:00.000Z";
    await notices.refused(MAIL, "mail.send", "allow");
    expect(rows).toHaveLength(1);
    expect(open()).toHaveLength(0);
  });

  it("a settled rule that is refused again raises once more", async () => {
    const { notifier, rows } = fakeNotifier();
    const notices = matrixNotices(notifier as never);
    await notices.refused(MAIL, "mail.send", "allow");
    await notices.settled(MAIL, "mail.send");
    await notices.refused(MAIL, "mail.send", "allow");
    expect(rows).toHaveLength(2);
  });

  it("clamps the action and the connector label to 60 characters", async () => {
    const { notifier, rows } = fakeNotifier();
    const notices = matrixNotices(notifier as never);
    const long = "x".repeat(120);
    await notices.refused({ id: "c-1", label: long }, long, "allow");
    expect(rows[0]?.message?.params?.action).toHaveLength(60);
    expect(rows[0]?.message?.params?.connector).toHaveLength(60);
  });
});
