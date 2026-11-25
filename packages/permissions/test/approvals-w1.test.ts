import { Receipts } from "@psyche/audit";
import type { ApprovalKind } from "@psyche/protocol";
import { FakeClock } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import { createPermissionHandlers } from "../src/handlers.ts";
import type {
  PermissionBrokerOptions,
  PolicyApprovalInput,
  PolicyCall,
  PolicyContext,
  PsychePermissionBroker,
} from "../src/index.ts";
import {
  approve,
  approvers,
  CTX,
  call,
  DEVICE,
  type Harness,
  makeBroker,
  memoryDb,
  recipient,
  sqliteBroker,
} from "./helpers.ts";

void Receipts;

/**
 * Approvals W1: session ("for this chat") grants across a restart, a token on request for a paired
 * phone, and the "you've allowed this N times" hint. Each table has the refusals and a positive
 * control. (The exec_host session grant and the restart-with-a-waiting-run tables live in
 * `host-program.test.ts` and `apps/gateway/test/restart-approvals.test.ts`.)
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WRITE = () =>
  call("calendar.create", "write", { kind: "origin", value: "https://cal.example" });
const THREAD = CTX.threadId;

/** A restartable broker pair: `boot()` is a Gateway start on the same database. */
function restartable(opts: { alive?: (id: string) => boolean; devices?: object } = {}) {
  const db = memoryDb();
  const clock = new FakeClock();
  const alive = opts.alive ?? ((id: string) => id === THREAD);
  const boot = (over: Partial<PermissionBrokerOptions> = {}) =>
    sqliteBroker(db, clock, {
      sessionThreadAlive: alive,
      ...over,
    });
  return { db, clock, boot };
}

async function sessionGrant(h: Harness) {
  const { approval } = await approve(h, WRITE(), CTX, "session");
  expect(approval.scopeGranted).toBe("session");
  return approval;
}

describe("session grants across a restart", () => {
  it("a grant of this chat survives, and covers only this chat", async () => {
    const r = restartable();
    const first = r.boot();
    await sessionGrant({ broker: first, clock: r.clock } as Harness);
    expect((await first.decide(WRITE(), CTX)).decision).toBe("allow");
    r.clock.advance(HOUR);
    const second = r.boot();
    await second.reissue();
    const d = await second.decide(WRITE(), CTX);
    expect(d.decision).toBe("allow");
    expect(d.rule).toMatch(/^grant:/);
    // Another chat is not covered.
    expect((await second.decide(WRITE(), { ...CTX, threadId: "thr_other" })).decision).toBe("ask");
    // And it carries over again at the next restart.
    const third = r.boot();
    await third.reissue();
    expect((await third.decide(WRITE(), CTX)).decision).toBe("allow");
  });

  const REFUSED: [
    string,
    (r: ReturnType<typeof restartable>, g: PsychePermissionBroker) => Promise<void>,
    object?,
  ][] = [
    [
      "the owner revoked it",
      async (_r, g) => {
        const [grant] = await g.listGrants({} as never);
        await g.revokeGrant(grant?.id ?? "");
      },
    ],
    [
      "the device that gave it was revoked",
      async () => {},
      {
        devices: approvers({
          dev_mac: { scopes: ["operator.read", "operator.approvals"], revoked: true },
        }),
      },
    ],
    ["the device that gave it is gone", async () => {}, { devices: approvers({}) }],
    [
      "the chat was cleared or deleted before the restart",
      async (_r, g) => {
        await g.endSession(THREAD);
      },
    ],
    [
      "the chat no longer exists (deleted while the Gateway was down)",
      async () => {},
      { alive: () => false },
    ],
    [
      "more than 12 hours idle",
      async (r) => {
        r.clock.advance(13 * HOUR);
      },
    ],
    [
      "more than 24 hours since it was given, though it was used all along",
      async (r, g) => {
        for (let i = 0; i < 4; i += 1) {
          r.clock.advance(7 * HOUR);
          await g.decide(WRITE(), CTX);
        }
      },
    ],
  ];
  it.each(REFUSED)("does not carry over when %s", async (_n, before, over = {}) => {
    const r = restartable(over as never);
    const first = r.boot();
    await sessionGrant({ broker: first, clock: r.clock } as Harness);
    await before(r, first);
    const devices = (over as { devices?: object }).devices;
    const second = r.boot(devices === undefined ? {} : { approvers: devices as never });
    await second.reissue();
    expect((await second.decide(WRITE(), CTX)).decision).toBe("ask");
    // And the revoked ones stay revoked at the next restart.
    const third = r.boot();
    await third.reissue();
    expect((await third.decide(WRITE(), CTX)).decision).toBe("ask");
  });

  it("without a way to ask whether the chat exists, nothing carries over (fail closed)", async () => {
    const db = memoryDb();
    const clock = new FakeClock();
    const first = sqliteBroker(db, clock);
    await sessionGrant({ broker: first, clock } as Harness);
    const second = sqliteBroker(db, clock);
    await second.reissue();
    expect((await second.decide(WRITE(), CTX)).decision).toBe("ask");
  });

  it("a carried grant is stored for the new boot (the SQLite row says so)", async () => {
    const r = restartable();
    const first = r.boot();
    await sessionGrant({ broker: first, clock: r.clock } as Harness);
    const before = r.db.sqlite.prepare("SELECT session_id AS s FROM grants").get() as { s: string };
    const second = r.boot();
    await second.reissue();
    const after = r.db.sqlite.prepare("SELECT session_id AS s FROM grants").get() as { s: string };
    expect(after.s).toBe(second.bootId);
    expect(after.s).not.toBe(before.s);
  });
});

