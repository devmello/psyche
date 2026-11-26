import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryConnectorStore } from "@psyche/connectors";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { composeConnectors } from "../src/compose/connectors.ts";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { adminClient, ik, type TestClient } from "./helpers.ts";

/**
 * An agent-drafted custom connector is installed by the owner's approval of its trust card, on the
 * Gateway (no Settings screen is involved). A denied card installs nothing.
 */

const MANIFEST = {
  schemaVersion: 1,
  id: "tasks-api",
  name: "Tasks API",
  description: "The owner's task tracker.",
  version: "1.0.0",
  baseUrl: "https://api.tasks.example/v2",
  hosts: ["api.tasks.example"],
  auth: { kind: "bearer", credential: "{{cred:tasks-api}}" },
  tools: [
    {
      name: "get_task",
      description: "Read one task.",
      method: "GET",
      path: "/tasks",
      params: [],
      sideEffect: "read",
    },
  ],
};

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let home = "";
let composed: ComposedGateway | null = null;
const clients: TestClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

async function setup(): Promise<TestClient> {
  home = mkdtempSync(join(tmpdir(), "psyche-custom-approval-"));
  const keyFile = join(home, "vault.key");
  writeFileSync(keyFile, Buffer.alloc(32, 7), { mode: 0o600 });
  composed = await composeGateway({
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db") },
    model: { provider: new FakeModelProvider(), model: "fake/model" },
    vault: { keyFile, argon2: { memory: 64, passes: 1, parallelism: 1 } },
    parts: [(s) => composeConnectors(s, { store: new MemoryConnectorStore(), syncIntervalMs: 0 })],
  });
  await composed.vault.setup();
  const owner = await adminClient(composed.gateway);
  clients.push(owner);
  return owner;
}

/** The card's answer, as the owner's desktop sends it (after the card's arming delay). */
async function answer(owner: TestClient, approvalId: string, decision: "approve" | "deny") {
  const { answerToken } = await owner.call<{ answerToken?: string }>("approvals.get", {
    approvalId,
  });
  await new Promise((r) => setTimeout(r, 450));
  await owner.call("approvals.answer", {
    approvalId,
    answerToken,
    decision,
    ...(decision === "approve" ? { scope: "once" } : {}),
  });
}

async function customConnectors(owner: TestClient): Promise<unknown[]> {
  const { connectors } = await owner.call<{ connectors: { type: string }[] }>(
    "connectors.list",
    {},
  );
  return connectors.filter((c) => c.type === "custom");
}

describe("custom connector: installed on the owner's approval", () => {
  it("installs the drafted connector once its card is approved", async () => {
    const owner = await setup();
    const { approval } = await owner.call<{ approval: { id: string } }>(
      "connectors.proposeCustom",
      { manifest: MANIFEST },
      ik(),
    );
    expect(await customConnectors(owner)).toEqual([]);
    await answer(owner, approval.id, "approve");
    await vi.waitFor(async () => expect(await customConnectors(owner)).toHaveLength(1));
    expect(await customConnectors(owner)).toHaveLength(1);
  });

  it("installs nothing when the card is denied", async () => {
    const owner = await setup();
    const { approval } = await owner.call<{ approval: { id: string } }>(
      "connectors.proposeCustom",
      { manifest: MANIFEST },
      ik(),
    );
    await answer(owner, approval.id, "deny");
    await new Promise((r) => setTimeout(r, 200));
    expect(await customConnectors(owner)).toEqual([]);
  });
});
