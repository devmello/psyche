import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rotatingFileSink } from "../src/log-rotation.ts";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "psyche-log-"));
  dirs.push(d);
  return d;
}

/** Every line the files hold, oldest rotated file first. */
function allLines(path: string, files: number): string[] {
  const out: string[] = [];
  for (let i = files - 1; i >= 1; i--) {
    const f = `${path}.${i}`;
    if (existsSync(f)) out.push(...readFileSync(f, "utf8").split("\n").filter(Boolean));
  }
  if (existsSync(path)) out.push(...readFileSync(path, "utf8").split("\n").filter(Boolean));
  return out;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("rotatingFileSink", () => {
  it("rotates in-process once a file would pass the cap, keeping the configured count", () => {
    const path = join(tempDir(), "logs", "gateway.log");
    const sink = rotatingFileSink(path, { maxBytes: 100, files: 3 });
    const line = "x".repeat(39); // 40 bytes with the newline
    for (let i = 0; i < 10; i++) sink(line);
    // Two lines fit in 100 bytes: the live file holds 2 and two rotated files hold 2 each.
    expect(readFileSync(path, "utf8")).toBe(`${line}\n${line}\n`);
    expect(readFileSync(`${path}.1`, "utf8")).toBe(`${line}\n${line}\n`);
    expect(readFileSync(`${path}.2`, "utf8")).toBe(`${line}\n${line}\n`);
    expect(existsSync(`${path}.3`)).toBe(false);
  });

  it("never rotates an empty file, and never throws on a line over the cap", () => {
    const path = join(tempDir(), "gateway.log");
    const sink = rotatingFileSink(path, { maxBytes: 5, files: 2 });
    expect(() => sink("a much longer line than the cap")).not.toThrow();
    expect(existsSync(`${path}.1`)).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("a much longer line than the cap\n");
  });

  it("falls back to stderr, without throwing, when the logs directory cannot be used", () => {
    const dir = tempDir();
    // A file where the logs directory should be: nothing can be created beneath it.
    writeFileSync(join(dir, "logs"), "not a directory");
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const sink = rotatingFileSink(join(dir, "logs", "gateway.log"));
    expect(() => sink('{"msg":"kept"}')).not.toThrow();
    expect(write).toHaveBeenCalledWith('{"msg":"kept"}\n');
  });

  it("keeps every line when two sinks rotate the same file", () => {
    const path = join(tempDir(), "gateway.log");
    const a = rotatingFileSink(path, { maxBytes: 100, files: 40 });
    const b = rotatingFileSink(path, { maxBytes: 100, files: 40 });
    const written: string[] = [];
    for (let i = 0; i < 30; i++) {
      const la = `a-${String(i).padStart(3, "0")}-${"x".repeat(30)}`;
      const lb = `b-${String(i).padStart(3, "0")}-${"x".repeat(30)}`;
      a(la);
      b(lb);
      written.push(la, lb);
    }
    const kept = allLines(path, 40);
    expect(kept.sort()).toEqual([...written].sort());
  });
});
