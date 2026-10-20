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

const run = (method: string, params: unknown) => {
  const handlers = filesHandlers({ folders: () => folders, home });
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
});
