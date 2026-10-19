# @psyche/notifications

**Owner:** S15 (`prompts/s15-proactive-notifications.md`). Feature id: O10 in [docs/03-feature-spec.md](../../docs/03-feature-spec.md).

The durable notification inbox and its delivery routing: in-app (desktop and web clients through Gateway events), the OS (the mac helper's `notify.show` node capability), and chat channels (`ChannelAdapter`). It handles de-duplication per task, quiet hours, retries, restart reconciliation, and the `notifications.*` method handlers.

```
notify(input)
  │  sync transaction: dedupe lookup → insert or update row → supersede → delivery plan
  ▼
inbox row (durable) ──► subscribe() events ──► Gateway ──► notification.created/updated/resolved (WS)
  │                                                          (desktop + web = "in_app", delivered at once)
  ├─ notification ─► SurfaceAdapter "os"      ─► NodeClient.invoke("notify.show") │ fallback (Electron)
  └─ <channel>:<id> ► SurfaceAdapter "channel" ─► ChannelAdapter.send / sendApprovalButtons
        │
        ├─ quiet hours → status "deferred", dueAt = end of window ─┐
        ├─ retryable failure → "pending", dueAt = now + 30 s·2^(n-1) ├─► flushDue(now) (Gateway timer at nextDueAt())
        └─ suppressed (policy) / failed (gave up)                 ─┘
```

## Public API (`src/index.ts`)

- `createNotifier(options) → PsycheNotifier`, which implements the `Notifier` contract plus:
  - `listPage({unreadOnly, unresolvedOnly, cursor, limit})` backs `notifications.list`. It lists newest first and pages with an opaque cursor (`seq:<n>`).
  - `get(id)`, `deliveries(id)`. Delivery records are per surface: `pending | deferred | delivered | failed | suppressed`, with attempts, `dueAt` and detail.
  - `resolveWithAction(id, actionId)` runs `options.onAction(n, actionId)` and then resolves. `approve`/`deny` on an approval is refused (`invalid_params`): approvals are answered through `approvals.answer` (S05).
  - `flushDue(now?)` and `nextDueAt()`. The Gateway arms one timer for `nextDueAt()` and calls `flushDue` when it fires.
  - `reconcile({tasks?, isStale?})` is called once at boot, after S05 invalidates pending approvals. It returns `{stale, requeued}`.
- Options: `store` (`MemoryNotificationStore` by default, or `SqliteNotificationStore`), `clock`, `newId` (ULID by default), `routing` (an object or a function so settings changes apply live), `adapters`, `retry {maxAttempts = 4, baseDelayMs = 30 000}`, `onAction`.
- Routing (`src/routing.ts`): `resolveSurfaces`, `planDelivery`, `interruptionFor`, `DEFAULT_SURFACES`, `DEFAULT_CHANNEL_KINDS`, `DEFAULT_INTERRUPTION`, and the `RoutingConfig` type.
- Quiet hours (`src/quiet-hours.ts`): `isQuietAt`, `quietEndsAt`, `breaksThrough`, `validateQuietHours`, and the `QuietHoursConfig` type. Times are local `HH:MM` in an IANA zone, windows may cross midnight, `days` filters the day a window starts on, and `breakthrough` defaults to `["approval"]`. The functions are DST-safe.
- Surfaces (`src/surfaces.ts`): `createOsSurface({node, fallback?, timeoutMs?})`, `createChannelSurface({adapter, approval?})`, `toNotifyShowParams`, `channelText`, and the `SurfaceAdapter` interface for new transports (phone push, for example).
- Handlers (`src/handlers.ts`): `createNotificationHandlers(notifier)` returns `{"notifications.list", "notifications.markRead", "notifications.resolve"}` typed from the protocol registry. `toGatewayEvent(e)` maps notifier events to WS events.
- Storage (`src/store.ts`, `src/sqlite-store.ts`): the synchronous `NotificationStore` interface, `MemoryNotificationStore`, `SqliteNotificationStore(db, {migrate?, now?})` on a better-sqlite3 handle, and `notificationsMigrationSql()`.

## Routing matrix (defaults)

| Kind | In-app (desktop, web) | OS (`notification`) | Owner's chat (`channelTargets`) | OS interruption level | Quiet hours |
| --- | --- | --- | --- | --- | --- |
| approval | yes | yes | yes, as buttons, never if `deviceOnly` | timeSensitive | breaks through |
| input_needed | yes | yes (text reply when the action id is `reply`) | yes | active | deferred |
| task_done / task_failed | yes | yes | yes | active | deferred |
| reminder | yes | yes | yes | passive | deferred |
| proactive / briefing | yes | no (opt in per kind) | no | passive | deferred |
| system | yes | no | no | passive | deferred |

Explicit `surfaces` on `notify` replace the defaults. `os` is accepted as an alias of the protocol's `notification`. In-app delivery is never deferred: the inbox row is written at once, and quiet hours only hold back interruptions.

## Behaviour rules

- **Dedupe.** The key is `dedupeKey`, or `<kind>:<taskId>` by default. A second `notify` while the first is unresolved updates title, body, actions and route, marks the row unread, moves it to the top, and emits `updated`. It does not send a new OS banner or chat message. A delivery that is still deferred sends the latest content when it goes out.
- **One notification per task state.** A `task_done` or `task_failed` resolves that task's open `input_needed`, `task_done` and `task_failed` rows and suppresses their pending deliveries.
- **Reconciliation.** Open `approval` rows become stale, because the Gateway invalidates every pending approval at boot and S05 re-issues them as new notifications. With `tasks`: a missing task makes its rows stale, an `input_needed` is stale once the task is no longer `awaiting_input`, and a `task_failed` is stale once the task is no longer `failed`. `isStale` adds custom rules. A stale row gets `staleAt`, `staleReason` and `resolvedAt`, and its open deliveries are suppressed. Deliveries cut off mid-flight (`pending` without `dueAt`) are due again at once.
- **Security.** Approvals reach chat only through `sendApprovalButtons` with the token S05 issued. A `deviceOnly` approval, an approval with no resolver, or a channel without buttons is `suppressed` and gets no text nudge either (security §3.5, §9). `authenticationRequired` on an action is passed to the helper (Touch ID). Notifications carry only what callers put in them, and callers must never include secrets (security §5).

## How this maps to the docs

- Architecture §4.12 (typed inbox, OS / channel / phone fan-out, dedupe per task, restart reconciliation); UI §3.20 (kinds, actions, interruption levels, "one notification per Task per state change", deep links); data model §8 `notifications`. The table gained `route`, `stale_at`, `stale_reason`, `dedupe_key`, `seq` and `updated_at`, plus a new `notification_deliveries` table. See [docs/04-data-model.md](../../docs/04-data-model.md) §8.
- Protocol: `Notifier` contract, `notifications.*` methods, and the `notification.created/updated/resolved` events. `Notification.staleAt` and `NotificationAction.authenticationRequired` come from protocol PR devmello/psyche#8.

## What is stubbed or pending

- **Migration placement.** The DDL ships in `migrations/202610190200_notifications_init.sql`. It moves to `packages/db/migrations/` once S01 adds the matching drizzle tables, because `@psyche/db`'s schema-parity test fails otherwise. Until then, `SqliteNotificationStore({migrate: true})` applies it to a fresh database.
- **Snooze.** Reminders' "Snooze 1 h" can be built with `onAction` plus a new `reminder` notify. No built-in snooze state exists yet.
- **Phone push** (no adapter yet) and the Electron fallback adapter (S11 passes it as `fallback`).
- **Live OS test.** Tests use `FakeNodeClient`. The helper's `notify.show` (S14) is exercised in S14's manual test plan.
