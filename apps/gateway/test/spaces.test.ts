import type { PsycheDb } from "@psyche/db";
import { afterEach, describe, expect, it } from "vitest";
import { spacesHandlers } from "../src/spaces/handlers.ts";
import {
  adminClient,
  desktopClient,
  ik,
  startTestGateway,
  type TestClient,
  type TestGateway,
} from "./helpers.ts";

/** Spaces wave S1 end to end: the real Gateway, the `spaces.*` handlers, fixture rows only. */

let t: TestGateway | null = null;
let c: TestClient | null = null;

afterEach(async () => {
  c?.close();
  c = null;
  await t?.cleanup();
  t = null;
});

async function start() {
  t = await startTestGateway({ handlers: spacesHandlers() });
  c = await adminClient(t.gateway);
  return { gw: t.gateway, c };
}

// biome-ignore lint/suspicious/noExplicitAny: loose JSON payloads read by the assertions
type Json = Record<string, any>;

const newChat = async (c: TestClient, params: Json = {}): Promise<string> => {
  const r = await c.call<Json>("threads.create", { kind: "side", title: "Tiles", ...params }, ik());
  return r.thread.id;
};

const insertAutomation = (
  db: { sqlite: PsycheDb["sqlite"]; now(): string },
  id: string,
  enabled = 1,
  system = 0,
) =>
  db.sqlite
    .prepare(
      `INSERT INTO automations (id, kind, title, schedule, timezone, session_target, delivery, prompt,
         enabled, light_context, system, next_run_at, created_at, updated_at)
       VALUES (?, 'cron', ?, '0 7 * * *', 'UTC', 'isolated', '{}', 'go', ?, 0, ?, ?, ?, ?)`,
    )
    .run(id, `Job ${id}`, enabled, system, enabled ? db.now() : null, db.now(), db.now());

