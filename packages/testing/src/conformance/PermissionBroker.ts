import {
  APPROVAL_ARM_DELAY_MS,
  APPROVAL_TTL_MS,
  type ApprovalKind,
  type DecisionContext,
  type GrantScope,
  type IssuedApproval,
  type PermissionBroker,
  type SideEffect,
  type ToolCallIntent,
} from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { sha256 } from "../canonical.ts";
import {
  type ConformanceContext,
  type ConformanceFactory,
  expectPsycheError,
  newContext,
} from "./harness.ts";

export interface PermissionBrokerConformanceContext extends ConformanceContext {
  /** The factory must install a user deny rule for each of these tools. */
  deniedTools: readonly string[];
}

const DENIED_TOOL = "conformance.denied_tool";

const CTX: DecisionContext = {
  threadId: "thr_conf",
  runId: "run_conf",
  taskId: "task_conf",
  permissionMode: "balanced",
  taint: false,
};

function intent(
  tool: string,
  sideEffect: SideEffect,
  target = "https://shop.example.com",
): ToolCallIntent {
  const params = { tool, target };
  return {
    tool,
    sideEffect,
    targetKind: "origin",
    target: { kind: "origin", value: target },
    params,
    paramsHash: sha256(JSON.stringify(params)),
  };
}

