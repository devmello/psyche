import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Methods } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { gateMemoryEntities } from "../src/compose/memory-chunks.ts";
import type { Call, HandlerDef } from "../src/context.ts";
import { silentLogger } from "../src/log.ts";
import { adminClient, ik, remoteClient, type TestClient } from "./helpers.ts";

/**
 * Every `memory.entities.*` method is the desktop app and Host CLI only (owner rule: remote
 * viewers cannot open Memory). One row per method and caller: must-refuse (phone, remote Mac,
 * web viewer, read-only, unpaired) and must-pass (desktop shell, Host CLI).
 */

const call = (identity: Record<string, unknown>): Call => ({ identity }) as unknown as Call;
const MUST_PASS = [
  ["desktop shell", call({ role: "client", desktopShell: true })],
  ["Host CLI", call({ role: "client", localHostCli: true })],
] as const;
const MUST_REFUSE = [
  ["phone", call({ role: "client", deviceId: "dev_phone" })],
  ["remote Mac", call({ role: "client", deviceId: "dev_mac", platform: "macos" })],
  ["web viewer", call({ role: "client", deviceId: "dev_web", platform: "web" })],
  ["read-only device", call({ role: "client", deviceId: "dev_ro", scopes: ["operator.read"] })],
  ["unpaired", call({ role: "node" })],
] as const;

const NAMES = Object.keys(Methods).filter((n) => n.startsWith("memory.entities."));

type Run = (c: Call, p: unknown) => Promise<unknown>;

function build() {
  const run = vi.fn(async () => ({ ok: true }));
  const handlers: Record<string, HandlerDef> = {};
  for (const n of NAMES) handlers[n] = { run } as unknown as HandlerDef;
  handlers["memory.loops.list"] = { run } as unknown as HandlerDef;
  gateMemoryEntities(handlers);
  const go = (name: string, c: Call) => (handlers[name] as unknown as { run: Run }).run(c, {});
  return { run, go };
}

describe("memory.entities.* per connection (handlers)", () => {
  it("covers every method the protocol declares (guards the table)", () => {
    expect(NAMES.length).toBeGreaterThanOrEqual(19);
    for (const n of ["create", "update", "merge", "forget", "split", "facts.set", "edges.set"])
      expect(NAMES).toContain(`memory.entities.${n}`);
  });

  for (const name of NAMES) {
    for (const [who, c] of MUST_PASS)
      it(`${name}: ${who} passes`, async () => {
        const { go, run } = build();
        await expect(go(name, c)).resolves.toEqual({ ok: true });
        expect(run).toHaveBeenCalledTimes(1);
      });
    for (const [who, c] of MUST_REFUSE)
      it(`${name}: ${who} is refused and nothing runs`, async () => {
        const { go, run } = build();
        await expect(go(name, c)).rejects.toMatchObject({
          code: "forbidden",
          details: { reason: "not_desktop" },
        });
        expect(run).not.toHaveBeenCalled();
      });
  }

  it("leaves other methods alone (memory.loops.list still reaches a phone)", async () => {
    const { go, run } = build();
    await go("memory.loops.list", MUST_REFUSE[0][1]);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

let home = "";
let composed: ComposedGateway | null = null;
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("memory.entities.* through the composed Gateway", () => {
  it("the desktop creates and reads a person; a paired phone cannot create, read or forget", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-entviewer-"));
    composed = await composeGateway({
      logger: silentLogger,
      retentionIntervalMs: 0,
      background: false,
      config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
      model: { provider: new FakeModelProvider(), model: "fake/model" },
    });
    const desktop = await adminClient(composed.gateway);
    const phone = await remoteClient(composed.gateway);
    clients.push(desktop, phone);
    const made = await desktop.request(
      "memory.entities.create",
      { kind: "person", name: "Dana Whitfield" },
      ik(),
    );
    expect(made.ok).toBe(true);
    const id = (made.payload as { entity: { id: string } }).entity.id;
    for (const [method, params] of [
      ["memory.entities.create", { kind: "person", name: "Sam Rivera" }],
      ["memory.entities.get", { id }],
      ["memory.entities.forget", { id }],
    ] as const) {
      const res = await phone.request(method, params, ik());
      expect(res.ok, method).toBe(false);
      expect((res.error as { code: string }).code, method).toBe("forbidden");
    }
    const still = await desktop.request("memory.entities.get", { id }, ik());
    expect(still.ok).toBe(true);
  });
});