// ---- a token on request ----------------------------------------------------------------------

const PHONE = { deviceId: "dev_phone", surface: "device:dev_phone" as const };
const phoneDevices = () =>
  approvers({
    dev_mac: { scopes: ["operator.read", "operator.approvals"] },
    dev_phone: { scopes: ["operator.read", "operator.approvals"] },
    dev_reader: { scopes: ["operator.read"] },
    dev_node: { scopes: ["node", "operator.approvals"], role: "node" },
  });

function raise(h: Harness, over: Partial<PolicyApprovalInput> & { offMac?: boolean } = {}) {
  return h.broker.requestApproval({
    kind: "connector_action",
    summary: "Create an event",
    details: { title: "Lunch" },
    bindingHash: "sha256:" + "a".repeat(64),
    grantKey: "calendar.create|https://cal.example",
    requestedBy: { runId: "run_1", taskId: null, threadId: THREAD },
    sideEffect: "write",
    surfaces: ["desktop", "notification"],
    taint: false,
    offMac: true,
    ...over,
  } as never);
}

describe("a token on request for a paired phone", () => {
  const harness = () => makeBroker({ approvers: phoneDevices(), deviceSurfaces: () => [] });

  it("a phone paired after the card was raised gets a token, and the token answers the card", async () => {
    const h = harness();
    const issued = await raise(h);
    expect(issued.answerTokens["device:dev_phone"]).toBeUndefined();
    // Nothing is minted by a plain look: it only says a token is available.
    expect(
      await h.broker.mintAnswerToken({
        approvalId: issued.approval.id,
        decidedBy: PHONE,
        mint: false,
      }),
    ).toEqual({
      needsMac: "paired_after",
    });
    const out = await h.broker.mintAnswerToken({
      approvalId: issued.approval.id,
      decidedBy: PHONE,
    });
    expect(out.token).toMatch(/^at_/);
    h.clock.advance(500);
    // Another device cannot use it, the phone can, once.
    await expect(
      h.broker.answer({
        approvalId: issued.approval.id,
        answerToken: out.token ?? "",
        decision: "approve",
        scope: "once",
        decidedBy: { deviceId: "dev_mac", surface: "desktop" },
      }),
    ).rejects.toThrow();
    const done = await h.broker.answer({
      approvalId: issued.approval.id,
      answerToken: out.token ?? "",
      decision: "approve",
      scope: "once",
      decidedBy: PHONE,
    });
    expect(done.status).toBe("approved");
    expect(done.decidedBy).toMatchObject({ deviceId: "dev_phone" });
  });

  it("a second ask gets nothing new, and a decided card gets nothing", async () => {
    const h = harness();
    const issued = await raise(h);
    expect(
      (await h.broker.mintAnswerToken({ approvalId: issued.approval.id, decidedBy: PHONE })).token,
    ).toBeDefined();
    expect(
      await h.broker.mintAnswerToken({ approvalId: issued.approval.id, decidedBy: PHONE }),
    ).toEqual({});
    const other = await raise(h);
    h.clock.advance(500);
    await h.broker.answer({
      approvalId: other.approval.id,
      answerToken: other.answerTokens.desktop ?? "",
      decision: "deny",
      decidedBy: DEVICE,
    });
    expect(
      await h.broker.mintAnswerToken({ approvalId: other.approval.id, decidedBy: PHONE }),
    ).toEqual({});
  });

  const NO_TOKEN: [string, Partial<PolicyApprovalInput> & { offMac?: boolean }, string][] = [
    ["a payment (financial)", { sideEffect: "financial", kind: "connector_action" }, "payment"],
    ["a purchase", { kind: "purchase", sideEffect: "financial" }, "payment"],
    ["a card that needs a presence step", { requireAuthentication: true } as never, "payment"],
    ["a saved login (credential_fill)", { kind: "credential_fill" }, "mac_only"],
    ["pairing", { kind: "pairing" }, "mac_only"],
    ["a policy change", { kind: "policy_change" }, "mac_only"],
    [
      "a card its caller kept on the Mac (skill install, capability, MCP add)",
      { kind: "skill_install", surfaces: ["desktop"], offMac: false },
      "mac_only",
    ],
    [
      "details too long to show in full on a phone",
      {
        details: Object.fromEntries(
          Array.from({ length: 80 }, (_, i) => [`k${i}`, "x".repeat(400)]),
        ),
      },
      "too_long",
    ],
  ];
  it.each(NO_TOKEN)("no token for %s", async (_n, over, reason) => {
    const h = harness();
    const issued = await raise(h, over);
    const out = await h.broker.mintAnswerToken({
      approvalId: issued.approval.id,
      decidedBy: PHONE,
    });
    expect(out.token).toBeUndefined();
    expect(out.needsMac).toBe(reason);
    // Nothing was stored for the phone either.
    expect(
      await h.broker.mintAnswerToken({
        approvalId: issued.approval.id,
        decidedBy: PHONE,
        mint: false,
      }),
    ).toEqual({
      needsMac: reason,
    });
  });

  const REFUSED_CALLERS: [string, { deviceId: string; surface: `device:${string}` | "desktop" }][] =
    [
      ["an unpaired (unknown) device", { deviceId: "dev_unknown", surface: "device:dev_unknown" }],
      [
        "a device without operator.approvals",
        { deviceId: "dev_reader", surface: "device:dev_reader" },
      ],
      ["a node", { deviceId: "dev_node", surface: "device:dev_node" }],
      [
        "a device asking for another device's surface",
        { deviceId: "dev_phone", surface: "device:dev_mac" },
      ],
      ["a device on the desktop surface", { deviceId: "dev_phone", surface: "desktop" }],
    ];
  it.each(REFUSED_CALLERS)("refuses %s", async (_n, by) => {
    const h = harness();
    const issued = await raise(h);
    await expect(
      h.broker.mintAnswerToken({ approvalId: issued.approval.id, decidedBy: by }),
    ).rejects.toThrow();
  });

  it("through approvals.get: a phone that asks gets a token, a plain read does not mint", async () => {
    const h = harness();
    const handlers = createPermissionHandlers(h.broker, undefined);
    const issued = await raise(h);
    const caller = {
      deviceId: "dev_phone",
      scopes: ["operator.read", "operator.approvals"] as never,
      surface: "device:dev_phone" as const,
    };
    const plain = await handlers["approvals.get"]({ approvalId: issued.approval.id }, caller);
    expect(plain.answerToken).toBeUndefined();
    expect(plain.needsMac).toBe("paired_after");
    const asked = await handlers["approvals.get"](
      { approvalId: issued.approval.id, wantToken: true },
      caller,
    );
    expect(asked.answerToken).toMatch(/^at_/);
    // A read-only device sees the plain card and nothing about tokens; asking for one is refused.
    const reader = {
      deviceId: "dev_reader",
      scopes: ["operator.read"] as never,
      surface: "device:dev_reader" as const,
    };
    expect(await handlers["approvals.get"]({ approvalId: issued.approval.id }, reader)).toEqual({
      approval: expect.anything(),
    });
    await expect(
      handlers["approvals.get"]({ approvalId: issued.approval.id, wantToken: true }, reader),
    ).rejects.toThrow();
    // A payment says why.
    const pay = await raise(h, { sideEffect: "financial" });
    const said = await handlers["approvals.get"](
      { approvalId: pay.approval.id, wantToken: true },
      caller,
    );
    expect(said.answerToken).toBeUndefined();
    expect(said.needsMac).toBe("payment");
  });
});

