import type { GrantScope, SideEffect } from "@psyche/protocol";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { allowedScopes, type PolicyContext, type Requester, SEVERITY } from "../../src/index.ts";
import { CTX, call, DEVICE, makeBroker } from "../helpers.ts";
import { FUZZ } from "./config.ts";

/**
 * decide() never grants what the security doc forbids, across random modes, taint states,
 * standing grants, requesters, tools and targets (security §3.2–§3.9).
 */

const TOOLS = [
  "calendar.create",
  "conn.action",
  "notes.create",
  "email.send",
  "messages.send",
  "purchase.checkout",
  "bank.transfer",
  "mcp__wallet__withdraw",
  "exec",
  "exec_host",
  "credentials.request",
  "browser.click",
  "browser.navigate",
  "computer.click",
  "drive.delete_permanently",
  "settings.set",
  "captcha.solve",
  "memory",
  "mcp__github__create_issue",
] as const;
/** Never allowed, whatever the policy, grant or mode (`exec_host`: see below). */
const FORBIDDEN = new Set([
  "bank.transfer",
  "mcp__wallet__withdraw",
  "settings.set",
  "captcha.solve",
]);
const TARGETS = [
  undefined,
  { kind: "origin" as const, value: "https://shop.example.com" },
  { kind: "origin" as const, value: "https://www.chase.com" },
  { kind: "origin" as const, value: "http://localhost:3000" },
  { kind: "origin" as const, value: "http://127.0.0.1:7979" },
  { kind: "origin" as const, value: "http://[::ffff:127.0.0.1]:9222" },
  { kind: "origin" as const, value: "http://user:pw@shop.example.com" },
  { kind: "origin" as const, value: "javascript:alert(1)" },
  { kind: "recipient" as const, value: "bob@example.org" },
  { kind: "path" as const, value: "/workspace/out.txt" },
  { kind: "app" as const, value: "com.apple.Notes" },
];
const LOOPBACK_OR_BAD = new Set([3, 4, 5, 6, 7]);
const REQUESTERS: (Requester | undefined)[] = [
  undefined,
  { role: "owner" },
  {
    role: "designated",
    identityId: "idn_1",
    toolAllow: ["calendar.*", "notes.*", "email.*", "messages.*"],
  },
  { role: "allowed", channel: "telegram", senderId: "9" },
];
const SIDE: SideEffect[] = ["none", "read", "write", "destructive", "financial"];
const SCOPES: GrantScope[] = ["once", "task", "site", "session", "always"];

const scenario = fc.record({
  tool: fc.nat(TOOLS.length - 1),
  side: fc.nat(SIDE.length - 1),
  target: fc.nat(TARGETS.length - 1),
  mode: fc.constantFrom("plan", "manual", "balanced", "auto"),
  taint: fc.boolean(),
  newTarget: fc.option(fc.boolean(), { nil: undefined }),
  requester: fc.nat(REQUESTERS.length - 1),
  allowAll: fc.boolean(),
  execHost: fc.boolean(),
  grantScope: fc.option(fc.constantFrom(...SCOPES), { nil: undefined }),
  grantAsRequester: fc.boolean(),
  ownerMessages: fc.boolean(),
});

