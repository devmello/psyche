// Liquid Glass spike (docs/design/research/liquid-glass.md): screenshots and frame-time probes of
// the GlassSurface stories, against the static Storybook served by visual/serve.ts.
//
//   node visual/glass-probe.mjs shots <outDir>            light + dark comparison screenshots
//   node visual/glass-probe.mjs probe [seconds] [runs]    frame times while the backdrop scrolls
//
// SB_PORT picks the server port (default 6106). Chrome runs headed by default so the GPU
// compositor and the display's refresh rate are real; GLASS_HEADLESS=1 runs headless instead.
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(`${process.cwd()}/package.json`);
const { chromium } = require("@playwright/test");
const port = process.env.SB_PORT ?? "6106";
const base = `http://127.0.0.1:${port}/iframe.html`;
const [mode = "probe", ...args] = process.argv.slice(2);

const browser = await chromium.launch({
  channel: "chrome",
  headless: process.env.GLASS_HEADLESS === "1",
});

async function open(page, id, theme = "light") {
  await page.goto(`${base}?id=${id}&viewMode=story&globals=theme:${theme}`);
  await page.waitForFunction(
    () => (document.querySelector("#storybook-root")?.innerHTML.length ?? 0) > 50,
    null,
    { timeout: 60_000 },
  );
  await page.waitForTimeout(600);
}

if (mode === "shots") {
  const out = args[0] ?? "glass-shots";
  mkdirSync(out, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1000, height: 640 } });
  const stories = [
    "primitives-glasssurface--comparison-photo",
    "primitives-glasssurface--comparison-text",
    "primitives-glasssurface--clear-over-photo",
    "primitives-glasssurface--reduce-transparency",
  ];
  for (const id of stories) {
    for (const theme of ["light", "dark"]) {
      await open(page, id, theme);
      // Scroll each backdrop a little so the chrome sits over busy content.
      await page.evaluate(() => {
        for (const el of document.querySelectorAll("[data-glass-backdrop]")) el.scrollTop = 180;
      });
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${out}/${id.split("--")[1]}-${theme}.png` });
    }
  }
} else {
  const seconds = Number(args[0] ?? 6);
  const runs = Number(args[1] ?? 3);
  const page = await browser.newPage({ viewport: { width: 980, height: 740 } });
  const gpu = await page.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl");
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "unknown";
  });
  // GPU-process and renderer CPU time over the run: the compositor's cost, which rAF pacing hides.
  const cdp = await browser.newBrowserCDPSession();
  const cpu = async () => {
    const { processInfo } = await cdp.send("SystemInfo.getProcessInfo");
    const sum = (type) =>
      processInfo.filter((p) => p.type === type).reduce((a, p) => a + p.cpuTime, 0);
    return { gpu: sum("GPU"), renderer: sum("renderer") };
  };
  const results = [];
  for (const id of ["probe-opaque", "probe-css", "probe-refraction", "probe-text-refraction"]) {
    for (let run = 0; run < runs; run++) {
      await open(page, `primitives-glasssurface--${id}`);
      const before = await cpu();
      const stats = await page.evaluate((s) => window.__glassProbe?.(s), seconds);
      const after = await cpu();
      results.push({
        story: id,
        run,
        ...stats,
        // CPU seconds per wall second, as a percentage of one core.
        gpuProcessPct: Number((((after.gpu - before.gpu) / seconds) * 100).toFixed(1)),
        rendererPct: Number((((after.renderer - before.renderer) / seconds) * 100).toFixed(1)),
      });
    }
  }
  process.stdout.write(
    `${JSON.stringify({ gpu, headless: process.env.GLASS_HEADLESS === "1", results }, null, 2)}\n`,
  );
}
await browser.close();
