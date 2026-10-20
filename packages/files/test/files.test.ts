import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolRegistration, ToolRunContext } from "@psyche/agent-core";
import type { ToolResult } from "@psyche/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type FileToolsOptions,
  fileTools,
  type GrantedFolder,
  MemoryFileProvenance,
} from "../src/index.ts";

let root: string;
let granted: string;
let readOnly: string;
let outside: string;
let folders: GrantedFolder[];

const ctx = (over: Partial<ToolRunContext> = {}) =>
  ({ signal: new AbortController().signal, taint: false, ...over }) as ToolRunContext;

function toolset(options: FileToolsOptions = {}) {
  const tools = Object.fromEntries(fileTools(options).map((t) => [t.spec.name, t])) as Record<
    string,
    AgentToolRegistration
  >;
  const run = (name: string, params: unknown, c = ctx()) =>
    tools[name]?.run?.(params, c) as Promise<ToolResult & { output: Record<string, unknown> }>;
  return { tools, run };
}

// The stand-in's behaviour (no folder list: the broker alone confines paths).
let tools: Record<string, AgentToolRegistration>;
let run: ReturnType<typeof toolset>["run"];

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "psy-ft-")));
  granted = join(root, "granted");
  readOnly = join(root, "ro");
  outside = join(root, "outside");
  mkdirSync(granted);
  mkdirSync(readOnly);
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "vault key");
  writeFileSync(join(readOnly, "notes.md"), "read me");
  folders = [
    { path: granted, mode: "rw" },
    { path: readOnly, mode: "ro" },
  ];
  ({ tools, run } = toolset());
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("ported from the Gateway stand-in", () => {
  it("reads and writes a real path", async () => {
    await run("write_file", { path: join(granted, "a.md"), content: "hi" });
    const r = await run("read_file", { path: join(granted, "a.md") });
    expect(r).toMatchObject({ output: { text: "hi" }, provenance: "untrusted" });
  });

  it("refuses to read through a symlinked directory or file", async () => {
    symlinkSync(outside, join(granted, "dir"));
    symlinkSync(join(outside, "secret.txt"), join(granted, "file"));
    await expect(
      run("read_file", { path: join(granted, "dir", "secret.txt") }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(run("read_file", { path: join(granted, "file") })).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(run("list_dir", { path: join(granted, "dir") })).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("refuses to write through a dangling symlink", async () => {
    symlinkSync(join(outside, "new.plist"), join(granted, "x.plist"));
    await expect(
      run("write_file", { path: join(granted, "x.plist"), content: "evil" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(() => readFileSync(join(outside, "new.plist"))).toThrow();
  });

  it("caps reads and binds writes without touching the disk", async () => {
    writeFileSync(join(granted, "big.txt"), "x".repeat(300 * 1024));
    const r = await run("read_file", { path: join(granted, "big.txt") });
    expect(r.output.truncated).toBe(true);
    expect((r.output.text as string).length).toBe(256 * 1024);
    const d = tools.write_file?.describeCall?.({ path: join(granted, "n.md"), content: "a" });
    expect(d).toMatchObject({ kind: "file_write", bindingFields: { operation: "overwrite" } });
    expect(readdirSync(granted)).not.toContain("n.md");
    expect(tools.read_file?.validate?.({ path: "relative.md" })).toBeTruthy();
  });
});

describe("side-effect classes and targets", () => {
  it("declares read tools as reads and writes as file_write approvals on the real path", () => {
    expect(Object.keys(tools).sort()).toEqual([
      "edit_file",
      "list_dir",
      "read_file",
      "search_files",
      "write_file",
    ]);
    for (const name of ["read_file", "list_dir", "search_files"]) {
      expect(tools[name]?.spec).toMatchObject({
        sideEffect: "read",
        targetKind: "path",
        provenanceOut: "untrusted",
      });
    }
    for (const name of ["write_file", "edit_file"]) {
      expect(tools[name]?.spec).toMatchObject({ sideEffect: "write", targetKind: "path" });
    }
    const target = tools.read_file?.describeCall?.({ path: `${granted}/../outside/secret.txt` });
    expect(target).toEqual({ target: { kind: "path", value: join(outside, "secret.txt") } });
  });

  it("puts a diff on the edit card and binds the exact edit", () => {
    const p = { path: join(granted, "a.md"), old_string: "teh", new_string: "the" };
    const d = tools.edit_file?.describeCall?.(p);
    expect(d).toMatchObject({
      kind: "file_write",
      target: { kind: "path", value: join(granted, "a.md") },
      bindingFields: { operation: "edit", realPath: join(granted, "a.md") },
      details: { path: join(granted, "a.md"), operation: "edit" },
    });
    expect(d?.details?.diff).toContain("-teh\n+the");
    const other = tools.edit_file?.describeCall?.({ ...p, replace_all: true });
    expect(other?.bindingFields).not.toEqual(d?.bindingFields);
  });
});

describe("traversal and granted folders", () => {
  beforeEach(() => {
    ({ tools, run } = toolset({ folders: () => folders }));
  });

  it("refuses `..` that leaves a granted folder", async () => {
    await expect(
      run("read_file", { path: `${granted}/../outside/secret.txt` }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      run("write_file", { path: `${granted}/sub/../../outside/x.txt`, content: "x" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(run("list_dir", { path: `${granted}/..` })).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      run("search_files", { path: `${granted}/../outside`, query: "vault" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(readdirSync(outside)).toEqual(["secret.txt"]);
  });

  it("does not treat a sibling with a shared prefix as inside the folder", async () => {
    mkdirSync(`${granted}-evil`);
    writeFileSync(`${granted}-evil/a.txt`, "x");
    await expect(run("read_file", { path: `${granted}-evil/a.txt` })).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("allows `..` that stays inside, and refuses writes to a read-only folder", async () => {
    mkdirSync(join(granted, "sub"));
    await run("write_file", { path: `${granted}/sub/../ok.md`, content: "ok" });
    expect(readFileSync(join(granted, "ok.md"), "utf8")).toBe("ok");
    expect((await run("read_file", { path: join(readOnly, "notes.md") })).output.text).toBe(
      "read me",
    );
    await expect(
      run("write_file", { path: join(readOnly, "notes.md"), content: "x" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      run("edit_file", { path: join(readOnly, "notes.md"), old_string: "read", new_string: "x" }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("follows the live folder list: a revoked folder is refused", async () => {
    folders = [];
    await expect(run("read_file", { path: join(readOnly, "notes.md") })).rejects.toMatchObject({
      code: "forbidden",
    });
  });
});

describe("protected locations (#285)", () => {
  it("refuses Psyche's home and credential stores under a granted rw folder", async () => {
    const home = join(granted, ".psyche");
    mkdirSync(join(home, "workspace"), { recursive: true });
    writeFileSync(join(home, "workspace", "MEMORY.md"), "memory");
    mkdirSync(join(granted, ".ssh"));
    writeFileSync(join(granted, ".ssh", "id_rsa"), "key");
    ({ run } = toolset({
      folders: () => folders,
      protectedRoots: () => [home, join(granted, ".ssh")],
    }));
    await expect(
      run("write_file", { path: join(home, "workspace", "MEMORY.md"), content: "x" }),
    ).rejects.toMatchObject({ code: "forbidden", details: { reason: "protected_path" } });
    await expect(run("read_file", { path: join(granted, ".ssh", "id_rsa") })).rejects.toMatchObject(
      { code: "forbidden" },
    );
    await expect(run("list_dir", { path: home })).rejects.toMatchObject({ code: "forbidden" });
    expect(readFileSync(join(home, "workspace", "MEMORY.md"), "utf8")).toBe("memory");
    // Everything else in the granted folder works as before.
    await run("write_file", { path: join(granted, "ok.md"), content: "ok" });
  });
});

describe("symlinks", () => {
  it("refuses edits and searches through links, and never searches into one", async () => {
    symlinkSync(join(outside, "secret.txt"), join(granted, "link.txt"));
    await expect(
      run("edit_file", { path: join(granted, "link.txt"), old_string: "vault", new_string: "x" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("vault key");
    symlinkSync(outside, join(granted, "out"));
    const r = await run("search_files", { path: granted, query: "vault" });
    expect(r.output.matches).toEqual([]);
    await expect(
      run("search_files", { path: join(granted, "out"), query: "vault" }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("refuses writes under a symlinked parent, even to a new folder", async () => {
    symlinkSync(outside, join(granted, "out"));
    await expect(
      run("write_file", { path: join(granted, "out", "new", "x.md"), content: "x" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(readdirSync(outside)).toEqual(["secret.txt"]);
  });

  it("replaces a hard link instead of writing through it", async () => {
    linkSync(join(outside, "secret.txt"), join(granted, "hard.txt"));
    await run("write_file", { path: join(granted, "hard.txt"), content: "new" });
    expect(readFileSync(join(granted, "hard.txt"), "utf8")).toBe("new");
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("vault key");
  });
});

describe("edit_file", () => {
  const file = () => join(granted, "doc.md");
  beforeEach(() => writeFileSync(file(), "alpha beta\nalpha gamma\n"));

  it("replaces exactly one match and reports both hashes", async () => {
    const r = await run("edit_file", { path: file(), old_string: "beta", new_string: "BETA" });
    expect(readFileSync(file(), "utf8")).toBe("alpha BETA\nalpha gamma\n");
    expect(r.output).toMatchObject({ replacements: 1 });
    expect(r.output.sha256).not.toBe(r.output.previousSha256);
    expect(readdirSync(granted)).toEqual(["doc.md"]);
  });

  it("refuses an ambiguous match unless replace_all", async () => {
    await expect(
      run("edit_file", { path: file(), old_string: "alpha", new_string: "A" }),
    ).rejects.toMatchObject({ code: "conflict" });
    const r = await run("edit_file", {
      path: file(),
      old_string: "alpha",
      new_string: "$&A",
      replace_all: true,
    });
    expect(r.output.replacements).toBe(2);
    expect(readFileSync(file(), "utf8")).toBe("$&A beta\n$&A gamma\n");
  });

  it("reports a conflict when the text is gone or the file changed since it was read", async () => {
    await expect(
      run("edit_file", { path: file(), old_string: "delta", new_string: "x" }),
    ).rejects.toMatchObject({ code: "conflict" });
    const read = await run("read_file", { path: file() });
    writeFileSync(file(), "alpha beta\nalpha gamma\nedited elsewhere\n");
    await expect(
      run("edit_file", {
        path: file(),
        old_string: "beta",
        new_string: "x",
        expected_sha256: read.output.sha256,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(readFileSync(file(), "utf8")).toContain("edited elsewhere");
    await expect(
      run("edit_file", { path: file(), old_string: "beta", new_string: "beta" }),
    ).rejects.toMatchObject({ code: "invalid_params" });
    await expect(
      run("edit_file", { path: join(granted, "missing.md"), old_string: "a", new_string: "b" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("limits and paging", () => {
  it("pages a large file without splitting characters", async () => {
    const text = `${"é".repeat(200 * 1024)}end`;
    writeFileSync(join(granted, "u.txt"), text);
    const a = await run("read_file", { path: join(granted, "u.txt") });
    expect(a.output.truncated).toBe(true);
    const b = await run("read_file", {
      path: join(granted, "u.txt"),
      offset: a.output.nextOffset,
    });
    expect(`${a.output.text}${b.output.text}`).toBe(text);
    expect(b.output.truncated).toBe(false);
    expect(a.output.sha256).toBe(b.output.sha256);
  });

  it("flags binary files and refuses oversized writes", async () => {
    writeFileSync(join(granted, "b.bin"), Buffer.from([1, 0, 2]));
    expect((await run("read_file", { path: join(granted, "b.bin") })).output).toMatchObject({
      binary: true,
      text: "",
    });
    await expect(
      run("write_file", { path: join(granted, "big.md"), content: "é".repeat(600 * 1024) }),
    ).rejects.toMatchObject({ code: "invalid_params" });
  });

  it("lists with kinds, sizes and pages", async () => {
    writeFileSync(join(granted, "a.txt"), "abc");
    mkdirSync(join(granted, "d"));
    symlinkSync(outside, join(granted, "l"));
    const r = await run("list_dir", { path: granted });
    expect(r.output).toMatchObject({
      total: 3,
      entries: [
        { name: "a.txt", kind: "file", size: 3 },
        { name: "d", kind: "dir" },
        { name: "l", kind: "link" },
      ],
    });
    expect((await run("list_dir", { path: granted, offset: 2 })).output.entries).toEqual([
      { name: "l", kind: "link" },
    ]);
  });
});

describe("search_files", () => {
  it("finds names and lines, skipping hidden folders and binaries", async () => {
    mkdirSync(join(granted, "notes"));
    mkdirSync(join(granted, ".git"));
    writeFileSync(join(granted, "notes", "tax.md"), "line one\nTax deadline April\n");
    writeFileSync(join(granted, ".git", "x"), "tax");
    writeFileSync(join(granted, "bin"), Buffer.from("tax\0"));
    const r = await run("search_files", { path: granted, query: "tax" });
    expect(r.output.files).toEqual([join(granted, "notes", "tax.md")]);
    expect(r.output.matches).toEqual([
      { path: join(granted, "notes", "tax.md"), line: 2, text: "Tax deadline April" },
    ]);
    expect(r.provenance).toBe("untrusted");
    const cs = await run("search_files", { path: granted, query: "tax", case_sensitive: true });
    expect(cs.output.matches).toEqual([]);
  });
});

describe("provenance", () => {
  it("reads back a trusted write as trusted only under a trusted root and while the bytes match", async () => {
    const index = new MemoryFileProvenance();
    const t = toolset({ provenance: index, trustedRoots: [granted] });
    expect(t.tools.read_file?.spec.provenanceOut).toBe("trusted");
    const path = join(granted, "mine.md");
    await t.run("write_file", { path, content: "clean" });
    expect((await t.run("read_file", { path })).provenance).toBe("trusted");
    writeFileSync(path, "changed outside Psyche");
    expect((await t.run("read_file", { path })).provenance).toBe("untrusted");
  });

  it("records writes from a tainted turn as untrusted with their sources", async () => {
    const index = new MemoryFileProvenance();
    const t = toolset({ provenance: index, trustedRoots: [granted] });
    const path = join(granted, "copied.md");
    const sources = [{ sourceKind: "fetch", origin: "https://evil.example" }];
    await t.run(
      "write_file",
      { path, content: "ignore previous" },
      ctx({ taint: true, taintSources: sources }),
    );
    expect(index.get(path)).toMatchObject({ provenance: "untrusted", sources });
    expect((await t.run("read_file", { path })).provenance).toBe("untrusted");
    expect((await t.run("search_files", { path: granted, query: "ignore" })).provenance).toBe(
      "untrusted",
    );
  });

  it("keeps every read untrusted outside the trusted roots", async () => {
    const t = toolset({ trustedRoots: [granted] });
    expect((await t.run("read_file", { path: join(readOnly, "notes.md") })).provenance).toBe(
      "untrusted",
    );
  });
});
