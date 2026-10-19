# @psyche/permissions

**Owner:** S05 (`prompts/s05-permissions-audit.md`). Feature ids: F1–F12 in [docs/03-feature-spec.md](../../docs/03-feature-spec.md).

The Permission Broker: the only component that can authorize a side effect (architecture §4.6, security §3). It implements the `PermissionBroker` contract (`packages/protocol/src/contracts/PermissionBroker.ts`) and passes `describePermissionBrokerConformance` on both stores.

## Public API

```ts
import { createPermissionBroker, SqlitePermissionStore, createPermissionHandlers } from "@psyche/permissions";
import { createAuditLog, Receipts, SqliteReceiptStore } from "@psyche/audit";

const audit = createAuditLog({ dir: `${home}/audit`, redact: vault.redact });
const broker = createPermissionBroker({
  approvers,                                   // ApproverDirectory: devices with operator.approvals, owner senders
  store: new SqlitePermissionStore(db.sqlite), // or MemoryPermissionStore (default)
  receipts: new Receipts({ audit, store: new SqliteReceiptStore(db.sqlite) }),
  audit, notifier, policy, psycheHome: home,
  localProject,                                // LocalProjectVerifier for §3.10 (default: deny all loopback)
  presence,                                    // optional PresenceVerifier (design-04)
});
await broker.reissue();                        // at every Gateway boot
const api = createPermissionHandlers(broker, audit); // approvals.*, grants.*, audit.*
```

- `decide(call, ctx)` → `PolicyDecision` (`allow | ask | deny`, deciding `rule`, `trace`, and for `ask`: `approvalKind`, `bindingHash`, `grantKey`, `scopesOffered`, `typedConfirmation`, `deferred`).
- `requestApproval`, `answer`, `awaitDecision`, `verifyBinding`, `get`, `list`, `reissue`, `revokeRunAuthority` (contract).
- `recordReceipt`, `listReceipts` (contract) plus `broker.receipts.reconcile()` for `uncertain` outcomes.
- Grant ledger: `listGrants`, `revokeGrant` (contract) plus `revokeAllGrants`, `revokeGrantsByDevice`, `revokeMcpGrants(serverId, toolsListHash)`, `endTask`, `endSession`, `exportGrants`.
- `setPolicy(config)` (takes effect on the next call), `subscribe(listener)` for `approval.created | decided | expired | invalidated`, `grant.created | used | revoked`, `receipt.created`, `task.paused | downgraded`. Events never carry answer tokens.
- Bindings: `bindingFor(kind, args)`, `bindingHash`, `grantKeyHash`; targets: `canonicalUrl`, `canonicalEmail`, `canonicalPath`.
- Cards: `renderForSurface(surface, approval)`, `sanitizeDisplay` (design-12).
- Classifier: `ActionClassifier`, `RulesClassifier` (default), `ModelClassifier` (over `ModelProvider`, enabled by `classifier.model`).

### Extensions of the contract types

All optional, so callers that only know the contract get the strict defaults (`src/types.ts`). They are listed for a `protocol:` PR in `docs/status/s05.md`.

- `PolicyCall`: `binding` (kind-specific arguments, see below), `meta` (`connector`, `app`, `action`, `field`, `permanentDelete`, `captcha`, `accountCreation`, `testCredential`, `network`, `writesOutsideWorkspace`, `mcpTier`), `toolCallId`.
- `PolicyContext`: `taintSources`, `initiator` (`content` is a hard prohibition, `mcp_app` taints), `originSet`, `ownerMessages`, `task` (`goalAuthoredBy`, `goalTainted`).
- `PolicyAnswerInput`: `presence`, `typedConfirmation`.

## Evaluation order (security §3.3)

