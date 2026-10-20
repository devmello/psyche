import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getLibraryItem,
  insertLibraryItem,
  type NewLibraryItem,
  openDb,
  type PsycheDb,
  updateDevice,
} from "@psyche/db";
import { LibraryItem, PsycheError } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { Value } from "@sinclair/typebox/value";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import {
  IndexedQuarantineWriter,
  indexedChannelLibrary,
  indexSavedAudio,
  libraryHandlers,
} from "../src/compose/library.ts";
import { FsAudioLibrary } from "../src/compose/speech.ts";
import { silentLogger } from "../src/log.ts";
import { desktopClient, ik, newDeviceKey, type TestClient } from "./helpers.ts";

let base: string;
let home: string;
let db: PsycheDb;

const run = (method: string, params: unknown) => {
  const h = libraryHandlers({ db, home })[method];
  if (h === undefined) throw new Error(`no handler ${method}`);
  return (async () => h.run({} as never, params as never))() as Promise<Record<string, unknown>>;
};

const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "ok";
  } catch (err) {
    return err instanceof PsycheError ? err.code : `raw: ${String(err)}`;
  }
};

const item = (over: Partial<NewLibraryItem> = {}): NewLibraryItem => ({
  kind: "document",
  name: "notes.txt",
  mime: "text/plain",
  path: "uploads/notes.txt",
  size: 5,
  sha256: "sha256:00",
  origin: "upload",
  ...over,
});

const names = async (params: unknown) =>
  ((await run("library.list", params)).items as LibraryItem[]).map((i) => i.name);

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "psyche-library-")));
  home = join(base, "home");
  await mkdir(join(home, "library"), { recursive: true });
  db = openDb(":memory:");
});

afterEach(async () => {
  db.close();
  await rm(base, { recursive: true, force: true });
});

describe("library.list / library.get", () => {
  it("filters by kind, thread, task and name, newest first, in pages", async () => {
    insertLibraryItem(db, item({ name: "a_plan.pdf", path: "u/1", threadId: "t1" }));
    insertLibraryItem(db, item({ name: "photo.png", kind: "image", path: "u/2", taskId: "k1" }));
    insertLibraryItem(db, item({ name: "aXplan.pdf", kind: "download", path: "u/3" }));

    expect(await names({})).toEqual(["aXplan.pdf", "photo.png", "a_plan.pdf"]);
    expect(await names({ kind: "image" })).toEqual(["photo.png"]);
    expect(await names({ threadId: "t1" })).toEqual(["a_plan.pdf"]);
    expect(await names({ taskId: "k1" })).toEqual(["photo.png"]);
    // `_` is a literal in the query, not a LIKE wildcard.
    expect(await names({ query: "A_P" })).toEqual(["a_plan.pdf"]);

    const first = await run("library.list", { limit: 2 });
    expect((first.items as LibraryItem[]).length).toBe(2);
    expect(first.nextCursor).toBe("o2");
    const second = await run("library.list", { limit: 2, cursor: first.nextCursor });
    expect((second.items as LibraryItem[]).map((i) => i.name)).toEqual(["a_plan.pdf"]);
    expect(second.nextCursor).toBeNull();
    expect(await codeOf(run("library.list", { cursor: "bogus" }))).toBe("invalid_params");
  });

  it("returns one item that matches the protocol schema, or not_found", async () => {
    const saved = insertLibraryItem(db, item({ quarantined: true, tags: ["x"] }));
    const out = (await run("library.get", { itemId: saved.id })).item as LibraryItem;
    expect(Value.Check(LibraryItem, out)).toBe(true);
    expect(out).toEqual(saved);
    expect(out.quarantined).toBe(true);
    expect(await codeOf(run("library.get", { itemId: "missing" }))).toBe("not_found");
  });
});

describe("library.delete", () => {
  it("removes the file and the row", async () => {
    await mkdir(join(home, "library", "uploads"), { recursive: true });
    await writeFile(join(home, "library", "uploads", "notes.txt"), "hello");
    const saved = insertLibraryItem(db, item());
    expect(await run("library.delete", { itemId: saved.id })).toEqual({ ok: true });
    expect(existsSync(join(home, "library", "uploads", "notes.txt"))).toBe(false);
    expect(getLibraryItem(db, saved.id)).toBeUndefined();
    expect(await codeOf(run("library.delete", { itemId: saved.id }))).toBe("not_found");
  });

  it("drops the row when the file is already gone, and removes recording folders", async () => {
    const gone = insertLibraryItem(db, item({ path: "uploads/gone.txt" }));
    expect(await codeOf(run("library.delete", { itemId: gone.id }))).toBe("ok");
    expect(getLibraryItem(db, gone.id)).toBeUndefined();

    const dir = join(home, "library", "recordings", "task_1");
    await mkdir(join(dir, "frames"), { recursive: true });
    await writeFile(join(dir, "frames", "0.jpg"), "x");
    const rec = insertLibraryItem(db, item({ kind: "recording", path: "recordings/task_1" }));
    expect(await codeOf(run("library.delete", { itemId: rec.id }))).toBe("ok");
    expect(existsSync(dir)).toBe(false);
  });

  it("never leaves the Library: a row pointing outside it is refused and kept", async () => {
    await writeFile(join(home, "secret.txt"), "keep me");
    const bad = insertLibraryItem(db, item({ path: "../secret.txt" }));
    expect(await codeOf(run("library.delete", { itemId: bad.id }))).toBe("forbidden");
    expect(existsSync(join(home, "secret.txt"))).toBe(true);
    expect(getLibraryItem(db, bad.id)).toBeDefined();
  });
});

