import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import {
  app,
  type BaseWindow,
  type BaseWindowConstructorOptions,
  type WebContents,
  type WebContentsView,
} from "electron";

/**
 * Liquid Glass spike (docs/design/research/liquid-glass.md), off unless `PSYCHE_GLASS=native` on
 * macOS. The community `electron-liquid-glass` addon puts one `NSGlassEffectView` under the whole
 * window (it has no region API), so the window is transparent and the page paints every region
 * opaque except the sidebar: the rail and the thread list show the glass, the content column
 * does not. Not for release: Psyche does not depend on the addon (the research recommends
 * against shipping it), so a probe installs it locally first and must not commit the change:
 *
 *   pnpm --filter @psyche/desktop add -O electron-liquid-glass@1.1.1   # N-API prebuilds, no build
 *   PSYCHE_GLASS=native PSYCHE_GLASS_PROBE=/tmp/psyche-glass/probe.json \
 *     pnpm --filter @psyche/desktop dev
 *   git checkout apps/desktop/package.json pnpm-lock.yaml              # drop the local install
 *
 * Without it, `PSYCHE_GLASS=native` logs one warning and the window stays opaque.
 */

export const GLASS_ENV = "PSYCHE_GLASS";
/** Writes frame-time and CPU numbers for one scripted scroll, then screenshots, to this path. */
export const GLASS_PROBE_ENV = "PSYCHE_GLASS_PROBE";

export type GlassMode = "native" | "off";

export function glassMode(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): GlassMode {
  return platform === "darwin" && env[GLASS_ENV] === "native" ? "native" : "off";
}

/** The main window must be transparent for a glass view under the web contents to show. */
export function glassWindowOptions(mode: GlassMode): Partial<BaseWindowConstructorOptions> {
  return mode === "native" ? { transparent: true } : {};
}

/**
 * The page side of native glass: the frame and the sidebar regions go transparent, the content
 * column keeps an opaque canvas. Uses the web shell's stable class names (`apps/web/src/shell`).
 */
export const NATIVE_GLASS_CSS = `
:root[data-glass="native"],
:root[data-glass="native"] body,
:root[data-glass="native"] #root,
:root[data-glass="native"] .app-frame,
:root[data-glass="native"] .shell,
:root[data-glass="native"] .titlebar,
:root[data-glass="native"] .rail-slot,
:root[data-glass="native"] .threads-slot,
:root[data-glass="native"] .rail-slot > *,
:root[data-glass="native"] .threads-slot > *,
:root[data-glass="native"] .threads-slot .threads-header {
  background: transparent !important;
}
:root[data-glass="native"] .shell > main {
  background: var(--canvas, var(--shell-bg)) !important;
}
`;

/** The slice of `electron-liquid-glass` this spike uses. */
export interface LiquidGlass {
  addView(
    handle: Buffer,
    options?: { cornerRadius?: number; tintColor?: string; opaque?: boolean },
  ): number;
  isGlassSupported(): boolean;
}

/** Loads the addon at runtime if it is installed locally; `null` when it is absent. */
async function loadLiquidGlass(): Promise<LiquidGlass | null> {
  try {
    // Resolved from the app directory at run time, never by tsc or the bundler: the package is
    // not a dependency (vite.main.config.ts also keeps it external, as bundling breaks its loader).
    const require = createRequire(join(app.getAppPath(), "package.json"));
    const mod = require("electron-liquid-glass") as { default?: LiquidGlass } & LiquidGlass;
    return mod.default ?? mod;
  } catch (err) {
    console.warn(
      `[glass] electron-liquid-glass is not installed (see main/glass.ts to add it locally): ${String(err)}`,
    );
    return null;
  }
}

/**
 * Puts the native glass under `win` and tells the page. Returns the addon's view id, or -1 when
 * the addon is missing or the OS has no `NSGlassEffectView` (the page then stays opaque).
 */
export async function attachNativeGlass(
  win: BaseWindow,
  view: WebContentsView,
  load: () => Promise<LiquidGlass | null> = loadLiquidGlass,
): Promise<number> {
  const glass = await load();
  if (glass === null || !glass.isGlassSupported()) return -1;
  view.setBackgroundColor("#00000000");
  const id = glass.addView(win.getNativeWindowHandle(), {});
  const mark = (wc: WebContents) => {
    void wc.insertCSS(NATIVE_GLASS_CSS);
    void wc.executeJavaScript(`document.documentElement.dataset.glass = "native";`);
  };
  mark(view.webContents);
  view.webContents.on("did-finish-load", () => mark(view.webContents));
  return id;
}

