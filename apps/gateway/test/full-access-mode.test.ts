import { createThread, getThread, openDb } from "@psyche/db";
import type { DeviceScope, ModelProvider, ThreadKind } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { modelPinsFor, threadSettingsHandlers } from "../src/compose/threads.ts";
import type { Call } from "../src/context.ts";

/**
 * Full access (owner, 2026-11-25) is set only in the owner's own chats, and only from the Mac app
 * or an admin-paired device. Turning it off is one tap from any paired device. Through the real
 * `threads.update` handler and a real SQLite thread row.
 */

const router = {
  allowsAutoMode: () => true,
  setThreadModel: async () => {},
  role: () => ({ model: "anthropic/claude-sonnet-5-5" }),
} as unknown as ModelProvider;

const MAC = { desktopShell: true as const, scopes: ["operator.read", "operator.write"] };
const PHONE_ADMIN = { scopes: ["operator.read", "operator.write", "operator.admin"] };
const PHONE_WRITE = { scopes: ["operator.read", "operator.write"] };

type Device = { desktopShell?: true; scopes: string[] };

function setup(
  thread: { kind: ThreadKind; sessionKey: string; imported?: { source: "claude"; key: string } },
  device: Device,
  remoteLoopback = device.desktopShell === true,
) {
  const db = openDb(":memory:");
  const row = createThread(db, thread);
  const callAs = (d: Device, loopback: boolean) =>
    ({
      ctx: { db, bus: { bumpStateVersion: () => {} } },
      emit: () => {},
      identity: { deviceId: "dev_1", role: "operator", ...d, scopes: d.scopes as DeviceScope[] },
      conn: { peer: { remoteLoopback: loopback } },
    }) as unknown as Call;
  const handler = threadSettingsHandlers(modelPinsFor(router))["threads.update"];
  if (handler === undefined) throw new Error("threads.update is not registered");
  const setAs = (d: Device, permissionMode: string, loopback = d.desktopShell === true) =>
    (handler.run as (c: Call, p: unknown) => Promise<unknown>)(callAs(d, loopback), {
      threadId: row.id,
      permissionMode,
    });
  const set = (permissionMode: string) => setAs(device, permissionMode, remoteLoopback);
  return { set, setAs, mode: () => getThread(db, row.id)?.permissionMode };
}

const MAIN = { kind: "main" as const, sessionKey: "main" };
const SIDE = { kind: "side" as const, sessionKey: "owner:side:t1" };

describe("threads.update permissionMode full: who and where", () => {
  it.each([
    ["the Mac app, main chat", MAIN, MAC],
    ["the Mac app, a side chat", SIDE, MAC],
    ["an admin-paired iPhone", SIDE, PHONE_ADMIN],
  ])("%s may turn it on", async (_name, thread, device) => {
    const t = setup(thread, device);
    await t.set("full");
    expect(t.mode()).toBe("full");
  });

  it.each([
    ["a channel thread (Telegram)", { kind: "channel" as const, sessionKey: "telegram:peer:42" }],
    ["an automation thread", { kind: "automation" as const, sessionKey: "automation:a1:r1" }],
    ["a Night shift thread", { kind: "automation" as const, sessionKey: "night-shift:n1" }],
    ["a specialist's job thread", { kind: "subagent" as const, sessionKey: "specialist:r:1" }],
    [
      "an imported chat",
      {
        kind: "side" as const,
        sessionKey: "import:c1",
        imported: { source: "claude" as const, key: "c1" },
      },
    ],
  ])("refuses %s, even from the Mac", async (_name, thread) => {
    const t = setup(thread, MAC);
    await expect(t.set("full")).rejects.toMatchObject({
      code: "forbidden",
      details: { reason: "full_access_thread" },
    });
    expect(t.mode()).toBe("balanced");
  });

  it("refuses a paired device without admin scope", async () => {
    const t = setup(SIDE, PHONE_WRITE);
    await expect(t.set("full")).rejects.toMatchObject({
      code: "forbidden",
      details: { reason: "full_access_device" },
    });
    expect(t.mode()).toBe("balanced");
  });

  it("refuses a client that says it is the desktop shell but is not on loopback", async () => {
    const t = setup(SIDE, MAC, false);
    await expect(t.set("full")).rejects.toMatchObject({ code: "forbidden" });
  });

  it("turning it off is one call from any paired device", async () => {
    const t = setup(SIDE, MAC);
    await t.set("auto");
    await t.set("full");
    expect(t.mode()).toBe("full");
    // The same thread, now from a write-only device: it can't turn Full access on, only off.
    await expect(t.setAs(PHONE_WRITE, "full")).rejects.toMatchObject({ code: "forbidden" });
    await t.setAs(PHONE_WRITE, "balanced");
    expect(t.mode()).toBe("balanced");
    await t.setAs(PHONE_WRITE, "manual");
    expect(t.mode()).toBe("manual");
  });

  it("keeps the mode under Full access in its own column (real SQLite round trip)", async () => {
    const t = setup(SIDE, MAC);
    await t.set("auto");
    await t.set("full");
    expect(t.mode()).toBe("full");
    await t.set("plan");
    expect(t.mode()).toBe("plan");
  });
});
