# Contracts

Cross-package TypeScript interfaces (`docs/archive/prompts/_shared-rules.md` "Contracts and fakes"). Every package that depends on another package's behavior codes against one of these and tests against its fake in `@psyche/testing`. Contracts are plain interfaces with doc comments; the only runtime code is small shared constants, `parsePlaceholders` and the `ResolvedSecret` handle. Growth is additive: new optional fields, methods or events through a `protocol:` PR that also updates the fake (see `../../CHANGES.md`).

| Contract | File | Docs | Owner (implements) | Fake | Conformance suite |
| --- | --- | --- | --- | --- | --- |
| `ModelProvider` | `ModelProvider.ts` | architecture §4.4, ADR-003 | S03 model-router | `FakeModelProvider.script([...])` | `describeModelProviderConformance` |
| `AgentLoop`, `ToolRegistry`, `ToolExecutor`, `AGENT_HOOKS` | `AgentLoop.ts` | architecture §4.2–§4.3, §13 | S02 agent-core | `FakeAgentLoop.script([...])` | — |
| `PermissionBroker` | `PermissionBroker.ts` | architecture §4.6, security §3 | S05 permissions | `FakePermissionBroker.policy({...})` | `describePermissionBrokerConformance` |
| `CredentialBroker`, `ResolvedSecret`, `PLACEHOLDER_PATTERN` | `CredentialBroker.ts` | architecture §4.7, data model §6, security §4.5 | S06 vault | `FakeCredentialBroker` | `describeCredentialBrokerConformance` |
| `MemoryStore` | `MemoryStore.ts` | architecture §4.8, data model §7, security §8 | S07 memory | `FakeMemoryStore` | `describeMemoryStoreConformance` |
| `TaskEngine` | `TaskEngine.ts` | architecture §4.5, data model §3 | S04 tasks | `FakeTaskEngine` | `describeTaskEngineConformance` |
| `Scheduler` | `Scheduler.ts` | architecture §4.11 | S04 scheduler | `FakeScheduler` | — |
| `BrowserDriver` | `BrowserDriver.ts` | architecture §8, security §6 | S08 browser | `FakeBrowserDriver.site(fixture)` | — |
| `SandboxRunner` | `SandboxRunner.ts` | architecture §9, security §5 | C1 sandbox | `FakeSandboxRunner` | `describeSandboxRunnerConformance` |
| `McpHost` | `McpHost.ts` | architecture §4.9, security §11 | S09 mcp-host | `FakeMcpHost` | — |
| `ChannelAdapter` | `ChannelAdapter.ts` | architecture §4.10, security §9 | S10 channels | `FakeChannelAdapter` | — |
| `NodeClient` | `NodeClient.ts` | architecture §7 | S01 gateway (client side); S14 / S19 nodes | `FakeNodeClient` | `describeNodeClientConformance` |
| `Notifier` | `Notifier.ts` | architecture §4.12 | S15 notifications | `FakeNotifier` | `describeNotifierConformance` |
| `SearchIndex` | `SearchIndex.ts` | architecture §4.12 | S16 search | `FakeSearchIndex` | `describeSearchIndexConformance` |
| `SkillLoader` | `SkillLoader.ts` | architecture §13, feature T2 | S16 skills | `FakeSkillLoader` | — |
| `SpeechEngine` | `SpeechEngine.ts` | feature Q1 / N11, architecture §5–§6 | S17 speech | `FakeSpeechEngine` | — |
| `ViewerRegistry`, `ViewerSpec` | `Viewer.ts` | architecture §5 viewers, §13 | S13 viewers | `FakeViewerRegistry` | — |
| `AuditLog` | `AuditLog.ts` | architecture §4.12, data model §5, security §15.1 | S05 audit | `FakeAuditLog` (real sha256 chain) | `describeAuditLogConformance` |
| `Clock`, `CallOptions`, `Unsubscribe` | `Clock.ts` | — | shared | `FakeClock` | — |

Conventions: cancellation is an `AbortSignal`; streams are `AsyncIterable`; failures crossing a package boundary are `PsycheError` with an `ErrorCode` from `../errors.ts`; times inside contracts are epoch milliseconds unless a protocol schema type (ISO strings) is reused. Type names that would collide with wire schemas are prefixed (`DriverTab`, `PageSnapshot`, `SandboxInstance`, `SearchIndexHit`).
