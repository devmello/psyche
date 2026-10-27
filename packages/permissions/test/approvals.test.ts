import { FakeClock, sha256 } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import { type BrokerEvent, type PolicyCall, presenceChallenge } from "../src/index.ts";
import {
  approve,
  approvers,
  CTX,
  call,
  makeBroker,
  memoryDb,
  origin,
  sqliteBroker,
} from "./helpers.ts";

const write = () => call("calendar.create", "write", origin("https://calendar.example.com"));

async function request(
  h: ReturnType<typeof makeBroker>,
  c: PolicyCall,
  surfaces = ["desktop", "web", "telegram:42"],
) {
  const d = await h.broker.decide(c, CTX);
  return h.broker.requestApproval({
    kind: d.approvalKind ?? "connector_action",
    summary: `do ${c.tool}`,
    details: { tool: c.tool },
    bindingHash: d.bindingHash ?? "",
    grantKey: d.grantKey ?? "",
    requestedBy: { runId: CTX.runId, taskId: CTX.taskId ?? null, threadId: CTX.threadId },
    sideEffect: c.sideEffect,
    ...(c.target === undefined ? {} : { target: c.target }),
    surfaces,
    taint: false,
  });
}

describe("approval lifecycle", () => {
  it("expires after 30 minutes, audits it and resolves the notification", async () => {
    const h = makeBroker();
    const issued = await request(h, write());
    const notes = await h.notifier.list();
    expect(notes[0]).toMatchObject({
      kind: "approval",
      approvalId: issued.approval.id,
      body: "Approval pending",
    });
    const waiting = h.broker.awaitDecision(issued.approval.id);
    h.clock.advance(30 * 60_000);
    expect((await waiting).status).toBe("expired");
    expect((await h.notifier.list({ unresolvedOnly: true })).length).toBe(0);
    await Promise.resolve();
    expect((await h.audit.query({ kind: "approval.expired" })).length).toBe(1);
  });

  it("stores answer tokens hashed and never emits them in events (design-20)", async () => {
    const events: BrokerEvent[] = [];
    const h = makeBroker({ onEvent: (e) => events.push(e) });
    const issued = await request(h, write());
    const tokens = Object.values(issued.answerTokens);
    expect(tokens.length).toBe(3);
    const wire = JSON.stringify([events, await h.broker.list(), await h.audit.export()]);
    for (const t of tokens) expect(wire).not.toContain(t);
    expect(wire).not.toContain("answerToken");
  });

  it("a replayed or late answer is rejected and audited", async () => {
    const h = makeBroker();
    const issued = await request(h, write());
    h.clock.advance(500);
    const answer = (surface: string, by: object = { deviceId: "dev_mac" }) =>
      h.broker.answer({
        approvalId: issued.approval.id,
        answerToken: issued.answerTokens[surface] ?? "",
        decision: "approve",
        decidedBy: by as { deviceId: string },
      });
    expect((await answer("desktop")).status).toBe("approved");
    await expect(answer("desktop")).rejects.toMatchObject({ code: "answer_replayed" });
    await expect(answer("web", { deviceId: "dev_web" })).rejects.toMatchObject({
      code: "answer_late",
    });
    const rejected = await h.audit.query({ kind: "approval.answer_rejected" });
    expect(rejected.map((e) => e.data.reason)).toEqual(["replayed", "late"]);
  });

  it("records an answer given by voice in the audit entry (voice-mode-2026 §4.6)", async () => {
    const h = makeBroker();
    const issued = await request(h, write());
    h.clock.advance(500);
    const approval = await h.broker.answer({
      approvalId: issued.approval.id,
      answerToken: issued.answerTokens.desktop ?? "",
      decision: "approve",
      scope: "once",
      via: "voice",
      decidedBy: { deviceId: "dev_mac", surface: "desktop" },
    });
    expect(approval.status).toBe("approved");
    const [decided] = await h.audit.query({ kind: "approval.decided" });
    expect(decided?.data).toMatchObject({ decision: "allow", via: "voice" });
  });

  it("only approvers answer: operator.approvals devices and owner senders (security §3.7)", async () => {
    const h = makeBroker();
    const issued = await request(h, write());
    h.clock.advance(500);
    const base = { approvalId: issued.approval.id, decision: "approve" as const };
    await expect(
      h.broker.answer({
        ...base,
        answerToken: issued.answerTokens.desktop ?? "",
        decidedBy: { deviceId: "dev_reader" },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      h.broker.answer({
        ...base,
        answerToken: issued.answerTokens.desktop ?? "",
        decidedBy: { deviceId: "dev_node" },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    // A merely allowlisted sender is not the owner.
    await expect(
      h.broker.answer({
        ...base,
        answerToken: issued.answerTokens["telegram:42"] ?? "",
        decidedBy: { channel: "telegram", senderId: "friend" },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    // A device cannot use the chat token, and the web device cannot use the desktop token.
    await expect(
      h.broker.answer({
        ...base,
        answerToken: issued.answerTokens["telegram:42"] ?? "",
        decidedBy: { deviceId: "dev_mac" },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      h.broker.answer({
        ...base,
        answerToken: issued.answerTokens.desktop ?? "",
        decidedBy: { deviceId: "dev_web", surface: "web" },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    const ok = await h.broker.answer({
      ...base,
      answerToken: issued.answerTokens["telegram:42"] ?? "",
      decidedBy: { channel: "telegram", senderId: "owner-1" },
    });
    expect(ok.status).toBe("approved");
  });

  it("chat answers may choose only once (design-28 #3)", async () => {
    const h = makeBroker();
    const issued = await request(h, write());
    h.clock.advance(500);
    await expect(
      h.broker.answer({
        approvalId: issued.approval.id,
        answerToken: issued.answerTokens["telegram:42"] ?? "",
        decision: "approve",
        scope: "always",
        decidedBy: { channel: "telegram", senderId: "owner-1" },
      }),
    ).rejects.toMatchObject({ code: "invalid_params" });
    expect(await h.broker.listGrants()).toEqual([]);
  });

  it("rate-limits answers per identity (security §10)", async () => {
    const h = makeBroker();
    const issued = await request(h, write());
    h.clock.advance(500);
    for (let i = 0; i < 10; i += 1) {
      await h.broker
        .answer({
          approvalId: issued.approval.id,
          answerToken: "forged",
          decision: "deny",
          decidedBy: { deviceId: "dev_mac" },
        })
        .catch(() => undefined);
    }
    await expect(
      h.broker.answer({
        approvalId: issued.approval.id,
        answerToken: issued.answerTokens.desktop ?? "",
        decision: "deny",
        decidedBy: { deviceId: "dev_mac" },
      }),
    ).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("destructive sends never reach chat (design-04, architecture §4.6)", async () => {
    const h = makeBroker();
    const issued = await request(
      h,
      call("email.send", "destructive", { kind: "recipient", value: "a@example.org" }),
      ["telegram:1", "desktop"],
    );
    expect(issued.approval.surfaces).toEqual(["desktop"]);
    expect(issued.approval.deviceOnly).toBe(true);
  });

  it("presence is required and bound to the request when a verifier is configured (design-04)", async () => {
    const seen: string[] = [];
    const h = makeBroker({
      presence: {
        verify: async (a, challenge) => {
          seen.push(challenge);
          return a.signature === `signed:${challenge}`;
        },
      },
    });
    const c = call("purchase.checkout", "financial", origin("https://shop.example.com"));
    const issued = await request(h, c, ["desktop", "web", "telegram:1"]);
    expect(issued.approval.surfaces).toEqual(["desktop", "web"]);
    expect(issued.approval.requiresAuthentication).toBe(true);
    h.clock.advance(500);
    const token = issued.answerTokens.web ?? "";
    const base = {
      approvalId: issued.approval.id,
      answerToken: token,
      decision: "approve" as const,
      decidedBy: { deviceId: "dev_web" },
    };
    await expect(h.broker.answer(base)).rejects.toMatchObject({
      code: "forbidden",
      details: { reason: "presence_required" },
    });
    const other = presenceChallenge("apr_other", issued.approval.bindingHash, token);
    await expect(
      h.broker.answer({
        ...base,
        presence: { kind: "webauthn", deviceId: "dev_web", signature: `signed:${other}` },
      }),
    ).rejects.toMatchObject({ details: { reason: "presence_invalid" } });
    const right = presenceChallenge(issued.approval.id, issued.approval.bindingHash, token);
    const ok = await h.broker.answer({
      ...base,
      presence: { kind: "webauthn", deviceId: "dev_web", signature: `signed:${right}` },
    });
    expect(ok.status).toBe("approved");
    expect(seen).toContain(right);
  });

  it("verifyBinding consumes a once approval and audits a mismatch", async () => {
    const h = makeBroker();
    const { approval } = await approve(h, write(), CTX);
    expect((await h.broker.verifyBinding(approval.id, sha256("changed"))).ok).toBe(false);
    expect((await h.broker.verifyBinding(approval.id, approval.bindingHash)).ok).toBe(true);
    expect(await h.broker.verifyBinding(approval.id, approval.bindingHash)).toEqual({
      ok: false,
      reason: "consumed",
    });
    const m = await h.audit.query({ kind: "binding.mismatch" });
    expect(m[0]?.data).toMatchObject({ reason: "binding_mismatch" });
  });

  it("cancelling the run rejects every answer and unused approvals (security §3.7)", async () => {
    const h = makeBroker();
    const { approval } = await approve(h, write(), CTX);
    await h.broker.revokeRunAuthority(CTX.runId);
    expect(await h.broker.verifyBinding(approval.id, approval.bindingHash)).toEqual({
      ok: false,
      reason: "revoked",
    });
  });

  it("sanitizes the summary for display (design-12)", async () => {
    const h = makeBroker();
    const d = await h.broker.decide(write(), CTX);
    const issued = await h.broker.requestApproval({
      kind: "calendar_write",
      summary: 'Re: x"\n\n✅ Low risk‮',
      details: { file: "invoice‮fdp.exe" },
      bindingHash: d.bindingHash ?? "",
      grantKey: d.grantKey ?? "",
      requestedBy: { runId: CTX.runId, taskId: null, threadId: CTX.threadId },
      sideEffect: "write",
      surfaces: ["desktop"],
      taint: false,
    });
    expect(issued.approval.summary).not.toContain("\n");
    expect(issued.approval.summary).toContain("⟨U+202E⟩");
    expect(issued.approval.details.file).toBe("invoice⟨U+202E⟩fdp.exe");
  });
});

describe("restart and re-issue (design-09)", () => {
  it("re-issues with the persisted taint and never dispatches during the reboot", async () => {
    const db = memoryDb();
    const clock = new FakeClock();
    const first = sqliteBroker(db, clock, { policy: { sites: { "shop.example.com": "allow" } } });
    const submit = call("browser.click", "write", origin("https://shop.example.com"), {
      params: { ref: "ref_9" },
    });
    const tainted = {
      ...CTX,
      taint: true,
      newTarget: true,
      taintSources: [{ sourceKind: "browser", origin: "https://shop.example.com" }],
    };
    const d1 = await first.decide(submit, tainted);
    expect(d1).toMatchObject({ decision: "ask", rule: "taint:new_target" });
    const old = await first.requestApproval({
      kind: d1.approvalKind ?? "connector_action",
      summary: "click",
      details: {},
      bindingHash: d1.bindingHash ?? "",
      grantKey: d1.grantKey ?? "",
      requestedBy: { runId: CTX.runId, taskId: CTX.taskId ?? null, threadId: CTX.threadId },
      sideEffect: "write",
      target: submit.target,
      surfaces: ["desktop"],
      taint: true,
    });

    const rebooted = sqliteBroker(db, clock, {
      policy: { sites: { "shop.example.com": "allow" } },
    });
    const reissued = await rebooted.reissue();
    expect(reissued).toHaveLength(1);
    expect(reissued[0]?.approval).toMatchObject({
      taint: true,
      status: "pending",
      bindingHash: old.approval.bindingHash,
    });
    expect((await rebooted.get(old.approval.id))?.status).toBe("invalidated");
    clock.advance(500);
    await expect(
      rebooted.answer({
        approvalId: old.approval.id,
        answerToken: old.answerTokens.desktop ?? "",
        decision: "approve",
        decidedBy: { deviceId: "dev_mac" },
      }),
    ).rejects.toMatchObject({ code: "approval_invalidated", details: { reason: "re-issued" } });
    expect(await rebooted.listReceipts()).toEqual([]);
  });

  it("drops a parked call that policy now denies", async () => {
    const db = memoryDb();
    const clock = new FakeClock();
    const first = sqliteBroker(db, clock);
    const c = write();
    const d = await first.decide(c, CTX);
    await first.requestApproval({
      kind: d.approvalKind ?? "connector_action",
      summary: "x",
      details: {},
      bindingHash: d.bindingHash ?? "",
      grantKey: d.grantKey ?? "",
      requestedBy: { runId: CTX.runId, taskId: null, threadId: CTX.threadId },
      sideEffect: "write",
      surfaces: ["desktop"],
      taint: false,
    });
    const rebooted = sqliteBroker(db, clock, { policy: { deny: ["calendar.*"] } });
    expect(await rebooted.reissue()).toEqual([]);
  });
});

describe("grant scopes and the ledger", () => {
  it("task grants end with the Task; destructive task grants last at most 8 h (design-28)", async () => {
    const h = makeBroker();
    const send = call("messages.send", "destructive", { kind: "recipient", value: "alice" });
    const { approval } = await approve(h, send, CTX, "task");
    const [g] = await h.broker.listGrants();
    expect(Date.parse(g?.expiresAt ?? "") - Date.parse(approval.decidedAt ?? "")).toBe(
      8 * 3_600_000,
    );
    expect((await h.broker.decide(send, CTX)).decision).toBe("allow");
    await h.broker.endTask(CTX.taskId ?? "");
    expect((await h.broker.decide(send, CTX)).decision).toBe("ask");
  });

  it("session grants are bound to the boot and thread, renew on use and cap at 24 h", async () => {
    const h = makeBroker();
    const c = write();
    await approve(h, c, CTX, "session");
    expect((await h.broker.decide(c, { ...CTX, threadId: "thr_other" })).decision).toBe("ask");
    for (let i = 0; i < 2; i += 1) {
      h.clock.advance(11 * 3_600_000);
      expect((await h.broker.decide(c, CTX)).decision).toBe("allow");
    }
    h.clock.advance(3 * 3_600_000); // 25 h after creation
    expect((await h.broker.decide(c, CTX)).decision).toBe("ask");
  });

  it("site grants cover one origin; always grants count uses and expire in 90 days", async () => {
    const h = makeBroker();
    const c = call("browser.click", "write", origin("https://www.kayak.com"));
    await approve(h, c, CTX, "site");
    expect((await h.broker.decide(c, CTX)).decision).toBe("allow");
    const [g] = await h.broker.listGrants({ scope: "site" });
    expect(g?.useCount).toBe(1);
    h.clock.advance(31 * 24 * 3_600_000);
    expect((await h.broker.decide(c, CTX)).decision).toBe("ask");
  });

  it("revoking a device revokes the grants it approved (design-28 #4)", async () => {
    const h = makeBroker();
    await approve(h, write(), CTX, "always");
    const revoked = await h.broker.revokeGrantsByDevice("dev_mac");
    expect(revoked).toHaveLength(1);
    expect((await h.broker.decide(write(), CTX)).decision).toBe("ask");
  });

  it("a tools/list hash change revokes MCP grants (security §11)", async () => {
    const h = makeBroker();
    const v1 = `sha256:${"1".repeat(64)}`;
    const v2 = `sha256:${"2".repeat(64)}`;
    const mcp = (toolsListHash: string) =>
      call("mcp__github__create_issue", "write", undefined, {
        binding: {
          serverId: "github",
          tool: "create_issue",
          toolsListHash,
          argsSha256: sha256("args"),
        },
        // Unknown-tier write tools always ask (#280); this one is from a verified server.
        meta: { mcpTier: "verified" },
      });
    await approve(h, mcp(v1), CTX, "always");
    expect((await h.broker.decide(mcp(v1), CTX)).decision).toBe("allow");
    // The grant key includes the hash, so a changed list never matches…
    expect((await h.broker.decide(mcp(v2), CTX)).decision).toBe("ask");
    // …and the ledger revokes the stale grants.
    const revoked = await h.broker.revokeMcpGrants("github", v2);
    expect(revoked).toHaveLength(1);
    expect((await h.broker.listGrants({ includeRevoked: true }))[0]?.revokedAt).toBeTypeOf(
      "string",
    );
  });

  it("a loop-shaped MCP call (precomputed binding, meta) is revoked on a tools/list change (#279)", async () => {
    const h = makeBroker();
    const A = `sha256:${"a".repeat(64)}`;
    const B = `sha256:${"b".repeat(64)}`;
    // What the agent loop sends: a precomputed bindingHash and grantKey, no binding, and the
    // MCP identity in meta (from @psyche/mcp-host describeMcpCall).
    const loopCall = (hash: string) =>
      call(
        "mcp__s__t",
        "write",
        { kind: "account", value: "mcp:s" },
        {
          kind: "connector_action",
          bindingHash: sha256(`binding|${hash}`),
          grantKey: `mcp__s__t|mcp:s:t:${hash}`,
          meta: { mcpServerId: "s", mcpToolsListHash: hash, mcpTier: "verified" },
        },
      );
    await approve(h, loopCall(A), CTX, "always");
    expect((await h.broker.decide(loopCall(A), CTX)).decision).toBe("allow");
    const [g] = await h.broker.listGrants();
    expect(g?.subject).toMatchObject({ serverId: "s", toolsListHash: A });

    // A → B: the grant bound to A is revoked…
    expect(await h.broker.revokeMcpGrants("s", B)).toHaveLength(1);
    // …so B → A does not revive it.
    expect((await h.broker.decide(loopCall(A), CTX)).decision).toBe("ask");
  });

  it("write tools of unknown-tier MCP servers ask even with a matching always grant (#280)", async () => {
    const h = makeBroker();
    const hash = `sha256:${"c".repeat(64)}`;
    const mcp = (
      sideEffect: "read" | "write",
      tier?: "bundled" | "verified" | "unknown",
      tool = "mcp__s__t",
    ) =>
      call(
        tool,
        sideEffect,
        { kind: "account", value: "mcp:s" },
        {
          kind: "connector_action",
          bindingHash: sha256(`binding|${tool}|${hash}`),
          grantKey: `${tool}|mcp:s:t:${hash}`,
          meta: {
            mcpServerId: "s",
            mcpToolsListHash: hash,
            ...(tier === undefined ? {} : { mcpTier: tier }),
          },
        },
      );
    // A grant made while the server was verified…
    await approve(h, mcp("write", "verified"), CTX, "always");
    expect((await h.broker.decide(mcp("write", "verified"), CTX)).decision).toBe("allow");
    // …does not cover the same tool once the server is unknown: it asks, once only.
    const d = await h.broker.decide(mcp("write", "unknown"), CTX);
    expect(d).toMatchObject({ decision: "ask", rule: "mcp:unknown_tier" });
    expect((d as { scopesOffered?: string[] }).scopesOffered).toEqual(["once"]);
    // An mcp__ tool that names no tier counts as unknown.
    expect(await h.broker.decide(mcp("write"), CTX)).toMatchObject({ rule: "mcp:unknown_tier" });
    // Reads of unknown servers follow the mode as before.
    expect((await h.broker.decide(mcp("read", "unknown"), CTX)).rule).not.toBe("mcp:unknown_tier");
  });

  it("exec_host always grants refuse cwd-config executables unless their config is bound (design-14)", async () => {
    const h = makeBroker({
      policy: { exec: { execHostEnabled: true }, folders: [{ path: "/tmp", mode: "rw" }] },
    });
    const git = (cwdConfigHashes?: Record<string, string>) =>
      call("exec_host", "destructive", undefined, {
        binding: {
          argv: ["git", "status"],
          cwd: "/tmp/r",
          executable: "/usr/bin/git",
          executableSha256: `sha256:${"e".repeat(64)}`,
          ...(cwdConfigHashes === undefined ? {} : { cwdConfigHashes }),
        },
      });
    expect((await h.broker.decide(git(), CTX)).scopesOffered).not.toContain("always");
    const bound = await h.broker.decide(git({ ".git/config": sha256("[core]") }), CTX);
    expect(bound.scopesOffered).toContain("always");
    const changed = await h.broker.decide(
      git({ ".git/config": sha256("[core]\nfsmonitor = x") }),
      CTX,
    );
    expect(changed.grantKey).not.toBe(bound.grantKey);
  });

  it("exports the ledger with revoked entries", async () => {
    const h = makeBroker();
    const { approval } = await approve(h, write(), CTX, "always");
    await h.broker.revokeGrant(approval.grantId ?? "");
    const ex = await h.broker.exportGrants();
    expect(ex.grants).toHaveLength(1);
    expect(ex.grants[0]?.revokedAt).toBeTypeOf("string");
  });
});

describe("approver directory default", () => {
  it("is required: the broker has no trust-everyone default", () => {
    expect(approvers().device).toBeTypeOf("function");
  });
});
