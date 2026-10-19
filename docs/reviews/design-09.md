# design-09: re-issuing approvals after a restart re-evaluates policy without the parked call's taint

**Severity:** High. **Surface:** Permission Broker `reissue()`, task leases. **Docs:** 05 §3.6, §3.7 (Restart); 04 §2 `tool_calls.taint_in`; `PermissionBroker.reissue`. **Owners:** S05, S04.

## Attack

§3.7: "A Gateway restart marks pending requests `invalidated(gateway_restart)`, **re-evaluates policy for the parked call** and issues a fresh request." Taint is "turn-scoped", and `DecisionContext.taint` is computed by the caller, the agent loop, from turn state that lives in memory.

1. A tainted turn produces `browser.submit` on `https://shop.example` with a new recipient address. A `site` grant exists for that origin, so without taint it would be `allow`; with taint it is `ask`. The turn parks in `awaiting_approval`.
2. The attacker forces a restart. A page that crashes the renderer is enough if the Gateway hosts the browser bridge; so are a memory spike (a `fetch` of a 2 GB response, if caps are enforced after buffering), an auto-update, or simply the nightly restart a user's launchd schedule triggers.
3. On boot, `reissue()` re-evaluates the parked call. If it rebuilds `DecisionContext` from the persisted call without `taint_in` (or with `taint: false` because the turn object is gone), the decision is `allow` (`grant:site`). The call dispatches with no card. The old card answers "re-issued".

A narrower version: the re-evaluation happens under a *changed* policy. The owner widened a grant while the request was pending, and the parked call now passes without the owner having seen it.

## Assumption broken

Re-evaluation is assumed to be at least as strict as the original decision. Nothing pins the inputs.

## Proposed control

- Persist the full `DecisionContext` (taint, `taintSources[]`, `newTarget`, mode, unattended) on the `approvals` row at creation. `reissue()` uses the persisted context, and the result may only be **equal or stricter** (`ask` stays `ask` at minimum). A re-issued request is never auto-allowed. It always yields a fresh `ask`, or `deny` if policy now denies.
- Only `once` grants that the original approval created are dropped at restart. A parked call never dispatches from `reissue()` without a new answer.

## Test case

```ts
const broker = makeBroker({ db });
await broker.grants.create({ scope: "site", kind: "browser_submit", subject: { origin: "https://shop.example" } });
const call = { tool: "browser.submit", sideEffect: "write", kind: "browser_submit",
  target: { kind: "origin", value: "https://shop.example" }, params: { fields: ["address"] }, paramsHash: "sha256:…" };
const d1 = await broker.decide(call, { threadId: "t", runId: "r", permissionMode: "balanced", taint: true, newTarget: true });
expect(d1.decision).toBe("ask");
const { approval } = await broker.requestApproval({ /* from d1 */ taint: true, surfaces: ["desktop"] });

const rebooted = makeBroker({ db });               // same DB, fresh process state
const reissued = await rebooted.reissue();
expect(reissued).toHaveLength(1);
expect(reissued[0].approval).toMatchObject({ taint: true, status: "pending" });
expect((await rebooted.get(approval.id))?.status).toBe("invalidated");
expect(dispatched(call)).toBe(false);            // nothing ran during reboot
```

Expected: a fresh pending request with `taint: true`, the old one invalidated, and no dispatch.
