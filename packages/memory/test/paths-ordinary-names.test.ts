import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeWorkspacePath, resolveInWorkspace } from "../src/paths.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

const NFC = "Caf\u00e9";
const NFD = "Cafe\u0301";

const ACCEPT = [
  "Ideas #1.md",
  "What? why.md",
  "[draft] plan.md",
  "100% done.md",
  "a;b.md",
  "\u{1F389} party.md",
  `${NFC}.md`,
  `${NFD}.md`,
  "Ideas #1/What? why.md",
  "[draft]/100% done/a;b.md",
  `\u{1F389} party/${NFD}/${NFC}.md`,
  "100%25.md", // a literal "%25" is just a name, never decoded
  "a_b%_c.md",
];

const REFUSE: [string, string][] = [
  ["traversal", "../x"],
  ["deep traversal", "a/../../x"],
  ["inner dot-dot", "a/../x"],
  ["dot", "."],
  ["dot-dot", ".."],
  ["dot segment", "a/./b"],
  ["absolute", "/etc/passwd"],
  ["empty segment", "a//b"],
  ["trailing slash", "a/"],
  ["drive letter", "C:\\x"],
  ["drive letter slash", "C:/x"],
  ["backslash", "a\\b.md"],
  ["NUL", "a\0b"],
  ["BEL", "a\u0007b"],
  ["DEL", "a\u007fb"],
  ["C1 control NEL", "a\u0085b"],
  ["C1 CSI", "a\u009bb"],
  ["bidi override", "a\u202eb.md"],
  ["empty", ""],
  ["hidden", ".git/config"],
  ["fullwidth solidus", "a\uff0fb.md"],
  ["fullwidth dots", "\uff0e\uff0e/x"],
  ["fullwidth dots segment", "a/\uff0e\uff0e"],
  ["two-dot leader", "\u2025/x"],
  ["division slash", "a\u2215b.md"],
  ["fullwidth backslash", "a\uff3cb.md"],
  ["fullwidth colon", "a\uff1ab.md"],
];

describe("normalizeWorkspacePath: ordinary names in, traversal and controls out", () => {
  it.each(ACCEPT)("accepts %j unchanged (no Unicode normalization)", (name) => {
    expect(normalizeWorkspacePath(name)).toBe(name);
  });

  it.each(REFUSE)("refuses %s", (_label, name) => {
    expect(() => normalizeWorkspacePath(name)).toThrow();
  });

  it("no refused name folds (NFC/NFD/NFKC/NFKD) into traversal that would be accepted", () => {
    for (const [, name] of REFUSE) {
      for (const form of ["NFC", "NFD", "NFKC", "NFKD"] as const) {
        const n = name.normalize(form);
        const segs = n.split("/");
        const dangerous = n.startsWith("/") || segs.includes("..") || segs.includes(".");
        if (!dangerous) continue;
        expect(() => normalizeWorkspacePath(n), JSON.stringify(n)).toThrow();
      }
    }
  });

  it("an accepted name resolves inside the workspace", () => {
    const root = process.cwd();
    for (const name of ACCEPT) {
      const abs = resolveInWorkspace(root, name);
      expect(abs.startsWith(`${root}/`) || abs.startsWith(`${root}`)).toBe(true);
    }
  });
});

describe("indexing names the regression refused", () => {
  let env: TestEnv | undefined;
  afterEach(async () => {
    await env?.cleanup();
    env = undefined;
  });

  it("sync() indexes, lists and searches every ordinary name; refused names stay out", async () => {
    env = await makeEnv();
    const names = ACCEPT.filter((n) => n.endsWith(".md") && !n.includes("%25"));
    const words = new Map<string, string>();
    const letters = "abcdefghijklmnopqrstuvwxyz";
    names.forEach((name, i) => {
      // NFC and NFD spellings are one file on APFS: they must share a word.
      const key = name.normalize("NFC");
      const word = words.get(key) ?? `zorblax${letters[i]}${letters[(i * 7) % 26]}ulum`;
      words.set(key, word);
      const abs = join(env?.workspace as string, ...name.split("/"));
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, `note ${word}`);
    });
    writeFileSync(join(env.workspace, "a|b.md"), "pipe zorblaxrefused");
    await env.store.sync();

    const files = await env.store.listFiles();
    // APFS treats NFC and NFD spellings as one name, so compare folded.
    const folded = new Set(files.map((f) => f.normalize("NFC")));
    for (const name of names) expect(folded.has(name.normalize("NFC")), name).toBe(true);
    expect(files).not.toContain("a|b.md");
    expect(await env.store.search("zorblaxrefused")).toEqual([]);

    for (const name of names) {
      const hits = await env.store.search(words.get(name.normalize("NFC")) as string);
      expect(
        hits.some((h) => h.chunk.source.normalize("NFC") === name.normalize("NFC")),
        name,
      ).toBe(true);
    }
  });

  it("a source filter with % and _ in the name is a literal prefix, not a LIKE pattern", async () => {
    env = await makeEnv();
    for (const [name, word] of [
      ["100% done.md", "lumpfishone"],
      ["100x done.md", "lumpfishtwo"],
      ["a_b.md", "lumpfishthree"],
      ["aXb.md", "lumpfishfour"],
    ] as const) {
      writeFileSync(join(env.workspace, name), `note ${word}`);
    }
    await env.store.sync();
    const only = async (q: string, source: string) =>
      ((await env?.store.search(q, { sources: [source] })) ?? []).map((h) => h.chunk.source);
    expect(await only("lumpfishtwo", "100% ")).toEqual([]);
    expect(await only("lumpfishone", "100% ")).toEqual(["100% done.md"]);
    expect(await only("lumpfishfour", "a_b")).toEqual([]);
    expect(await only("lumpfishthree", "a_b")).toEqual(["a_b.md"]);
  });
});