1. **Hard prohibitions** (`src/prohibitions.ts`, not configurable): instructions from content; settings, grants, devices, pairing and policy tools; writes to `$PSYCHE_HOME` config / state / audit and any vault access; Safari / Passwords / keychain paths; model-visible secrets; `{{cred:…}}` placeholders outside `credentials.*` and exec env values; typing into password fields; credential fills into the wrong field class (design-01); CAPTCHAs; transfers and trades; non-canonical URLs; the Gateway's own origin; loopback origins that are not the owner's project (resolved address, listener PID spawned by Psyche, not a Psyche or well-known port; design-03); card / IBAN / SSN entry (published test cards only on the owner's project); dangerous exec env names (design-14); untrusted-derived writes to protected memory. Permanent deletion asks `once` with the typed word `DELETE`; third-party account creation always asks.
2. **User deny rules**, plus plan mode, `exec_host` off, connector matrices, site rules, origin sets, folder grants (outside → deny, `ro` + write → deny) and app tiers with fixed caps.
3. **Hooks**: `deny` or `ask`, never `allow`; a rewrite restarts at step 1 and the final call asks `once`.
4. **Taint**: write+ on a new target, navigation to a new origin, a fill whose origin is not a tainting origin, exec with network or outside writes → `ask` regardless of grants.
5. **Standing grants** (and configured allowances: allow rules, connector `allow`, `rw` folders, `rw` origin sets, app tiers).
6. **Mode default** (security §3.2 table).
7. **Classifier** in `auto` mode for writes that would be allowed. Fails closed to `sensitive`; two `prohibited` pause the Task, three consecutive `sensitive` downgrade it to `balanced`.

Calls of `browser_submit`, `credential_fill` and `mcp_tool` without kind-specific `binding` arguments get `once` only, because the field checks (cross-origin form actions, fill field class, the `tools/list` hash) cannot run. A precomputed `bindingHash` / `grantKey` must equal what the arguments give, and a call whose tool implies a strict kind (`exec_host`, `purchase`, …) cannot be relabelled with another `kind`. Path rules, protected paths and bundle ids compare without case (APFS).

The broker floors declared side-effect classes (`src/kinds.ts`): a registry or node can make a tool stricter, never laxer (design-20).

## Designated persons and other senders (M2)

`PolicyContext.requester` says who asked for the call. S02 fills it from S10's `RouteContext`: `role`, `identityId`, `links`, `toolAllow`. Absent means the owner. Security §9:

- **`designated`:**
  - Fixed persona limits: no `exec`, vault or credential fills, purchases, browser or app writes, protected memory, skill installs, pairing or policy changes (`designated:persona_limit`).
  - The identity's `toolAllow` globs apply (`designated:not_in_tool_allow`).
  - So does the owner's per-person matrix, `policy.designated[identityId] = { allow, ask, deny }`.
  - Every `destructive` action asks the owner.
  - The owner's own configured allowances do not apply.
- **`allowed`** (allowlisted, neither owner nor designated): nothing above `read` (`requester:not_owner`).
- **Grants are per requester:** `grants.requester_id` (migration `202610201600_permissions_requester.sql`). The owner's grants never cover anyone else, and a grant approved for one person's request covers only that person.
- **Approval cards** go to the owner's surfaces. The requester's own chats (`links`, `channel:senderId`) are stripped, and `details.requestedFor` names the person.

## Binding hashes

`bindingHash = sha256("psyche.binding.v1|" + kind + "|" + canonicalJSON(fields))`, `grantKey = sha256("psyche.grantkey.v1|" + kind + "|" + canonicalJSON(keyFields))`, over the strict canonical JSON in `@psyche/audit` (throws on NaN, ±Infinity, -0, non-plain objects, `undefined` in arrays, lone surrogates; no NFC folding; design-13). Security §3.5 is the normative table; extra fields from data model §4.2 and S23 are included:

| Kind | Bound fields | Grant key |
| --- | --- | --- |
| `exec`, `exec_host` | argv (exact), cwd, env (`k=v`, sorted), executable, executableSha256 (required for `exec_host`), sandboxId, stdinSha256, network, cwdConfigHashes | argv, cwd, env, executable, executableSha256, cwdConfigHashes, stdinSha256, network, sandboxId |
| `send_email` | account, to / cc / bcc (addr-spec, lowercased, punycode, sorted), subject, bodySha256, htmlSha256, mimeSha256, from, sender, replyTo, inReplyTo, references, other headers, attachments | account + exact recipient set |
| `calendar_write` | account, calendarId, operation, eventSha256 | account, calendarId, operation |
| `message_send` | channel, account, recipient, bodySha256, attachments | channel, account, recipient |
| `browser_submit` | origin, pathname, action URL and origin, method, sorted field names (hidden included), values digest, submitRef | origin, pathname |
| `credential_fill` | itemId, origin, field selector (ref, name, element type), field, tabId | itemId, origin |
| `purchase` | merchant, amountMinor (safe integer), currency, line-item hash, paymentSourceId | — (`once` only) |
| `file_write` | realPath, operation, contentSha256, mode | folder-grant root, operation |
| `mcp_tool` | serverId, tool, toolsListHash, argsSha256 | serverId, tool, toolsListHash |
| `computer_action` | app, tierRequired, action, elementRefSha256, textSha256 | app, tierRequired |
| `new_origin` | origin, taskId | origin |
| other kinds | tool, paramsHash, target | tool, target |

## Grant scopes

| Scope | Lifetime (default) | Notes |
| --- | --- | --- |
| `once` | until dispatch (`verifyBinding` consumes it) | only via the approval id, never via `decide` |
| `task` | 24 h, 8 h for `destructive` (design-28), ends at `endTask` | covers only that Task |
| `site` | 30 days | one origin; `credential_fill` binds item + origin |
| `session` | 12 h idle, 24 h absolute; ends at restart (boot id) and `/new` | stored as its own scope with boot and thread (design-28) |
| `always` | 90 days (`exec_host` 30 days) | refused for cwd-config executables unless their config hashes are bound |

`destructive` offers `once | task`, `financial` and `purchase` `once`, `credential_fill` `once | site`, `exec_host` `once | always`. Chat surfaces answer `once` only (design-28) and never see device-only kinds or `destructive` / `financial` requests (architecture §4.6).

## policy.json

The owner-authored policy (`config.json` → `permissions`). Schema: [`policy.schema.json`](policy.schema.json) (regenerate with `pnpm --filter @psyche/permissions gen:schema`); example: [`policy.example.json`](policy.example.json). Rule strings: `"<tool glob>"`, `"<tool glob>(<target glob>)"`, or `"origin: | path: | recipient: | app: | account: | command:<glob>"`. Path globs keep `*` inside a segment and `**` across; `*.example.com` never covers the bare domain. Unknown keys are rejected so a typo cannot silently disable a rule.

## How this maps to the docs

- Architecture §2 (principles 2–4), §4.6; security §2 (approval replay row), §3, §9 (chat approvals), §10 (answer rate limit), §11 (`tools/list` hash), §12 (app tiers); data model §4 (tables `approvals`, `grants`, `policy_rules` in `packages/db/migrations/202610200900_permissions_init.sql`).
- S23 design findings with tests: 01 (fill field class), 03, 04, 07, 08 (broker side), 09, 11, 12, 13, 14, 20 (tokens, node answers, side-effect floors), 28. See `test/s23-review.test.ts`.

## What is stubbed

- `PresenceVerifier` and `LocalProjectVerifier` are interfaces: the Gateway / mac helper supply WebAuthn and Touch ID verification, DNS resolution and listener-PID lookup.
- Card rendering for desktop, web and chat belongs to S12 / S10; `renderForSurface` is the shared text template they should use.
- The unattended approvals queue keeps the 30-minute expiry; re-deriving queued proposals (design-28 #5) is S04's.
- Per-sender grant matrices for designated persons (M2, with S10); model-backed classifier evaluation set (M2).
