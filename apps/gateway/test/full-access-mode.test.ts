import { appendMessage, createThread, getThread, openDb } from "@psyche/db";
import type { DeviceScope, ModelProvider, ThreadKind } from "@psyche/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { browserProfiles, protectedRoots } from "../src/compose/protected-paths.ts";
import { modelPinsFor, threadSettingsHandlers } from "../src/compose/threads.ts";
import type { Call } from "../src/context.ts";
import { spaceFolderHandlers } from "../src/spaces/folders.ts";
import { spacesHandlers } from "../src/spaces/handlers.ts";
import {
  adminClient,
  desktopClient,
  ik,
  remoteClient,
  startTestGateway,
  type TestClient,
  type TestGateway,
} from "./helpers.ts";

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

/** #1689 review r1, item 12: the other ways a thread could start in Full access. */
describe("Full access never starts by another route", () => {
  let g: TestGateway | null = null;
  const clients: TestClient[] = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    await g?.cleanup();
    g = null;
  });
  // biome-ignore lint/suspicious/noExplicitAny: loose JSON payloads read by the assertions
  type Json = Record<string, any>;
  const boot = async () => {
    g = await startTestGateway({
      handlers: {
        ...spacesHandlers(),
        ...spaceFolderHandlers({ broker: () => undefined, home: "/tmp/psyche-full-access-test" }),
        ...threadSettingsHandlers(modelPinsFor(router)),
      },
    });
    const mac = await desktopClient(g.gateway);
    const phone = await remoteClient(g.gateway);
    const admin = await adminClient(g.gateway);
    clients.push(mac, phone, admin);
    return { db: g.gateway.context.db, mac, phone, admin };
  };

  it("threads.create with full from a paired device without admin scope is refused", async () => {
    const { mac, phone } = await boot();
    const res = await phone.request("threads.create", { kind: "side", permissionMode: "full" }, ik());
    expect(res.error).toMatchObject({ code: "forbidden", details: { reason: "full_access_device" } });
    // Control: the Mac app may.
    const made = await mac.call<Json>("threads.create", { kind: "side", permissionMode: "full" }, ik());
    expect(made.thread.permissionMode).toBe("full");
  });

  it("a fork of a Full-access chat starts in Balanced", async () => {
    const { db, mac } = await boot();
    const source = (
      await mac.call<Json>("threads.create", { kind: "side", permissionMode: "full" }, ik())
    ).thread;
    const at = appendMessage(
      db,
      { threadId: source.id, role: "user", blocks: [{ type: "text", md: "hi" }], provenance: "owner" },
      { expectedWriterRunId: null },
    );
    const fork = (
      await mac.call<Json>("threads.fork", { threadId: source.id, messageId: at.id }, ik())
    ).thread;
    expect(fork.id).not.toBe(source.id);
    expect(fork.permissionMode).toBe("balanced");
  });

  it("a Space's default mode can't be full", async () => {
    const { admin } = await boot();
    const space = (await admin.call<Json>("spaces.create", { name: "Kitchen" }, ik())).space;
    const res = await admin.request(
      "spaces.settings.set",
      { spaceId: space.id, defaultPermissionMode: "full" },
      ik(),
    );
    expect(res.ok).not.toBe(true);
    expect(res.error).toMatchObject({ details: { reason: "full_access_thread" } });
  });

  it("threads.newChat reusing an empty Full-access chat doesn't carry Full access over", async () => {
    const { mac } = await boot();
    const first = await mac.call<Json>("threads.newChat", { kind: "side" }, ik());
    expect(first.reused).toBe(false);
    await mac.call("threads.update", { threadId: first.thread.id, permissionMode: "full" }, ik());
    const again = await mac.call<Json>(
      "threads.newChat",
      { kind: "side", preferThreadId: first.thread.id },
      ik(),
    );
    expect(again.reused).toBe(true);
    expect(again.thread.id).toBe(first.thread.id);
    expect(again.thread.permissionMode).toBe("balanced");
  });
});

/** #1689 review r1, item 9: what no file tool reads, Full access's home root included. */
describe("file tools never read the owner's private stores", () => {
  const H = "/Users/o";
  it.each([
    "Library/Application Support/BraveSoftware",
    "Library/Application Support/Microsoft Edge",
    "Library/Application Support/Arc",
    "Library/Application Support/Chromium",
    "Library/Application Support/Vivaldi",
    "Library/Containers/com.apple.Safari",
    "Library/Messages",
    "Library/Mail",
    "Library/Application Support/Claude",
    ".codex",
    ".gemini",
    ".zsh_history",
    ".bash_history",
  ])("~/%s is protected", (rel) => {
    expect(protectedRoots(`${H}/.psyche`, "darwin", H)).toContain(`${H}/${rel}`);
  });

  it("exec_host's sandbox denies the same browser profiles (one list)", () => {
    const roots = protectedRoots(`${H}/.psyche`, "darwin", H);
    for (const p of browserProfiles(H)) expect(roots).toContain(p);
  });

  it("control: the owner's documents are not", () => {
    expect(protectedRoots(`${H}/.psyche`, "darwin", H)).not.toContain(`${H}/Documents`);
  });
});
