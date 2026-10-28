import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateContextTokens } from "@psyche/agent-core";
import { insertLibraryItem, type NewLibraryItem, openDb, type PsycheDb } from "@psyche/db";
import { PsycheError, UPLOAD_CHUNK_BYTES, UPLOAD_MAX_BYTES } from "@psyche/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { libraryHandlers } from "../src/compose/library.ts";
import { ATTACHMENT_LIMITS, resolveAttachments } from "../src/session/attachments.ts";
import { GatedAgentLoop, RecordingBroker } from "./agent.ts";
import {
  desktopClient,
  ik,
  startTestGateway,
  type TestClient,
  type TestGateway,
} from "./helpers.ts";

let base: string;
let home: string;
let db: PsycheDb;

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "psyche-attach-")));
  home = join(base, "home");
  await mkdir(join(home, "library", "uploads"), { recursive: true });
  db = openDb(":memory:");
});

afterEach(async () => {
  db.close();
  await rm(base, { recursive: true, force: true });
});

/** A Library file on disk plus its row. */
async function stored(
  name: string,
  bytes: Buffer | string,
  over: Partial<NewLibraryItem> = {},
): Promise<string> {
  const data = Buffer.from(bytes);
  await writeFile(join(home, "library", "uploads", name), data);
  return insertLibraryItem(db, {
    kind: "document",
    name,
    mime: "text/plain",
    path: `uploads/${name}`,
    size: data.byteLength,
    sha256: "sha256:00",
    origin: "upload",
    ...over,
  }).id;
}

/** A PNG header for the given size, padded with noise to `bytes`. */
function bigPng(width: number, height: number, bytes: number): Buffer {
  const b = Buffer.alloc(bytes);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  for (let i = 33; i < bytes; i++) b[i] = (i * 31) & 0xff;
  return b;
}

describe("image attachments and tokens", () => {
  it("returns a large screenshot as an image, not text, and estimates a few thousand tokens", async () => {
    const id = await stored("shot.png", bigPng(1200, 800, 505_000), {
      kind: "image",
      mime: "image/png",
    });
    const out = await resolveAttachments(db, home, [id]);
    expect(out.images).toHaveLength(1);
    expect(out.images[0]?.mime).toBe("image/png");
    expect(out.text).not.toContain(out.images[0]?.data.slice(0, 40) ?? "?");
    const tokens = estimateContextTokens(
      "",
      [{ role: "user", parts: [{ type: "image", ...(out.images[0] as object) } as never] }],
      [],
    );
    expect(tokens).toBeLessThan(3_000);
  });
});

describe("resolveAttachments", () => {
  it("passes a text file as a labelled block", async () => {
    const id = await stored("notes.txt", "buy milk\nand eggs");
    const out = await resolveAttachments(db, home, [id]);
    expect(out.images).toEqual([]);
    expect(out.text).toContain("[attached file: notes.txt");
    expect(out.text).toContain("buy milk\nand eggs");
    expect(out.text).toContain("[end of attached file]");
  });

  it("passes an image as an image part and says the model can see it", async () => {
    const id = await stored("shot.png", PNG, { kind: "image", mime: "image/png" });
    const out = await resolveAttachments(db, home, [id]);
    expect(out.images).toEqual([{ mime: "image/png", data: PNG.toString("base64") }]);
    expect(out.text).toContain("attached image: shot.png");
  });

  it("caps one document's text and says what was cut", async () => {
    const long = "x".repeat(ATTACHMENT_LIMITS.docChars + 500);
    const id = await stored("big.md", long, { mime: "text/markdown" });
    const out = await resolveAttachments(db, home, [id]);
    expect(out.text).toContain(`cut: showed ${ATTACHMENT_LIMITS.docChars} of ${long.length}`);
    expect(out.text.length).toBeLessThan(long.length);
  });

  it("stops at the message's total text budget", async () => {
    const part = "y".repeat(ATTACHMENT_LIMITS.docChars);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await stored(`d${i}.txt`, part));
    const out = await resolveAttachments(db, home, ids);
    expect(out.text).toContain("text budget");
    const body = out.text.split("\n").filter((l) => l.startsWith("yyy"));
    expect(body).toHaveLength(3);
  });

  it("keeps at most four images and skips oversized ones", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(await stored(`i${i}.png`, PNG, { kind: "image", mime: "image/png" }));
    }
    const out = await resolveAttachments(db, home, ids);
    expect(out.images).toHaveLength(ATTACHMENT_LIMITS.images);
    expect(out.text).toContain("only 4 images go with a message");
    const bigId = await stored("big.png", Buffer.alloc(ATTACHMENT_LIMITS.imageBytes + 1), {
      kind: "image",
      mime: "image/png",
    });
    const big = await resolveAttachments(db, home, [bigId]);
    expect(big.images).toEqual([]);
    expect(big.text).toContain("too large");
  });

  it("notes what it cannot read instead of failing the message", async () => {
    const quarantined = await stored("q.txt", "secret", { quarantined: true });
    const binary = await stored("a.bin", "zz", { mime: "application/octet-stream" });
    const fakePdf = await stored("fake.pdf", "not a pdf", { mime: "application/pdf" });
    const out = await resolveAttachments(db, home, [quarantined, binary, fakePdf, "missing"]);
    expect(out.text).toContain("q.txt (library item");
    expect(out.text).toContain("is quarantined");
    expect(out.text).toContain("files are not read as text");
    expect(out.text).toContain("it is not a PDF file");
    expect(out.text).toContain("library item missing was not found");
    expect(out.text).not.toContain("secret");
  });
});

