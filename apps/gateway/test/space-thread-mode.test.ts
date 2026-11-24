import { setSetting } from "@psyche/db";
import { afterEach, describe, expect, it } from "vitest";
import { spacesHandlers } from "../src/spaces/handlers.ts";
import { adminClient, ik, startTestGateway, type TestClient, type TestGateway } from "./helpers.ts";

/**
 * A Space's default permission mode sets the mode of new chats in it (design §4.2), and only ever
 * narrows: the stricter of the Space's mode and the owner's global default.
 */

let t: TestGateway | null = null;
let c: TestClient | null = null;

afterEach(async () => {
  c?.close();
  c = null;
  await t?.cleanup();
  t = null;
});

// biome-ignore lint/suspicious/noExplicitAny: loose JSON payloads read by the assertions
type Json = Record<string, any>;

async function start() {
  t = await startTestGateway({ handlers: spacesHandlers() });
  c = await adminClient(t.gateway);
  const db = t.gateway.context.db;
  const space = async (mode: string | null) => {
    const id = (await c?.call<Json>("spaces.create", { name: `S ${mode}` }, ik()))?.space.id;
    db.sqlite.prepare("UPDATE spaces SET default_permission_mode = ? WHERE id = ?").run(mode, id);
    return id as string;
  };
  const global = (mode: string | undefined) => {
    if (mode !== undefined) setSetting(db, "permissions.mode", mode);
  };
  const create = async (params: Json) =>
    (await (c as TestClient).call<Json>("threads.create", { kind: "side", ...params }, ik()))
      .thread as Json;
  return { db, space, global, create, c: c as TestClient };
}

describe("new chats in a Space", () => {
  it("global balanced with Space plan gives plan", async () => {
    const s = await start();
    s.global("balanced");
    const id = await s.space("plan");
    expect((await s.create({ spaceId: id })).permissionMode).toBe("plan");
  });

  it("global auto (no allowlisted model, so balanced) with Space plan gives plan", async () => {
    const s = await start();
    s.global("auto");
    const id = await s.space("plan");
    expect((await s.create({ spaceId: id })).permissionMode).toBe("plan");
  });

  it("global manual with Space auto gives manual: a Space never widens", async () => {
    const s = await start();
    s.global("manual");
    const id = await s.space("auto");
    expect((await s.create({ spaceId: id })).permissionMode).toBe("manual");
  });

  it("global manual with Space balanced gives manual; Space manual under balanced gives manual", async () => {
    const s = await start();
    s.global("manual");
    expect((await s.create({ spaceId: await s.space("balanced") })).permissionMode).toBe("manual");
    s.global("balanced");
    expect((await s.create({ spaceId: await s.space("manual") })).permissionMode).toBe("manual");
  });

  it("a Space with no mode gives the global mode", async () => {
    const s = await start();
    s.global("manual");
    const id = await s.space(null);
    const inSpace = await s.create({ spaceId: id });
    const outside = await s.create({});
    expect(inSpace.permissionMode).toBe("manual");
    expect(inSpace.permissionMode).toBe(outside.permissionMode);
  });

  it("an explicit permissionMode is still honoured, and Auto still needs an allowlisted model", async () => {
    const s = await start();
    s.global("manual");
    const id = await s.space("plan");
    expect((await s.create({ spaceId: id, permissionMode: "balanced" })).permissionMode).toBe(
      "balanced",
    );
    expect(
      await s.c.request(
        "threads.create",
        { kind: "side", spaceId: id, permissionMode: "auto" },
        ik(),
      ),
    ).toMatchObject({ ok: false });
  });

  it("a chat outside any Space is unchanged by other Spaces' modes", async () => {
    const s = await start();
    s.global("balanced");
    await s.space("plan");
    expect((await s.create({})).permissionMode).toBe("balanced");
  });

  it("the Space page's new chat (threads.newChat) gets the narrower mode, new or reused", async () => {
    const s = await start();
    s.global("balanced");
    const id = await s.space("plan");
    const fresh = (await s.c.call<Json>("threads.newChat", { kind: "side", spaceId: id })).thread;
    expect(fresh.permissionMode).toBe("plan");
    // The empty chat is reused by a Space with a stricter mode; it narrows, never widens.
    const other = await s.space("manual");
    const reused = await s.c.call<Json>("threads.newChat", { kind: "side", spaceId: other });
    expect(reused.reused).toBe(true);
    expect(reused.thread.permissionMode).toBe("plan");
    // A chat with no Space keeps the global default.
    s.db.sqlite
      .prepare("UPDATE threads SET permission_mode = 'balanced' WHERE id = ?")
      .run(fresh.id);
    const out = await s.c.call<Json>("threads.newChat", { kind: "side" });
    expect(out.thread.permissionMode).toBe("balanced");
  });
});
