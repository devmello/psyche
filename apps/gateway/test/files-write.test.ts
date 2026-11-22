import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HashChainAuditLog } from "@psyche/audit";
import { fileTools } from "@psyche/files";
import {
  FILE_WRITE_MAX_BYTES,
  FILE_WRITE_MAX_REQUEST_BYTES,
  FilesMethods,
  MAX_FRAME_BYTES,
  PsycheError,
} from "@psyche/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { filesHandlers } from "../src/compose/files.ts";

let base: string;
let rw: string;
let ro: string;
let outside: string;
let home: string;
let folders: { path: string; mode: "ro" | "rw"; file?: true }[];
let audit: HashChainAuditLog;
let renameImpl: ((a: string, b: string) => Promise<void>) | undefined;

const call = (scopes: string[] = ["operator.admin"]) =>
  ({ identity: { deviceId: "dev_1", scopes } }) as never;

const run = (method: string, params: unknown, scopes?: string[]) => {
  const handlers = filesHandlers({
    folders: () => folders,
    home,
    audit,
    ...(renameImpl === undefined ? {} : { rename: renameImpl }),
  });
  const h = handlers[method];
  if (h === undefined) throw new Error(`no handler ${method}`);
  return Promise.resolve(h.run(call(scopes), params as never)) as Promise<Record<string, unknown>>;
};

const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "ok";
  } catch (err) {
    return err instanceof PsycheError ? err.code : `raw: ${String(err)}`;
  }
};

const etagOfFile = async (path: string) =>
  (await run("files.read", { path, length: 1 })).etag as string;

