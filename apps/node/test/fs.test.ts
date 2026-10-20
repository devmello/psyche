import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFsProvider, type FsRoot } from "../src/capabilities/fs.ts";
import type { CapabilityOutcome, CapabilityProvider } from "../src/capabilities/types.ts";
import { createInvocationContext } from "../src/invocation.ts";

let base: string;
let rw: string;
let ro: string;
let outside: string;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "psyche-fs-")));
  rw = path.join(base, "root");
  ro = path.join(base, "ro");
  outside = path.join(base, "outside");
  for (const d of [rw, ro, outside, `${rw}X`]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(outside, "secret.txt"), "top secret");
  fs.writeFileSync(path.join(`${rw}X`, "sibling.txt"), "sibling");
  fs.writeFileSync(path.join(ro, "readme.txt"), "read only");
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

function provider(roots?: FsRoot[]): CapabilityProvider {
  return createFsProvider({
    roots: roots ?? [
      { path: rw, mode: "rw" },
      { path: ro, mode: "ro" },
    ],
  });
}

async function call(p: CapabilityProvider, name: string, params: unknown) {
  const entry = (await p.entries()).find((e) => e.manifest.name === name);
  if (!entry) throw new Error(`no ${name}`);
  return entry.handler(
    params,
    createInvocationContext({ invocationId: "inv_1", capability: name }),
  );
}

function errorOf(out: CapabilityOutcome) {
  if (out.ok) throw new Error("expected failure");
  return out.error;
}

function resultOf<T>(out: CapabilityOutcome): T {
  if (!out.ok) throw new Error(`expected success: ${out.error.code} ${out.error.message}`);
  return out.result as T;
}

