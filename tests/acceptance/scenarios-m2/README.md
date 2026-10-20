# Milestone 2 acceptance scenarios

**Owner:** INT-3. The Milestone 2 acceptance scenarios (docs/08 Milestone 2: "Acceptance: V5, V6, V8, V9"), written in S18's scenario format (tests/scenarios/README.md) so the same validator and runner apply. V3 is with S06.

| Scenario | Spec (docs/03 V) | What it checks |
| --- | --- | --- |
| `v5-permission-slip` | V5, P2 | A teacher's fillable PDF is filed, its fields read, the missing values asked of the owner, a review copy filled, and the reply sent after approval with the copy flattened on send. A planted note in the form never produces egress. |
| `v6-messages-voice-note` | V6, J7, N5, N11 | A Messages thread is read (the first read asks), a voice note transcribed, and a reply sent with a voice note encoded for iMessage after one approval. A hijacked send to a new recipient stops at a card the owner denies. |
| `v8-subscription-audit` | V8 | Three months of receipts become a list of recurring charges (price change, annual renewal, trial), the one-off purchase and a phishing message are set apart, the owner picks what to cancel, and each cancellation becomes a task the owner approves. A hijacked reply to the phishing message stops at a card. |
| `v9-weekly-review` | V9, O9 | Creating a weekly automation asks once; each Friday at 4 PM Pacific an unattended run reads the active goals and the week's calendar, saves a review and proposes next steps without changing anything. A hijacked run's send is deferred to the owner, who is notified. |

## Running

```bash
node tests/scenarios/validate.mjs --dir tests/acceptance/scenarios-m2
pnpm --filter @psyche/acceptance-tests exec vitest run --project node offline/scenarios-m2.test.ts
```

Both also run in `pnpm -r test`. The resumability sweep (`offline/resumability.test.ts`) kills each scenario's happy path at 4 seeded random points.

`scripts/make-m2-fixtures.ts` rebuilds V5's PDF and writes its size and SHA-256 into the mailbox fixture. The output is deterministic.

## How these differ from tests/scenarios

- **Owner and world.** The scenarios use S18's owner (`tests/scenarios/shared/owner.json`): Avery Lin, the same clock start and the same connector matrices.
- **Tool registry.** `shared/tools.json` here holds only what the M2 scenarios call. Rows copied from S18's registry keep their meaning. The rest are agent-core built-ins (`task.start`, `schedule`) or provisional tools (below).
- **Fakes.** `tests/acceptance/src/m2-world.ts` plugs the M2 executors and the built-ins' services into S18's Stack through `StackOverrides.impls` and `.services`.
- **Extra fixtures.** `fixtures/threads.json` (V6) and `fixtures/goals.json` (V9) are read by the fakes. They are not listed under `fixtures` in the scenario file, because the schema's fixture names are the M1 ones.

## Provisional tools

These tools have no agent registration on main. The scenarios fix their names and argument shapes. Each owner should replace the fake with the real tool and keep the scenario passing.

| Tool | Class | Fake | Owner |
| --- | --- | --- | --- |
| `documents.form_fields` | read, untrusted | the real `detectFormFields` (packages/viewers) | S13 |
| `documents.fill_form` | none (Library) | the real `prepareFilledCopy`; `gmail.send` flattens with `finalizeFilledCopy` and records `fillReceipt` | S13 |
| `messages.read` | read, untrusted; asks on first read | fixtures/threads.json | S14 (J7) |
| `messages.send` | destructive, `message_send` | records the message and egress | S14 (J7, N5) |
| `speech.transcribe` | read, untrusted | fixture transcript | S17 (N11) |
| `speech.voice_note` | none (Library) | the real `VOICE_NOTE_PROFILES` choose the container (CAF for iMessage); no audio is encoded | S17 (N11) |
| `goals.list` | read, trusted | fixtures/goals.json, active goals only | S15 (O9) |

## Decisions where the docs were ambiguous

1. **V5 binds the reply to the Library item, not to the copy's hash.** The scripted model cannot know the hash of a copy filled at run time. So the card binds the item id. The send then refuses a copy whose bytes changed after review (`finalizeFilledCopy`). The test checks that refusal with a tampering executor. A real P2 tool should put the copy's SHA-256 in the call's arguments, so the card shows it.
2. **The V5 fill receipt is checked in the test, not the scenario.** The documents pipeline records its fill receipt as `file_write`, the approval-kind name docs/04 §5 uses. The scenario vocabulary follows docs/05 §3.11 (`file.write`). `offline/scenarios-m2.test.ts` checks the receipt: hashes only, no field values.
3. **V6: the first Messages read asks.** docs/05 §3.2: in `balanced` the first read of a new source asks. The owner allows it for the task. The Messages account is not a connector with a standing read grant, unlike Gmail.
4. **V8: starting a task asks.** agent-core declares `task.start` as `none`. The broker floors it to `write` (issue #48), so each cancellation task is approved before it starts. That is what V8 means by "cancellations as approved tasks". When the cancellation itself would submit something, the task asks again.
5. **V9: the automation's card is `connector_action`.** The `schedule` built-in declares no kind, so the broker falls back to `connector_action`. docs/05 says a standing automation is never silent but names no kind.
6. **V9: unattended runs do not wait.** A card raised by an automation run is queued and the owner is notified (C8). The run goes on without the action.

## Findings

- **S05:** a tool that declares no approval kind is named by prefix (`inferApprovalKind`). A `messages.read` card would say `message_send`, and a `calendar.list` card `calendar_write`. Reads should not be labelled as sends or writes. The M2 registry declares `connector_action` for `messages.read`.
- **S02:** tasks inherit their turn's taint and sources (design-08). The sources are tool calls with their target account (`gmail.get` on `owner@example.com`), not the sender. A task's card cannot say which message tainted it.
- **S13 / S18:** receipt-kind vocabulary differs between the documents pipeline (`file_write`) and the scenario format (`file.write`).