describe("fuzz: decide() invariants", () => {
  it(
    "never allows a forbidden, unauthorized or unapproved action",
    async () => {
      await fc.assert(
        fc.asyncProperty(scenario, async (s) => {
          const tool = TOOLS[s.tool] as string;
          const target = TARGETS[s.target];
          const requester = REQUESTERS[s.requester];
          const h = makeBroker({
            policy: {
              ...(s.allowAll ? { allow: ["*"] } : {}),
              folders: [{ path: "/Users/o/Projects", mode: "rw" }],
              exec: { execHostEnabled: s.execHost },
            },
          });
          const c = call(tool, SIDE[s.side] as SideEffect, target, {
            ...(tool === "exec_host"
              ? {
                  binding: {
                    argv: ["/bin/ls"],
                    cwd: "/tmp",
                    executable: "/bin/ls",
                    executableSha256: `sha256:${"e".repeat(64)}`,
                  },
                }
              : {}),
          });
          const ctx: PolicyContext = {
            ...CTX,
            permissionMode: s.mode,
            taint: s.taint,
            ...(s.newTarget === undefined ? {} : { newTarget: s.newTarget }),
            ...(requester === undefined ? {} : { requester }),
            ...(s.ownerMessages ? { ownerMessages: ["please do it"] } : {}),
          };

          // Optionally a standing grant first, approved by the owner in a clean balanced turn.
          if (s.grantScope !== undefined) {
            const grantCtx: PolicyContext = {
              ...CTX,
              ...(s.grantAsRequester && requester !== undefined ? { requester } : {}),
            };
            const pre = await h.broker.decide(c, grantCtx);
            if (pre.decision === "ask" && pre.scopesOffered?.includes(s.grantScope)) {
              const issued = await h.broker.requestApproval({
                kind: pre.approvalKind ?? "connector_action",
                summary: "fuzz",
                details: {},
                bindingHash: pre.bindingHash ?? "",
                grantKey: pre.grantKey ?? "",
                requestedBy: {
                  runId: CTX.runId,
                  taskId: CTX.taskId ?? null,
                  threadId: CTX.threadId,
                },
                sideEffect: c.sideEffect,
                ...(target === undefined ? {} : { target }),
                surfaces: ["desktop"],
                taint: false,
              });
              h.clock.advance(500);
              await h.broker.answer({
                approvalId: issued.approval.id,
                answerToken: issued.answerTokens.desktop ?? "",
                decision: "approve",
                scope: s.grantScope,
                decidedBy: DEVICE,
                ...(pre.typedConfirmation === undefined
                  ? {}
                  : { typedConfirmation: pre.typedConfirmation }),
              });
            }
          }

          const d = await h.broker.decide(c, ctx);
          const se = d.sideEffect;
          const why = JSON.stringify({ s, tool, d: { decision: d.decision, rule: d.rule, se } });

          // Every result is explained.
          expect(d.rule.length, why).toBeGreaterThan(0);
          expect(d.trace.at(-1), why).toBe(`${d.decision}:${d.rule}`);
          // Effective class is never below the declared one.
          expect(SEVERITY[se], why).toBeGreaterThanOrEqual(SEVERITY[c.sideEffect]);

          if (d.decision === "allow") {
            expect(FORBIDDEN.has(tool), why).toBe(false);
            if (tool === "exec_host") {
              // Security §5.4: only when enabled, and only by an `always` grant bound to argv + cwd.
              expect(s.execHost, why).toBe(true);
              expect(d.rule, why).toMatch(/^grant:/);
            }
            expect(se, why).not.toBe("financial");
            if (se === "destructive") expect(d.rule, why).toMatch(/^grant:/);
            if (s.mode === "plan") expect(se, why).toBe("none");
            if (s.taint && s.newTarget === true)
              expect(SEVERITY[se], why).toBeLessThan(SEVERITY.write);
            if (requester?.role === "allowed")
              expect(SEVERITY[se], why).toBeLessThanOrEqual(SEVERITY.read);
            if (requester?.role === "designated") {
              expect(
                ["exec", "credentials.request", "browser.click", "computer.click", "memory"],
                why,
              ).not.toContain(tool);
            }
            expect(LOOPBACK_OR_BAD.has(s.target), why).toBe(false);
          }
          if (d.decision === "ask") {
            expect(d.bindingHash, why).toMatch(/^sha256:[0-9a-f]{64}$/);
            const allowed = allowedScopes(se, d.approvalKind ?? "connector_action");
            for (const sc of d.scopesOffered ?? []) expect(allowed, why).toContain(sc);
            if (se === "financial") expect(d.scopesOffered, why).toEqual(["once"]);
          }
        }),
        { seed: FUZZ.seed, numRuns: FUZZ.asyncRuns },
      );
    },
    FUZZ.timeoutMs,
  );
});
