---
name: psyche-permissions
description: Changing Psyche's permissions, approvals and trust code. Covers the broker and its answer limits, approval cards and presence (Touch ID or password, for payments only), sealed security settings, the Auto-mode model allowlist, and every rule that classifies inputs into a risk class, above all the payment rule in money-intent (computer use, browser, MCP). Use for any change in packages/permissions, apps/gateway/src/security, presence or approvals handlers, compose/helper.ts, compose/computer.ts money checks, the model-router allowlist or packages/protocol/src/money-intent.ts.
---

# Permissions, approvals and classifiers

Every PR here gets an independent security review. In the five PRs of 2026-11-09, the three in this area needed 2 to 5 fix rounds each (#1299, #1300, #1301). The traps below caused most of those rounds. Read them before the first edit.

## Where things live

- **Broker:** `packages/permissions/src/broker.ts`. It handles answers, the failure cap and `requiresAuthentication` (financial, purchase or an explicit flag). Its handlers are in `packages/permissions/src/handlers.ts`, and the deterministic classifier is `RulesClassifier` in `classifier.ts`. No model classifier is wired in.
- **Presence gate:** `apps/gateway/src/presence-gate.ts` and the context fields `presenceState` and `presenceCanVerify` (`apps/gateway/src/context.ts`). Mac sheets and helper signing are in `compose/helper.ts`.
- **Seal:** `apps/gateway/src/security/seal-spec.ts` (`isSecuritySettingKey`) and `state-seal.ts` (`isAuthorizingSetting`, `reseal()`). Presence for settings is `needsPresence` with `OWNER_CHOICE_KEYS` in `apps/gateway/src/handlers/settings.ts`.
- **Payment rule:** `packages/protocol/src/money-intent.ts` (`@psyche/protocol/money-intent`), used by `compose/computer.ts`, `packages/browser/src/tools/classify.ts` and `packages/mcp-host/src/policy.ts`. The owner's override is `mcp.handlesMoney.set` (`compose/mcp-manage.ts`).
- **Auto allowlist:** `AUTO_MODE_KIND_RULES` in `packages/model-router/src/router.ts`.
- **Spec:** `docs/05-security-and-permissions.md`, with §3.7 for approvals and presence and §3.12 for floors.

## Owner decisions (don't "fix" these)

- Approvals are a plain tap from a paired device. Touch ID or the password is only for payments: `financial` or `purchase`. The financial floor is never liftable, and a payment is `once` only, never Always. (2026-11-09)
- Mac-control approvals stay a tap from any device. A stolen admin device is an accepted residual risk, documented in §3.7. (2026-11-09)
- Auto is allowed on the smallest model tiers too. (2026-11-09)
- The one exception to payments-only: adding a verifier (a first passkey, a Windows Hello key, applying a presence reset at once) needs the presence step whenever a helper can verify (`presenceCanVerify`), so a stolen admin device can't enrol its own authenticator (§3.7).

## 1. Trust comes from the connection only

`local`, `decidedBy`, scope and surface are set by the server from the connection (`Caller`). Never spread client `params` into a call that carries them. Protocol schemas accept extra keys, so a client can send `local: true`. Pass trust as a separate argument, the way `broker.answer(input, { local: c.local === true })` does. (#1299 R2: a remote device spoofed `local: true` and dodged the lockout.)

## 2. Changing a shared predicate

A fix that changes who counts as local, enrolled, ready, owner-choice or financial changes every caller of that predicate. Twice on 2026-11-09 the fix for one finding opened the next hole:
- #1299 R2: the per-call `local` flag led to the params spoofing.
- #1301 R2: the enrollment fix for finding 5 opened B1, a first passkey with no sheet.

Before you push such a fix:
1. `git grep` the predicate and list every caller in your report. Say for each whether it should widen, narrow or stay the same.
2. Add a test for at least one caller you did *not* mean to change, asserting that it still behaves as before.
3. When you drop a presence step from a security setting, keep it sealed. `permissions.mode` stayed in `isSecuritySettingKey` through `OWNER_CHOICE_KEYS` (#1300 R1, finding 2).

## 3. Classifiers: precise both ways

This covers any rule that sorts inputs into "asks" and "doesn't ask": money-intent, the failure cap's guessing-shaped rejections, the Auto allowlist. A miss lets a payment through on a tap, and a false match puts a sheet in front of an ordinary action. The rule in money-intent:
- **Verb plus object or amount:** a money verb needs a money object ("send money") or an amount ("Send $50", "Send 0.1 ETH"). A bare payment label also counts ("Pay", "Place bid"). A word alone doesn't: "transfer", "checkout", "card" and "token" name git, files and logins as often as payments.
- **Navigation never pays:** a link or a GET form doesn't pay. Only the control that submits does. Quote, estimate and preview tools move nothing.
- **Every activation path:** a click by point, Return, Enter, Space, a typed newline or space, and Tab followed by any of those. Check what is under the point or the focus (`computer.resolve_target`) before each piece that could activate (`moneyUnderFocus`, `moneyAfterFocusMove`). #1301 needed rounds 3, 4 and 5 to cover keyboard, Tab and space one at a time.
- **Fail closed:** if the target can't be read (an old helper, a Windows or Linux helper), refuse with `point_unchecked` or `focus_unchecked`. Don't let it through.
- **Unlabelled targets:** treat them as unknown and use context: the window title or URL, the parent labels, a recent payment in the same app.
- **An owner flag beats the heuristic:** a tool renamed to dodge the words still pays under `handlesMoney`. A raw `settings.set` must not be able to clear that flag.
- **Match on kind:** match on the provider's kind, never on an id a user can choose. #1300 R2: the id `anthropic` on an `anthropic-compatible` endpoint passed, and the real CLI refs didn't.

**Write the probe table first.** Before you change a rule, write a table-driven test with two lists: inputs that must match, and near-misses that share a word and must not. The pattern is `packages/protocol/test/money-intent.test.ts`: `PAYMENT_LABELS` and `ORDINARY_LABELS` with `it.each`. Include amounts with decimals, tickers, keyboard paths, snake_case and camelCase tool names, and the reviewer's probes from every earlier round. Every review finding becomes a row that failed before your fix. In #1301, round 1 widened regexes one way only. Rounds 2 to 5 each found misses in the other direction, and the reviewers' two-way probe lists caught them.

## 4. Tests to run

`verify.sh` runs the related tests. These suites break most often when this area changes:
- **permissions:** `answer-lockout`;
- **gateway:** `passkeys`, `remote-presence`, `payments-only-presence`, `seal-owner-choice` and the other `seal-*` suites, `mode-switch`, `computer`, `compose-mcp`, `device-rate-limits`;
- **protocol:** `money-intent`.

If you change copy that names Touch ID, presence or approvals, also run `packages/ui/test/platform-*.test.tsx` (#1301 R3).

## Learnings

(The `reflect` skill adds dated lines here.)