describe("writers index what they save", () => {
  it("channel attachments: quarantined, origin channel, readable at their path", async () => {
    const lib = indexedChannelLibrary(db, home);
    const { libraryItemId } = await lib.ingest({
      name: "../photo.png",
      mime: "image/png",
      data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      provenance: "untrusted",
      source: { channel: "telegram", channelId: "ch1", chatId: "c1", messageId: "m1" },
    });
    const saved = getLibraryItem(db, libraryItemId);
    expect(saved).toMatchObject({
      kind: "image",
      name: "photo.png",
      mime: "image/png",
      size: 4,
      origin: "channel",
      quarantined: true,
      tags: ["telegram"],
    });
    expect(saved?.path).toBe(`quarantine/${libraryItemId}-photo.png`);
    expect(saved?.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    const onDisk = join(home, "library", saved?.path ?? "");
    expect([...(await readFile(onDisk))]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect((await stat(onDisk)).mode & 0o777).toBe(0o600);
  });

  it("browser downloads: quarantined downloads with sniffed flags as tags", async () => {
    const landed = join(base, "landed.bin");
    await writeFile(landed, Buffer.from([0x4d, 0x5a, 0x90, 0x00]));
    const writer = new IndexedQuarantineWriter(db, home);
    const imported = await writer.importDownload(
      {
        path: landed,
        filename: "setup.pdf",
        declaredMime: "application/pdf",
        sourceUrl: "https://example.test/setup.pdf",
        taskId: "task1",
      },
      { mime: "application/x-msdownload", executable: true, mismatch: true },
    );
    const saved = getLibraryItem(db, imported.libraryItemId);
    expect(saved).toMatchObject({
      kind: "download",
      name: "setup.pdf",
      mime: "application/x-msdownload",
      origin: "download",
      taskId: "task1",
      quarantined: true,
      tags: ["executable", "mime-mismatch"],
      size: 4,
      sha256: imported.sha256,
    });
    expect(saved?.path).toBe(`quarantine/${imported.libraryItemId}-setup.pdf`);
    expect(existsSync(join(home, "library", saved?.path ?? ""))).toBe(true);
    expect(writer.items.size).toBe(0);
  });

  it("browser recordings: one row per recording, refreshed on re-import", async () => {
    const dir = join(home, "library", "recordings", "thread_t1");
    await mkdir(join(dir, "frames"), { recursive: true });
    await writeFile(join(dir, "index.json"), '{"version":1}');
    await writeFile(join(dir, "frames", "0.jpg"), "abcd");
    const writer = new IndexedQuarantineWriter(db, home);
    const rec = {
      id: "thread:t1",
      dir,
      taskId: null,
      threadId: "t1",
      frameCount: 1,
      eventCount: 0,
    };
    const first = await writer.importRecording(rec);
    expect(getLibraryItem(db, first.libraryItemId)).toMatchObject({
      kind: "recording",
      path: "recordings/thread_t1",
      threadId: "t1",
      origin: "agent",
      size: 17,
    });
    expect(getLibraryItem(db, first.libraryItemId)).not.toHaveProperty("quarantined");
    await writeFile(join(dir, "frames", "1.jpg"), "efgh");
    const again = await writer.importRecording({ ...rec, frameCount: 2 });
    expect(again.libraryItemId).toBe(first.libraryItemId);
    expect(getLibraryItem(db, first.libraryItemId)?.size).toBe(21);
  });

  it("speech audio: clips and memos are indexed, untrusted ones quarantined", async () => {
    const audio = new FsAudioLibrary(home, undefined, indexSavedAudio(db));
    const clip = await audio.saveAudio({
      name: "Read aloud.mp3",
      mime: "audio/mpeg",
      data: new Uint8Array([1, 2, 3]),
      threadId: "t1",
      tags: ["read-aloud"],
      provenance: "untrusted",
    } as never);
    expect(getLibraryItem(db, clip.id)).toEqual(clip);
    expect(clip.quarantined).toBe(true);
    expect(await names({ threadId: "t1", kind: "audio" })).toEqual(["Read aloud.mp3"]);
  });
});

describe("over the wire", () => {
  let composed: ComposedGateway | null = null;
  const clients: TestClient[] = [];

  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    await composed?.stop("test");
    composed = null;
  });

  it("serves library.* with the protocol's scopes", async () => {
    composed = await composeGateway({
      env: {},
      logger: silentLogger,
      retentionIntervalMs: 0,
      background: false,
      config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
      model: { provider: new FakeModelProvider(), model: "fake/model" },
    });
    const saved = insertLibraryItem(composed.db, item());
    const desk = await desktopClient(composed.gateway);
    clients.push(desk);
    const listed = await desk.call<{ items: LibraryItem[] }>("library.list", {});
    expect(listed.items.map((i) => i.id)).toEqual([saved.id]);
    expect(await desk.call("library.get", { itemId: saved.id })).toEqual({ item: saved });

    const key = newDeviceKey();
    (await desktopClient(composed.gateway, key, "reader")).close();
    updateDevice(composed.db, "reader", { scopes: ["operator.read"] });
    const reader = await desktopClient(composed.gateway, key, "reader");
    clients.push(reader);
    await expect(reader.call("library.list", {})).resolves.toBeDefined();
    await expect(reader.call("library.delete", { itemId: saved.id }, ik())).rejects.toThrow(
      /"code":"forbidden"/,
    );

    expect(await desk.call("library.delete", { itemId: saved.id }, ik())).toEqual({ ok: true });
    expect(getLibraryItem(composed.db, saved.id)).toBeUndefined();
  });
});
