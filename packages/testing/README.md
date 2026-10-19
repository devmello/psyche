# @psyche/testing

**Owner:** S00 (bootstrap) → S18 (security and test harness). Feature ids: cross-cutting acceptance criteria in [docs/03-feature-spec.md](../../docs/03-feature-spec.md).

Deterministic in-memory fakes for every contract in [`packages/protocol/src/contracts`](../protocol/src/contracts/README.md), conformance suites that real implementations run, fixtures, a fake clock, deterministic ids and the skeleton of the secret-leak checker.

## Public API (`src/index.ts`)

- **Fakes** (`src/fakes/`): `FakeModelProvider` (`.script([...turns])`, records `requests`), `FakeAgentLoop` (`.script([...])`), `FakePermissionBroker` (`.policy({default, byTool, bySideEffect, prohibited})`, full approval lifecycle: 30 min expiry on an injectable clock, 400 ms arm delay, one single-use answer token per surface, first answer wins, `verifyBinding` with `once` consumption, `revokeRunAuthority`, `reissue()` / `restart()`), `FakeCredentialBroker` (`add`, `approve`; secrets auto-registered with the leak checker; resolves only for a matching binding and an approved id), `FakeMemoryStore`, `FakeTaskEngine` (leases on the clock), `FakeScheduler`, `FakeBrowserDriver.site(fixture)`, `FakeSandboxRunner` (scripted results; `backend: null` = no backend, no host fallback; never spawns anything), `FakeMcpHost` (`serve`, rug-pull hash check), `FakeChannelAdapter` (`receive`, `press`, `sent`), `FakeNodeClient` (`handle`; `system.echo` built in), `FakeNotifier`, `FakeSearchIndex`, `FakeSkillLoader`, `FakeSpeechEngine`, `FakeViewerRegistry`, `FakeAuditLog` (real sha256 chain, `tamper` hook).
- **Conformance** (`src/conformance/`, imported from `@psyche/testing/conformance` because it depends on vitest): `describe<Contract>Conformance(name, factory, options?)` for ModelProvider, PermissionBroker, CredentialBroker, MemoryStore, TaskEngine, SandboxRunner, Notifier, NodeClient, AuditLog, SearchIndex. The factory receives a context with a `FakeClock` (time moves only when the suite advances it) and an id generator, plus contract-specific setup (deny-rule tools, a credential seed, an approved memory approval id, `backendAvailable`).
- **Utilities**: `FakeClock` (`now`, `iso`, `advance`, `set`, `setTimer`), `createIdGenerator` (counter ids or seeded ULIDs), `canonicalJSON`, `sha256`, `bindingHash` (security §3.5), `collect(asyncIterable)`, `expectPsycheError`.
- **Fixtures** (`src/fixtures/`): `SAMPLE_THREAD`, `SAMPLE_RUN`, `SAMPLE_MESSAGES` (valid against the protocol TypeBox schemas), `SAMPLE_APPROVAL_REQUEST` (data model §4.1), `SAMPLE_GMAIL_THREAD` (fictional example.com people, a PDF attachment and one injection line), `SAMPLE_PDF_FORM` / `SAMPLE_PDF_FORM_BYTES` (hand-written one-page AcroForm with fields `student_name`, `parent_name`, `emergency_phone`, `consent`).
- **Secret-leak checker** (`src/secrets.ts`): `registerSecret(value, label?)`, `clearSecrets()`, `findSecrets(textOrObject)`, `assertNoSecrets(textOrObject, where?)`. Finds raw, base64, base64url, URL-encoded and hex forms anywhere in nested objects (keys and `toJSON` output included). Errors name the label, path and offset, never the value.

## Using it from another package

Add `"@psyche/testing": "workspace:*"` to `devDependencies`, then:

```ts
// my-broker.conformance.test.ts
import { describePermissionBrokerConformance } from "@psyche/testing/conformance";
import { createBroker } from "../src/index.ts";

describePermissionBrokerConformance("permissions", ({ clock, deniedTools }) =>
  createBroker({ now: () => clock.now(), denyRules: deniedTools }),
);
```

Build features against fakes, for example `FakeModelProvider.script([[{type: "text_delta", text: "hi"}, {type: "finish", reason: "stop"}]])`. `test/conformance.test.ts` runs every suite against its fake; that is the proof that the fakes satisfy their contracts.

## What is stubbed (S18 completes)

- Secret-leak checker: no corpus of shared fake secrets yet, no card / government-id pattern detection, no Vitest reporter, no `pnpm check:secrets` CLI, no CI gate.
- Fakes simplify policy (no classifier, no sensitive-category list, read asks only in `manual`), scheduling (UTC-only cron subset) and search ranking (term overlap). Contracts without a conformance suite yet: AgentLoop, Scheduler, BrowserDriver, McpHost, ChannelAdapter, SkillLoader, SpeechEngine, ViewerRegistry.
- No injection corpus, scenario runner, resumability harness or mock Gateway server yet.

## How this package maps to the docs

- Architecture: [docs/02-architecture.md](../../docs/02-architecture.md) §4–§9, §13
- Data model: [docs/04-data-model.md](../../docs/04-data-model.md) §2–§7
- Security: [docs/05-security-and-permissions.md](../../docs/05-security-and-permissions.md) §3, §4.5–§4.7, §15.1

## Rules

Edit only this package (see `prompts/_shared-rules.md`). Cross-package needs go through `packages/protocol` contracts and the fakes here.
