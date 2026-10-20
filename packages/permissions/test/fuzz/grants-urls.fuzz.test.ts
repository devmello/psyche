import type { GrantScope, SideEffect } from "@psyche/protocol";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canonicalUrl, isLoopbackName, TargetError } from "../../src/index.ts";
import { CTX, call, DEVICE, makeBroker, origin } from "../helpers.ts";
import { FUZZ } from "./config.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Upper bound of a grant's life from creation (security §3.4, design-28). */
function bound(scope: GrantScope, se: SideEffect): number {
  switch (scope) {
    case "task":
      return se === "destructive" ? 8 * HOUR : 24 * HOUR;
    case "site":
      return 30 * DAY;
    case "session":
      return 24 * HOUR;
    case "always":
      return 90 * DAY;
    default:
      return 0;
  }
}

describe("fuzz: grant scopes and TTLs never outlive their bounds", () => {
  it(
    "expiry, renewal and use never carry a grant past its scope's bound",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom<SideEffect>("write", "destructive"),
          fc.constantFrom<GrantScope>("task", "site", "session", "always"),
          fc.array(fc.integer({ min: 1, max: 40 * DAY }), { minLength: 1, maxLength: 8 }),
          async (se, scope, steps) => {
            const h = makeBroker();
            const c = call(
              se === "write" ? "calendar.create" : "messages.send",
              se,
              origin("https://cal.example.com"),
            );
            const d = await h.broker.decide(c, CTX);
            if (d.decision !== "ask" || !(d.scopesOffered ?? []).includes(scope)) return;
            const issued = await h.broker.requestApproval({
              kind: d.approvalKind ?? "connector_action",
              summary: "fuzz",
              details: {},
              bindingHash: d.bindingHash ?? "",
              grantKey: d.grantKey ?? "",
              requestedBy: { runId: CTX.runId, taskId: CTX.taskId ?? null, threadId: CTX.threadId },
              sideEffect: se,
              target: { kind: "origin", value: "https://cal.example.com" },
              surfaces: ["desktop"],
              taint: false,
            });
            h.clock.advance(500);
            const a = await h.broker.answer({
              approvalId: issued.approval.id,
              answerToken: issued.answerTokens.desktop ?? "",
              decision: "approve",
              scope,
              decidedBy: DEVICE,
            });
            const created = Date.parse(a.decidedAt ?? "");
            for (const step of steps) {
              h.clock.advance(step);
              const r = await h.broker.decide(c, CTX);
              const [g] = await h.broker.listGrants({ includeRevoked: true });
              const why = JSON.stringify({
                se,
                scope,
                steps,
                elapsed: h.clock.now() - created,
                r: r.rule,
              });
              expect(Date.parse(g?.expiresAt ?? "") - created, why).toBeLessThanOrEqual(
                bound(scope, se),
              );
              if (h.clock.now() - created >= bound(scope, se)) {
                expect(r.rule.startsWith("grant:"), why).toBe(false);
              }
            }
            // Restarts end session grants; the end of the Task ends task grants.
            await h.broker.reissue();
            await h.broker.endTask(CTX.taskId ?? "");
            const after = await h.broker.decide(c, CTX);
            if (scope === "session" || scope === "task")
              expect(after.rule.startsWith("grant:")).toBe(false);
          },
        ),
        { seed: FUZZ.seed, numRuns: FUZZ.asyncRuns },
      );
    },
    FUZZ.timeoutMs,
  );
});

// Alternate spellings of loopback and unspecified addresses that URL parsers accept.
const LOOPBACK_FORMS = [
  "localhost",
  "LOCALHOST",
  "localhost.",
  "app.localhost",
  "app.test",
  "127.0.0.1",
  "127.1",
  "127.255.255.254",
  "2130706433",
  "0x7f000001",
  "0177.0.0.1",
  "0x7f.1",
  "0.0.0.0",
  "0",
  "[::1]",
  "[::]",
  "[0:0:0:0:0:0:0:1]",
  "[::ffff:127.0.0.1]",
  "[::ffff:7f00:1]",
  "127.0.0.1.nip.io",
  "app.127.0.0.1.sslip.io",
  "lvh.me",
];

describe("fuzz: origin and localhost rules fail closed", () => {
  const junk = fc.oneof(
    fc.string({ maxLength: 40 }),
    fc.webUrl({ withQueryParameters: true, withFragments: true }),
    fc
      .tuple(
        fc.constantFrom(
          "http",
          "https",
          "HTTP",
          "javascript",
          "file",
          "data",
          "ftp",
          "ws",
          "android",
          "blob",
        ),
        fc.string({ maxLength: 20 }),
      )
      .map(([s, rest]) => `${s}:${rest}`),
    fc
      .tuple(fc.webUrl(), fc.string({ minLength: 1, maxLength: 6 }), fc.string({ maxLength: 6 }))
      .map(([u, user, pw]) => u.replace("://", `://${user}:${pw}@`)),
  );

  it("canonicalUrl returns a canonical http(s) origin or throws TargetError, nothing else", () => {
    fc.assert(
      fc.property(junk, (input) => {
        let out: ReturnType<typeof canonicalUrl> | undefined;
        try {
          out = canonicalUrl(input);
        } catch (e) {
          expect(e, input).toBeInstanceOf(TargetError);
          return;
        }
        expect(["http", "https"]).toContain(out.scheme);
        expect(out.origin).not.toContain("@");
        expect(out.origin).toBe(out.origin.toLowerCase());
        // Idempotent: the canonical origin canonicalizes to itself.
        expect(canonicalUrl(out.origin).origin, input).toBe(out.origin);
      }),
      { seed: FUZZ.seed, numRuns: FUZZ.numRuns },
    );
  });

  it(
    "a navigation to any loopback spelling or malformed URL is never allowed",
    async () => {
      const h = makeBroker({ policy: { allow: ["*"] } });
      const auto = { ...CTX, permissionMode: "auto" as const };
      await fc.assert(
        fc.asyncProperty(
          fc.oneof(
            junk,
            fc
              .tuple(
                fc.constantFrom(...LOOPBACK_FORMS),
                fc.option(fc.integer({ min: 1, max: 65535 }), { nil: undefined }),
                fc.constantFrom("http", "https"),
              )
              .map(
                ([host, port, scheme]) =>
                  `${scheme}://${host}${port === undefined ? "" : `:${port}`}/x`,
              ),
          ),
          async (url) => {
            const d = await h.broker.decide(
              call("browser.navigate", "read", origin(url), { kind: "new_origin" }),
              auto,
            );
            let host: string | undefined;
            try {
              host = canonicalUrl(url).host;
            } catch {
              // Denied, usually as invalid_target; a credential-shaped URL is caught earlier.
              expect(d.decision, `${url} → ${d.rule}`).toBe("deny");
              expect(d.rule, url).toMatch(/^(prohibition|binding):/);
              return;
            }
            if (isLoopbackName(host)) expect(d.decision, `${url} → ${host}`).toBe("deny");
          },
        ),
        { seed: FUZZ.seed, numRuns: FUZZ.numRuns },
      );
    },
    FUZZ.timeoutMs,
  );

  it("every loopback spelling canonicalizes to a loopback-like host", () => {
    for (const host of LOOPBACK_FORMS) {
      const h = canonicalUrl(`http://${host}/`).host;
      expect(isLoopbackName(h), `${host} → ${h}`).toBe(true);
    }
  });
});
