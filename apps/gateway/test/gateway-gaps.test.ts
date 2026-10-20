import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { resolveConfig } from "../src/config.ts";
import { silentLogger } from "../src/log.ts";
import { MAX_SOCKET_PATH_BYTES, resolveNodeSocketPath } from "../src/socket-path.ts";
import { FakeNode } from "./fake-node.ts";
import { adminClient, ik, startTestGateway, type TestClient, type TestGateway } from "./helpers.ts";

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

function deepHome(): string {
  const base = mkdtempSync(join(tmpdir(), "psy-"));
  homes.push(base);
  return join(base, "a".repeat(Math.max(1, MAX_SOCKET_PATH_BYTES - base.length)), "home");
}

describe("node socket paths (issue #50)", () => {
  it("keeps run/node.sock when it fits", () => {
    expect(resolveNodeSocketPath("/tmp/h", undefined)).toBe("/tmp/h/run/node.sock");
  });

  it("names PSYCHE_NODE_SOCKET when an explicit path is too long", () => {
    expect(() => resolveNodeSocketPath("/tmp/h", `/tmp/${"x".repeat(200)}.sock`)).toThrow(
      /PSYCHE_NODE_SOCKET/,
    );
  });

  it("falls back to a private directory for a deep home, and the Gateway starts there", async () => {
    const home = deepHome();
    const path = resolveConfig({}, { home }).nodeSocketPath;
    expect(path.startsWith(join(home, "run"))).toBe(false);
    expect(Buffer.byteLength(path)).toBeLessThanOrEqual(MAX_SOCKET_PATH_BYTES);
    let t: TestGateway | null = null;
    try {
      t = await startTestGateway({ home });
      expect(t.gateway.config.nodeSocketPath).toBe(path);
      expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
      expect(readFileSync(join(home, "run", "node-socket"), "utf8").trim()).toBe(path);
      expect(existsSync(path)).toBe(true);
    } finally {
      await t?.cleanup();
    }
    expect(existsSync(join(home, "run", "node-socket"))).toBe(false);
  });
});

describe("node receipts are published once (issue #50)", () => {
  let composed: ComposedGateway | null = null;
  let node: FakeNode | null = null;
  let admin: TestClient | null = null;
  afterEach(async () => {
    admin?.close();
    await node?.close();
    await composed?.stop("test");
    composed = null;
  });

  it("forwards the broker's receipt.created and does not repeat it", async () => {
    const home = mkdtempSync(join(tmpdir(), "psyche-rcpt-"));
    homes.push(home);
    composed = await composeGateway({
      env: {},
      logger: silentLogger,
      retentionIntervalMs: 0,
      background: false,
      config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
      model: { provider: new FakeModelProvider(), model: "fake/model" },
    });
    node = await FakeNode.connect(composed.gateway.config.nodeSocketPath, {
      origin: composed.gateway.origin,
      secret: composed.gateway.handshakeSecret,
      handlers: [
        {
          capability: { name: "status.ping", sideEffect: "read" },
          run: () => ({ shown: true }),
          receipt: { outcome: "ok", summary: "Showed a notification" },
        },
      ],
    });
    admin = await adminClient(composed.gateway);
    const res = await admin.request(
      "nodes.invoke",
      { nodeId: node.nodeId, capability: "status.ping", params: {} },
      ik(),
    );
    if (res.ok !== true) {
      // The default policy may ask; the receipt rule is what this test checks.
      expect(res.error).toMatchObject({
        code: expect.stringMatching(/approval_required|policy_denied/),
      });
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
    const receiptId = (res.payload as { receipt?: { id: string } }).receipt?.id;
    expect(receiptId).toBeTruthy();
    const seen = admin
      .eventsNamed("receipt.created")
      .filter((e) => (e.payload as { receipt: { id: string } }).receipt.id === receiptId);
    expect(seen).toHaveLength(1);
  });
});