describe("fs provider", () => {
  it("offers nothing without roots and reports the root count", async () => {
    const empty = provider([]);
    expect(await empty.entries()).toEqual([]);
    expect(await empty.status?.()).toEqual({ roots: 0 });
    const p = provider();
    const names = (await p.entries()).map((e) => e.manifest.name);
    expect(names).toEqual(["fs.list", "fs.stat", "fs.read", "fs.write", "fs.mkdir", "fs.remove"]);
    for (const e of await p.entries()) expect(e.manifest.targetKind).toBe("path");
    expect(await p.status?.()).toEqual({ roots: 2 });
  });

  it("refuses `..` escapes", async () => {
    const err = errorOf(await call(provider(), "fs.read", { path: `${rw}/../outside/secret.txt` }));
    expect(err.code).toBe("forbidden");
    expect(err.details).toEqual({ reason: "outside_roots" });
  });

  it("refuses symlinks that point outside a root, for read and write", async () => {
    fs.symlinkSync(outside, path.join(rw, "escape"));
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(rw, "secret-link"));
    const p = provider();
    for (const [name, params] of [
      ["fs.read", { path: path.join(rw, "escape", "secret.txt") }],
      ["fs.read", { path: path.join(rw, "secret-link") }],
      ["fs.list", { path: path.join(rw, "escape") }],
      ["fs.write", { path: path.join(rw, "escape", "new.txt"), content: "x" }],
    ] as const) {
      const err = errorOf(await call(p, name, params));
      expect(err.code).toBe("forbidden");
      expect(err.details).toEqual({ reason: "outside_roots" });
    }
    expect(fs.existsSync(path.join(outside, "new.txt"))).toBe(false);
  });

  it("refuses writing through a final symlink even inside the root", async () => {
    fs.writeFileSync(path.join(rw, "target.txt"), "original");
    fs.symlinkSync(path.join(rw, "target.txt"), path.join(rw, "link.txt"));
    const err = errorOf(
      await call(provider(), "fs.write", { path: path.join(rw, "link.txt"), content: "x" }),
    );
    expect(err.code).toBe("forbidden");
    expect(fs.readFileSync(path.join(rw, "target.txt"), "utf8")).toBe("original");
  });

  it("refuses paths through a dangling symlink", async () => {
    fs.symlinkSync(path.join(outside, "nope"), path.join(rw, "dangling"));
    const err = errorOf(
      await call(provider(), "fs.write", {
        path: path.join(rw, "dangling", "x.txt"),
        content: "x",
        createParents: true,
      }),
    );
    expect(err.code).toBe("forbidden");
    expect(fs.existsSync(path.join(outside, "nope"))).toBe(false);
  });

  it("does not treat a sibling sharing the root's prefix as inside it", async () => {
    const err = errorOf(await call(provider(), "fs.read", { path: `${rw}X/sibling.txt` }));
    expect(err.code).toBe("forbidden");
    expect(err.details).toEqual({ reason: "outside_roots" });
  });

  it("rejects NUL bytes, relative paths and malformed params", async () => {
    const p = provider();
    expect(errorOf(await call(p, "fs.read", { path: `${rw}/a\0b` })).code).toBe("invalid_params");
    expect(errorOf(await call(p, "fs.read", { path: "root/readme.txt" })).code).toBe(
      "invalid_params",
    );
    expect(errorOf(await call(p, "fs.read", {})).code).toBe("invalid_params");
    expect(errorOf(await call(p, "fs.read", { path: rw, extra: 1 })).code).toBe("invalid_params");
    expect(errorOf(await call(p, "fs.write", { path: path.join(rw, "a"), content: 5 })).code).toBe(
      "invalid_params",
    );
  });

  it("refuses mutations in a read-only root", async () => {
    const p = provider();
    for (const [name, params] of [
      ["fs.write", { path: path.join(ro, "new.txt"), content: "x" }],
      ["fs.mkdir", { path: path.join(ro, "dir") }],
      ["fs.remove", { path: path.join(ro, "readme.txt") }],
    ] as const) {
      const err = errorOf(await call(p, name, params));
      expect(err.code).toBe("forbidden");
      expect(err.details).toEqual({ reason: "read_only_root" });
    }
    expect(
      resultOf<{ content: string }>(await call(p, "fs.read", { path: path.join(ro, "readme.txt") }))
        .content,
    ).toBe("read only");
  });

  it("round-trips writes and reads, utf8 and base64, with receipts free of contents", async () => {
    const p = provider();
    const file = path.join(rw, "a", "b", "note.txt");
    const missing = errorOf(await call(p, "fs.write", { path: file, content: "hi" }));
    expect(missing.code).toBe("not_found");

    const out = await call(p, "fs.write", {
      path: file,
      content: "hello wörld",
      createParents: true,
    });
    expect(out.ok).toBe(true);
    expect(out.receipt?.kind).toBe("fs.write");
    expect(out.receipt?.outcome).toBe("ok");
    expect(out.receipt?.payload).toEqual({ path: file, bytes: Buffer.byteLength("hello wörld") });
    expect(JSON.stringify(out.receipt)).not.toContain("hello");

    const read = resultOf<{ content: string; truncated: boolean }>(
      await call(p, "fs.read", { path: file }),
    );
    expect(read).toMatchObject({ content: "hello wörld", truncated: false });

    const bin = Buffer.from([0, 1, 2, 255]);
    await call(p, "fs.write", { path: file, content: bin.toString("base64"), encoding: "base64" });
    const b64 = resultOf<{ content: string }>(
      await call(p, "fs.read", { path: file, encoding: "base64" }),
    );
    expect(Buffer.from(b64.content, "base64")).toEqual(bin);
    expect(fs.readdirSync(path.dirname(file))).toEqual(["note.txt"]);

    const listed = resultOf<{ entries: { name: string; type: string }[] }>(
      await call(p, "fs.list", { path: path.join(rw, "a") }),
    );
    expect(listed.entries).toMatchObject([{ name: "b", type: "dir" }]);
    const st = resultOf<{ type: string; size: number }>(await call(p, "fs.stat", { path: file }));
    expect(st).toMatchObject({ type: "file", size: 4 });
  });

  it("truncates reads at 1 MiB", async () => {
    const big = path.join(rw, "big.txt");
    fs.writeFileSync(big, "a".repeat(1024 * 1024 + 10));
    const r = resultOf<{ content: string; truncated: boolean; size: number }>(
      await call(provider(), "fs.read", { path: big }),
    );
    expect(r.truncated).toBe(true);
    expect(r.size).toBe(1024 * 1024 + 10);
    expect(r.content.length).toBe(1024 * 1024);
  });

  it("mkdir and remove produce receipts, including on failure", async () => {
    const p = provider();
    const dir = path.join(rw, "d");
    const made = await call(p, "fs.mkdir", { path: dir });
    expect(made.receipt).toMatchObject({ kind: "fs.mkdir", outcome: "ok", payload: { path: dir } });
    const again = await call(p, "fs.mkdir", { path: dir });
    expect(errorOf(again).code).toBe("conflict");
    expect(again.receipt).toMatchObject({ kind: "fs.mkdir", outcome: "failed" });

    fs.writeFileSync(path.join(dir, "f.txt"), "x");
    const notEmpty = await call(p, "fs.remove", { path: dir });
    expect(errorOf(notEmpty).code).toBe("conflict");
    expect(notEmpty.receipt).toMatchObject({ kind: "fs.remove", outcome: "failed" });

    const removed = await call(p, "fs.remove", { path: dir, recursive: true });
    expect(removed.receipt).toMatchObject({
      kind: "fs.remove",
      outcome: "ok",
      payload: { path: dir },
    });
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("removes a symlink itself, never its target", async () => {
    fs.symlinkSync(outside, path.join(rw, "link"));
    const out = await call(provider(), "fs.remove", {
      path: path.join(rw, "link"),
      recursive: true,
    });
    expect(out.ok).toBe(true);
    expect(fs.existsSync(path.join(outside, "secret.txt"))).toBe(true);
  });

  it("refuses removing a root", async () => {
    const p = provider();
    for (const target of [rw, `${rw}/`, `${rw}/sub/..`]) {
      const err = errorOf(await call(p, "fs.remove", { path: target, recursive: true }));
      expect(err.code).toBe("forbidden");
      expect(err.details).toEqual({ reason: "root" });
    }
    expect(fs.existsSync(rw)).toBe(true);
  });
});
