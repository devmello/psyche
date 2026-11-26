import { createThread, openDb } from "@psyche/db";
import {
  createPermissionBroker,
  createPermissionHandlers,
  SqlitePermissionStore,
} from "@psyche/permissions";
import { FakeClock } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import { ApprovalTokens } from "../src/compose/approval-tokens.ts";
import { mountPermissions } from "../src/compose/handlers.ts";
import { threadKeepsSessionGrants } from "../src/compose/thread-end.ts";
import type { Call } from "../src/context.ts";

/** Approvals W1, the Gateway half: a token on request through the mounted `approvals.get`. */

const PHONE = "dev_phone";
const DEVICES: Record<string, { scopes: string[]; role?: string }> = {
  dev_mac: { scopes: ["operator.read", "operator.approvals"] },
  [PHONE]: { scopes: ["operator.read", "operator.approvals"] },
  dev_reader: { scopes: ["operator.read"] },
};

function setup() {
  const clock = new FakeClock(Date.parse("2026-11-25T10:00:00Z"));
  const db = openDb(":memory:");
  const tokens = new ApprovalTokens();
  const broker = createPermissionBroker({
    armDelayMs: 0,
    clock,
    approvers: {
      device: async (id) => DEVICES[id] as never,
    },
    store: new SqlitePermissionStore(db.sqlite),
    // No phone is paired when the card is raised.
    deviceSurfaces: () => [],
  });
  const wrapped = tokens.wrap(broker);
  const mount = mountPermissions(db, createPermissionHandlers(broker, undefined), tokens);
  const callAs = (deviceId: string, scopes: string[]): Call =>
    ({
      identity: { deviceId, scopes, role: "client" },
      conn: { peer: { remoteLoopback: false } },
    }) as unknown as Call;
  const get = (deviceId: string, params: object, scopes = DEVICES[deviceId]?.scopes ?? []) =>
    (mount["approvals.get"] as { run(c: Call, p: never): Promise<unknown> }).run(
      callAs(deviceId, scopes),
      params as never,
    ) as Promise<{ approval: { id: string }; answerToken?: string; needsMac?: string }>;
  const raise = (over: object = {}) =>
    wrapped.requestApproval({
      kind: "connector_action",
      summary: "Create an event",
      details: { title: "Lunch" },
      bindingHash: `sha256:${"a".repeat(64)}`,
      grantKey: "calendar.create|x",
      requestedBy: { runId: "run_1", taskId: null, threadId: "thr_1" },
      sideEffect: "write",
      surfaces: ["desktop", "notification"],
      taint: false,
      ...over,
    } as never);
  return { clock, db, broker, get, raise };
}

describe("approvals.get with wantToken (mounted)", () => {
  it("a paired phone gets a token for a normal card, gets the same one again, and answers with it", async () => {
    const t = setup();
    const issued = await t.raise();
    // A plain read tells the phone it can get one.
    expect(await t.get(PHONE, { approvalId: issued.approval.id })).toMatchObject({
      needsMac: "paired_after",
    });
    const asked = await t.get(PHONE, { approvalId: issued.approval.id, wantToken: true });
    expect(asked.answerToken).toMatch(/^at_/);
    expect(asked.needsMac).toBeUndefined();
    // Asking again, or reading, returns the same token (the Gateway keeps it for this surface).
    const again = await t.get(PHONE, { approvalId: issued.approval.id });
    expect(again.answerToken).toBe(asked.answerToken);
    expect(again.needsMac).toBeUndefined();
    const done = await t.broker.answer({
      approvalId: issued.approval.id,
      answerToken: asked.answerToken ?? "",
      decision: "approve",
      scope: "once",
      decidedBy: { deviceId: PHONE, surface: `device:${PHONE}` },
    });
    expect(done.status).toBe("approved");
  });

  const NONE: [string, object, string][] = [
    ["a payment", { sideEffect: "financial" }, "payment"],
    ["a purchase", { kind: "purchase", sideEffect: "financial" }, "payment"],
    ["a saved login", { kind: "credential_fill" }, "mac_only"],
    ["pairing", { kind: "pairing" }, "mac_only"],
    ["a policy change", { kind: "policy_change" }, "mac_only"],
    ["a card kept on the Mac", { kind: "skill_install", surfaces: ["desktop"] }, "mac_only"],
  ];
  it.each(NONE)("no token for %s", async (_n, over, reason) => {
    const t = setup();
    const issued = await t.raise(over);
    const got = await t.get(PHONE, { approvalId: issued.approval.id, wantToken: true });
    expect(got.answerToken).toBeUndefined();
    expect(got.needsMac).toBe(reason);
    // Nothing was kept for a later plain read either.
    expect((await t.get(PHONE, { approvalId: issued.approval.id })).answerToken).toBeUndefined();
  });

  it("an unpaired caller, and a read-only device that asks, are refused", async () => {
    const t = setup();
    const issued = await t.raise();
    await expect(
      t.get("dev_unknown", { approvalId: issued.approval.id, wantToken: true }, [
        "operator.read",
        "operator.approvals",
      ]),
    ).rejects.toThrow();
    await expect(
      t.get("dev_reader", { approvalId: issued.approval.id, wantToken: true }),
    ).rejects.toThrow();
    // A read-only device still reads the plain card.
    expect(
      (await t.get("dev_reader", { approvalId: issued.approval.id })).answerToken,
    ).toBeUndefined();
  });
});

describe("which chats keep their for-this-chat grants across a restart", () => {
  it("a normal chat does; an incognito chat, a deleted one and an unknown id do not", () => {
    const db = openDb(":memory:");
    const main = createThread(db, { kind: "main", sessionKey: "a" });
    const side = createThread(db, { kind: "side", sessionKey: "b" });
    const incognito = createThread(db, { kind: "incognito", sessionKey: "c" });
    expect(threadKeepsSessionGrants(db, main.id)).toBe(true);
    expect(threadKeepsSessionGrants(db, side.id)).toBe(true);
    expect(threadKeepsSessionGrants(db, incognito.id)).toBe(false);
    expect(threadKeepsSessionGrants(db, "thr_gone")).toBe(false);
    db.sqlite.prepare("DELETE FROM threads WHERE id = ?").run(side.id);
    expect(threadKeepsSessionGrants(db, side.id)).toBe(false);
  });
});