describe("spaces: create, rename, list", () => {
  it("creates, renames, edits instructions with a revision bump, and lists in order", async () => {
    const { c } = await start();
    const a = (
      await c.call<Json>("spaces.create", { name: "Kitchen remodel", icon: "hammer" }, ik())
    ).space;
    const b = (await c.call<Json>("spaces.create", { name: "Job search" }, ik())).space;
    expect(a).toMatchObject({
      name: "Kitchen remodel",
      instructions: "",
      instructionsRev: 1,
      private: false,
    });
    expect(b.sort).toBeGreaterThan(a.sort);

    const renamed = (await c.call<Json>("spaces.update", { spaceId: a.id, name: "Kitchen" })).space;
    expect(renamed.name).toBe("Kitchen");
    expect(renamed.instructionsRev).toBe(1);
    const ins = (
      await c.call<Json>("spaces.update", { spaceId: a.id, instructions: "Use metric." })
    ).space;
    expect(ins).toMatchObject({ instructions: "Use metric.", instructionsRev: 2 });
    const same = (
      await c.call<Json>("spaces.update", { spaceId: a.id, instructions: "Use metric." })
    ).space;
    expect(same.instructionsRev).toBe(2);
    // The Keep-private flag is stored (it is enforced in S3).
    expect(
      (await c.call<Json>("spaces.update", { spaceId: a.id, private: true })).space.private,
    ).toBe(true);

    const list = await c.call<Json>("spaces.list", {});
    expect(list.spaces.map((s: Json) => s.name)).toEqual(["Kitchen", "Job search"]);
    expect(list.spaces[0].counts).toEqual({ chats: 0, trackers: 0, due: 0 });
  });

  it("returns the same Space for a retried create key and refuses a second Space for one project", async () => {
    const { c } = await start();
    const key = ik();
    const one = await c.call<Json>("spaces.create", { name: "Trip" }, key);
    const two = await c.call<Json>("spaces.create", { name: "Trip" }, key);
    expect(two.space.id).toBe(one.space.id);
    expect((await c.call<Json>("spaces.list", {})).spaces).toHaveLength(1);

    await c.call("spaces.create", { name: "A", entityId: "ent_1" }, ik());
    const dup = await c.request("spaces.create", { name: "B", entityId: "ent_1" }, ik());
    expect(dup).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("answers not_found for an unknown Space, and, in this S1-only fixture, not_implemented for the folders and settings methods (spaces/folders.ts registers them in the composed Gateway)", async () => {
    const { c } = await start();
    expect(await c.request("spaces.get", { spaceId: "nope" })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    const s = (await c.call<Json>("spaces.create", { name: "X" }, ik())).space;
    for (const [method, params] of [
      ["spaces.folders.add", { spaceId: s.id, path: "/tmp/x" }],
      ["spaces.folders.remove", { spaceId: s.id, path: "/tmp/x" }],
      ["spaces.folders.setMode", { spaceId: s.id, path: "/tmp/x", mode: "ro" }],
      ["spaces.settings.set", { spaceId: s.id }],
    ] as const) {
      expect(await c.request(method, params, ik())).toMatchObject({
        ok: false,
        error: { code: "not_implemented" },
      });
    }
  });
});

describe("spaces: chats move in and out (SP11: one Space per chat)", () => {
  it("starts a chat in a Space, moves it to another, and out", async () => {
    const { c } = await start();
    const a = (await c.call<Json>("spaces.create", { name: "A" }, ik())).space;
    const b = (await c.call<Json>("spaces.create", { name: "B" }, ik())).space;
    const inA = await newChat(c, { spaceId: a.id });
    const loose = await newChat(c);
    expect((await c.call<Json>("threads.get", { threadId: inA })).thread.spaceId).toBe(a.id);
    expect((await c.call<Json>("threads.get", { threadId: loose })).thread.spaceId).toBeNull();

    // Moving the loose chat in, then the first chat across: a chat is in at most one Space.
    expect(await c.call("spaces.threads.move", { threadIds: [loose, inA], spaceId: b.id })).toEqual(
      { moved: 2 },
    );
    expect((await c.call<Json>("spaces.list", {})).spaces.map((s: Json) => s.counts.chats)).toEqual(
      [0, 2],
    );
    // Already there: nothing moves.
    expect(await c.call("spaces.threads.move", { threadIds: [loose], spaceId: b.id })).toEqual({
      moved: 0,
    });

    expect(await c.call("spaces.threads.move", { threadIds: [loose], spaceId: null })).toEqual({
      moved: 1,
    });
    expect((await c.call<Json>("threads.get", { threadId: loose })).thread.spaceId).toBeNull();

    const bOnly = await c.call<Json>("threads.list", { spaceId: b.id });
    expect(bOnly.threads.map((e: Json) => e.thread.id)).toEqual([inA]);
    const detail = await c.call<Json>("spaces.get", { spaceId: b.id });
    expect(detail.counts.chats).toBe(1);
    expect(detail.lastActivityAt).not.toBeNull();
  });

  it("refuses a missing chat, the main chat and an archived target, moving nothing", async () => {
    const { c } = await start();
    const a = (await c.call<Json>("spaces.create", { name: "A" }, ik())).space;
    const chat = await newChat(c);
    const main = (await c.call<Json>("threads.create", { kind: "main" }, ik())).thread.id;

    expect(
      await c.request("spaces.threads.move", { threadIds: [chat, "ghost"], spaceId: a.id }),
    ).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(
      await c.request("spaces.threads.move", { threadIds: [chat, main], spaceId: a.id }),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid_params" },
    });
    expect((await c.call<Json>("threads.get", { threadId: chat })).thread.spaceId).toBeNull();

    await c.call("spaces.archive", { spaceId: a.id });
    expect(
      await c.request("spaces.threads.move", { threadIds: [chat], spaceId: a.id }),
    ).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    expect(await c.request("threads.create", { kind: "side", spaceId: a.id }, ik())).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    expect(
      await c.request("threads.create", { kind: "side", spaceId: "ghost" }, ik()),
    ).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });

  it("puts a New chat in the Space it was opened in", async () => {
    const { c } = await start();
    const a = (await c.call<Json>("spaces.create", { name: "A" }, ik())).space;
    const r = await c.call<Json>("threads.newChat", { kind: "side", spaceId: a.id });
    expect(r.thread.spaceId).toBe(a.id);
    // Opened again without a Space, the same empty chat comes back in the main list.
    const again = await c.call<Json>("threads.newChat", { kind: "side" });
    expect(again).toMatchObject({ reused: true });
    expect(again.thread.spaceId).toBeNull();
  });
});

describe("spaces: automations move", () => {
  it("moves automations in and out, and refuses Psyche's own routines", async () => {
    const { gw, c } = await start();
    const db = gw.context.db;
    insertAutomation(db, "aut_1");
    insertAutomation(db, "aut_sys", 1, 1);
    const a = (await c.call<Json>("spaces.create", { name: "A" }, ik())).space;
    expect(
      await c.call("spaces.automations.move", { automationIds: ["aut_1"], spaceId: a.id }),
    ).toEqual({ moved: 1 });
    expect((await c.call<Json>("spaces.get", { spaceId: a.id })).automationIds).toEqual(["aut_1"]);
    expect(
      await c.request("spaces.automations.move", { automationIds: ["aut_sys"], spaceId: a.id }),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid_params" },
    });
    expect(
      await c.call("spaces.automations.move", { automationIds: ["aut_1"], spaceId: null }),
    ).toEqual({ moved: 1 });
    expect((await c.call<Json>("spaces.get", { spaceId: a.id })).automationIds).toEqual([]);
  });
});

describe("spaces: archive, restore, delete clean up", () => {
  it("archives (hidden, automations paused) and restores (only those it paused resume)", async () => {
    const { gw, c } = await start();
    const db = gw.context.db;
    insertAutomation(db, "aut_on");
    insertAutomation(db, "aut_off", 0);
    const a = (await c.call<Json>("spaces.create", { name: "A" }, ik())).space;
    await c.call("spaces.automations.move", {
      automationIds: ["aut_on", "aut_off"],
      spaceId: a.id,
    });

    const archived = (await c.call<Json>("spaces.archive", { spaceId: a.id })).space;
    expect(archived.archivedAt).not.toBeNull();
    expect((await c.call<Json>("spaces.list", {})).spaces).toEqual([]);
    expect(
      (await c.call<Json>("spaces.list", { archived: true })).spaces.map((s: Json) => s.id),
    ).toEqual([a.id]);
    const enabled = () =>
      (db.sqlite.prepare("SELECT id, enabled FROM automations ORDER BY id").all() as Json[]).map(
        (r) => [r.id, r.enabled],
      );
    expect(enabled()).toEqual([
      ["aut_off", 0],
      ["aut_on", 0],
    ]);
    // Archiving twice changes nothing.
    expect((await c.call<Json>("spaces.archive", { spaceId: a.id })).space.archivedAt).toBe(
      archived.archivedAt,
    );

    const restored = (await c.call<Json>("spaces.restore", { spaceId: a.id })).space;
    expect(restored.archivedAt).toBeNull();
    expect(enabled()).toEqual([
      ["aut_off", 0],
      ["aut_on", 1],
    ]);
    expect((await c.call<Json>("spaces.list", {})).spaces).toHaveLength(1);
  });

  it("deletes: chats and automations stay with no Space, links and shelf rows go", async () => {
    const { gw, c } = await start();
    const db = gw.context.db;
    insertAutomation(db, "aut_1");
    const a = (await c.call<Json>("spaces.create", { name: "A" }, ik())).space;
    const chat = await newChat(c, { spaceId: a.id });
    await c.call("spaces.automations.move", { automationIds: ["aut_1"], spaceId: a.id });
    await c.call("spaces.links.add", {
      spaceId: a.id,
      kind: "url",
      ref: "https://example.com",
      label: "Quote",
    });
    // A folder row and a shelf row, as S2 and S4 will write them.
    db.sqlite
      .prepare(
        "INSERT INTO space_folders (space_id, path, real, mode, added_at) VALUES (?, '/p', '/p', 'ro', ?)",
      )
      .run(a.id, db.now());

    expect(await c.call("spaces.delete", { spaceId: a.id })).toEqual({ ok: true });
    expect((await c.call<Json>("threads.get", { threadId: chat })).thread.spaceId).toBeNull();
    expect(db.sqlite.prepare("SELECT space_id FROM automations WHERE id = 'aut_1'").get()).toEqual({
      space_id: null,
    });
    for (const table of ["space_links", "space_folders", "space_trackers"]) {
      expect(db.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
    expect(await c.request("spaces.get", { spaceId: a.id })).toMatchObject({ ok: false });
  });

  it("needs admin scope to delete (the method table says operator.admin)", async () => {
    const { gw, c } = await start();
    const a = (await c.call<Json>("spaces.create", { name: "A" }, ik())).space;
    const desk = await desktopClient(gw);
    try {
      expect(await desk.request("spaces.delete", { spaceId: a.id })).toMatchObject({
        ok: false,
        error: { code: "forbidden" },
      });
    } finally {
      desk.close();
    }
    expect((await c.call<Json>("spaces.list", {})).spaces).toHaveLength(1);
  });
});

describe("spaces: links", () => {
  it("adds owner links, refuses duplicates and non-web URLs, removes", async () => {
    const { c } = await start();
    const a = (await c.call<Json>("spaces.create", { name: "A" }, ik())).space;
    const { link } = await c.call<Json>("spaces.links.add", {
      spaceId: a.id,
      kind: "url",
      ref: "https://example.com/a",
      label: "Plan",
    });
    expect(link).toMatchObject({ addedBy: "owner", labelProvenance: "owner", kind: "url" });
    expect(
      await c.request("spaces.links.add", {
        spaceId: a.id,
        kind: "url",
        ref: "https://example.com/a",
        label: "Again",
      }),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(
      await c.request("spaces.links.add", {
        spaceId: a.id,
        kind: "url",
        ref: "javascript:alert(1)",
        label: "x",
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_params" } });
    expect((await c.call<Json>("spaces.get", { spaceId: a.id })).links).toHaveLength(1);
    await c.call("spaces.links.remove", { spaceId: a.id, linkId: link.id });
    expect((await c.call<Json>("spaces.get", { spaceId: a.id })).links).toEqual([]);
    expect(
      await c.request("spaces.links.remove", { spaceId: a.id, linkId: link.id }),
    ).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });
});

describe("spaces: proposals", () => {
  it("accepting creates the Space and moves the named chats in; dismissing closes it", async () => {
    const { gw, c } = await start();
    const db = gw.context.db;
    const chat = await newChat(c);
    const add = (id: string, threads: string[]) =>
      db.sqlite
        .prepare(
          `INSERT INTO space_proposals (id, name, reason, entity_id, thread_ids, taint, status, created_at)
           VALUES (?, 'Taxes', 'You talk about it', NULL, ?, '[]', 'open', ?)`,
        )
        .run(id, JSON.stringify(threads), db.now());
    add("prop_1", [chat, "ghost"]);
    add("prop_2", []);
    expect((await c.call<Json>("spaces.proposals.list", {})).proposals).toHaveLength(2);

    const { space } = await c.call<Json>(
      "spaces.proposals.accept",
      { proposalId: "prop_1", name: "Taxes 2026" },
      ik(),
    );
    expect(space).toMatchObject({ name: "Taxes 2026", createdFrom: "proposal" });
    expect((await c.call<Json>("threads.get", { threadId: chat })).thread.spaceId).toBe(space.id);
    expect(
      await c.request("spaces.proposals.accept", { proposalId: "prop_1" }, ik()),
    ).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });

    await c.call("spaces.proposals.dismiss", { proposalId: "prop_2" });
    expect((await c.call<Json>("spaces.proposals.list", { status: "open" })).proposals).toEqual([]);
  });
});

describe("spaces: events", () => {
  it("fires space.updated for each kind of change, and thread.updated for moved chats", async () => {
    const { c } = await start();
    const changes = () =>
      c.eventsNamed("space.updated").map((e) => (e.payload as Json).changed.join(","));
    const a = (await c.call<Json>("spaces.create", { name: "A" }, ik())).space;
    await c.call("spaces.update", { spaceId: a.id, name: "A2" });
    const { link } = await c.call<Json>("spaces.links.add", {
      spaceId: a.id,
      kind: "note",
      ref: "n1",
      label: "Note",
    });
    await c.call("spaces.links.remove", { spaceId: a.id, linkId: link.id });
    const chat = await newChat(c);
    await c.call("spaces.threads.move", { threadIds: [chat], spaceId: a.id });
    await c.call("spaces.archive", { spaceId: a.id });
    await c.call("spaces.restore", { spaceId: a.id });
    await c.call("spaces.delete", { spaceId: a.id });
    await c.waitForEvent(
      (e) => e.event === "space.updated" && (e.payload as Json).changed[0] === "deleted",
    );
    expect(changes()).toEqual([
      "row",
      "row",
      "links",
      "links",
      "threads",
      "archived",
      "archived",
      "deleted",
    ]);
    const moved = c
      .eventsNamed("thread.updated")
      .filter((e) => (e.payload as Json).thread.id === chat);
    expect(moved.length).toBeGreaterThanOrEqual(2);
    expect(((moved.at(-1) as Json).payload as Json).thread.spaceId).toBeNull();
  });
});