/** Security §3: decisions, scopes, approval lifecycle, binding, receipts. */
export function describePermissionBrokerConformance(
  name: string,
  factory: ConformanceFactory<PermissionBroker, PermissionBrokerConformanceContext>,
): void {
  const setup = async () => {
    const ctx: PermissionBrokerConformanceContext = { ...newContext(), deniedTools: [DENIED_TOOL] };
    return { broker: await factory(ctx), clock: ctx.clock };
  };

  async function request(
    broker: PermissionBroker,
    call: ToolCallIntent,
    options: {
      surfaces?: string[];
      scopesOffered?: GrantScope[];
      kind?: ApprovalKind;
      runId?: string;
      taskId?: string | null;
    } = {},
  ): Promise<IssuedApproval> {
    const d = await broker.decide(call, CTX);
    return broker.requestApproval({
      kind: options.kind ?? d.approvalKind ?? "connector_action",
      summary: `conformance ${call.tool}`,
      details: { tool: call.tool },
      bindingHash: d.bindingHash ?? sha256(call.paramsHash),
      grantKey: d.grantKey ?? `${call.tool}|${call.target?.value ?? "*"}`,
      requestedBy: {
        runId: options.runId ?? CTX.runId,
        taskId: options.taskId === undefined ? (CTX.taskId ?? null) : options.taskId,
        threadId: CTX.threadId,
      },
      sideEffect: call.sideEffect,
      ...(call.target === undefined ? {} : { target: call.target }),
      surfaces: options.surfaces ?? ["desktop", "web"],
      ...(options.scopesOffered === undefined ? {} : { scopesOffered: options.scopesOffered }),
      taint: false,
    });
  }

  function token(issued: IssuedApproval, surface: string): string {
    const t = issued.answerTokens[surface];
    expect(t, `answer token for ${surface}`).toBeTypeOf("string");
    return t ?? "";
  }

  const by = { deviceId: "dev_conf" };

  function approveWith(broker: PermissionBroker, issued: IssuedApproval, scope: GrantScope) {
    return broker.answer({
      approvalId: issued.approval.id,
      answerToken: token(issued, "desktop"),
      decision: "approve",
      scope,
      decidedBy: by,
    });
  }

  describe(`PermissionBroker conformance: ${name}`, () => {
    it("plan mode denies anything with a side effect", async () => {
      const { broker } = await setup();
      const plan = { ...CTX, permissionMode: "plan" as const };
      expect((await broker.decide(intent("write_file", "write"), plan)).decision).toBe("deny");
      expect((await broker.decide(intent("math.eval", "none"), plan)).decision).toBe("allow");
    });

    it("asks for an unknown write and says what to bind", async () => {
      const { broker } = await setup();
      const d = await broker.decide(intent("calendar.create", "write"), CTX);
      expect(d.decision).toBe("ask");
      expect(d.rule.length).toBeGreaterThan(0);
      expect(d.bindingHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(d.grantKey).toBeTypeOf("string");
    });

    it("issues one distinct single-use token per surface", async () => {
      const { broker } = await setup();
      const issued = await request(broker, intent("calendar.create", "write"));
      expect(issued.approval.status).toBe("pending");
      const tokens = issued.approval.surfaces.map((s) => token(issued, s));
      expect(new Set(tokens).size).toBe(tokens.length);
      expect(Date.parse(issued.approval.expiresAt) - Date.parse(issued.approval.requestedAt)).toBe(
        APPROVAL_TTL_MS,
      );
    });

    it("a standing grant allows the same grantKey afterwards", async () => {
      const { broker, clock } = await setup();
      const call = intent("calendar.create", "write");
      const issued = await request(broker, call);
      clock.advance(APPROVAL_ARM_DELAY_MS + 100);
      const a = await broker.answer({
        approvalId: issued.approval.id,
        answerToken: token(issued, "desktop"),
        decision: "approve",
        scope: "always",
        decidedBy: by,
      });
      expect(a.status).toBe("approved");
      expect(a.grantId).toBeTypeOf("string");
      expect((await broker.decide(call, CTX)).decision).toBe("allow");
      expect((await broker.listGrants()).map((g) => g.id)).toContain(a.grantId);
    });

    it("deny beats allow: a user deny rule wins over a standing grant", async () => {
      const { broker, clock } = await setup();
      const call = {
        ...intent(DENIED_TOOL, "write"),
        grantKey: `${DENIED_TOOL}|grant`,
        bindingHash: sha256("x"),
      };
      const issued = await broker.requestApproval({
        kind: "connector_action",
        summary: "seed grant",
        details: {},
        bindingHash: call.bindingHash,
        grantKey: call.grantKey,
        requestedBy: { runId: CTX.runId, taskId: null, threadId: CTX.threadId },
        sideEffect: "write",
        surfaces: ["desktop"],
        taint: false,
      });
      clock.advance(APPROVAL_ARM_DELAY_MS + 100);
      await broker.answer({
        approvalId: issued.approval.id,
        answerToken: token(issued, "desktop"),
        decision: "approve",
        scope: "always",
        decidedBy: by,
      });
      expect((await broker.decide(call, CTX)).decision).toBe("deny");
    });

    it("destructive is never offered or granted beyond task", async () => {
      const { broker, clock } = await setup();
      const call = intent("email.send", "destructive");
      const d = await broker.decide(call, CTX);
      expect(d.decision).toBe("ask");
      for (const s of d.scopesOffered ?? []) expect(["once", "task"]).toContain(s);
      const issued = await request(broker, call, {
        scopesOffered: ["once", "task", "site", "session", "always"],
      });
      for (const s of issued.approval.scopesOffered) expect(["once", "task"]).toContain(s);
      clock.advance(APPROVAL_ARM_DELAY_MS + 100);
      await expectPsycheError(
        broker.answer({
          approvalId: issued.approval.id,
          answerToken: token(issued, "desktop"),
          decision: "approve",
          scope: "always",
          decidedBy: by,
        }),
      );
      expect((await broker.get(issued.approval.id))?.status).toBe("pending");
    });

    it("financial is once-only, device-only, needs authentication and never becomes allow", async () => {
      const { broker, clock } = await setup();
      const call = intent("purchase.checkout", "financial");
      const issued = await request(broker, call, {
        kind: "purchase",
        surfaces: ["desktop", "telegram:4242"],
      });
      expect(issued.approval.scopesOffered).toEqual(["once"]);
      expect(issued.approval.deviceOnly).toBe(true);
      expect(issued.approval.requiresAuthentication).toBe(true);
      expect(issued.approval.surfaces).not.toContain("telegram:4242");
      expect(Object.keys(issued.answerTokens)).not.toContain("telegram:4242");
      clock.advance(APPROVAL_ARM_DELAY_MS + 100);
      await broker.answer({
        approvalId: issued.approval.id,
        answerToken: token(issued, "desktop"),
        decision: "approve",
        scope: "once",
        decidedBy: by,
      });
      expect((await broker.decide(call, CTX)).decision).not.toBe("allow");
    });

    it("rejects answers before the card is armed", async () => {
      const { broker } = await setup();
      const issued = await request(broker, intent("calendar.create", "write"));
      await expectPsycheError(
        broker.answer({
          approvalId: issued.approval.id,
          answerToken: token(issued, "desktop"),
          decision: "approve",
          decidedBy: by,
        }),
        "approval_not_armed",
      );
      expect((await broker.get(issued.approval.id))?.status).toBe("pending");
    });

    it("approvals expire, deny late answers and wake waiters", async () => {
      const { broker, clock } = await setup();
      const issued = await request(broker, intent("calendar.create", "write"));
      const waiting = broker.awaitDecision(issued.approval.id);
      clock.advance(APPROVAL_TTL_MS + 1_000);
      expect((await waiting).status).toBe("expired");
      expect((await broker.get(issued.approval.id))?.status).toBe("expired");
      await expectPsycheError(
        broker.answer({
          approvalId: issued.approval.id,
          answerToken: token(issued, "desktop"),
          decision: "approve",
          decidedBy: by,
        }),
        "approval_expired",
      );
    });

    it("answer tokens are single-use and the first answer wins", async () => {
      const { broker, clock } = await setup();
      const issued = await request(broker, intent("calendar.create", "write"));
      clock.advance(APPROVAL_ARM_DELAY_MS + 100);
      const answer = (surface: string, decision: "approve" | "deny") =>
        broker.answer({
          approvalId: issued.approval.id,
          answerToken: token(issued, surface),
          decision,
          decidedBy: by,
        });
      expect((await answer("desktop", "deny")).status).toBe("denied");
      await expectPsycheError(answer("desktop", "approve"), "answer_replayed");
      await expectPsycheError(answer("web", "approve"), "answer_late");
      await expectPsycheError(
        broker.answer({
          approvalId: issued.approval.id,
          answerToken: "forged",
          decision: "approve",
          decidedBy: by,
        }),
      );
      expect((await broker.get(issued.approval.id))?.status).toBe("denied");
      expect((await broker.awaitDecision(issued.approval.id)).status).toBe("denied");
    });

    it("verifyBinding rejects a changed binding and consumes a once approval", async () => {
      const { broker, clock } = await setup();
      const issued = await request(broker, intent("calendar.create", "write"));
      clock.advance(APPROVAL_ARM_DELAY_MS + 100);
      await broker.answer({
        approvalId: issued.approval.id,
        answerToken: token(issued, "desktop"),
        decision: "approve",
        scope: "once",
        decidedBy: by,
      });
      const wrong = await broker.verifyBinding(issued.approval.id, sha256("tampered arguments"));
      expect(wrong).toEqual({ ok: false, reason: "binding_mismatch" });
      const right = await broker.verifyBinding(issued.approval.id, issued.approval.bindingHash);
      expect(right.ok).toBe(true);
      const again = await broker.verifyBinding(issued.approval.id, issued.approval.bindingHash);
      expect(again.ok).toBe(false);
    });

    it("verifyBinding refuses a denied or pending approval", async () => {
      const { broker } = await setup();
      const issued = await request(broker, intent("calendar.create", "write"));
      const v = await broker.verifyBinding(issued.approval.id, issued.approval.bindingHash);
      expect(v.ok).toBe(false);
    });

    it("taint escalates allow to ask for a new target", async () => {
      const { broker, clock } = await setup();
      const call = intent("calendar.create", "write");
      const issued = await request(broker, call);
      clock.advance(APPROVAL_ARM_DELAY_MS + 100);
      await broker.answer({
        approvalId: issued.approval.id,
        answerToken: token(issued, "desktop"),
        decision: "approve",
        scope: "always",
        decidedBy: by,
      });
      expect((await broker.decide(call, CTX)).decision).toBe("allow");
      expect((await broker.decide(call, { ...CTX, taint: true, newTarget: true })).decision).toBe(
        "ask",
      );
    });

    it("revoking a grant stops it from allowing", async () => {
      const { broker, clock } = await setup();
      const call = intent("calendar.create", "write");
      const issued = await request(broker, call);
      clock.advance(APPROVAL_ARM_DELAY_MS + 100);
      const a = await broker.answer({
        approvalId: issued.approval.id,
        answerToken: token(issued, "desktop"),
        decision: "approve",
        scope: "always",
        decidedBy: by,
      });
      const revoked = await broker.revokeGrant(a.grantId ?? "");
      expect(revoked.revokedAt).toBeTypeOf("string");
      expect((await broker.decide(call, CTX)).decision).toBe("ask");
    });

    it("revokeRunAuthority invalidates the run's pending approvals", async () => {
      const { broker, clock } = await setup();
      const issued = await request(broker, intent("calendar.create", "write"), {
        runId: "run_cancelled",
      });
      await broker.revokeRunAuthority("run_cancelled");
      expect((await broker.get(issued.approval.id))?.status).toBe("invalidated");
      clock.advance(APPROVAL_ARM_DELAY_MS + 100);
      await expectPsycheError(
        broker.answer({
          approvalId: issued.approval.id,
          answerToken: token(issued, "desktop"),
          decision: "approve",
          decidedBy: by,
        }),
      );
    });

    it("reissue invalidates pending requests and issues fresh tokens", async () => {
      const { broker, clock } = await setup();
      const old = await request(broker, intent("calendar.create", "write"));
      const fresh = await broker.reissue();
      expect(fresh).toHaveLength(1);
      const next = fresh[0];
      if (next === undefined) return;
      expect(next.approval.id).not.toBe(old.approval.id);
      expect(next.approval.bindingHash).toBe(old.approval.bindingHash);
      const stale = await broker.get(old.approval.id);
      expect(stale?.status).toBe("invalidated");
      clock.advance(APPROVAL_ARM_DELAY_MS + 100);
      await expectPsycheError(
        broker.answer({
          approvalId: old.approval.id,
          answerToken: token(old, "desktop"),
          decision: "approve",
          decidedBy: by,
        }),
      );
      await expectPsycheError(
        broker.answer({
          approvalId: next.approval.id,
          answerToken: token(old, "desktop"),
          decision: "approve",
          decidedBy: by,
        }),
      );
      const ok = await broker.answer({
        approvalId: next.approval.id,
        answerToken: token(next, "desktop"),
        decision: "approve",
        decidedBy: by,
      });
      expect(ok.status).toBe("approved");
    });

    it("a grant never covers a more severe side-effect class", async () => {
      const { broker, clock } = await setup();
      const write = intent("email.send", "write");
      const issued = await request(broker, write);
      clock.advance(APPROVAL_ARM_DELAY_MS + 100);
      await approveWith(broker, issued, "always");
      expect((await broker.decide(write, CTX)).decision).toBe("allow");
      expect((await broker.decide(intent("email.send", "destructive"), CTX)).decision).not.toBe(
        "allow",
      );
      expect((await broker.decide(intent("email.send", "financial"), CTX)).decision).not.toBe(
        "allow",
      );
    });

    it("a task grant covers only calls of its own task", async () => {
      const { broker, clock } = await setup();
      const call = intent("calendar.create", "write");
      const issued = await request(broker, call);
      clock.advance(APPROVAL_ARM_DELAY_MS + 100);
      await approveWith(broker, issued, "task");
      expect((await broker.decide(call, CTX)).decision).toBe("allow");
      expect((await broker.decide(call, { ...CTX, taskId: "task_other" })).decision).not.toBe(
        "allow",
      );
      const { taskId: _omit, ...noTask } = CTX;
      expect((await broker.decide(call, noTask)).decision).not.toBe("allow");
    });

    it("a task-less approval never yields a task grant that matches task-less calls", async () => {
      const { broker, clock } = await setup();
      const call = intent("calendar.create", "write");
      const issued = await request(broker, call, { taskId: null, scopesOffered: ["once", "task"] });
      clock.advance(APPROVAL_ARM_DELAY_MS + 100);
      if (issued.approval.scopesOffered.includes("task")) await approveWith(broker, issued, "task");
      const { taskId: _omit, ...noTask } = CTX;
      expect((await broker.decide(call, noTask)).decision).not.toBe("allow");
    });

    it("destructive chat-capable kinds stay device-only with narrowed scopes", async () => {
      const { broker } = await setup();
      const issued = await request(broker, intent("messages.send", "destructive"), {
        kind: "message_send",
        surfaces: ["desktop", "telegram:4242"],
        scopesOffered: ["once", "task", "site", "session", "always"],
      });
      expect(issued.approval.deviceOnly).toBe(true);
      expect(issued.approval.surfaces).not.toContain("telegram:4242");
      for (const s of issued.approval.scopesOffered) expect(["once", "task"]).toContain(s);
    });

    it("pairing and policy changes are device-only", async () => {
      const { broker } = await setup();
      for (const kind of ["pairing", "policy_change"] as const) {
        const issued = await request(broker, intent(`conformance.${kind}`, "write"), {
          kind,
          surfaces: ["desktop", "telegram:4242"],
        });
        expect(issued.approval.deviceOnly, kind).toBe(true);
        expect(issued.approval.surfaces).not.toContain("telegram:4242");
      }
    });

    it("verifyBinding stops accepting a standing approval once its grant expires", async () => {
      const { broker, clock } = await setup();
      const issued = await request(broker, intent("calendar.create", "write"));
      clock.advance(APPROVAL_ARM_DELAY_MS + 100);
      await approveWith(broker, issued, "task");
      expect((await broker.verifyBinding(issued.approval.id, issued.approval.bindingHash)).ok).toBe(
        true,
      );
      clock.advance(25 * 3_600_000);
      expect(await broker.verifyBinding(issued.approval.id, issued.approval.bindingHash)).toEqual({
        ok: false,
        reason: "expired",
      });
    });

    it("session grants end at a restart", async () => {
      const { broker, clock } = await setup();
      const call = intent("calendar.create", "write");
      const issued = await request(broker, call);
      clock.advance(APPROVAL_ARM_DELAY_MS + 100);
      await approveWith(broker, issued, "session");
      expect((await broker.decide(call, CTX)).decision).toBe("allow");
      await broker.reissue();
      expect((await broker.decide(call, CTX)).decision).not.toBe("allow");
    });

    it("records receipts and finds them by task", async () => {
      const { broker } = await setup();
      const r = await broker.recordReceipt({
        kind: "exec",
        outcome: "ok",
        summary: "ran echo",
        taskId: "task_conf",
        externalRefs: { exitCode: 0 },
      });
      expect(r.id).toBeTypeOf("string");
      expect(r.outcome).toBe("ok");
      expect(r.externalRefs).toEqual({ exitCode: 0 });
      expect((await broker.listReceipts({ taskId: "task_conf" })).map((x) => x.id)).toContain(r.id);
    });
  });
}
