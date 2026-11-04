import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkCallable, checkExternalUrl } from "../src/lib/ipc.ts";
import {
  checkSourceOpen,
  grantedFilePath,
  mailUrl,
  openSource,
  type SourceOpenDeps,
} from "../src/lib/source-open.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "psyche-desk-open-")));
  dirs.push(d);
  return d;
};

describe("the renderer's request carries one document id", () => {
  it("accepts a document id and nothing else", () => {
    for (const ok of ["mail:123", "files:/Users/me/a b.md", "messages:chat1:2026-10-01"])
      expect(checkSourceOpen({ docId: ok }).docId, ok).toBe(ok);
  });

  it("rejects URLs, paths, control characters, other fields standing in and oversized ids", () => {
    for (const bad of [
      null,
      "mail:1",
      {},
      { docId: "" },
      { docId: 3 },
      { docId: "/etc/passwd" },
      { docId: "no-colon" },
      { docId: "mail:1\n2" },
      { docId: "mail:1\0" },
      { docId: `mail:${"x".repeat(400)}` },
      { url: "message://%3Ca%40b.c%3E" },
      { messageId: "a@b.c" },
      { path: "/etc/passwd" },
    ])
      expect(() => checkSourceOpen(bad), JSON.stringify(bad)?.slice(0, 40)).toThrow();
  });
});

describe("the Mail URL", () => {
  it("is message://%3C<id>%3E for a well-formed Message-ID, with the id percent-encoded", () => {
    expect(mailUrl("abc@mail.example.com")).toBe("message://%3Cabc%40mail.example.com%3E");
    expect(mailUrl("<abc@mail.example.com>")).toBe("message://%3Cabc%40mail.example.com%3E");
    expect(mailUrl("CAF=a+b@mail.gmail.com")).toBe("message://%3CCAF%3Da%2Bb%40mail.gmail.com%3E");
    // Characters encodeURIComponent leaves alone are encoded too, so the URL has one alphabet.
    expect(mailUrl("a!b'c*d@h.example")).toBe("message://%3Ca%21b%27c%2Ad%40h.example%3E");
  });

  it("is undefined for anything that is not a Message-ID: other URLs, whitespace, brackets, quotes, a host literal", () => {
    for (const bad of [
      "",
      "no-at",
      "file:///etc/passwd",
      "https://evil.example/@a.b",
      "message://%3Ca@b.c%3E",
      "a b@h.example",
      "a@h.example\n",
      "a@h.example>%3Cb@h.example",
      "<<a@h.example>>",
      'a"@h.example',
      "a@[127.0.0.1]",
      "a@h.example/../x",
      "a@h.example?x=1",
      "a@h.example#x",
      `${"a".repeat(260)}@h.example`,
      42,
      null,
      undefined,
    ])
      expect(mailUrl(bad), JSON.stringify(bad)).toBeUndefined();
  });

  it("never reaches openExternal through the general link policy: message: and file: stay refused there", () => {
    for (const url of [
      "message://%3Ca%40b.c%3E",
      "file:///etc/passwd",
      "x-apple.systempreferences:",
    ])
      expect(() => checkExternalUrl({ url }), url).toThrow();
  });
});

describe("granted files", () => {
  it("is the real path of a regular file inside a granted folder", () => {
    const root = tmp();
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub", "a.md"), "a");
    expect(grantedFilePath(join(root, "sub", "a.md"), [root])).toBe(join(root, "sub", "a.md"));
  });

  it("refuses outside paths, folders, missing files, relative paths, NULs and a root that is `/`", () => {
    const root = tmp();
    const other = tmp();
    writeFileSync(join(other, "x.md"), "x");
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "a.md"), "a");
    expect(grantedFilePath(join(other, "x.md"), [root])).toBeUndefined();
    expect(grantedFilePath(join(root, "sub"), [root])).toBeUndefined();
    expect(grantedFilePath(join(root, "missing.md"), [root])).toBeUndefined();
    expect(grantedFilePath("a.md", [root])).toBeUndefined();
    expect(grantedFilePath(`${join(root, "a.md")}\0.png`, [root])).toBeUndefined();
    expect(grantedFilePath(join(root, "a.md"), ["/"])).toBeUndefined();
    expect(grantedFilePath(join(root, "a.md"), [])).toBeUndefined();
    expect(grantedFilePath(join(root, "a.md"), "nope")).toBeUndefined();
    expect(grantedFilePath(join(root, "a.md"), Array(65).fill(root))).toBeUndefined();
  });

  it("refuses a prefix sibling (`/a/docs-private` is not inside `/a/docs`)", () => {
    const base = tmp();
    mkdirSync(join(base, "docs"));
    mkdirSync(join(base, "docs-private"));
    writeFileSync(join(base, "docs-private", "s.md"), "s");
    expect(
      grantedFilePath(join(base, "docs-private", "s.md"), [join(base, "docs")]),
    ).toBeUndefined();
  });

  it("refuses symlinks that leave the folder, file or directory, and `..` escapes", () => {
    const root = tmp();
    const outside = tmp();
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(join(outside, "secret.txt"), join(root, "file-link"));
    symlinkSync(outside, join(root, "dir-link"));
    expect(grantedFilePath(join(root, "file-link"), [root])).toBeUndefined();
    expect(grantedFilePath(join(root, "dir-link", "secret.txt"), [root])).toBeUndefined();
    mkdirSync(join(root, "in"));
    const name = outside.split("/").at(-1) as string;
    expect(
      grantedFilePath(join(root, "in", "..", "..", name, "secret.txt"), [root]),
    ).toBeUndefined();
  });

  it("allows a link that stays inside the folder, and a granted folder that is itself a link", () => {
    const root = tmp();
    const alias = join(tmp(), "alias");
    writeFileSync(join(root, "real.md"), "r");
    symlinkSync(join(root, "real.md"), join(root, "inner.md"));
    symlinkSync(root, alias);
    expect(grantedFilePath(join(root, "inner.md"), [root])).toBe(join(root, "real.md"));
    expect(grantedFilePath(join(alias, "real.md"), [alias])).toBe(join(root, "real.md"));
  });
});

