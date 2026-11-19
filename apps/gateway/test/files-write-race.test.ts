import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HashChainAuditLog } from "@psyche/audit";
import { PsycheError } from "@psyche/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Runs once, right after the temp file is opened: a process racing the save. */
const hook: { afterOpen?: (path: string) => Promise<void> } = {};

vi.mock("node:fs/promises", async (orig) => {
  const actual = await orig<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const fh = await actual.open(...args);
      const path = String(args[0]);
      if (path.endsWith(".tmp") && hook.afterOpen) {
        const run = hook.afterOpen;
        hook.afterOpen = undefined;
        await run(path);
      }
      return fh;
    },
  };
});

const { filesHandlers } = await import("../src/compose/files.ts");

let base: string;
let rw: string;
let outside: string;
let home: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "psyche-fwrite-race-")));
  rw = join(base, "rw");
  outside = join(base, "outside");
  home = join(base, "home");
  for (const d of [join(rw, "sub"), outside, home]) await mkdir(d, { recursive: true });
  await writeFile(join(rw, "sub", "a.md"), "# one\n");
  await writeFile(join(outside, "a.md"), "# out\n");
});

afterEach(async () => {
  hook.afterOpen = undefined;
  await rm(base, { recursive: true, force: true });
});

const handlers = () =>
  filesHandlers({
    folders: () => [{ path: rw, mode: "rw" }],
    home,
    audit: new HashChainAuditLog(),
  });
const call = { identity: { deviceId: "dev_1", scopes: ["operator.admin"] } } as never;

describe("files.write against a folder swapped for a link mid-save", () => {
  it("refuses, and writes nothing outside the grant", async () => {
    const path = join(rw, "sub", "a.md");
    const h = handlers();
    const read = h["files.read"];
    if (read === undefined) throw new Error("no files.read");
    const etag = ((await read.run(call, { path, length: 1 } as never)) as { etag: string }).etag;
    hook.afterOpen = async () => {
      await rename(join(rw, "sub"), join(rw, "sub-moved"));
      await symlink(outside, join(rw, "sub"));
    };
    const err = await Promise.resolve(
      h["files.write"]?.run(call, { path, content: "OWNER", ifMatch: etag } as never),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PsycheError);
    expect((err as PsycheError).code).toBe("forbidden");
    expect(await readFile(join(outside, "a.md"), "utf8")).toBe("# out\n");
    expect(await readdir(outside)).toEqual(["a.md"]);
    // The real file the swapped folder held is untouched.
    expect(await readFile(join(rw, "sub-moved", "a.md"), "utf8")).toBe("# one\n");
  });

  it("refuses when the temp file is not the one that was written", async () => {
    const path = join(rw, "sub", "a.md");
    const h = handlers();
    const read = h["files.read"];
    if (read === undefined) throw new Error("no files.read");
    const etag = ((await read.run(call, { path, length: 1 } as never)) as { etag: string }).etag;
    hook.afterOpen = async (tmp) => {
      // Another process replaces the temp name with a file of its own.
      await rm(tmp);
      await writeFile(tmp, "planted");
    };
    const err = await Promise.resolve(
      h["files.write"]?.run(call, { path, content: "OWNER", ifMatch: etag } as never),
    ).catch((e: unknown) => e);
    expect((err as PsycheError).code).toBe("forbidden");
    expect(await readFile(path, "utf8")).toBe("# one\n");
    expect(await readdir(join(rw, "sub"))).toEqual(["a.md"]);
  });
});
