// Builds the self-contained Gateway bundle for Psyche.app (docs/status/s22.md "Packaging layout").
//
//   node deploy/scripts/build-psyched.mjs [--arch arm64|x64] [--out <dir>] [--skip-web-build] [--smoke]
//
// Output: apps/gateway/dist-bin/darwin-<arch>/psyched/
//   psyched, psyche            /bin/sh launchers (no PATH needed): runtime/node + app/apps/*/src/main.ts
//   runtime/node               the official Node build of the version deploy/scripts/node-pins.mjs pins,
//                              SHA-256 checked against nodejs.org's SHASUMS256.txt
//   app/                       the workspace subset with production dependencies, run by Node's type
//                              stripping exactly like the Docker image (packages read migrations and
//                              templates next to their sources, so nothing is bundled)
//   com.psyche.gateway.plist.template   LaunchAgent with {{PSYCHED}} and {{PSYCHE_HOME}}
//   build-info.json            {version, commit, node, arch, builtAt, bytes}
//
// Native addons (better-sqlite3, node-pty, sqlite-vec, …) are installed for the host by pnpm, so
// build each arch on a host of that arch (the release workflow uses an Intel runner for x64); the
// script checks every .node file's architecture and refuses a mismatch. --smoke starts the built
// psyched with only PSYCHE_HOME set and waits for /healthz.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, arch as hostArch, platform, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findPins } from "./node-pins.mjs";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");

/** Dirs of the exported tree the runtime never reads (the Dockerfile's deps stage drops the same). */
const PRUNE = [
  "apps/desktop",
  "apps/mac-helper",
  "apps/web/src",
  "apps/web/testing",
  "docs",
  "prompts",
  "tests",
  "spikes",
  "research_notes",
  "reports",
  ".changeset",
  ".github",
  "deploy/homebrew",
  "deploy/macos",
  "deploy/scripts",
];

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** The Node version every base image is pinned to: one version for the whole release. */
export function pinnedNodeVersion(root = ROOT) {
  const pins = findPins(readFileSync(join(root, "deploy/Dockerfile"), "utf8"));
  const v = pins[0]?.version;
  if (!v || !/^\d+\.\d+\.\d+$/.test(v)) throw new Error("deploy/Dockerfile has no exact Node pin");
  return v;
}

