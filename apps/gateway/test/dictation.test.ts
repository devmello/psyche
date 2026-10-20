import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { isUnreachableCapability } from "../src/handlers/nodes.ts";
import { silentLogger } from "../src/log.ts";
import { FakeNode, type FakeNodeHandler } from "./fake-node.ts";
import { desktopClient, ik, newDeviceKey, type TestClient } from "./helpers.ts";

let composed: ComposedGateway | null = null;
let home = "";
const clients: TestClient[] = [];
let helper: FakeNode | null = null;

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await helper?.close();
  helper = null;
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

const notes = {
  pid: 11,
  bundleId: "com.apple.Notes",
  appName: "Notes",
  role: "AXTextArea",
  insertable: true,
};

/** A helper shaped like apps/mac-helper's `dictation.*` group. */
function dictationHelper(opts: { watchFails?: boolean } = {}) {
  const inserted: string[] = [];
  const watchers: ((d: unknown) => void)[] = [];
  const handlers: FakeNodeHandler[] = [
    {
      capability: { name: "dictation.target", sideEffect: "read", streaming: false },
      run: () => ({ target: notes }),
    },
    {
      capability: { name: "dictation.insert", sideEffect: "write", streaming: false },
      run: (params) => {
        const p = params as { text: string; expectPid?: number };
        if (p.expectPid !== undefined && p.expectPid !== notes.pid) {
          throw Object.assign(new Error("Focus moved"), { code: "policy_denied" });
        }
        inserted.push(p.text);
        return { method: "ax", chars: p.text.length, target: notes };
      },
      receipt: { outcome: "ok", summary: "Dictated 11 characters into Notes" },
    },
    {
      capability: { name: "dictation.watch", sideEffect: "read", streaming: true },
      run: (params, emit) => {
        const p = params as { key: string | null };
        if (p.key === null) return { watching: false };
        if (opts.watchFails)
          throw new Error("Psyche Helper does not have the accessibility permission");
        emit({ key: p.key, down: false, at: new Date().toISOString() });
        watchers.push(emit);
        return new Promise(() => undefined);
      },
    },
  ];
  return { handlers, inserted, watchers };
}

async function setup(): Promise<ComposedGateway> {
  home = mkdtempSync(join(tmpdir(), "psyche-dictation-"));
  composed = await composeGateway({
    env: {},
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    model: { provider: new FakeModelProvider(), model: "fake/model" },
  });
  return composed;
}

async function withHelper(c: ComposedGateway, h: ReturnType<typeof dictationHelper>) {
  helper = await FakeNode.connect(c.gateway.config.nodeSocketPath, {
    origin: c.gateway.origin,
    secret: c.gateway.handshakeSecret,
    handlers: h.handlers,
  });
  return helper;
}

describe("system-wide dictation (J9, Q2)", () => {
  it("is unavailable without a helper, then forwards target and insert", async () => {
    const c = await setup();
    const desk = await desktopClient(c.gateway);
    clients.push(desk);
    await expect(desk.call("dictation.target", {})).rejects.toThrow(/"code":"unavailable"/);

    const h = dictationHelper();
    await withHelper(c, h);
    expect(await desk.call("dictation.target", {})).toEqual({ target: notes });
    const r = await desk.call("dictation.insert", { text: "hello world", expectPid: 11 }, ik());
    expect(r).toEqual({ method: "ax", chars: 11, target: notes });
    expect(h.inserted).toEqual(["hello world"]);

    const receipt = await desk.waitForEvent((e) => e.event === "receipt.created");
    expect((receipt.payload as { receipt: { kind: string } }).receipt.kind).toBe(
      "node.dictation.insert",
    );
    expect(JSON.stringify(receipt.payload)).not.toContain("hello world");

    await expect(
      desk.call("dictation.insert", { text: "elsewhere", expectPid: 99 }, ik()),
    ).rejects.toThrow(/Focus moved/);
  });

  it("refuses callers that are not the desktop app", async () => {
    const c = await setup();
    await withHelper(c, dictationHelper());
    const desk = await desktopClient(c.gateway, newDeviceKey(), "phone");
    clients.push(desk);
    c.db.sqlite.prepare("UPDATE devices SET platform = 'web' WHERE id = ?").run("phone");
    await expect(desk.call("dictation.insert", { text: "hi" }, ik())).rejects.toThrow(
      /"code":"forbidden"/,
    );
  });

  it("never reaches dictation through nodes.invoke", async () => {
    expect(isUnreachableCapability("dictation.insert")).toBe(true);
    expect(isUnreachableCapability("dictation.watch")).toBe(true);
    const c = await setup();
    const node = await withHelper(c, dictationHelper());
    const desk = await desktopClient(c.gateway);
    clients.push(desk);
    await expect(
      desk.call(
        "nodes.invoke",
        {
          nodeId: node.nodeId,
          capability: "dictation.insert",
          params: { text: "rm -rf ~" },
        },
        ik(),
      ),
    ).rejects.toThrow(/"code":"forbidden"/);
  });

  it("forwards hold-to-talk key events to the watching device only", async () => {
    const c = await setup();
    const h = dictationHelper();
    await withHelper(c, h);
    const desk = await desktopClient(c.gateway, newDeviceKey(), "desk-a");
    const other = await desktopClient(c.gateway, newDeviceKey(), "desk-b");
    clients.push(desk, other);

    expect(await desk.call("dictation.watch", { key: "fn" })).toEqual({ watching: true });
    h.watchers.at(-1)?.({ key: "fn", down: true, at: "2026-10-19T00:00:00.000Z" });
    const down = await desk.waitForEvent(
      (e) => e.event === "dictation.key" && (e.payload as { down: boolean }).down,
    );
    expect(down.payload).toEqual({ key: "fn", down: true, at: "2026-10-19T00:00:00.000Z" });
    expect(other.eventsNamed("dictation.key")).toEqual([]);

    expect(await desk.call("dictation.watch", { key: null })).toEqual({ watching: false });
    const before = desk.eventsNamed("dictation.key").length;
    h.watchers.at(-1)?.({ key: "fn", down: false, at: "2026-10-19T00:00:01.000Z" });
    await new Promise((r) => setTimeout(r, 50));
    expect(desk.eventsNamed("dictation.key").length).toBe(before);
  });

  it("reports a watch the helper refuses (no Accessibility)", async () => {
    const c = await setup();
    await withHelper(c, dictationHelper({ watchFails: true }));
    const desk = await desktopClient(c.gateway);
    clients.push(desk);
    await expect(desk.call("dictation.watch", { key: "fn" })).rejects.toBeDefined();
  });
});
