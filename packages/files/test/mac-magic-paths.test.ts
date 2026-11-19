import { mkdirSync, mkdtempSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolRegistration, ToolRunContext } from "@psyche/agent-core";
import { describe, expect, it } from "vitest";
import { assertGranted, assertNotProtected, canonicalTarget, fileTools } from "../src/index.ts";

/**
 * macOS opens `/.nofollow/<abs>`, `/.vol/<dev>/<ino>` and `/.resolve/..` as another file while
 * `realpath` returns them unchanged, so every lexical root check is blind to them (#1384 review).
 */

const MAC = process.platform === "darwin";
const ctx = {
  signal: new AbortController().signal,
  taint: false,
  threadId: "t",
} as unknown as ToolRunContext;

describe.runIf(MAC)("macOS magic root names", () => {
  const MAGIC = [
    "/.nofollow/opt/homebrew",
    "/.nofollow/Library",
    "/.nofollow/Applications",
    "/.nofollow/usr/local",
    "/.vol/16777232/51890",
    "/.resolve/1/x",
    "/opt/../.nofollow/opt",
  ];

  it.each(MAGIC)("canonicalTarget refuses %s", (p) => {
    expect(() => canonicalTarget(p)).toThrowError(/not a path Psyche can use/);
  });

  it("assertNotProtected refuses a magic path even with no matching root", () => {
    expect(() => assertNotProtected("/.nofollow/Library", ["/Users/o/.ssh"])).toThrow();
  });

  it("still accepts ordinary paths", () => {
    for (const p of ["/Users/Shared/x", "/tmp/x", "/Volumes/External/x"]) {
      expect(canonicalTarget(p)).toBe(p);
    }
  });

  it("assertGranted ignores a stored grant on a magic path", () => {
    expect(() =>
      assertGranted(
        "/.nofollow/opt/homebrew/bin/x",
        [{ path: "/.nofollow/opt/homebrew", mode: "rw" }],
        "read",
      ),
    ).toThrow();
  });

  async function run(
    folders: { path: string; mode: "ro" | "rw" }[],
    name: string,
    params: unknown,
  ) {
    const tools = Object.fromEntries(
      fileTools({ folders: () => folders, protectedRoots: () => [] }).map((t) => [t.spec.name, t]),
    ) as Record<string, AgentToolRegistration>;
    try {
      await tools[name]?.run?.(params, ctx);
      return "ok";
    } catch (e) {
      return `throw ${(e as { code?: string }).code ?? ""}`;
    }
  }

  it("the executor refuses read_file and write_file through a /.nofollow grant on a protected folder", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "psy-mg-")));
    mkdirSync(join(home, ".ssh"));
    writeFileSync(join(home, ".ssh", "id_fake"), "FAKEKEY");
    const nf = `/.nofollow${home}`;
    const prot = [join(home, ".ssh")];
    const tools = Object.fromEntries(
      fileTools({
        folders: () => [{ path: `${nf}/.ssh`, mode: "rw" as const }],
        protectedRoots: () => prot,
      }).map((t) => [t.spec.name, t]),
    ) as Record<string, AgentToolRegistration>;
    await expect(tools.read_file?.run?.({ path: `${nf}/.ssh/id_fake` }, ctx)).rejects.toBeDefined();
    await expect(
      tools.write_file?.run?.({ path: `${nf}/.ssh/authorized_keys`, content: "x" }, ctx),
    ).rejects.toBeDefined();
  });

  it("list_dir through /.vol/<dev>/<ino> is refused", async () => {
    const d = statSync(tmpdir());
    const vol = `/.vol/${d.dev}/${d.ino}`;
    expect(await run([{ path: vol, mode: "rw" }], "list_dir", { path: vol })).toMatch(/^throw/);
  });
});