describe("library.upload", () => {
  let handlers: ReturnType<typeof libraryHandlers>;
  beforeEach(() => {
    handlers = libraryHandlers({ db, home });
  });
  const call = (deviceId = "dev_1") => ({ identity: { deviceId } }) as never;
  const upload = (params: unknown, deviceId?: string) =>
    (async () => handlers["library.upload"]?.run(call(deviceId), params as never))() as Promise<{
      uploadId: string;
      received: number;
      item?: { id: string; path: string; origin: string; mime: string; kind: string; size: number };
    }>;
  const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");

  it("stores a file sent in chunks and returns its Library item", async () => {
    const run = upload;
    const first = await run({ name: "plan.txt", bytes: b64("hello "), final: false });
    expect(first.item).toBeUndefined();
    expect(first.received).toBe(6);
    const last = await run({
      name: "plan.txt",
      uploadId: first.uploadId,
      bytes: b64("world"),
      final: true,
      threadId: "th_1",
    });
    expect(last.item).toMatchObject({
      origin: "upload",
      mime: "text/plain",
      kind: "document",
      size: 11,
    });
    const out = await resolveAttachments(db, home, [last.item?.id as string]);
    expect(out.text).toContain("hello world");
  });

  it("types an image by its extension when the browser gave no mime", async () => {
    const res = await upload({ name: "pic.PNG", bytes: b64(PNG), final: true });
    expect(res.item).toMatchObject({ mime: "image/png", kind: "image" });
  });

  it("refuses an empty file, an oversized one and another device's upload", async () => {
    const code = async (p: Promise<unknown>) =>
      p.then(
        () => "ok",
        (e: unknown) => (e instanceof PsycheError ? e.code : String(e)),
      );
    expect(await code(upload({ name: "e.txt", bytes: "", final: true }))).toBe("invalid_params");
    const first = await upload({ name: "a.txt", bytes: b64("a"), final: false });
    expect(
      await code(
        upload({ name: "a.txt", uploadId: first.uploadId, bytes: b64("b"), final: true }, "dev_2"),
      ),
    ).toBe("not_found");
    const chunk = b64(Buffer.alloc(UPLOAD_CHUNK_BYTES));
    let id: string | undefined;
    let result = "ok";
    for (let sent = 0; sent <= UPLOAD_MAX_BYTES && result === "ok"; sent += UPLOAD_CHUNK_BYTES) {
      result = await code(
        upload({
          name: "big.bin",
          ...(id ? { uploadId: id } : {}),
          bytes: chunk,
          final: false,
        }).then((r) => {
          id = r.uploadId;
        }),
      );
    }
    expect(result).toBe("invalid_params");
  });
});

describe("chat.send with attachments", () => {
  let t: TestGateway;
  let agent: GatedAgentLoop;
  const clients: TestClient[] = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    await t?.cleanup();
  });

  it("gives the agent extracted text and image parts for the Library items", async () => {
    agent = new GatedAgentLoop();
    t = await startTestGateway({ agent, broker: new RecordingBroker({ armDelayMs: 0 }) });
    const c = await desktopClient(t.gateway);
    clients.push(c);
    const ctx = t.gateway.context;
    const lib = join(ctx.config.home, "library", "uploads");
    await mkdir(lib, { recursive: true });
    await writeFile(join(lib, "memo.txt"), "the plan is to ship on friday");
    await writeFile(join(lib, "shot.png"), PNG);
    const doc = insertLibraryItem(ctx.db, {
      kind: "document",
      name: "memo.txt",
      mime: "text/plain",
      path: "uploads/memo.txt",
      size: 29,
      sha256: "sha256:00",
      origin: "upload",
    });
    const img = insertLibraryItem(ctx.db, {
      kind: "image",
      name: "shot.png",
      mime: "image/png",
      path: "uploads/shot.png",
      size: PNG.byteLength,
      sha256: "sha256:00",
      origin: "upload",
    });
    const { thread } = await c.call<{ thread: { id: string } }>(
      "threads.create",
      { kind: "side" },
      ik(),
    );
    await c.call(
      "chat.send",
      { threadId: thread.id, content: "what do these say?", attachments: [doc.id, img.id] },
      ik(),
    );
    await ctx.sessions.idle();
    const input = agent.turns[0]?.input;
    expect(input?.text).toBe("what do these say?");
    expect(input?.attachments).toEqual([{ libraryItemId: doc.id }, { libraryItemId: img.id }]);
    expect(input?.attachmentText).toContain("the plan is to ship on friday");
    expect(input?.images).toEqual([{ mime: "image/png", data: PNG.toString("base64") }]);
  });
});
