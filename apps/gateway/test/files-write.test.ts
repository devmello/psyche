import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HashChainAuditLog } from "@psyche/audit";
import { fileTools } from "@psyche/files";
import { FILE_WRITE_MAX_BYTES, FilesMethods, PsycheError } from "@psyche/protocol";
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
  it("is operator.admin and side-effecting in the protocol", () => {
    expect(FilesMethods["files.write"].scope).toBe("operator.admin");
    expect(FilesMethods["files.write"].sideEffecting).toBe(true);
  });

  it("saves in an rw folder, with an audit row that holds no content", async () => {
    const path = join(rw, "a.md");
    const etag = await etagOfFile(path);
    const out = await run("files.write", { path, content: "# secret body\n", ifMatch: etag });
    expect(await readFile(path, "utf8")).toBe("# secret body\n");
    expect(out.size).toBe(14);
    expect(out.etag).toBe(await etagOfFile(path));
    const rows = await audit.query({ kind: "files.write" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor).toMatchObject({ type: "device", deviceId: "dev_1" });
    expect(rows[0]?.data).toMatchObject({ path, bytes: 14 });
    expect(JSON.stringify(rows[0])).not.toContain("secret body");
  });

  it("keeps the mode bits and leaves no temp file", async () => {
    const path = join(rw, "a.md");
    await chmod(path, 0o600);
    await run("files.write", {
      path,
      content: "x",
      ifMatch: await etagOfFile(path),
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(rw)).toEqual(["a.md"]);
  });

  it("creates a new file in an existing folder, and refuses an existing one", async () => {
    const path = join(rw, "new.csv");
    await run("files.write", { path, content: "a,b\n", create: true });
    expect(await readFile(path, "utf8")).toBe("a,b\n");
    expect(await codeOf(run("files.write", { path, content: "z", create: true }))).toBe("conflict");
    expect(await readFile(path, "utf8")).toBe("a,b\n");
    expect(
      await codeOf(
        run("files.write", { path: join(rw, "nodir", "n.md"), content: "", create: true }),
      ),
    ).toBe("not_found");
  });

  it("needs exactly one of ifMatch and create", async () => {
    const path = join(rw, "a.md");
    expect(await codeOf(run("files.write", { path, content: "x" }))).toBe("invalid_params");
    expect(
      await codeOf(run("files.write", { path, content: "x", ifMatch: "1", create: true })),
    ).toBe("invalid_params");
    expect(
      await codeOf(run("files.write", { path: join(rw, "no.md"), content: "x", ifMatch: "1" })),
    ).toBe("not_found");
  });

  it("refuses a read-only folder", async () => {
    const path = join(ro, "a.md");
    expect(
      await codeOf(run("files.write", { path, content: "x", ifMatch: await etagOfFile(path) })),
    ).toBe("forbidden");
    expect(await readFile(path, "utf8")).toBe("# ro\n");
  });

  it("refuses a path under a file grant, even an rw one", async () => {
    folders = [{ path: join(outside, "a.md"), mode: "rw", file: true }];
    const path = join(outside, "a.md");
    expect(
      await codeOf(run("files.write", { path, content: "x", ifMatch: await etagOfFile(path) })),
    ).toBe("forbidden");
    expect(await readFile(path, "utf8")).toBe("# out\n");
  });

  it("refuses outside every folder and through `..`", async () => {
    const path = join(outside, "a.md");
    expect(await codeOf(run("files.write", { path, content: "x", ifMatch: "1" }))).toBe(
      "forbidden",
    );
    expect(
      await codeOf(
        run("files.write", { path: join(rw, "..", "outside", "a.md"), content: "x", ifMatch: "1" }),
      ),
    ).toBe("forbidden");
    expect(await readFile(path, "utf8")).toBe("# out\n");
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

  it("refuses Psyche's home even under a granted ancestor", async () => {
    await writeFile(join(home, "notes.md"), "mine");
    folders = [{ path: base, mode: "rw" }];
    expect(
      await codeOf(
        run("files.write", { path: join(home, "notes.md"), content: "x", ifMatch: "1" }),
      ),
    ).toBe("forbidden");
    expect(
      await codeOf(run("files.write", { path: join(home, "new.md"), content: "x", create: true })),
    ).toBe("forbidden");
    expect(await readFile(join(home, "notes.md"), "utf8")).toBe("mine");
  });

  it("allows only the listed extensions", async () => {
    for (const name of ["a.md", "b.markdown", "c.txt", "d.csv", "E.MD"]) {
      expect(
        await codeOf(run("files.write", { path: join(rw, name), content: "x", create: true })),
      ).toBe(name === "a.md" ? "conflict" : "ok");
    }
    for (const name of ["x.sh", "x.json", "x.xlsx", "x.md.exe", "noext", ".bashrc", "x.html"]) {
      expect(
        await codeOf(run("files.write", { path: join(rw, name), content: "x", create: true })),
      ).toBe("invalid_params");
    }
  });

  it("refuses content over the cap, NUL and non-UTF-8 text", async () => {
    const path = join(rw, "big.txt");
    expect(
      await codeOf(
        run("files.write", { path, content: "a".repeat(FILE_WRITE_MAX_BYTES + 1), create: true }),
      ),
    ).toBe("invalid_params");
    // Multi-byte characters count as bytes, not characters.
    expect(
      await codeOf(
        run("files.write", {
          path,
          content: "é".repeat(FILE_WRITE_MAX_BYTES / 2 + 1),
          create: true,
        }),
      ),
    ).toBe("invalid_params");
    expect(await codeOf(run("files.write", { path, content: "a\0b", create: true }))).toBe(
      "invalid_params",
    );
    expect(await codeOf(run("files.write", { path, content: "\ud800", create: true }))).toBe(
      "invalid_params",
    );
    expect(
      await codeOf(
        run("files.write", { path, content: "a".repeat(FILE_WRITE_MAX_BYTES), create: true }),
      ),
    ).toBe("ok");
  });

  it("is forbidden for a device without operator.admin", async () => {
    const path = join(rw, "a.md");
    expect(
      await codeOf(
        run("files.write", { path, content: "x", ifMatch: await etagOfFile(path) }, [
          "operator.read",
        ]),
      ),
    ).toBe("forbidden");
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
    // Overwrite: re-read the etag, then save.
    await run("files.write", { path, content: "mine", ifMatch: await etagOfFile(path) });
    expect(await readFile(path, "utf8")).toBe("mine");
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
});

describe("the agent's tool surface", () => {
  it("has no tool that writes through files.write", () => {
    const names = fileTools().map((t) => t.spec.name);
    expect(names.join(" ")).not.toContain("files.write");
    expect(names).toContain("write_file");
  });
});
