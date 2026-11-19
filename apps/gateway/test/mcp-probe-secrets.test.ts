import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
        return composeMcp(s, { hostOptions: { launcher: fakeSrt } });
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

describe("removing a server releases its vault items", () => {
  const listed = async (owner: TestClient) =>
    (
      await owner.call<{ credentials: { id: string; slug: string; bindings: unknown[] }[] }>(
        "vault.list",
        {},
      )
    ).credentials;

  it("deletes an item made for it alone and unbinds one shared with another", async () => {
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
    expect(after.some((c) => c.slug === "only-echo")).toBe(false);
    const kept = after.find((c) => c.slug === "shared-key");
    expect(JSON.stringify(kept?.bindings)).toContain("mcp:other");
    expect(JSON.stringify(kept?.bindings)).not.toContain("mcp:echo");
    // Positive control: an item bound only to another server is untouched.
    expect(after.some((c) => c.slug === "unrelated")).toBe(true);
  });
});
