import { writeFileSync } from "node:fs";
import type { WebContents } from "electron";

/**
 * Window-to-first-paint measurement (docs/status/v1-perf.md), opt-in with
 * PSYCHE_PERF_FIRST_PAINT_FILE=<path>. The app writes how far startup got to that file at each
 * stage (`ready`, `loaded`, then `painted` or `no-paint`) and quits after the last one, so a run
 * that never paints still says why. A measured run leaves the owner's machine alone: it registers
 * no psyche:// handler, no global shortcut, starts no updater and launches no helper
 * (tests/acceptance/perf).
 */
export const PERF_FIRST_PAINT_ENV = "PSYCHE_PERF_FIRST_PAINT_FILE";

/** How long to wait for the first contentful paint after the page loaded. */
const PAINT_TIMEOUT_MS = 10_000;

export function perfProbeFile(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[PERF_FIRST_PAINT_ENV] || undefined;
}

/** Epoch milliseconds, so the launcher can subtract its own spawn time on the same clock. */
export interface FirstPaintRecord {
  stage: "started" | "ready" | "loaded" | "painted" | "no-paint" | "error";
  mainStartAt: number;
  readyAt?: number;
  didFinishLoadAt?: number;
  /** When the main window was shown (`startShell`); window-to-first-paint starts here. */
  shownAt?: number;
  /** When the page first reported `visibilityState: "visible"` (occlusion delays painting). */
  visibleAt?: number;
  firstContentfulPaintAt?: number;
  /** Renderer state when there was no paint: what to look at next. */
  page?: { url: string; visibility: string; readyState: string; textLength: number };
  error?: string;
}

const FCP_SCRIPT = `new Promise((done) => {
  const page = () => ({
    url: location.href,
    visibility: document.visibilityState,
    readyState: document.readyState,
    textLength: (document.body?.innerText ?? "").length,
  });
  let visibleAt = document.visibilityState === "visible" ? performance.timeOrigin : null;
  document.addEventListener("visibilitychange", () => {
    if (visibleAt === null && document.visibilityState === "visible") visibleAt = Date.now();
  });
  const report = (e) =>
    done({ origin: performance.timeOrigin, fcp: e.startTime, page: page(), visibleAt });
  const seen = performance.getEntriesByName("first-contentful-paint")[0];
  if (seen) return report(seen);
  new PerformanceObserver((list) => {
    const e = list.getEntriesByName("first-contentful-paint")[0];
    if (e) report(e);
  }).observe({ type: "paint", buffered: true });
  setTimeout(
    () => done({ origin: performance.timeOrigin, fcp: null, page: page(), visibleAt }),
    ${PAINT_TIMEOUT_MS},
  );
})`;

/**
 * Called first thing in the main process: records that the app started, and records an uncaught
 * error or rejected promise (startup that throws before the window exists leaves the app running
 * windowless, which a measurement must report rather than time out on).
 */
export function startProbe(file: string): void {
  const write = (record: FirstPaintRecord) => writeFileSync(file, `${JSON.stringify(record)}\n`);
  const mainStartAt = Math.round(performance.timeOrigin);
  write({ stage: "started", mainStartAt });
  const fail = (err: unknown) =>
    write({
      stage: "error",
      mainStartAt,
      error: err instanceof Error ? (err.stack ?? err.message) : String(err),
    });
  process.on("uncaughtExceptionMonitor", fail);
  process.on("unhandledRejection", fail);
}

/**
 * Records the main window's progress and first contentful paint into `file`, then calls `done`.
 * Call it right after the main window is created, before its page can finish loading.
 */
export function watchFirstPaint(
  wc: WebContents,
  file: string,
  done: () => void,
  options: { shownAt?: number } = {},
): void {
  const record: FirstPaintRecord = {
    stage: "ready",
    mainStartAt: Math.round(performance.timeOrigin),
    readyAt: Date.now(),
    ...(options.shownAt === undefined ? {} : { shownAt: options.shownAt }),
  };
  const write = () => writeFileSync(file, `${JSON.stringify(record)}\n`);
  write();
  wc.once("did-finish-load", () => {
    record.stage = "loaded";
    record.didFinishLoadAt = Date.now();
    write();
    void wc
      .executeJavaScript(FCP_SCRIPT)
      .then(
        (r: {
          origin: number;
          fcp: number | null;
          page: FirstPaintRecord["page"];
          visibleAt: number | null;
        }) => {
          if (r.visibleAt !== null) record.visibleAt = Math.round(r.visibleAt);
          if (r.fcp === null) {
            record.stage = "no-paint";
          } else {
            record.stage = "painted";
            record.firstContentfulPaintAt = Math.round(r.origin + r.fcp);
          }
          record.page = r.page;
        },
      )
      .catch((err: unknown) => {
        record.stage = "error";
        record.error = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        write();
        done();
      });
  });
}