describe("openSource", () => {
  const deps = (target: unknown, over: Partial<SourceOpenDeps> = {}) => {
    const openExternal = vi.fn(async () => undefined);
    const showItemInFolder = vi.fn();
    const call = vi.fn(async () => ({ target }));
    const d: SourceOpenDeps = { call, openExternal, showItemInFolder, ...over };
    return { d, call, openExternal, showItemInFolder };
  };

  it("opens a mail message in Mail with the URL it built, after asking the Gateway for the document id", async () => {
    const { d, call, openExternal, showItemInFolder } = deps({
      kind: "mail",
      messageId: "abc@mail.example.com",
    });
    expect(await openSource("mail:1", d)).toBe("mail");
    expect(call).toHaveBeenCalledWith("mail:1");
    expect(openExternal).toHaveBeenCalledExactlyOnceWith("message://%3Cabc%40mail.example.com%3E");
    expect(showItemInFolder).not.toHaveBeenCalled();
  });

  it("opens nothing for a Message-ID of the wrong shape, even from the Gateway", async () => {
    for (const messageId of [
      "a b@h.example",
      "https://evil.example",
      "file:///etc/passwd",
      "",
      7,
      undefined,
    ]) {
      const { d, openExternal } = deps({ kind: "mail", messageId });
      expect(await openSource("mail:1", d), String(messageId)).toBe("none");
      expect(openExternal).not.toHaveBeenCalled();
    }
  });

  it("reveals a granted file in Finder, never opens it", async () => {
    const root = tmp();
    writeFileSync(join(root, "plan.md"), "p");
    const path = join(root, "plan.md");
    const { d, showItemInFolder, openExternal } = deps({ kind: "file", path, roots: [root] });
    expect(await openSource("files:x", d)).toBe("file");
    expect(showItemInFolder).toHaveBeenCalledExactlyOnceWith(path);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("opens nothing for a file outside the folders the Gateway named, or one that escapes by a symlink", async () => {
    const root = tmp();
    const outside = tmp();
    writeFileSync(join(outside, "secret.txt"), "s");
    symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
    for (const path of [join(outside, "secret.txt"), join(root, "link.txt"), "/etc/hosts"]) {
      const { d, showItemInFolder } = deps({ kind: "file", path, roots: [root] });
      expect(await openSource("files:x", d), path).toBe("none");
      expect(showItemInFolder).not.toHaveBeenCalled();
    }
  });

  it("opens nothing for no target, an unknown kind, a URL kind or a malformed answer", async () => {
    for (const target of [
      null,
      undefined,
      { kind: "url", url: "https://evil.example" },
      { kind: "app", path: "/Applications/Calculator.app" },
      { kind: "file" },
      {},
    ]) {
      const { d, openExternal, showItemInFolder } = deps(target);
      expect(await openSource("notes:1", d), JSON.stringify(target)).toBe("none");
      expect(openExternal).not.toHaveBeenCalled();
      expect(showItemInFolder).not.toHaveBeenCalled();
    }
    const { d } = deps(null, { call: async () => "nonsense" });
    await expect(openSource("notes:1", d)).rejects.toThrow();
  });

  it("passes a Gateway failure on, and opens nothing", async () => {
    const { d, openExternal } = deps(null, {
      call: async () => {
        throw new Error("not_found");
      },
    });
    await expect(openSource("mail:gone", d)).rejects.toThrow("not_found");
    expect(openExternal).not.toHaveBeenCalled();
  });
});

describe("the renderer cannot ask the Gateway for a target itself", () => {
  it("search.openSource is main-only through the generic relay", () => {
    expect(() => checkCallable("search.openSource", () => true)).toThrow(/not callable/);
    expect(checkCallable("search.document", () => true)).toBe("search.document");
  });
});
