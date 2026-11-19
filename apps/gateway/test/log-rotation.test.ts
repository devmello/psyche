import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rotatingFileSink } from "../src/log-rotation.ts";

describe("rotatingFileSink", () => {
  it("rotates in-process once a file would pass the cap, keeping the configured count", () => {
    const dir = mkdtempSync(join(tmpdir(), "psyche-log-"));
    const path = join(dir, "logs", "gateway.log");
    const sink = rotatingFileSink(path, { maxBytes: 100, files: 3 });
    const line = "x".repeat(39); // 40 bytes with the newline
    for (let i = 0; i < 10; i++) sink(line);
    // Two lines fit in 100 bytes: the live file holds 2 and two rotated files hold 2 each.
    expect(readFileSync(path, "utf8")).toBe(`${line}\n${line}\n`);
    expect(readFileSync(`${path}.1`, "utf8")).toBe(`${line}\n${line}\n`);
    expect(readFileSync(`${path}.2`, "utf8")).toBe(`${line}\n${line}\n`);
    expect(existsSync(`${path}.3`)).toBe(false);
  });

  it("does not rotate an empty file, and never throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "psyche-log-"));
    const path = join(dir, "gateway.log");
    const sink = rotatingFileSink(path, { maxBytes: 5, files: 2 });
    expect(() => sink("a much longer line than the cap")).not.toThrow();
    expect(existsSync(`${path}.1`)).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("a much longer line than the cap\n");
  });
});
