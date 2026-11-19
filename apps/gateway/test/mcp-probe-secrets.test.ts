import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setSetting } from "@psyche/db";
import type { McpProposal } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { composeMcp } from "../src/compose/mcp.ts";
import type { ComposeServices } from "../src/compose/services.ts";
import { adminClient, ik, seedMcpServers, type TestClient } from "./helpers.ts";

/**
 * N6: the probe host runs a server under the id `<id>-probe-xxxx`, but a vault secret is bound to
 * `mcp:<id>`. Add, Edit and Test with a vault env secret must still resolve it (the same item,
 * the same binding), and must still refuse an item bound to something else.
 */

vi.setConfig({ testTimeout: 60_000 });

const SERVER = fileURLToPath(new URL("./fixtures/echo-mcp-server.mjs", import.meta.url));
const fakeSrt = {
  isolation: "srt" as const,
  prepare: async (spec: { command: string[] }) => ({
    command: spec.command[0] as string,
    args: spec.command.slice(1),
    env: { PATH: process.env.PATH ?? "" },
  }),
};

let home = "";
let composed: ComposedGateway | null = null;
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

async function setup() {
  home = mkdtempSync(join(tmpdir(), "psyche-mcp-probe-secrets-"));
  const keyFile = join(home, "vault.key");
  writeFileSync(keyFile, Buffer.alloc(32, 7), { mode: 0o600 });
  let services: ComposeServices | undefined;
  composed = await composeGateway({
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    model: { provider: new FakeModelProvider(), model: "fake/model" },
    vault: { keyFile, argon2: { memory: 64, passes: 1, parallelism: 1 } },
    parts: [
      (s) => {
        services = s;
        lastMcp = composeMcp(s, { hostOptions: { launcher: fakeSrt } });
        return lastMcp;
      },
    ],
  });
  await composed.vault.setup();
  const owner = await adminClient(composed.gateway);
  clients.push(owner);
  lastServices = services as ComposeServices;
  return owner;
}
let lastServices: ComposeServices | undefined;
let lastMcp: ReturnType<typeof composeMcp> | undefined;

async function answer(owner: TestClient, approvalId: string) {
  const { answerToken } = await owner.call<{ answerToken?: string }>("approvals.get", {
    approvalId,
  });
  await new Promise((r) => setTimeout(r, 450)); // cards arm after 400 ms
  await owner.call("approvals.answer", {
    approvalId,
    answerToken,
    decision: "approve",
    scope: "once",
  });
}

