import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { perfProbeFile, startProbe, watchFirstPaint } from "../src/main/perf-probe.ts";

describe("perf-probe", () => {
  it("is off unless PSYCHE_PERF_FIRST_PAINT_FILE names a file", () => {
    expect(perfProbeFile({})).toBeUndefined();
    expect(perfProbeFile({ PSYCHE_PERF_FIRST_PAINT_FILE: "" })).toBeUndefined();
    expect(perfProbeFile({ PSYCHE_PERF_FIRST_PAINT_FILE: "/tmp/x.json" })).toBe("/tmp/x.json");
  });

  const page = {
    url: "app://psyche/chat",
    visibility: "visible",
    readyState: "complete",
    textLength: 42,
  };

  async function run(result: unknown) {
    const dir = mkdtempSync(join(tmpdir(), "psyche-probe-"));
    try {
      let onLoad: (() => void) | undefined;
      const wc = {
        once: (event: string, cb: () => void) => {
          if (event === "did-finish-load") onLoad = cb;
        },
        executeJavaScript: vi.fn(async () => result),
      };
      const file = join(dir, "paint.json");
      const done = new Promise<void>((resolve) =>
        watchFirstPaint(wc as never, file, () => resolve()),
      );
      // Written before the page loads: a run that never gets further still says so.
      expect(JSON.parse(readFileSync(file, "utf8")).stage).toBe("ready");
      onLoad?.();
      await done;
      return JSON.parse(readFileSync(file, "utf8"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("writes the renderer's first contentful paint as epoch ms after did-finish-load", async () => {
    const record = await run({ origin: 1_000_000, fcp: 123.4, page });
    expect(record).toMatchObject({ stage: "painted", firstContentfulPaintAt: 1_000_123, page });
    expect(record.didFinishLoadAt).toBeGreaterThan(0);
    expect(record.mainStartAt).toBeGreaterThan(0);
  });

  it("records the start, and a rejected promise during startup", async () => {
    const dir = mkdtempSync(join(tmpdir(), "psyche-probe-"));
    const before = process.listeners("unhandledRejection");
    try {
      const file = join(dir, "paint.json");
      startProbe(file);
      expect(JSON.parse(readFileSync(file, "utf8")).stage).toBe("started");
      const added = process.listeners("unhandledRejection").filter((l) => !before.includes(l));
      for (const l of added) (l as (e: unknown) => void)(new Error("boom"));
      const record = JSON.parse(readFileSync(file, "utf8"));
      expect(record.stage).toBe("error");
      expect(record.error).toContain("boom");
      for (const l of added) process.off("unhandledRejection", l as never);
      for (const l of process.listeners("uncaughtExceptionMonitor"))
        process.off("uncaughtExceptionMonitor", l as never);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records the page state when nothing contentful painted", async () => {
    const record = await run({ origin: 1_000_000, fcp: null, page: { ...page, textLength: 0 } });
    expect(record.stage).toBe("no-paint");
    expect(record.firstContentfulPaintAt).toBeUndefined();
    expect(record.page.textLength).toBe(0);
  });
});