// ---- the "you've allowed this N times" hint --------------------------------------------------

const hintOf = (a: { grantHint?: { count: number; days: number; scope: string } }) => a.grantHint;

async function card(
  h: Harness,
  c: PolicyCall,
  ctx: PolicyContext,
  details: Record<string, unknown> = {},
) {
  const d = await h.broker.decide(c, ctx);
  if (d.decision !== "ask" || d.approvalKind === undefined) throw new Error(`no ask: ${d.rule}`);
  return h.broker.requestApproval({
    kind: d.approvalKind,
    summary: "test",
    details,
    bindingHash: d.bindingHash ?? "",
    grantKey: d.grantKey ?? "",
    requestedBy: { runId: ctx.runId, taskId: ctx.taskId ?? null, threadId: ctx.threadId },
    sideEffect: c.sideEffect,
    ...(c.target === undefined ? {} : { target: c.target }),
    surfaces: ["desktop"],
    taint: ctx.taint,
  });
}

describe("the grant hint", () => {
  const MAIL = (to: string) => call("gmail.send", "write", recipient(to));

  it("3 approvals of the same grant key in 7 days: the next card carries the hint and the lasting choice", async () => {
    const h = makeBroker();
    for (let i = 0; i < 3; i += 1) {
      await approve(h, WRITE(), CTX, "once");
      h.clock.advance(HOUR);
    }
    const c = await card(h, WRITE(), CTX);
    expect(hintOf(c.approval)).toEqual({ count: 3, days: 7, scope: "always" });
    // A top-level field, never a `details` entry (the phone reads nested details as "review").
    expect(c.approval.details).not.toHaveProperty("grantHint");
    // A caller's own hint is dropped, and another grant key has none.
    const other = await card(
      h,
      call("calendar.create", "write", { kind: "origin", value: "https://other.example" }),
      CTX,
      {
        grantHint: { count: 9, days: 7, scope: "always" },
      },
    );
    expect(hintOf(other.approval)).toBeUndefined();
  });

  it("2 approvals: no hint", async () => {
    const h = makeBroker();
    for (let i = 0; i < 2; i += 1) await approve(h, WRITE(), CTX, "once");
    expect(hintOf((await card(h, WRITE(), CTX)).approval)).toBeUndefined();
  });

  it("3 approvals, all older than 7 days: no hint; two of them older: no hint", async () => {
    const h = makeBroker();
    for (let i = 0; i < 3; i += 1) await approve(h, WRITE(), CTX, "once");
    h.clock.advance(8 * DAY);
    expect(hintOf((await card(h, WRITE(), CTX)).approval)).toBeUndefined();
    await approve(h, WRITE(), CTX, "once");
    expect(hintOf((await card(h, WRITE(), CTX)).approval)).toBeUndefined();
  });

  it("a denied card does not count", async () => {
    const h = makeBroker();
    for (let i = 0; i < 3; i += 1) {
      const c = await card(h, WRITE(), CTX);
      h.clock.advance(500);
      await h.broker.answer({
        approvalId: c.approval.id,
        answerToken: c.answerTokens.desktop ?? "",
        decision: "deny",
        decidedBy: DEVICE,
      });
    }
    expect(hintOf((await card(h, WRITE(), CTX)).approval)).toBeUndefined();
  });

  it("a tainted card never carries it, and tainted approvals never count", async () => {
    const h = makeBroker();
    for (let i = 0; i < 3; i += 1) await approve(h, WRITE(), CTX, "once");
    expect(hintOf((await card(h, WRITE(), CTX)).approval)).toBeDefined();
    const tainted = { ...CTX, taint: true };
    expect(hintOf((await card(h, WRITE(), tainted)).approval)).toBeUndefined();
    const h2 = makeBroker();
    for (let i = 0; i < 3; i += 1) await approve(h2, WRITE(), tainted, "once");
    expect(hintOf((await card(h2, WRITE(), CTX)).approval)).toBeUndefined();
  });

  it("a payment never carries it, whatever the history", async () => {
    const h = makeBroker();
    let grantKey = "";
    let kind: ApprovalKind = "connector_action";
    for (let i = 0; i < 3; i += 1) {
      const { d } = await approve(h, WRITE(), CTX, "once");
      grantKey = d.grantKey ?? "";
      kind = d.approvalKind ?? kind;
    }
    const raiseAs = (sideEffect: "write" | "financial") =>
      h.broker.requestApproval({
        kind,
        summary: "test",
        details: {},
        bindingHash: `sha256:${"b".repeat(64)}`,
        grantKey,
        requestedBy: { runId: "run_1", taskId: null, threadId: THREAD },
        sideEffect,
        surfaces: ["desktop"],
        taint: false,
      });
    // Control: the same history and key, as a write, carries it.
    expect(hintOf((await raiseAs("write")).approval)).toMatchObject({ count: 3 });
    const pay = await raiseAs("financial");
    expect(hintOf(pay.approval)).toBeUndefined();
    expect(pay.approval.scopesOffered).toEqual(["once"]);
    // A real purchase card: once only, no hint.
    const purchase = await card(
      h,
      call("purchase.checkout", "financial", { kind: "origin", value: "https://shop.example" }),
      CTX,
    );
    expect(purchase.approval.requiresAuthentication).toBe(true);
    expect(hintOf(purchase.approval)).toBeUndefined();
  });

  it("a send: the hint comes only for a recipient the owner has answered for three times", async () => {
    const h = makeBroker();
    for (let i = 0; i < 3; i += 1) await approve(h, MAIL("ann@example.com"), CTX, "once");
    expect(hintOf((await card(h, MAIL("ann@example.com"), CTX)).approval)).toBeDefined();
    // A new recipient has no history of its own.
    expect(hintOf((await card(h, MAIL("bob@example.com"), CTX)).approval)).toBeUndefined();
    // And a send the engine flags as a new target never carries it.
    expect(
      hintOf((await card(h, MAIL("ann@example.com"), { ...CTX, newTarget: true })).approval),
    ).toBeUndefined();
  });
});