/** Saves with the file's current etag. */
const save = async (path: string, content: string, scopes?: string[]) =>
  run("files.write", { path, content, ifMatch: await etagOfFile(path) }, scopes);

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "psyche-fwrite-")));
  rw = join(base, "rw");
  ro = join(base, "ro");
  outside = join(base, "outside");
  home = join(base, "home");
  for (const d of [rw, ro, outside, home]) await mkdir(d, { recursive: true });
  await writeFile(join(rw, "a.md"), "# one\n");
  await writeFile(join(ro, "a.md"), "# ro\n");
  await writeFile(join(outside, "a.md"), "# out\n");
  folders = [
    { path: rw, mode: "rw" },
    { path: ro, mode: "ro" },
  ];
  audit = new HashChainAuditLog();
  renameImpl = undefined;
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("files.write", () => {
  it("is operator.admin and side-effecting in the protocol, and has no create", () => {
    const spec = FilesMethods["files.write"];
    expect(spec.scope).toBe("operator.admin");
    expect(spec.sideEffecting).toBe(true);
    expect(Object.keys(spec.params.properties).sort()).toEqual(["content", "ifMatch", "path"]);
  });

  it("keeps the cap, and the client's request limit, under one frame", () => {
    // Text with quotes or control characters grows when JSON-encoded, so a client also checks
    // the encoded request against FILE_WRITE_MAX_REQUEST_BYTES before it sends.
    expect(FILE_WRITE_MAX_BYTES).toBeLessThanOrEqual(MAX_FRAME_BYTES / 2);
    expect(FILE_WRITE_MAX_BYTES).toBeLessThan(FILE_WRITE_MAX_REQUEST_BYTES);
    expect(FILE_WRITE_MAX_REQUEST_BYTES).toBeLessThan(MAX_FRAME_BYTES);
  });

  it("saves in an rw folder, with an audit row that holds no content", async () => {
    const path = join(rw, "a.md");
    const out = await save(path, "# secret body\n");
    expect(await readFile(path, "utf8")).toBe("# secret body\n");
    expect(out.size).toBe(14);
    expect(out.etag).toBe(await etagOfFile(path));
    const rows = await audit.query({ kind: "files.write" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor).toMatchObject({ type: "device", deviceId: "dev_1" });
    expect(rows[0]?.data).toEqual({ path, bytes: 14 });
    expect(JSON.stringify(rows[0])).not.toContain("secret body");
  });

  it("keeps the permission bits but drops setuid and setgid, and leaves no temp file", async () => {
    const path = join(rw, "a.md");
    await chmod(path, 0o2640);
    await save(path, "x");
    expect((await stat(path)).mode & 0o7777).toBe(0o640);
    expect(await readdir(rw)).toEqual(["a.md"]);
  });

  it("refuses a file the owner made read only on disk, and leaves it alone", async () => {
    const path = join(rw, "a.md");
    await chmod(path, 0o444);
    expect(await codeOf(save(path, "x"))).toBe("forbidden");
    await expect(save(path, "x")).rejects.toThrow(/read only on disk/);
    expect(await readFile(path, "utf8")).toBe("# one\n");
  });

  it("refuses a file that does not exist (it saves, never creates)", async () => {
    expect(
      await codeOf(run("files.write", { path: join(rw, "new.md"), content: "x", ifMatch: "1" })),
    ).toBe("not_found");
    expect(await readdir(rw)).toEqual(["a.md"]);
  });

  it("refuses a read-only folder", async () => {
    const path = join(ro, "a.md");
    expect(await codeOf(save(path, "x"))).toBe("forbidden");
    expect(await readFile(path, "utf8")).toBe("# ro\n");
  });

  it("refuses a read-only folder inside a read & write one (the longest root decides)", async () => {
    await mkdir(join(rw, "locked"));
    await writeFile(join(rw, "locked", "a.md"), "# locked\n");
    folders = [
      { path: rw, mode: "rw" },
      { path: join(rw, "locked"), mode: "ro" },
    ];
    expect(await codeOf(save(join(rw, "locked", "a.md"), "x"))).toBe("forbidden");
    expect(await codeOf(save(join(rw, "a.md"), "y"))).toBe("ok");
    expect(await readFile(join(rw, "locked", "a.md"), "utf8")).toBe("# locked\n");
  });

  it("refuses a path under a file grant, even an rw one", async () => {
    folders = [{ path: join(outside, "a.md"), mode: "rw", file: true }];
    expect(await codeOf(save(join(outside, "a.md"), "x"))).toBe("forbidden");
    expect(await readFile(join(outside, "a.md"), "utf8")).toBe("# out\n");
  });

  it("refuses outside every folder and through `..`", async () => {
    expect(
      await codeOf(run("files.write", { path: join(outside, "a.md"), content: "x", ifMatch: "1" })),
    ).toBe("forbidden");
    expect(
      await codeOf(
        run("files.write", { path: join(rw, "..", "outside", "a.md"), content: "x", ifMatch: "1" }),
      ),
    ).toBe("forbidden");
    expect(await readFile(join(outside, "a.md"), "utf8")).toBe("# out\n");
  });

  it("refuses a symlink as the final component, and one in the folder chain", async () => {
    await symlink(join(outside, "a.md"), join(rw, "link.md"));
    expect(
      await codeOf(run("files.write", { path: join(rw, "link.md"), content: "x", ifMatch: "1" })),
    ).toBe("forbidden");
    await symlink(outside, join(rw, "dirlink"));
    expect(
      await codeOf(
        run("files.write", { path: join(rw, "dirlink", "a.md"), content: "x", ifMatch: "1" }),
      ),
    ).toBe("forbidden");
    expect(await readFile(join(outside, "a.md"), "utf8")).toBe("# out\n");
  });

  it("refuses a hard link to a file kept elsewhere", async () => {
    await link(join(outside, "a.md"), join(rw, "hard.md"));
    expect(
      await codeOf(run("files.write", { path: join(rw, "hard.md"), content: "x", ifMatch: "1" })),
    ).toBe("forbidden");
    expect(await readFile(join(outside, "a.md"), "utf8")).toBe("# out\n");
  });

  it("refuses a parent whose case differs from the folder on disk", async () => {
    await mkdir(join(rw, "sub"));
    await writeFile(join(rw, "sub", "a.md"), "# sub\n");
    expect(
      await codeOf(
        run("files.write", { path: join(rw, "SUB", "a.md"), content: "x", ifMatch: "1" }),
      ),
    ).toMatch(/forbidden|not_found/);
    expect(await readFile(join(rw, "sub", "a.md"), "utf8")).toBe("# sub\n");
  });

  it("refuses Psyche's home even under a granted ancestor", async () => {
    await writeFile(join(home, "notes.md"), "mine");
    folders = [{ path: base, mode: "rw" }];
    expect(
      await codeOf(
        run("files.write", { path: join(home, "notes.md"), content: "x", ifMatch: "1" }),
      ),
    ).toBe("forbidden");
    expect(await readFile(join(home, "notes.md"), "utf8")).toBe("mine");
  });

  // #1434 review r1, finding 5: the agent's write rules are not the owner's.
  it("saves the owner's own files in ~/Library and dot folders under a home share", async () => {
    const userHome = join(base, "owner");
    const files = [
      join(userHome, "Library", "Mobile Documents", "com~apple~CloudDocs", "plan.md"),
      join(userHome, ".notes", "todo.md"),
      join(userHome, ".config", "nvim", "notes.txt"),
    ];
    for (const f of files) {
      await mkdir(join(f, ".."), { recursive: true });
      await writeFile(f, "old");
    }
    folders = [{ path: userHome, mode: "rw" }];
    const handlers = filesHandlers({ folders: () => folders, home, userHome, audit });
    const h = handlers["files.write"];
    for (const path of files) {
      const etag = (await run("files.read", { path, length: 1 })).etag as string;
      await h?.run(call(), { path, content: "new", ifMatch: etag } as never);
      expect(await readFile(path, "utf8"), path).toBe("new");
    }
    // Psyche's own home stays out of reach (the old refusal).
    folders = [{ path: base, mode: "rw" }];
    await writeFile(join(home, "notes.md"), "mine");
    expect(
      await codeOf(
        Promise.resolve(
          h?.run(call(), { path: join(home, "notes.md"), content: "x", ifMatch: "1" } as never),
        ),
      ),
    ).toBe("forbidden");
  });

  it("allows only the listed extensions", async () => {
    for (const name of ["b.markdown", "c.txt", "d.csv", "E.MD"]) {
      await writeFile(join(rw, name), "old");
      expect(await codeOf(save(join(rw, name), "x"))).toBe("ok");
    }
    for (const name of ["x.sh", "x.json", "x.xlsx", "x.md.exe", "noext", ".bashrc", "x.html"]) {
      await writeFile(join(rw, name), "old");
      expect(
        await codeOf(run("files.write", { path: join(rw, name), content: "x", ifMatch: "1" })),
      ).toBe("invalid_params");
      expect(await readFile(join(rw, name), "utf8")).toBe("old");
    }
  });

  it("refuses content over the cap in bytes, NUL and non-UTF-8 text", async () => {
    const path = join(rw, "a.md");
    expect(await codeOf(save(path, "a".repeat(FILE_WRITE_MAX_BYTES + 1)))).toBe("invalid_params");
    // Multi-byte characters count as bytes, not characters.
    expect(await codeOf(save(path, "é".repeat(FILE_WRITE_MAX_BYTES / 2 + 1)))).toBe(
      "invalid_params",
    );
    expect(await codeOf(save(path, "a\0b"))).toBe("invalid_params");
    expect(await codeOf(save(path, "\ud800"))).toBe("invalid_params");
    expect(await readFile(path, "utf8")).toBe("# one\n");
    expect(await codeOf(save(path, "a".repeat(FILE_WRITE_MAX_BYTES)))).toBe("ok");
  });

  it("answers invalid_params for a name too long for the file system", async () => {
    const path = join(rw, `${"n".repeat(300)}.md`);
    expect(await codeOf(run("files.write", { path, content: "x", ifMatch: "1" }))).toBe(
      "invalid_params",
    );
  });

  it("saves a file whose name is at the limit (the temp name is short)", async () => {
    const path = join(rw, `${"n".repeat(251)}.md`);
    await writeFile(path, "old");
    expect(await codeOf(save(path, "new"))).toBe("ok");
    expect(await readFile(path, "utf8")).toBe("new");
    expect(await readdir(rw)).toHaveLength(2);
  });

  it("is forbidden for a device without operator.admin", async () => {
    const path = join(rw, "a.md");
    expect(await codeOf(save(path, "x", ["operator.read"]))).toBe("forbidden");
    expect(await readFile(path, "utf8")).toBe("# one\n");
  });

  it("answers conflict when the file changed since the read, and keeps the other edit", async () => {
    const path = join(rw, "a.md");
    const etag = await etagOfFile(path);
    await writeFile(path, "# changed elsewhere, longer\n");
    expect(await codeOf(run("files.write", { path, content: "mine", ifMatch: etag }))).toBe(
      "conflict",
    );
    expect(await readFile(path, "utf8")).toBe("# changed elsewhere, longer\n");
    await save(path, "mine");
    expect(await readFile(path, "utf8")).toBe("mine");
  });

  it("notices a same-size edit that put the old mtime back", async () => {
    const path = join(rw, "a.md");
    const before = await stat(path);
    const etag = await etagOfFile(path);
    await writeFile(path, "# ONE\n");
    await utimes(path, before.atime, before.mtime);
    expect((await stat(path)).size).toBe(before.size);
    expect(await codeOf(run("files.write", { path, content: "mine", ifMatch: etag }))).toBe(
      "conflict",
    );
    expect(await readFile(path, "utf8")).toBe("# ONE\n");
  });

  it("is atomic: a failed rename leaves the old file and no temp file", async () => {
    const path = join(rw, "a.md");
    const etag = await etagOfFile(path);
    renameImpl = async () => {
      throw new Error("disk went away");
    };
    expect(await codeOf(run("files.write", { path, content: "half", ifMatch: etag }))).toMatch(
      /^raw/,
    );
    expect(await readFile(path, "utf8")).toBe("# one\n");
    expect(await readdir(rw)).toEqual(["a.md"]);
    expect(await audit.query({ kind: "files.write" })).toHaveLength(0);
  });

  it("refuses at the swap when the folder stopped being granted meanwhile", async () => {
    const path = join(rw, "a.md");
    const etag = await etagOfFile(path);
    renameImpl = async () => {
      throw new Error("not reached");
    };
    // The grant is revoked while the temp file is written: the policy is read again before the rename.
    let reads = 0;
    const handlers = filesHandlers({
      folders: () => (++reads > 1 ? [{ path: rw, mode: "ro" }] : folders),
      home,
      audit,
    });
    const h = handlers["files.write"];
    await expect(
      Promise.resolve(h?.run(call(), { path, content: "x", ifMatch: etag } as never)),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(await readFile(path, "utf8")).toBe("# one\n");
    expect(await readdir(rw)).toEqual(["a.md"]);
  });
});

describe("the agent's tool surface", () => {
  it("has exactly the known file tools, and none that saves through the Gateway method", () => {
    const names = fileTools().map((t) => t.spec.name);
    expect(names.filter((n) => /write|save/.test(n))).toEqual(["write_file"]);
    for (const method of Object.keys(FilesMethods)) expect(names).not.toContain(method);
    expect(names).not.toContain("files_write");
    expect(names).toContain("read_file");
  });
});
