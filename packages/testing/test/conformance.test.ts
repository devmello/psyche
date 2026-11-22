// Proves every fake passes the conformance suite real implementations will run.
import {
  describeAuditLogConformance,
  describeCredentialBrokerConformance,
  describeHostHelperConformance,
  describeMemoryStoreConformance,
  describeModelProviderConformance,
  describeNodeClientConformance,
  describeNotifierConformance,
  describePermissionBrokerConformance,
  describeSandboxRunnerConformance,
  describeSearchIndexConformance,
  describeTaskEngineConformance,
  LINUX_HELPER_L3_SPEC,
} from "../src/conformance/index.ts";
import {
  FakeAuditLog,
  FakeCredentialBroker,
  FakeMemoryStore,
  FakeModelProvider,
  FakeNodeClient,
  FakeNotifier,
  FakePermissionBroker,
  FakeSandboxRunner,
  FakeSearchIndex,
  FakeTaskEngine,
} from "../src/index.ts";

describeModelProviderConformance("FakeModelProvider", () => new FakeModelProvider());
describeModelProviderConformance("FakeModelProvider (tool-call turn)", () =>
  FakeModelProvider.script([
    [
      { type: "reasoning", provider: "fake", data: { signature: "sig" } },
      { type: "tool_call", id: "call_1", name: "search", input: { q: "x" } },
      {
        type: "usage",
        usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 1, costUsd: 0.001 },
      },
      { type: "finish", reason: "tool_calls" },
    ],
  ]),
);

describePermissionBrokerConformance(
  "FakePermissionBroker",
  ({ clock, ids, deniedTools }) =>
    new FakePermissionBroker({
      clock,
      ids,
      policy: { byTool: Object.fromEntries(deniedTools.map((t) => [t, "deny" as const])) },
    }),
);

describeCredentialBrokerConformance("FakeCredentialBroker", ({ clock, ids, seed }) => {
  const broker = new FakeCredentialBroker({ clock, ids });
  broker.add({
    slug: seed.slug,
    bindings: [{ origin: seed.origin }],
    username: seed.username,
    secret: seed.password,
  });
  broker.add({
    slug: seed.other.slug,
    bindings: [{ origin: seed.origin }],
    secret: seed.other.password,
  });
  return broker.approve(seed.approvalId, { slug: seed.slug, origin: seed.origin });
});

describeMemoryStoreConformance(
  "FakeMemoryStore",
  ({ clock, ids, approvedApprovalId }) =>
    new FakeMemoryStore({ clock, ids, isApproved: (id) => id === approvedApprovalId }),
);

describeTaskEngineConformance(
  "FakeTaskEngine",
  ({ clock, ids }) => new FakeTaskEngine({ clock, ids }),
);

describeSandboxRunnerConformance(
  "FakeSandboxRunner",
  ({ ids, backendAvailable }) =>
    new FakeSandboxRunner({ ids, backend: backendAvailable ? "fake" : null }),
);

describeNotifierConformance("FakeNotifier", ({ clock, ids }) => new FakeNotifier({ clock, ids }));

describeNodeClientConformance(
  "FakeNodeClient",
  () =>
    new FakeNodeClient().handle({
      capability: { name: "computer.delete_file", sideEffect: "destructive" },
      handle: () => ({ deleted: true }),
    }),
  {
    echo: { capability: "system.echo", params: { hello: "node" } },
    destructiveCapability: "computer.delete_file",
  },
);

describeAuditLogConformance("FakeAuditLog", ({ clock }) => new FakeAuditLog({ clock }));

describeSearchIndexConformance("FakeSearchIndex", () => new FakeSearchIndex());

describeHostHelperConformance(
  "FakeNodeClient as a Linux helper",
  () =>
    new FakeNodeClient({ kind: "host-helper" }).handle({
      capability: { name: "health", sideEffect: "none" },
      handle: () => ({
        ok: true,
        platform: "linux",
        version: "0.0.0",
        build: "dev",
        uptimeMs: 1,
      }),
    }),
  {
    ...LINUX_HELPER_L3_SPEC,
    // The fake always offers its echo capability.
    manifest: [...LINUX_HELPER_L3_SPEC.manifest, { name: "system.echo", sideEffect: "none" }],
  },
);

describeHostHelperConformance(
  "FakeNodeClient with a destructive capability",
  () =>
    new FakeNodeClient({ kind: "mac-helper" })
      .handle({
        capability: { name: "health", sideEffect: "none" },
        handle: () => ({
          ok: true,
          platform: "linux",
          version: "0.0.0",
          build: "dev",
          uptimeMs: 1,
        }),
      })
      .handle({
        capability: { name: "computer.delete_file", sideEffect: "destructive" },
        handle: () => ({ deleted: true }),
      }),
  {
    ...LINUX_HELPER_L3_SPEC,
    kinds: ["mac-helper"],
    manifest: [
      { name: "health", sideEffect: "none" },
      { name: "computer.delete_file", sideEffect: "destructive" },
      { name: "system.echo", sideEffect: "none" },
    ],
    refusals: [
      {
        label: "a destructive capability without an approval id",
        capability: "computer.delete_file",
        params: {},
        code: "approval_required",
      },
    ],
  },
);
