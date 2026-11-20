import { FakeClock, sha256 } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import { detailsTooDeep, MAX_DETAILS_DEPTH, sanitizeDetails } from "../src/cards.ts";
import { type PolicyApprovalInput, SqlitePermissionStore } from "../src/index.ts";
import { makeBroker, memoryDb, sqliteBroker } from "./helpers.ts";

/**
 * Paired phones get their own `device:<deviceId>` surface on a card that needs no presence, but
 * only when the caller itself offered an off-Mac surface (`offMac`, set by the Gateway's relay
 * wrapper before the Mac helper adds `notification`). Payments never get one.
 */

const PHONES = ["device:phone-1", "device:phone-2"];
let n = 0;

function card(over: Partial<PolicyApprovalInput>): PolicyApprovalInput {
  n += 1;
  return {
    kind: "skill_install",
    summary: "Run a script",
    details: {},
    bindingHash: sha256(`card-${n}`),
    grantKey: `card-${n}`,
    requestedBy: { runId: null, taskId: null, threadId: null },
    sideEffect: "destructive",
    surfaces: ["desktop"],
    taint: false,
    ...over,
  };
}

const phones = (surfaces: readonly string[]) => surfaces.filter((s) => s.startsWith("device:"));

describe("which cards get the phones' surfaces", () => {
  const rows: [string, Partial<PolicyApprovalInput>, string[]][] = [
    ["desktop only, no flag", { surfaces: ["desktop"] }, []],
    ["caller offered notification, no flag", { surfaces: ["desktop", "notification"] }, PHONES],
    ["caller offered web, no flag", { surfaces: ["desktop", "web"] }, PHONES],
    // The relay merged the helper's `notification` into a desktop-only card: the flag wins.
    [
      "relay-added notification, caller kept desktop",
      { surfaces: ["desktop", "notification"], offMac: false },
      [],
    ],
    [
      "caller offered notification, flag says so",
      { surfaces: ["desktop", "notification"], offMac: true },
      PHONES,
    ],
    [
      "a payment offered everywhere",
      {
        kind: "purchase",
        sideEffect: "financial",
        surfaces: ["desktop", "notification", "web"],
        offMac: true,
      },
      [],
    ],
    [
      "enrolling a verifier",
      {
        kind: "policy_change",
        surfaces: ["desktop", "web"],
        offMac: true,
        requireAuthentication: true,
      },
      [],
    ],
  ];
  it.each(rows)("%s", async (_name, over, expected) => {
    const h = makeBroker({ deviceSurfaces: () => PHONES });
    const issued = await h.broker.requestApproval(card(over));
    expect(phones(issued.approval.surfaces)).toEqual(expected);
    expect(Object.keys(issued.answerTokens).filter((s) => s.startsWith("device:"))).toEqual(
      expected,
    );
  });

  it("a restart re-issues a relay-merged desktop-only card without the phones", async () => {
    const h = makeBroker({ deviceSurfaces: () => PHONES });
    await h.broker.requestApproval(card({ surfaces: ["desktop", "notification"], offMac: false }));
    const [again] = await h.broker.reissue();
    expect(again).toBeDefined();
    expect(phones(again?.approval.surfaces ?? [])).toEqual([]);
  });

  it("a row stored before the flag existed never gets the phones on the first restart after upgrade", async () => {
    const db = memoryDb();
    const clock = new FakeClock();
    // As main's relay wrapper stored it: the helper's `notification` merged in, no `offMac`.
    const before = sqliteBroker(db, clock);
    const legacy = card({ surfaces: ["desktop", "notification"] });
    await before.requestApproval(legacy);
    const stored = new SqlitePermissionStore(db.sqlite).listApprovals({ status: "pending" });
    expect(stored.map((r) => r.input.offMac)).toEqual([undefined]);
    const after = sqliteBroker(db, clock, { deviceSurfaces: () => PHONES });
    const again = (await after.reissue()).find(
      (i) => i.approval.bindingHash === legacy.bindingHash,
    );
    expect(again).toBeDefined();
    expect(phones(again?.approval.surfaces ?? [])).toEqual([]);
    expect(Object.keys(again?.answerTokens ?? {}).some((s) => s.startsWith("device:"))).toBe(false);
    db.close();
  });
});

describe("details deeper than a card shows are refused", () => {
  const nest = (levels: number): unknown => {
    let v: unknown = "rm -rf ~";
    for (let i = 0; i < levels; i += 1) v = { a: v };
    return v;
  };

  it("matches the sanitizer's own cut-off exactly", () => {
    // details → a → … : the scalar sits at depth `levels`.
    for (const levels of [0, 1, MAX_DETAILS_DEPTH, MAX_DETAILS_DEPTH + 1, MAX_DETAILS_DEPTH + 4]) {
      const value = nest(levels);
      const elided = JSON.stringify(sanitizeDetails(value)).includes("…");
      expect(detailsTooDeep(value), String(levels)).toBe(elided);
    }
    expect(detailsTooDeep([[[]]])).toBe(false);
  });

  it("the broker refuses the deep card and raises the shallow one", async () => {
    const h = makeBroker();
    const ok = await h.broker.requestApproval(
      card({ details: nest(MAX_DETAILS_DEPTH) as PolicyApprovalInput["details"] }),
    );
    expect(ok.approval.status).toBe("pending");
    await expect(
      h.broker.requestApproval(
        card({ details: nest(MAX_DETAILS_DEPTH + 1) as PolicyApprovalInput["details"] }),
      ),
    ).rejects.toMatchObject({
      code: "invalid_params",
      details: { reason: "details_too_deep" },
    });
  });
});
