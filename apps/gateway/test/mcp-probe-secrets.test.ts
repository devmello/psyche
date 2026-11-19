import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpProposal } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { composeMcp } from "../src/compose/mcp.ts";
import { adminClient, ik, type TestClient } from "./helpers.ts";

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
  composed = await composeGateway({
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    model: { provider: new FakeModelProvider(), model: "fake/model" },
    vault: { keyFile, argon2: { memory: 64, passes: 1, parallelism: 1 } },
    parts: [(s) => composeMcp(s, { hostOptions: { launcher: fakeSrt } })],
  });
  await composed.vault.setup();
  const owner = await adminClient(composed.gateway);
  clients.push(owner);
  return owner;
}

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
async function withCards<T>(owner: TestClient, run: () => Promise<T>): Promise<T> {
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
        if (a.kind === "credential_fill") await answer(owner, a.id);
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
    const r = await withCards(owner, () =>
      owner.call<{ proposal: McpProposal }>("mcp.probe", { server: server("echo-key") }, ik()),
    );
    expect(r.proposal.tools.map((t) => t.name)).toContain("echo");
  });

  it("a secret bound to another server is still refused (not widened)", async () => {
    const owner = await setup();
    await addKey(owner, "other-key", "mcp:other");
    await expect(
      withCards(owner, () => owner.call("mcp.probe", { server: server("other-key") }, ik())),
    ).rejects.toThrow();
  });
});
