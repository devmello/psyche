# design-28: grant-scope semantics differ between the docs, so grants can outlive or exceed what the owner chose

**Severity:** Medium. **Surface:** grant ledger, approval answers that pick a scope, unattended approvals queue. **Docs:** 05 §3.4, §3.7, §9; 02 §4.5, §4.6; `PermissionBroker.answer` (`scope`), `reissue`. **Owners:** S05, S10, S04.

## Attack

1. **`session` has two definitions.** 05 §3.4: "until `/new`, Gateway restart, or 12 h idle". 02 §4.6: "stored as `always` with `expiresAt` set to the end of the current app session". The end of an app session cannot be known at write time. An implementation that stores `always` with a placeholder `expiresAt` (for example now + 12 h) and does not revoke on restart (`reissue()` is documented to revoke session grants, but only if the grant is still tagged `session`) gives an `always` grant to whoever later reads the ledger. Activity renews the idle timer forever.
2. **Chat answers choose the scope.** `ApprovalAnswer.scope` is optional and set by the answering surface. `/approve <id> always`, or a Telegram button whose `callback_data` the client edits (`…:task` → `…:always`), asks for a wider scope than the card offered. The contract rejects scopes "not offered", but which scopes are offered *on chat*? The design never limits chat surfaces to `once`. A stolen phone that can approve `write` creates 90-day `always` grants and keeps that authority after the phone is revoked, because grants are not tied to the approving device.
3. **`task` grants for `destructive` last 24 h** and cover the whole Task, including steps added later (plans are rewritable checklists). A long Task that turns tainted halfway still sends to earlier-approved targets, which §3.6 deliberately exempts ("targets approved earlier in the Task").
4. **Unattended queue vs expiry.** Automations defer approvals into the queue, but approvals expire after 30 minutes. A 03:00 automation's approvals expire before the owner wakes. Extending the TTL for queued cards would mean a 09:00 approval dispatches arguments derived from 03:00 page state (a price, a seat), which the owner sees out of context.

## Assumption broken

Scope is what the owner chose on the card. In practice it is whatever the answer field, the storage representation and the renewal rule make of it.

## Proposed control

- Give `session` its own scope value in the ledger, with `sessionId` = the Gateway boot id. `reissue()` revokes every grant whose `sessionId` is not the current boot. Idle expiry is absolute: 12 h after the last use, capped at 24 h after creation.
- Chat surfaces may answer only `once` (and `deny`). The scope is taken from the server-side card state, never from `callback_data`. Grants record `createdByDeviceId` and are revoked when that device is revoked.
- A `task` grant for `destructive` lasts until the Task ends or 8 h, whichever comes first, and taint arriving after the grant was made re-asks for targets outside the original approval's exact set.
- Unattended approvals: the queue keeps a *proposal* (not an approval) without expiry. Opening it re-derives the arguments with a fresh run (or shows them with their timestamp and a "re-check" action) and issues a normal 30-minute request.

## Test case

| # | Steps | Expected |
| --- | --- | --- |
| 1 | answer with `scope: "session"`; then `reissue()` on a new boot id | the grant is revoked (`gateway_restart`) |
| 2 | session grant used every 11 h for 3 days | revoked at 24 h |
| 3 | Telegram answer `{decision:"approve", scope:"always"}` for a `write` card | `invalid_params`; no grant created |
| 4 | approve `task` on device P; revoke P | grants with `createdByDeviceId: P` revoked |
| 5 | automation at 03:00 requests `send_email`; owner opens it at 09:00 | old request `expired`; a new request with fresh `requestedAt` and re-derived details; no dispatch from the 03:00 binding |
