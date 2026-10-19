import { FakeClock } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import type { PolicyContext, Requester } from "../src/index.ts";
import { requesterKey } from "../src/index.ts";
import { approve, CTX, call, makeBroker, memoryDb, origin, sqliteBroker } from "./helpers.ts";

/** Per-sender grant matrices for designated persons (security §9; S05 M2, with S10 identities). */

const GRANDMA: Requester = {
  role: "designated",
  identityId: "idn_grandma",
  display: "Grandma",
  channel: "telegram",
  senderId: "555",
  links: ["telegram:555", "imessage:+15550001"],
  toolAllow: ["calendar.*", "reminders.*", "notes.*", "email.draft", "email.send"],
};
const as = (requester: Requester): PolicyContext => ({ ...CTX, requester });
const policy = {
  designated: {
    idn_grandma: { allow: ["reminders.create"], ask: ["calendar.create"], deny: ["notes.delete"] },
  },
};

describe("designated persons", () => {
  it("persona limits are fixed: no exec, vault, money, browser or app writes, protected memory", async () => {
    const h = makeBroker({ policy: { ...policy, allow: ["*"] } });
    const cases: [string, "write" | "destructive" | "financial", PolicyContext["requester"]][] = [
      ["exec", "write", GRANDMA],
      ["credentials.request", "write", GRANDMA],
      ["purchase.checkout", "financial", GRANDMA],
      ["browser.click", "write", GRANDMA],
      ["computer.type", "write", GRANDMA],
      ["memory", "write", GRANDMA],
    ];
    for (const [tool, se] of cases) {
      const d = await h.broker.decide(
        call(tool, se, origin("https://shop.example.com")),
        as(GRANDMA),
      );
      expect(d.decision, tool).toBe("deny");
      expect(["designated:persona_limit", "designated:not_in_tool_allow"], tool).toContain(d.rule);
    }
  });

  it("the identity's tool list and the owner's per-person matrix apply", async () => {
    const h = makeBroker({ policy });
    expect((await h.broker.decide(call("drive.upload", "write"), as(GRANDMA))).rule).toBe(
      "designated:not_in_tool_allow",
    );
    expect((await h.broker.decide(call("notes.delete", "write"), as(GRANDMA))).rule).toBe(
      "designated:deny:notes.delete",
    );
    expect((await h.broker.decide(call("calendar.create", "write"), as(GRANDMA))).rule).toBe(
      "designated:ask:calendar.create",
    );
    expect(await h.broker.decide(call("reminders.create", "write"), as(GRANDMA))).toMatchObject({
      decision: "allow",
      rule: "designated:allow:reminders.create",
    });
  });

  it("the owner's allowances are not the designated person's", async () => {
    const h = makeBroker({ policy: { allow: ["notes.create"] } });
    expect((await h.broker.decide(call("notes.create", "write"), CTX)).decision).toBe("allow");
    expect((await h.broker.decide(call("notes.create", "write"), as(GRANDMA))).decision).toBe(
      "ask",
    );
  });

  it("destructive requests always go to the owner, and never to the requester's own chat", async () => {
    const h = makeBroker({ policy });
    const send = call("email.send", "destructive", { kind: "recipient", value: "bob@example.org" });
    const d = await h.broker.decide(send, as(GRANDMA));
    expect(d.decision).toBe("ask");
    const issued = await h.broker.requestApproval({
      kind: d.approvalKind ?? "send_email",
      summary: "Send for Grandma",
      details: {},
      bindingHash: d.bindingHash ?? "",
      grantKey: d.grantKey ?? "",
      requestedBy: { runId: CTX.runId, taskId: CTX.taskId ?? null, threadId: CTX.threadId },
      sideEffect: "destructive",
      surfaces: ["desktop", "telegram:555", "telegram:owner-1"],
      taint: false,
    });
    expect(issued.approval.surfaces).toEqual(["desktop"]);
    expect(issued.approval.details.requestedFor).toBe("designated: Grandma");
  });

  it("chat cards for a designated person's write skip their own chats", async () => {
    const h = makeBroker({ policy });
    const c = call("calendar.create", "write");
    const d = await h.broker.decide(c, as(GRANDMA));
    const issued = await h.broker.requestApproval({
      kind: d.approvalKind ?? "calendar_write",
      summary: "Add event for Grandma",
      details: {},
      bindingHash: d.bindingHash ?? "",
      grantKey: d.grantKey ?? "",
      requestedBy: { runId: CTX.runId, taskId: CTX.taskId ?? null, threadId: CTX.threadId },
      sideEffect: "write",
      surfaces: ["desktop", "imessage:+15550001", "telegram:555", "telegram:owner-1"],
      taint: false,
    });
    expect(issued.approval.surfaces).toEqual(["desktop", "telegram:owner-1"]);
  });

  it("grants never cross requesters", async () => {
    const h = makeBroker({ policy });
    const c = call("calendar.create", "write", origin("https://calendar.example.com"));
    // The owner's always grant does not cover Grandma…
    await approve(h, c, CTX, "always");
    expect((await h.broker.decide(c, CTX)).decision).toBe("allow");
    expect((await h.broker.decide(c, as(GRANDMA))).decision).toBe("ask");
    // …and a grant approved for Grandma's request covers only her.
    const h2 = makeBroker({ policy: {} });
    const r2 = call("reminders.create", "write");
    await approve(h2, r2, as(GRANDMA), "always");
    expect((await h2.broker.decide(r2, as(GRANDMA))).decision).toBe("allow");
    expect((await h2.broker.decide(r2, CTX)).decision).toBe("ask");
    expect((await h2.broker.decide(r2, as({ ...GRANDMA, identityId: "idn_other" }))).decision).toBe(
      "ask",
    );
  });

  it("per-requester grants survive a restart (SQLite)", async () => {
    const db = memoryDb();
    const clock = new FakeClock();
    const a = sqliteBroker(db, clock);
    const h = { broker: a, clock, audit: a.audit, notifier: undefined } as unknown as Parameters<
      typeof approve
    >[0];
    const r = call("reminders.create", "write");
    await approve(h, r, as(GRANDMA), "always");
    const b = sqliteBroker(db, clock);
    expect((await b.decide(r, as(GRANDMA))).decision).toBe("allow");
    expect((await b.decide(r, CTX)).decision).toBe("ask");
    const [g] = await b.listGrants();
    expect(g).toBeDefined();
  });

  it("allowlisted senders who are neither owner nor designated request nothing above read", async () => {
    const h = makeBroker({ policy: { allow: ["*"] } });
    const friend: Requester = { role: "allowed", channel: "telegram", senderId: "777" };
    expect((await h.broker.decide(call("calendar.create", "write"), as(friend))).rule).toBe(
      "requester:not_owner",
    );
    expect((await h.broker.decide(call("calendar.list", "read"), as(friend))).decision).not.toBe(
      "deny",
    );
  });

  it("requester keys", () => {
    expect(requesterKey(undefined)).toBeNull();
    expect(requesterKey({ role: "owner" })).toBeNull();
    expect(requesterKey(GRANDMA)).toBe("identity:idn_grandma");
    expect(requesterKey({ role: "allowed", channel: "telegram", senderId: "7" })).toBe(
      "sender:telegram:7",
    );
  });
});