/** node-v<ver>-darwin-<arch>/bin/node, downloaded once into a cache and checked against SHASUMS256. */
async function nodeRuntime(version, arch) {
  const cache = join(
    process.env.XDG_CACHE_HOME ?? join(homedir(), "Library", "Caches"),
    "psyche-build",
    "node",
  );
  mkdirSync(cache, { recursive: true });
  const name = `node-v${version}-darwin-${arch}.tar.gz`;
  const tarball = join(cache, name);
  const base = `https://nodejs.org/dist/v${version}/`;
  const sums = await (await fetch(`${base}SHASUMS256.txt`)).text();
  const expected = new RegExp(`^([0-9a-f]{64})\\s+${name.replace(/\./g, "\\.")}$`, "m").exec(
    sums,
  )?.[1];
  if (!expected) throw new Error(`SHASUMS256.txt has no ${name}`);
  if (!existsSync(tarball) || sha256(tarball) !== expected) {
    const res = await fetch(`${base}${name}`);
    if (!res.ok) throw new Error(`GET ${name}: ${res.status}`);
    writeFileSync(tarball, Buffer.from(await res.arrayBuffer()));
  }
  if (sha256(tarball) !== expected) throw new Error(`${name}: SHA-256 does not match nodejs.org`);
  const dir = mkdtempSync(join(tmpdir(), "psyche-node-"));
  run("tar", ["-xzf", tarball, "-C", dir, `node-v${version}-darwin-${arch}/bin/node`]);
  return {
    node: join(dir, `node-v${version}-darwin-${arch}`, "bin", "node"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Every real file once: symlinks (pnpm's node_modules layout) are never followed. */
function walk(dir, visit, onDir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p, { throwIfNoEntry: false });
    if (!st || st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      if (onDir?.(p, name) === false) continue;
      walk(p, visit, onDir);
    } else visit(p, st);
  }
}

const PLATFORM_TOKEN = /(darwin|linux|linuxmusl|win32|android|freebsd|openbsd|sunos|aix)-/;

/**
 * Packages ship prebuilt addons for every platform (`prebuilds/linux-x64.node`, …). Keep only
 * this bundle's `darwin-<arch>`: the rest is dead weight that would also have to be signed.
 */
export function pruneForeignPrebuilds(appDir, arch) {
  let removed = 0;
  walk(
    appDir,
    () => {},
    (p, name) => {
      if (name !== "prebuilds") return true;
      for (const entry of readdirSync(p)) {
        if (PLATFORM_TOKEN.test(entry) && !entry.startsWith(`darwin-${arch}`)) {
          rmSync(join(p, entry), { recursive: true, force: true });
          removed++;
        }
      }
      return true;
    },
  );
  return removed;
}

/** Every .node file must be a Mach-O for `arch` (pnpm installs host binaries). */
export function checkAddons(appDir, arch) {
  const want = arch === "arm64" ? "arm64" : "x86_64";
  const bad = [];
  walk(appDir, (p) => {
    if (!p.endsWith(".node")) return;
    const out = execFileSync("/usr/bin/file", ["-b", p], { encoding: "utf8" });
    if (!out.includes(want)) bad.push(`${p.slice(appDir.length + 1)}: ${out.trim()}`);
  });
  return bad;
}

// Both launchers find the bundle through any symlinks to them (`/usr/local/bin/psyche`).
const RESOLVE_HERE = `self=$0
case $self in */*) ;; *) self=./$self ;; esac
while [ -L "$self" ]; do
  link=$(readlink "$self")
  case $link in /*) self=$link ;; *) self=\${self%/*}/$link ;; esac
done
here=\${self%/*}`;

export const PSYCHED_LAUNCHER = `#!/bin/sh
# Psyche Gateway (psyched) from Psyche.app. Needs only PSYCHE_HOME; no Node, PATH or checkout.
${RESOLVE_HERE}
exec "$here/runtime/node" --disable-warning=ExperimentalWarning "$here/app/apps/gateway/src/main.ts" "$@"
`;

export const PSYCHE_LAUNCHER = `#!/bin/sh
# The psyche CLI from Psyche.app, on the same runtime as psyched.
${RESOLVE_HERE}
exec "$here/runtime/node" --disable-warning=ExperimentalWarning "$here/app/apps/cli/src/main.ts" "$@"
`;

async function smoke(bundle) {
  const home = mkdtempSync(join("/tmp", "psy-smoke-"));
  try {
    const child = spawn(join(bundle, "psyched"), [], {
      // Only what launchd gives it plus PSYCHE_HOME; PSYCHE_PORT=0 avoids a clash with a running Gateway.
      env: { PSYCHE_HOME: home, PSYCHE_PORT: "0", PSYCHE_BROWSER: "off" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    const origin = await new Promise((ok, fail) => {
      let buf = "";
      const t = setTimeout(() => fail(new Error(`psyched did not start:\n${buf}`)), 30_000);
      child.stderr.on("data", (d) => {
        buf += String(d);
        const m = /"msg":"gateway listening","origin":"(http:\/\/127\.0\.0\.1:\d+)"/.exec(buf);
        if (m) {
          clearTimeout(t);
          ok(m[1]);
        }
      });
      child.on("exit", (code) => {
        clearTimeout(t);
        fail(new Error(`psyched exited ${code}:\n${buf}`));
      });
    });
    const health = await (await fetch(`${origin}/healthz`)).json();
    child.kill("SIGTERM");
    if (health?.ok !== true) throw new Error(`/healthz answered ${JSON.stringify(health)}`);
    process.stdout.write(`smoke: psyched healthy at ${origin}/healthz with only PSYCHE_HOME set\n`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

async function main(argv) {
  const opt = (n) => {
    const i = argv.indexOf(n);
    return i === -1 ? undefined : argv[i + 1];
  };
  const arch = opt("--arch") ?? (hostArch() === "arm64" ? "arm64" : "x64");
  if (platform() !== "darwin")
    throw new Error("build-psyched.mjs builds the macOS bundle; run it on a Mac");
  if (arch !== (hostArch() === "arm64" ? "arm64" : "x64")) {
    throw new Error(
      `--arch ${arch} needs a ${arch} host: native addons are installed for the host`,
    );
  }
  const out = resolve(opt("--out") ?? join(ROOT, "apps/gateway/dist-bin", `darwin-${arch}`));
  const bundle = join(out, "psyched");
  const app = join(bundle, "app");
  const version = pinnedNodeVersion();
  rmSync(bundle, { recursive: true, force: true });
  mkdirSync(join(bundle, "runtime"), { recursive: true });

  // 1. The tracked tree (committed state of this checkout, like `git archive`).
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  mkdirSync(app, { recursive: true });
  for (const f of files) {
    const src = join(ROOT, f);
    if (!existsSync(src)) continue;
    mkdirSync(join(app, f, ".."), { recursive: true });
    cpSync(src, join(app, f));
  }

  // 2. Production dependencies of the Gateway and the CLI, for this host.
  run(
    "pnpm",
    [
      "install",
      "--frozen-lockfile",
      "--prod",
      "--prefer-offline",
      "--filter",
      "@psyche/gateway...",
      "--filter",
      "@psyche/cli...",
    ],
    {
      cwd: app,
      env: {
        ...process.env,
        CI: "1",
        ELECTRON_SKIP_BINARY_DOWNLOAD: "1",
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
      },
    },
  );

  // 3. The web client the Gateway serves at /.
  if (!argv.includes("--skip-web-build"))
    run("pnpm", ["--filter", "@psyche/web", "build"], { cwd: ROOT });
  const web = join(ROOT, "apps/web/dist");
  if (!existsSync(join(web, "index.html")))
    throw new Error("apps/web/dist is missing; build the web client");
  cpSync(web, join(app, "apps/web/dist"), { recursive: true });

  // 4. Drop what the runtime never reads.
  for (const p of PRUNE) rmSync(join(app, p), { recursive: true, force: true });
  rmSync(join(app, "node_modules/.cache"), { recursive: true, force: true });

  const pruned = pruneForeignPrebuilds(app, arch);
  process.stdout.write(`pruned ${pruned} prebuilt addon(s) for other platforms\n`);
  const bad = checkAddons(app, arch);
  if (bad.length) throw new Error(`native addons for the wrong architecture:\n${bad.join("\n")}`);

  // 5. Runtime, launchers, plist template, build info.
  const rt = await nodeRuntime(version, arch);
  try {
    cpSync(rt.node, join(bundle, "runtime/node"));
  } finally {
    rt.cleanup();
  }
  chmodSync(join(bundle, "runtime/node"), 0o755);
  writeFileSync(join(bundle, "psyched"), PSYCHED_LAUNCHER, { mode: 0o755 });
  writeFileSync(join(bundle, "psyche"), PSYCHE_LAUNCHER, { mode: 0o755 });
  const { renderLaunchAgentPlist } = await import(join(ROOT, "apps/cli/src/supervisor.ts"));
  writeFileSync(
    join(bundle, "com.psyche.gateway.plist.template"),
    renderLaunchAgentPlist({ program: "{{PSYCHED}}", psycheHome: "{{PSYCHE_HOME}}" }),
  );
  let bytes = 0;
  walk(bundle, (_p, st) => {
    bytes += st.size;
  });
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  const pkg = JSON.parse(readFileSync(join(ROOT, "apps/gateway/package.json"), "utf8"));
  writeFileSync(
    join(bundle, "build-info.json"),
    `${JSON.stringify({ version: process.env.PSYCHE_VERSION ?? pkg.version, commit, node: version, arch, builtAt: new Date().toISOString(), bytes }, null, 2)}\n`,
  );
  process.stdout.write(
    `built ${bundle} (${(bytes / 1e6).toFixed(0)} MB, Node ${version}, darwin-${arch})\n`,
  );

  if (argv.includes("--smoke")) await smoke(bundle);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`build-psyched: ${err.message}\n`);
    process.exit(1);
  });
}
