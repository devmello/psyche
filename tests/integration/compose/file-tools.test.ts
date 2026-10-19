import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolRegistration, ToolRunContext } from "@psyche/agent-core";
import { fileTools } from "@psyche/gateway/compose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let root: string;
let granted: string;
let outside: string;
const tools = Object.fromEntries(fileTools().map((t) => [t.spec.name, t])) as Record<
  string,
  AgentToolRegistration
>;
const ctx = { signal: new AbortController().signal } as ToolRunContext;
const run = (name: string, params: unknown) => tools[name]?.run?.(params, ctx);

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "psy-ft-")));
  granted = join(root, "granted");
  outside = join(root, "outside");
  mkdirSync(granted);
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "vault key");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("compose file tools", () => {
  it("reads and writes a real path", async () => {
    await run("write_file", { path: join(granted, "a.md"), content: "hi" });
    const r = (await run("read_file", { path: join(granted, "a.md") })) as {
      output: { text: string };
      provenance: string;
    };
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
    const r = (await run("read_file", { path: join(granted, "big.txt") })) as {
      output: { truncated: boolean; text: string };
    };
    expect(r.output.truncated).toBe(true);
    expect(r.output.text.length).toBe(256 * 1024);
    const d = tools.write_file?.describeCall?.({ path: join(granted, "n.md"), content: "a" });
    expect(d).toMatchObject({ kind: "file_write", bindingFields: { operation: "overwrite" } });
    expect(tools.read_file?.validate?.({ path: "relative.md" })).toBeTruthy();
  });
});