const PROBE_SCRIPT = (seconds: number) => `new Promise((done) => {
  const scroller = [...document.querySelectorAll("main *")].find(
    (el) => el.scrollHeight > el.clientHeight + 40 && getComputedStyle(el).overflowY !== "visible",
  );
  const deltas = [];
  let last = performance.now();
  const end = last + ${seconds * 1000};
  let dir = 1;
  const step = (now) => {
    deltas.push(now - last);
    last = now;
    if (scroller) {
      scroller.scrollTop += 4 * dir;
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1) dir = -1;
      if (scroller.scrollTop <= 0) dir = 1;
    }
    if (now < end) requestAnimationFrame(step);
    else {
      const d = deltas.slice(5).sort((a, b) => a - b);
      const q = (p) => d[Math.min(d.length - 1, Math.floor(p * d.length))] || 0;
      done({
        scroller: scroller ? scroller.className.slice(0, 80) : null,
        glass: document.documentElement.dataset.glass || "off",
        frames: d.length,
        mean: d.reduce((a, b) => a + b, 0) / Math.max(1, d.length),
        p50: q(0.5), p95: q(0.95), p99: q(0.99), max: d[d.length - 1] || 0,
        dropped: d.filter((x) => x > q(0.5) * 1.5).length,
      });
    }
  };
  requestAnimationFrame((now) => { last = now; requestAnimationFrame(step); });
})`;

/** WindowServer's accumulated CPU seconds (`ps` reads it without privileges). */
function windowServerCpu(): Promise<number> {
  return new Promise((resolve) => {
    execFile("ps", ["-A", "-o", "time=,comm="], (err, out) => {
      if (err) return resolve(Number.NaN);
      const line = out.split("\n").find((l) => l.trim().endsWith("WindowServer"));
      const t = line?.trim().split(/\s+/)[0] ?? "";
      const parts = t.split(":").map(Number);
      resolve(parts.reduce((acc, p) => acc * 60 + p, 0));
    });
  });
}

/**
 * One scripted measurement (dev only, `PSYCHE_GLASS_PROBE=<file>`): scroll the transcript for 6 s
 * with the glass showing, then again with the page painted opaque over it, recording rAF frame
 * times, Electron's GPU-process and renderer CPU and WindowServer CPU; then screenshot the window
 * in light and dark with `screencapture` (needs Screen Recording for the terminal).
 */
export async function runGlassProbe(
  win: BaseWindow,
  view: WebContentsView,
  file: string,
  deps: {
    metrics: () => { type: string; cpu: { cumulativeCPUUsage?: number } }[];
    setTheme: (t: "light" | "dark" | "system") => void;
  },
): Promise<void> {
  const wc = view.webContents;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const cpu = (type: string) =>
    deps
      .metrics()
      .filter((m) => m.type === type)
      .reduce((a, m) => a + (m.cpu.cumulativeCPUUsage ?? 0), 0);
  const phase = async (label: string) => {
    const before = { gpu: cpu("GPU"), tab: cpu("Tab"), ws: await windowServerCpu() };
    const stats = (await wc.executeJavaScript(PROBE_SCRIPT(6))) as Record<string, unknown>;
    const after = { gpu: cpu("GPU"), tab: cpu("Tab"), ws: await windowServerCpu() };
    return {
      label,
      ...stats,
      gpuProcessPct: ((after.gpu - before.gpu) / 6) * 100,
      rendererPct: ((after.tab - before.tab) / 6) * 100,
      windowServerPct: ((after.ws - before.ws) / 6) * 100,
    };
  };
  const shot = (name: string) =>
    new Promise<string>((resolve) => {
      const id = win.getMediaSourceId().split(":")[1] ?? "";
      const out = file.replace(/\.json$/, `-${name}.png`);
      execFile("screencapture", ["-x", "-o", "-l", id, out], (err) =>
        resolve(err ? `failed: ${err.message}` : out),
      );
    });

  await sleep(4000);
  // An occluded window gets no animation frames, so the probe would wait forever behind other
  // windows: bring it to the front first (this is a dev-only, owner-started run).
  win.show();
  win.moveTop();
  console.warn(`[glass] probe started; results go to ${file}`);
  const results: unknown[] = [];
  const shots: Record<string, string> = {};
  deps.setTheme("light");
  await sleep(800);
  shots.light = await shot("light");
  results.push(await phase("native glass, light"));
  deps.setTheme("dark");
  await sleep(800);
  shots.dark = await shot("dark");
  results.push(await phase("native glass, dark"));
  // Same window, page opaque over the glass: the cost of the glass view itself.
  await wc.executeJavaScript(`document.documentElement.dataset.glass = "covered";`);
  await sleep(500);
  shots.covered = await shot("covered-dark");
  results.push(await phase("glass covered by opaque page, dark"));
  deps.setTheme("system");
  writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), results, shots }, null, 2));
  console.warn(`[glass] probe finished: ${file}`);
}