/** Runs a call that may raise secret cards, approving each until it settles. */
async function withCards<T>(
  owner: TestClient,
  run: () => Promise<T>,
  cards: unknown[] = [],
): Promise<T> {
  const seen = new Set<string>();
  let done = false;
  const pending = run().finally(() => {
    done = true;
  });
  pending.catch(() => undefined);
  while (!done) {
    for (const e of owner.events) {
      const a = (e as { event?: string; payload?: { approval?: { id: string; kind: string } } })
        .payload?.approval;
      if ((e as { event?: string }).event === "approval.created" && a && !seen.has(a.id)) {
        seen.add(a.id);
        if (a.kind === "credential_fill") {
          cards.push(a);
          await answer(owner, a.id);
        }
      }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return pending;
}

const server = (slug: string) => ({
  id: "echo",
  name: "Echo",
  transport: {
    kind: "stdio" as const,
    command: [process.execPath, SERVER],
    env: { API_KEY: `{{cred:${slug}}}` },
  },
});

const addKey = (owner: TestClient, slug: string, connector: string) =>
  owner.call(
    "vault.add",
    {
      kind: "api_key",
      name: slug,
      slug,
      bindings: [{ connector }],
      secret: { token: "s3cret-value" },
    },
    ik(),
  );

describe("probe resolves the server's own vault binding", () => {
  it("a secret bound to mcp:<id> resolves in the probe", async () => {
    const owner = await setup();
    await addKey(owner, "echo-key", "mcp:echo");
    const cards: unknown[] = [];
    const r = await withCards(
      owner,
      () =>
        owner.call<{ proposal: McpProposal }>("mcp.probe", { server: server("echo-key") }, ik()),
      cards,
    );
    expect(r.proposal.tools.map((t) => t.name)).toContain("echo");
    // The card says it is a check, not the approved server's routine start.
    const text = JSON.stringify(cards);
    expect(cards.length).toBeGreaterThan(0);
    expect(text).toContain("mcp:echo check");
    expect(text).not.toContain('"agent":"mcp:echo"');
  });

  it("a secret bound to another server is still refused (not widened)", async () => {
    const owner = await setup();
    await addKey(owner, "other-key", "mcp:other");
    await expect(
      withCards(owner, () => owner.call("mcp.probe", { server: server("other-key") }, ik())),
    ).rejects.toThrow();
  });
});

describe("removing a server unbinds its vault items", () => {
  const listed = async (owner: TestClient) =>
    (
      await owner.call<{ credentials: { id: string; slug: string; bindings: unknown[] }[] }>(
        "vault.list",
        {},
      )
    ).credentials;

  it("unbinds every item bound to it and deletes none; a new Add under the same id gets nothing", async () => {
    const owner = await setup();
    await addKey(owner, "only-echo", "mcp:echo");
    await addKey(owner, "shared-key", "mcp:echo");
    await addKey(owner, "unrelated", "mcp:other");
    const shared = (await listed(owner)).find((c) => c.slug === "shared-key");
    await owner.call(
      "vault.update",
      {
        credentialId: shared?.id,
        bindings: [{ connector: "mcp:echo" }, { connector: "mcp:other" }],
      },
      ik(),
    );
    // A server entry that is off, so nothing asks for a secret.
    seedMcpServers(lastServices as ComposeServices, [
      {
        id: "echo",
        name: "Echo",
        trust: "unknown",
        enabled: false,
        transport: { kind: "stdio", command: [process.execPath, SERVER] },
      },
    ]);
    await owner.call("mcp.remove", { serverId: "echo" }, ik());
    const after = await listed(owner);
    // Kept in the vault, with no binding to the removed server left.
    const only = after.find((c) => c.slug === "only-echo");
    expect(only).toBeDefined();
    expect(JSON.stringify(only?.bindings)).not.toContain("mcp:echo");
    const kept = after.find((c) => c.slug === "shared-key");
    expect(JSON.stringify(kept?.bindings)).toContain("mcp:other");
    expect(JSON.stringify(kept?.bindings)).not.toContain("mcp:echo");
    // Positive control: an item bound only to another server is untouched.
    const unrelated = after.find((c) => c.slug === "unrelated");
    expect(JSON.stringify(unrelated?.bindings)).toContain("mcp:other");
    // A new Add under the same id can't be handed the unbound items.
    await expect(
      withCards(owner, () => owner.call("mcp.probe", { server: server("only-echo") }, ik())),
    ).rejects.toThrow(/target does not match the credential's bindings/);
  });
});

describe("the check label is explicit", () => {
  it("a real server whose id looks like a probe id is not labelled a check", async () => {
    const owner = await setup();
    await addKey(owner, "gh-key", "mcp:github-probe-deadbeef");
    const cards: unknown[] = [];
    await withCards(
      owner,
      async () => {
        seedMcpServers(lastServices as ComposeServices, [
          {
            id: "github-probe-deadbeef",
            name: "Look-alike",
            trust: "unknown",
            transport: {
              kind: "stdio",
              command: [process.execPath, SERVER],
              env: { API_KEY: "{{cred:gh-key}}" },
            },
          },
        ]);
        await lastMcp?.idle();
      },
      cards,
    );
    const text = JSON.stringify(cards);
    expect(cards.length).toBeGreaterThan(0);
    expect(text).toContain('"agent":"mcp:github-probe-deadbeef"');
    expect(text).not.toContain("check");
  });
});

describe("a locked vault cannot leave the old secrets for a new server of the same id", () => {
  const listed = async (owner: TestClient) =>
    (await owner.call<{ credentials: { slug: string; bindings: unknown[] }[] }>("vault.list", {}))
      .credentials;
  const plain = {
    id: "echo",
    name: "Echo",
    transport: { kind: "stdio" as const, command: [process.execPath, SERVER] },
  };

  it("refuses a re-add until the vault is unlocked, then unbinds and allows it", async () => {
    const owner = await setup();
    await addKey(owner, "old-key", "mcp:echo");
    seedMcpServers(lastServices as ComposeServices, [
      {
        id: "echo",
        name: "Echo",
        trust: "unknown",
        enabled: false,
        transport: { kind: "stdio", command: [process.execPath, SERVER] },
      },
    ]);
    (composed as ComposedGateway).vault.lock("manual");
    await owner.call("mcp.remove", { serverId: "echo" }, ik());
    // The unbind could not run: the re-add is refused with a clear reason.
    await expect(owner.call("mcp.probe", { server: plain }, ik())).rejects.toThrow(
      /vault_removal_pending/,
    );
    await (composed as ComposedGateway).vault.unlock("test");
    // Allowed now, and the old item is unbound (kept).
    const r = await owner.call<{ proposal: McpProposal }>("mcp.probe", { server: plain }, ik());
    expect(r.proposal.tools.map((t) => t.name)).toContain("echo");
    const old = (await listed(owner)).find((c) => c.slug === "old-key");
    expect(old).toBeDefined();
    expect(JSON.stringify(old?.bindings)).not.toContain("mcp:echo");
  });

  it("a retry unbinds only the items recorded at remove time, never a key stored since", async () => {
    const owner = await setup();
    await addKey(owner, "old-key", "mcp:echo");
    const oldId = (await listed(owner)).find((c) => c.slug === "old-key") as unknown as {
      id: string;
    };
    // What a remove under a locked vault leaves behind: the exact item ids still to unbind.
    setSetting((lastServices as ComposeServices).db, "_mcp.pendingUnbind", {
      echo: { ids: [oldId.id], unlisted: false },
    });
    // The owner has since stored a key for the new server of the same id.
    await addKey(owner, "new-key", "mcp:echo");
    // The re-add retries first; it must succeed, so the old item is no longer bound.
    const r = await owner.call<{ proposal: McpProposal }>("mcp.probe", { server: plain }, ik());
    expect(r.proposal.tools.length).toBeGreaterThan(0);
    const after = await listed(owner);
    expect(JSON.stringify(after.find((c) => c.slug === "old-key")?.bindings)).not.toContain(
      "mcp:echo",
    );
    // The new key keeps its binding.
    expect(JSON.stringify(after.find((c) => c.slug === "new-key")?.bindings)).toContain("mcp:echo");
  });

  it("does not block a re-add when nothing was left bound (positive control)", async () => {
    const owner = await setup();
    seedMcpServers(lastServices as ComposeServices, [
      {
        id: "echo",
        name: "Echo",
        trust: "unknown",
        enabled: false,
        transport: { kind: "stdio", command: [process.execPath, SERVER] },
      },
    ]);
    await owner.call("mcp.remove", { serverId: "echo" }, ik());
    const r = await owner.call<{ proposal: McpProposal }>("mcp.probe", { server: plain }, ik());
    expect(r.proposal.tools.length).toBeGreaterThan(0);
  });
});
