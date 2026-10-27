# design-04: a click is accepted as a device-only approval, with no proof of user presence bound to the request

**Severity:** Critical. **Surface:** approvals, web UI, notifications, chat. **Docs:** 05 §3.7, §9, §10, §16.6; 02 §4.6, §11; `PermissionBroker.answer`. **Owners:** S05, S11, S14.

## Attack

An answer is valid if it carries the surface's `answerToken`, arrives in time and comes from "a paired device with `operator.approvals`". Architecture §4.6 counts `web` as a device surface for `deviceOnly` kinds, and only macOS notifications for purchases and fills require `authenticationRequired`. So:

1. **Web UI XSS → financial approval.** Any script running in the web UI origin (a sanitizer bypass in streamed Markdown, the email-preview HTML, a viewer bug, a malicious plugin's UI contribution) holds the web surface's `answerToken` for every pending card. It calls `approvals.answer({approvalId, answerToken, decision: "approve"})` for a `purchase` or `credential_fill`. Nothing ties the answer to a human; the 400 ms arming delay is measured server-side from delivery, and a script simply waits.
2. **Lock-screen notification.** `write` and `destructive` notifications without `authenticationRequired` can be approved from the lock screen of an unattended Mac, by anyone in the room.
3. **Spec contradiction.** 02 §4.6 and §17 say chat approves `write` only and `destructive` is device-only. 05 §3.7, §9 and the `chatSurfacesMaySee: ["write","destructive"]` example still deliver `destructive` sends to Telegram and iMessage, and 05 §16.6 lists it as open. Implementers will pick one at random: S05 builds whichever its broker reads, and S10 sends buttons for whatever it is given.

## Assumption broken

"Paired device" equals "owner present". A device token (or a web session) authenticates a *client*, not a *decision*.

## Proposed control

- For `deviceOnly` kinds, require a **presence assertion over the `bindingHash`**: WebAuthn `get()` with `challenge = sha256(approvalId || bindingHash || answerToken)` and `userVerification: "required"` on web, or a helper-signed Touch ID (`LAContext` + Secure Enclave key) signature on macOS. The broker verifies the signature against the device's registered key before `answer` succeeds.
- Every notification carrying Approve sets `authenticationRequired`. Lock-screen previews of approvals show "Approval pending", not the summary.
- Settle 05 §16.6 now in line with architecture §4.6 (chat = `write` only), and change 05 §3.7, §9 and the §3.11 config example to match.
- Approval cards render in a separate, script-free origin (or the desktop's native card) so web-UI XSS cannot read the tokens.

## Test case

```ts
const { approval, answerTokens } = await broker.requestApproval({ kind: "purchase", sideEffect: "financial",
  surfaces: ["desktop", "web", "telegram:1"], /* … */ });
expect(approval.surfaces).not.toContain("telegram:1");                         // device-only stripped
clock.advance(500);
await expect(broker.answer({ approvalId: approval.id, answerToken: answerTokens.web, decision: "approve",
  decidedBy: { deviceId: "dev_web" } })).rejects.toMatchObject({ code: "presence_required" });
await expect(broker.answer({ /* same */ presence: webauthnAssertion({ challengeFor: "other-approval" }) }))
  .rejects.toMatchObject({ code: "presence_invalid" });
// destructive email.send must not be offered to chat either:
const r2 = await broker.requestApproval({ kind: "send_email", sideEffect: "destructive", surfaces: ["telegram:1", "desktop"] });
expect(r2.approval.surfaces).toEqual(["desktop"]);
```

Expected: a click without a presence assertion is rejected; an assertion made for another approval is rejected; chat surfaces are stripped for `destructive`.
