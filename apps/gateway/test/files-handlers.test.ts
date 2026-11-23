import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FILE_CHUNK_BYTES, PsycheError } from "@psyche/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { filesHandlers } from "../src/compose/files.ts";

let base: string;
let granted: string;
let outside: string;
let home: string;
let folders: { path: string; mode: "ro" | "rw" }[];
/** The Library's rows by relative path, as the Gateway's DB holds them. */
let rows: Record<string, { name: string; quarantined: boolean }[]>;

const run = (method: string, params: unknown) => {
  const handlers = filesHandlers({
    folders: () => folders,
    home,
    library: { itemsAtPath: (path) => rows[path] ?? [] },
  });
  const h = handlers[method];
  if (h === undefined) throw new Error(`no handler ${method}`);
  return Promise.resolve(h.run({} as never, params as never)) as Promise<Record<string, unknown>>;
};

const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "ok";
  } catch (err) {
    return err instanceof PsycheError ? err.code : `raw: ${String(err)}`;
  }
};

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "psyche-files-")));
  granted = join(base, "granted");
  outside = join(base, "outside");
  home = join(base, "home");
  await mkdir(join(granted, "sub"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await mkdir(join(home, "library", "recordings"), { recursive: true });
  await writeFile(join(granted, "notes.txt"), "hello files");
  await writeFile(join(granted, "deck.pptx"), Buffer.from([0x50, 0x4b, 3, 4]));
  await writeFile(join(outside, "secret.txt"), "not yours");
  await symlink(join(outside, "secret.txt"), join(granted, "link.txt"));
  await writeFile(join(home, "library", "recordings", "shot.png"), Buffer.from([0x89, 0x50]));
  await writeFile(join(home, "secret.txt"), "home secret");
  folders = [{ path: granted, mode: "ro" }];
  rows = {};
  await mkdir(join(home, "library", "quarantine"), { recursive: true });
  await writeFile(join(home, "library", "quarantine", "q1-held.bin"), "held bytes");
  await writeFile(join(home, "library", "quarantine", "t2-trusted.txt"), "trusted text");
  await symlink(
    join(home, "library", "quarantine", "q1-held.bin"),
    join(home, "library", "recordings", "qlink.bin"),
  );
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("Psyche's home under a granted folder (#285)", () => {
  it("never reads or lists $PSYCHE_HOME, even with an ancestor granted", async () => {
    await mkdir(join(home, "vault"), { recursive: true });
    await writeFile(join(home, "vault", "slots.json"), "{}");
    folders = [{ path: base, mode: "ro" }];
    expect(await codeOf(run("files.read", { path: join(home, "vault", "slots.json") }))).toBe(
      "forbidden",
    );
    expect(await codeOf(run("files.list", { path: home }))).toBe("forbidden");
    const out = await run("files.list", { path: base });
    expect((out.entries as { name: string }[]).map((e) => e.name)).not.toContain("home");
    // The Library stays reachable by libraryPath.
    expect(await codeOf(run("files.read", { libraryPath: "recordings/shot.png" }))).toBe("ok");
  });
});

describe("files.list", () => {
  it("lists folders first, then files by name, and symlinks as other", async () => {
    const out = await run("files.list", { path: granted });
    const entries = out.entries as { name: string; kind: string; size: number | null }[];
    expect(entries.map((e) => [e.name, e.kind])).toEqual([
      ["sub", "folder"],
      ["deck.pptx", "file"],
      ["notes.txt", "file"],
      ["link.txt", "other"],
    ]);
    expect(entries.find((e) => e.name === "notes.txt")?.size).toBe(11);
    expect(out.nextOffset).toBeNull();
  });

  it("refuses folders outside the grants, and a revoked grant at once", async () => {
    expect(await codeOf(run("files.list", { path: outside }))).toBe("forbidden");
    expect(await codeOf(run("files.list", { path: join(granted, "..", "outside") }))).toBe(
      "forbidden",
    );
    folders = [];
    expect(await codeOf(run("files.list", { path: granted }))).toBe("forbidden");
  });
});

describe("files.read", () => {
  it("reads a granted file with its name, mime and etag", async () => {
    const out = await run("files.read", { path: join(granted, "notes.txt") });
    expect(Buffer.from(out.bytes as string, "base64").toString()).toBe("hello files");
    expect(out).toMatchObject({
      name: "notes.txt",
      mime: "text/plain",
      size: 11,
      offset: 0,
      nextOffset: null,
    });
    expect(typeof out.etag).toBe("string");
    const deck = await run("files.read", { path: join(granted, "deck.pptx") });
    expect(deck.mime).toBe(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );
  });

  it("pages a large file in chunks no bigger than FILE_CHUNK_BYTES", async () => {
    const big = Buffer.alloc(FILE_CHUNK_BYTES + 10, 7);
    await writeFile(join(granted, "big.bin"), big);
    const first = await run("files.read", { path: join(granted, "big.bin") });
    expect(Buffer.from(first.bytes as string, "base64").length).toBe(FILE_CHUNK_BYTES);
    expect(first.nextOffset).toBe(FILE_CHUNK_BYTES);
    expect(first.mime).toBe("application/octet-stream");
    const rest = await run("files.read", {
      path: join(granted, "big.bin"),
      offset: first.nextOffset,
    });
    expect(Buffer.from(rest.bytes as string, "base64").length).toBe(10);
    expect(rest.nextOffset).toBeNull();
    const small = await run("files.read", { path: join(granted, "big.bin"), length: 4 });
    expect(Buffer.from(small.bytes as string, "base64").length).toBe(4);
    expect(small.nextOffset).toBe(4);
  });

  it("refuses symlinks, folders, outside paths and bad sources", async () => {
    expect(await codeOf(run("files.read", { path: join(granted, "link.txt") }))).toBe("forbidden");
    expect(await codeOf(run("files.read", { path: join(outside, "secret.txt") }))).toBe(
      "forbidden",
    );
    expect(await codeOf(run("files.read", { path: join(granted, "sub") }))).toBe("invalid_params");
    expect(await codeOf(run("files.read", { path: join(granted, "missing.txt") }))).toBe(
      "not_found",
    );
    expect(await codeOf(run("files.read", {}))).toBe("invalid_params");
    expect(
      await codeOf(
        run("files.read", { path: join(granted, "notes.txt"), libraryPath: "recordings/shot.png" }),
      ),
    ).toBe("invalid_params");
    expect(await codeOf(run("files.read", { path: join(granted, "notes.txt"), offset: 999 }))).toBe(
      "invalid_params",
    );
  });

  it("reads Library items by their relative path and nothing outside the Library", async () => {
    const out = await run("files.read", { libraryPath: "recordings/shot.png" });
    expect(out).toMatchObject({ name: "shot.png", mime: "image/png", size: 2 });
    expect(await codeOf(run("files.read", { libraryPath: "../secret.txt" }))).toBe("forbidden");
    expect(await codeOf(run("files.read", { libraryPath: "recordings/../../secret.txt" }))).toBe(
      "forbidden",
    );
    expect(await codeOf(run("files.read", { libraryPath: "." }))).toBe("forbidden");
  });

  it("refuses a quarantined Library item, whatever path the client sends", async () => {
    rows["quarantine/q1-held.bin"] = [{ name: "held.bin", quarantined: true }];
    expect(await codeOf(run("files.read", { libraryPath: "quarantine/q1-held.bin" }))).toBe(
      "forbidden",
    );
    // A quarantined row at a path reached through `..` or `./` is the same file: refused too.
    expect(
      await codeOf(run("files.read", { libraryPath: "recordings/../quarantine/q1-held.bin" })),
    ).toBe("forbidden");
    expect(await codeOf(run("files.read", { libraryPath: "./quarantine/q1-held.bin" }))).toBe(
      "forbidden",
    );
    // A row that is quarantined wins over a second row at the same path.
    rows["quarantine/q1-held.bin"] = [
      { name: "held.bin", quarantined: false },
      { name: "held.bin", quarantined: true },
    ];
    expect(await codeOf(run("files.read", { libraryPath: "quarantine/q1-held.bin" }))).toBe(
      "forbidden",
    );
  });

  it("refuses anything in the quarantine folder that has no trusted row (fail closed)", async () => {
    // No row at all: the bytes sit in quarantine/ and nothing vouches for them.
    expect(await codeOf(run("files.read", { libraryPath: "quarantine/q1-held.bin" }))).toBe(
      "forbidden",
    );
  });

  it("reads a trusted download that stays in quarantine/ once its row is released", async () => {
    rows["quarantine/t2-trusted.txt"] = [{ name: "trusted.txt", quarantined: false }];
    const out = await run("files.read", { libraryPath: "quarantine/t2-trusted.txt" });
    expect(Buffer.from(out.bytes as string, "base64").toString()).toBe("trusted text");
  });

  it("refuses a symlink in the Library that points into quarantine/", async () => {
    rows["quarantine/q1-held.bin"] = [{ name: "held.bin", quarantined: true }];
    expect(await codeOf(run("files.read", { libraryPath: "recordings/qlink.bin" }))).toBe(
      "forbidden",
    );
  });

  it("reads nothing from the Library when the Gateway has no Library rows to check", async () => {
    const read = filesHandlers({ folders: () => folders, home })["files.read"];
    if (read === undefined) throw new Error("no files.read handler");
    expect(await codeOf(Promise.resolve(read.run({} as never, { libraryPath: "recordings/shot.png" } as never)))).toBe(
      "unavailable",
    );
  });
});

describe("video files are range-served through the same granted-folder path (inline video)", () => {
  // 3 chunks plus a tail: a player seeking asks for ranges of a large file, never the whole.
  const size = FILE_CHUNK_BYTES * 2 + 1234;
  const video = () => {
    const b = Buffer.alloc(size);
    Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]).copy(b);
    for (let i = 12; i < size; i++) b[i] = i % 251;
    return b;
  };

  it("returns exactly the asked range, a chunk at a time, with a stable etag", async () => {
    const bytes = video();
    await writeFile(join(granted, "clip.mp4"), bytes);
    const a = await run("files.read", { path: join(granted, "clip.mp4") });
    expect(a.mime).toBe("video/mp4");
    expect(a.size).toBe(size);
    expect(a.nextOffset).toBe(FILE_CHUNK_BYTES);
    const mid = await run("files.read", {
      path: join(granted, "clip.mp4"),
      offset: 1_000_000,
      length: 100,
    });
    expect(
      Buffer.from(mid.bytes as string, "base64").equals(bytes.subarray(1_000_000, 1_000_100)),
    ).toBe(true);
    const tail = await run("files.read", {
      path: join(granted, "clip.mp4"),
      offset: FILE_CHUNK_BYTES * 2,
    });
    expect(tail.nextOffset).toBeNull();
    expect(Buffer.from(tail.bytes as string, "base64").length).toBe(1234);
    expect(tail.etag).toBe(a.etag);
  });

  it("types mov, webm and m4v by name", async () => {
    for (const [name, mime] of [
      ["a.mov", "video/quicktime"],
      ["a.webm", "video/webm"],
      ["a.m4v", "video/x-m4v"],
    ] as const) {
      await writeFile(join(granted, name), Buffer.from([0, 1, 2]));
      expect((await run("files.read", { path: join(granted, name) })).mime).toBe(mime);
    }
  });

  it("gives video no more access than an image: outside the grant, a link, or past the end", async () => {
    await writeFile(join(outside, "x.mp4"), Buffer.from([0, 1, 2]));
    expect(await codeOf(run("files.read", { path: join(outside, "x.mp4") }))).toBe("forbidden");
    await symlink(join(outside, "x.mp4"), join(granted, "l.mp4"));
    expect(await codeOf(run("files.read", { path: join(granted, "l.mp4") }))).not.toBe("ok");
    await writeFile(join(granted, "c.mp4"), Buffer.from([0, 1, 2]));
    expect(await codeOf(run("files.read", { path: join(granted, "c.mp4"), offset: 99 }))).toBe(
      "invalid_params",
    );
  });
});
