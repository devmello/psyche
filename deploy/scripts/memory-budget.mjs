// Regression guard for the Gateway's settled idle memory and bundle size (deploy/size-budget.json;
// docs/design/lightweight-2026.md).
//
//   node deploy/scripts/memory-budget.mjs [--bundle <psyched dir>] [--settle <seconds>] [--json-out <file>]
//
// Measures the bundled Gateway of a built tree (the output of build-psyched.mjs, default
// apps/gateway/dist-bin/darwin-<arch>/psyched), prints the numbers as JSON on stdout and exits 1 when
// one is over gatewayIdleFootprintMB, gatewayIdleHeapMB or gatewayBundleMB. Run build-psyched.mjs first.
//
// The metric is macOS physical footprint (`footprint <pid>`), not RSS: RSS swings 80-200 MB for the
// same idle process. "Settled idle" is: start the bundle's own Node with the launcher's flags, wait for
// GET /healthz, force a full GC at settle-20 s (two gc() calls from a --import preload; it also writes
// process.memoryUsage().heapUsed to a file), then read the footprint at the settle mark (60 s). The
// Gateway runs isolated: a fresh PSYCHE_HOME under /tmp, a free port, no browser, no model; it never
// touches ~/.psyche, Psyche.app or the LaunchAgent. Off macOS the footprint and heap are skipped (only
// the bundle size is checked). PSYCHE_SIZE_BUDGET=skip turns the check off.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { arch, platform } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { budgets } from "./size-budget.mjs";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");

const UNITS = { B: 1 / 1048576, KB: 1 / 1024, MB: 1, GB: 1024 };

/** MiB from `footprint <pid>` output ("zsh [92526]: 64-bit    Footprint: 2368 KB (...)"), or undefined. */
export function parseFootprint(text) {
  const m = /Footprint:\s*([\d.]+)\s*(B|KB|MB|GB)\b/.exec(text);
  return m ? Number(m[1]) * UNITS[m[2]] : undefined;
}

/**
 * Compare measurements with the limits. `measured` maps a budget key to MiB (or undefined when it was
 * not measured); returns the over-budget lines (empty when all pass) and a line per measurement.
 */
export function compareBudgets(measured, limits) {
  const lines = [];
  const over = [];
  for (const [key, mb] of Object.entries(measured)) {
    const limit = limits[key];
    if (typeof limit !== "number") throw new Error(`size-budget.json has no "${key}"`);
    if (mb === undefined) {
      lines.push(`${key}: not measured (limit ${limit} MiB)`);
      continue;
    }
    const line = `${key}: ${mb.toFixed(1)} MiB of ${limit} MiB`;
    lines.push(line);
    if (mb > limit) over.push(line);
  }
  return { lines, over };
}

const preloadSource = (heapFile, gcAtMs) => `
setTimeout(() => {
  gc(); gc();
  require("node:fs").writeFileSync(${JSON.stringify(heapFile)}, String(process.memoryUsage().heapUsed));
}, ${gcAtMs}).unref();
`;

function freePort() {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function measureIdle(bundle, settleS) {
  const home = mkdtempSync("/tmp/psyG.");
  const heapFile = join(home, "heap.txt");
  const preload = join(home, "gc-preload.cjs");
  writeFileSync(preload, preloadSource(heapFile, Math.max(settleS - 20, 1) * 1000));
  const port = await freePort();
  const child = spawn(
    join(bundle, "runtime/node"),
    [
      "--max-semi-space-size=4",
      "--disable-warning=ExperimentalWarning",
      "--expose-gc",
      "--import",
      preload,
      join(bundle, "app/apps/gateway/dist/main.mjs"),
    ],
    {
      env: {
        PATH: "/usr/bin:/bin",
        PSYCHE_HOME: home,
        PSYCHE_PORT: String(port),
        PSYCHE_BROWSER: "off",
      },
      stdio: "ignore",
    },
  );
  let exited;
  child.on("exit", (code) => {
    exited = code;
  });
  try {
    const started = Date.now();
    for (;;) {
      if (exited !== undefined) throw new Error(`psyched exited ${exited} before /healthz`);
      if (Date.now() - started > 30_000) throw new Error("psyched gave no /healthz in 30 s");
      try {
        if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break;
      } catch {}
      await sleep(250);
    }
    await sleep(Math.max(settleS * 1000 - (Date.now() - started), 0));
    if (exited !== undefined) throw new Error(`psyched exited ${exited} while idle`);
    const footprint = parseFootprint(
      execFileSync("footprint", [String(child.pid)], { encoding: "utf8" }),
    );
    if (footprint === undefined) throw new Error("could not read Footprint from `footprint`");
    const heap = Number(readFileSync(heapFile, "utf8")) / 1048576;
    return { gatewayIdleFootprintMB: footprint, gatewayIdleHeapMB: heap };
  } finally {
    child.kill("SIGKILL");
    rmSync(home, { recursive: true, force: true });
  }
}

async function main(argv) {
  const opt = (n) => {
    const i = argv.indexOf(n);
    return i === -1 ? undefined : argv[i + 1];
  };
  const hostArch = arch() === "arm64" ? "arm64" : "x64";
  const bundle = resolve(
    opt("--bundle") ?? join(ROOT, "apps/gateway/dist-bin", `darwin-${hostArch}`, "psyched"),
  );
  const entry = join(bundle, "app/apps/gateway/dist/main.mjs");
  let size;
  try {
    size = statSync(entry).size / 1048576;
  } catch {
    throw new Error(
      `${entry} not found: build the tree first (node deploy/scripts/build-psyched.mjs)`,
    );
  }
  const measured = { gatewayBundleMB: size };
  if (platform() === "darwin") {
    Object.assign(measured, await measureIdle(bundle, Number(opt("--settle") ?? 60)));
  } else {
    process.stderr.write(
      "memory-budget: footprint and heap are macOS only; checking the bundle size\n",
    );
  }
  const { lines, over } = compareBudgets(measured, budgets());
  const json = `${JSON.stringify({ ...measured, over: over.length > 0 }, null, 2)}\n`;
  const out = opt("--json-out");
  if (out) writeFileSync(out, json);
  process.stdout.write(json);
  for (const l of lines) process.stderr.write(`memory budget: ${l}\n`);
  if (over.length > 0 && process.env.PSYCHE_SIZE_BUDGET !== "skip") {
    process.stderr.write(
      `memory budget: over the budget. Find what grew, or raise the key in deploy/size-budget.json with the reason in the PR\n`,
    );
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`memory-budget: ${err.message}\n`);
    process.exit(1);
  });
}