describe("reads never count against anyone", () => {
  it("a plain approvals.get from a device the broker does not trust writes no lockout and no audit row", async () => {
    const h = makeBroker({ approvers: phoneDevices(), deviceSurfaces: () => [] });
    const handlers = createPermissionHandlers(h.broker, undefined);
    const issued = await raise(h);
    // The connection says it may approve; the broker's directory says otherwise (seal-trusted scopes differ).
    const caller = {
      deviceId: "dev_unknown",
      scopes: ["operator.read", "operator.approvals"] as never,
      surface: "device:dev_unknown" as const,
    };
    for (let i = 0; i < 20; i += 1) {
      expect(await handlers["approvals.get"]({ approvalId: issued.approval.id }, caller)).toEqual({
        approval: expect.anything(),
      });
    }
    const rejected = (await h.audit.query({} as never)).filter(
      (e) => e.kind === "approval.answer_rejected",
    );
    expect(rejected).toHaveLength(0);
    // Control: explicitly asking for a token is a refusal, and it is audited.
    await expect(
      handlers["approvals.get"]({ approvalId: issued.approval.id, wantToken: true }, caller),
    ).rejects.toThrow();
    const after = (await h.audit.query({} as never)).filter(
      (e) => e.kind === "approval.answer_rejected",
    );
    expect(after).toHaveLength(1);
  });
});

describe("tokens at issue time agree with tokens on request", () => {
  const phone = "device:dev_phone" as const;
  const withPhone = () => makeBroker({ approvers: phoneDevices(), deviceSurfaces: () => [phone] });
  it("a normal card reaches the paired phone at once (control)", async () => {
    const issued = await raise(withPhone());
    expect(issued.answerTokens[phone]).toBeDefined();
  });
  it.each([
    ["a saved login", { kind: "credential_fill" }],
    ["pairing", { kind: "pairing" }],
    ["a policy change", { kind: "policy_change" }],
    [
      "details too long for a phone",
      {
        details: Object.fromEntries(
          Array.from({ length: 80 }, (_, i) => [`k${i}`, "x".repeat(400)]),
        ),
      },
    ],
  ])("no phone token for %s", async (_n, over) => {
    const issued = await raise(withPhone(), over as never);
    expect(issued.answerTokens[phone]).toBeUndefined();
  });
});
