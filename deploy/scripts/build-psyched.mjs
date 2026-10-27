// Builds the self-contained Gateway bundle for Psyche.app (docs/archive/status/s22.md "Packaging layout").
//
//   node deploy/scripts/build-psyched.mjs [--arch arm64|x64] [--out <dir>] [--skip-web-build] [--smoke]
//   node deploy/scripts/build-psyched.mjs --smoke-only [--out <dir>]     smoke an already built bundle
//
// Output: apps/gateway/dist-bin/darwin-<arch>/psyched/
//   psyched, psyche            /bin/sh launchers (no PATH needed): runtime/node + app/apps/*/dist/main.mjs
//   runtime/node               the official Node build of the version deploy/scripts/node-pins.mjs pins,
//                              SHA-256 checked against nodejs.org's SHASUMS256.txt
//   app/                       the Gateway and the CLI bundled by esbuild (apps/gateway/dist/main.mjs,
//                              extract-worker.mjs, apps/cli/dist/main.mjs; bundle-gateway.mjs), the
//                              files that sit next to the code (migrations, templates, skills, the
//                              web client; found through @psyche/assets) and node_modules with only
//                              the packages that cannot be bundled (native addons, pdf.js, playwright)
//   com.psyche.gateway.plist.template   LaunchAgent with {{PSYCHED}} and {{PSYCHE_HOME}}
//   build-info.json            {version, commit, node, arch, builtAt, bytes}
//
// The bundle's size is held to deploy/size-budget.json (psychedMB); the build fails above it.
//
// Native addons (better-sqlite3, node-pty, sqlite-vec, …) are installed for the host by pnpm, so
// build each arch on a host of that arch (the release workflow uses an Intel runner for x64); the
// script checks every .node file's architecture and refuses a mismatch. The build fails when the
// bundled skills folder (app/skills) is missing or a skill has no SKILL.md (#506). --smoke starts
// the built psyched with only PSYCHE_HOME set and waits for /healthz, runs `psyched --bundle-check`
// (migrations on a fresh database, templates, skills, the web client, a PDF through the extraction
// worker) and loads the external packages, all with the bundle's own runtime.
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
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { builtinModules } from "node:module";
import { homedir, arch as hostArch, platform, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleGateway, discardSources } from "./bundle-gateway.mjs";
import { findPins } from "./node-pins.mjs";
import {
  depNames,
  prunePnpmStore,
  removeAllDanglingLinks,
  removeDanglingLinks,
} from "./pnpm-store.mjs";
import { prunePackageWaste } from "./prune-package-waste.mjs";
import { checkBudget, treeSize } from "./size-budget.mjs";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");

/** Dirs of the exported tree the runtime never reads (the Dockerfile's deps stage drops the same). */
const PRUNE = [
  "apps/desktop",
  "apps/mac-helper",
  "apps/web/src",
  "apps/web/testing",
  "apps/site",
  "docs",
  "tests",
  ".changeset",
  ".github",
  "deploy/homebrew",
  "deploy/macos",
  "deploy/scripts",
];

/** The workspace packages psyched and the CLI start from; their workspace closure ships. */
const ENTRY_WORKSPACES = ["apps/gateway", "apps/cli"];

/**
 * Workspace packages the Gateway uses only a server-side corner of. Just these sources ship, and
 * only these dependencies are followed: `@psyche/viewers` would otherwise install the whole viewer
 * UI (Univer, Sandpack, CodeMirror, React, …), about 600 MB that psyched never loads
 * (docs/archive/reports/v1-bundle-size.md).
 */
export const SERVER_SUBSETS = {
  "@psyche/viewers": {
    deps: ["@psyche/protocol"],
    src: ["src/core/convert.ts", "src/core/detect.ts", "src/core/registry.ts"],
  },
};

/** Optional dependencies psyched never needs: pdf.js only extracts text on the server, never renders. */
export const DROP_PACKAGES = ["@napi-rs/canvas"];

/** Files in node_modules the runtime never reads. */
const DEAD_FILE = /\.(map|d\.ts|d\.mts|d\.cts)$/;

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

const PLATFORM_DIRS = new Set(["darwin", "linux", "win32", "android", "freebsd", "openbsd"]);

/**
 * Packages ship prebuilt addons for every platform (`prebuilds/linux-x64.node`, …). Keep only
 * this bundle's `darwin-<arch>`: the rest is dead weight that would also have to be signed.
 * onnxruntime-node (on-device search embeddings) lays them out as `bin/napi-v6/<platform>/<arch>/`
 * (~300 MB for all of them): only `darwin/<arch>` stays.
 */
export function pruneForeignPrebuilds(appDir, arch) {
  let removed = 0;
  walk(
    appDir,
    () => {},
    (p, name) => {
      if (/^napi-v\d+$/.test(name)) {
        for (const platformDir of readdirSync(p)) {
          if (!PLATFORM_DIRS.has(platformDir)) continue;
          if (platformDir !== "darwin") {
            rmSync(join(p, platformDir), { recursive: true, force: true });
            removed++;
            continue;
          }
          for (const a of readdirSync(join(p, platformDir))) {
            if (a !== arch) {
              rmSync(join(p, platformDir, a), { recursive: true, force: true });
              removed++;
            }
          }
        }
        return true;
      }
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

/** `name` → `{ dir, deps }` for every workspace package in the exported tree. */
function workspacePackages(appDir) {
  const out = new Map();
  for (const group of ["apps", "packages"]) {
    if (!existsSync(join(appDir, group))) continue;
    for (const name of readdirSync(join(appDir, group))) {
      const file = join(appDir, group, name, "package.json");
      if (!existsSync(file)) continue;
      const pkg = JSON.parse(readFileSync(file, "utf8"));
      out.set(pkg.name, { dir: `${group}/${name}`, deps: Object.keys(pkg.dependencies ?? {}) });
    }
  }
  return out;
}

/** The workspace packages reachable from the entry points, with `SERVER_SUBSETS` applied. */
export function workspaceClosure(appDir, subsets = SERVER_SUBSETS) {
  const all = workspacePackages(appDir);
  const byDir = new Map([...all].map(([name, p]) => [p.dir, name]));
  const closure = new Map();
  const queue = ENTRY_WORKSPACES.map((d) => byDir.get(d)).filter(Boolean);
  while (queue.length) {
    const name = queue.shift();
    if (closure.has(name)) continue;
    const pkg = all.get(name);
    const subset = subsets[name];
    const deps = subset ? pkg.deps.filter((d) => subset.deps.includes(d)) : pkg.deps;
    closure.set(name, { dir: pkg.dir, deps, subset });
    for (const d of deps) if (all.has(d)) queue.push(d);
  }
  return { all, closure };
}

/**
 * Cuts the installed tree down to what psyched and the CLI can load:
 * - workspace packages outside the closure (apps/node, packages/ui, packages/testing, …) go;
 * - `SERVER_SUBSETS` keep only their listed sources and dependencies;
 * - `.pnpm` entries not reachable from the closure's dependencies (pnpm's symlink graph) go;
 * - `DROP_PACKAGES`, sourcemaps and type declarations in node_modules go.
 * pnpm installs per workspace package, so `--filter` alone keeps every dependency of a package
 * even when the Gateway imports one file of it.
 */
export function pruneToServerSubset(
  appDir,
  { subsets = SERVER_SUBSETS, drop = DROP_PACKAGES } = {},
) {
  const { all, closure } = workspaceClosure(appDir, subsets);
  const stats = { workspaces: 0, packages: 0, files: 0 };
  for (const [name, pkg] of all) {
    // The web client ships as its built dist only (served at /).
    if (name === "@psyche/web") {
      rmSync(join(appDir, pkg.dir, "node_modules"), { recursive: true, force: true });
      continue;
    }
    if (closure.has(name)) continue;
    rmSync(join(appDir, pkg.dir), { recursive: true, force: true });
    stats.workspaces++;
  }
  for (const [, pkg] of closure) {
    if (!pkg.subset) continue;
    const keep = new Set(pkg.subset.src.map((f) => join(appDir, pkg.dir, f)));
    walk(join(appDir, pkg.dir, "src"), (p) => {
      if (!keep.has(p)) rmSync(p);
    });
    const nm = join(appDir, pkg.dir, "node_modules");
    for (const dep of depNames(nm)) {
      if (!pkg.deps.includes(dep)) rmSync(join(nm, dep), { recursive: true, force: true });
    }
  }

  stats.packages = prunePnpmStore(
    appDir,
    [...closure].map(([, pkg]) => join(appDir, pkg.dir, "node_modules")),
    drop,
  );
  removeDanglingLinks(join(appDir, "node_modules"));
  for (const [, pkg] of closure) removeDanglingLinks(join(appDir, pkg.dir, "node_modules"));

  walk(join(appDir, "node_modules"), (p) => {
    if (DEAD_FILE.test(p)) {
      rmSync(p);
      stats.files++;
    }
  });
  // codesign cannot seal a link to nothing ("No such file or directory" for the whole app).
  stats.links = removeAllDanglingLinks(appDir);
  return stats;
}

const IMPORT_RE =
  /(?:^|[\s;}])(?:import|export)\s+(?!type\s)(?:[^'"`;]*?\sfrom\s*)?["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;

/**
 * Every bare import in the shipped workspace sources must resolve: pnpm links a package's direct
 * dependencies into its own node_modules, so that is where each one has to be after pruning.
 * Lazy `import()`s count too; they are what a boot smoke would miss.
 */
export function checkImports(appDir, subsets = SERVER_SUBSETS) {
  const { closure } = workspaceClosure(appDir, subsets);
  const builtins = new Set(builtinModules);
  const missing = [];
  for (const [name, pkg] of closure) {
    const root = join(appDir, pkg.dir);
    if (!existsSync(join(root, "src"))) continue;
    walk(
      join(root, "src"),
      (p) => {
        if (!/\.(m?ts|m?js)$/.test(p) || /\.test\.|\.spec\.|\.d\.m?ts$/.test(p)) return;
        const text = readFileSync(p, "utf8");
        for (const m of text.matchAll(IMPORT_RE)) {
          const spec = m[1] ?? m[2];
          if (/^[./#]/.test(spec) || spec.startsWith("node:") || builtins.has(spec)) continue;
          const parts = spec.split("/");
          const dep = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
          if (dep === name || existsSync(join(root, "node_modules", dep))) continue;
          missing.push(`${relative(appDir, p)}: ${spec}`);
        }
      },
      // Test suites other packages' tests import (`@psyche/browser/conformance` needs vitest).
      (_p, dir) => !["test", "__tests__", "conformance"].includes(dir),
    );
  }
  return missing;
}

/** Strips local symbols from the Node runtime (≈ 24 MB) and signs it ad-hoc again so it runs. */
function stripRuntime(node) {
  run("strip", ["-x", node]);
  run("codesign", ["--force", "--sign", "-", node]);
}

// Node's compile cache (V8 code and stripped TypeScript) saves ≈ 150 ms of every start. It lives
// in the per-user cache, outside the signed bundle, and only when HOME is known (launchd sets it).
const COMPILE_CACHE = `if [ -z "\${NODE_COMPILE_CACHE:-}" ] && [ -n "\${HOME:-}" ]; then
  NODE_COMPILE_CACHE="$HOME/Library/Caches/com.psyche.gateway/node-compile-cache"
  export NODE_COMPILE_CACHE
fi`;

// Both launchers find the bundle through any symlinks to them (`/usr/local/bin/psyche`).
const RESOLVE_HERE = `self=$0
case $self in */*) ;; *) self=./$self ;; esac
while [ -L "$self" ]; do
  link=$(readlink "$self")
  case $link in /*) self=$link ;; *) self=\${self%/*}/$link ;; esac
done
here=\${self%/*}`;

/**
 * The bundled skills the Gateway loads from `app/skills` (issue #506). The Gateway resolves the
 * folder four levels up from `apps/gateway/src/compose/skills.ts`; this checks that the folder is
 * there, that the path still lands on it, and that every skill folder has a `SKILL.md` naming
 * itself. Returns the skill names; throws so a bundle without skills never ships.
 */
export function checkShippedSkills(appDir) {
  const dir = join(appDir, "skills");
  const resolved = resolve(appDir, "apps/gateway/src/compose", "../../../../skills");
  if (resolved !== dir)
    throw new Error(`the Gateway would look for skills at ${resolved}, not ${dir}`);
  if (!existsSync(dir)) throw new Error(`bundled skills folder missing: ${dir}`);
  const names = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const md = join(dir, entry.name, "SKILL.md");
    if (!existsSync(md)) throw new Error(`bundled skill ${entry.name} has no SKILL.md`);
    const name = /^name:\s*(\S+)\s*$/m.exec(readFileSync(md, "utf8"))?.[1];
    if (name !== entry.name)
      throw new Error(`bundled skill ${entry.name}: SKILL.md names "${name ?? ""}"`);
    names.push(entry.name);
  }
  if (names.length === 0) throw new Error(`no bundled skills in ${dir}`);
  return names.sort();
}

/**
 * Runs `psyched --bundle-check` (apps/gateway/src/bundle-check.ts) with the bundle's own runtime and a
 * fresh home: migrations on a new database, the templates, the skills (all of those shipped must
 * load), the web client, the sandbox image context, the MCP bridge, and a PDF through the
 * extraction worker, each found through @psyche/assets from where the bundle sits.
 */
function smokeBundle(bundle, home) {
  const app = join(bundle, "app");
  const out = execFileSync(join(bundle, "psyched"), ["--bundle-check"], {
    encoding: "utf8",
    env: { PSYCHE_HOME: home },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const check = JSON.parse(out.trim().split("\n").pop());
  const shipped = checkShippedSkills(app);
  if (check.skills !== shipped.length)
    throw new Error(`the bundle loads ${check.skills} of ${shipped.length} shipped skills`);
  if (check.root !== realpathSync(app))
    throw new Error(`the bundle looks for its assets in ${check.root}, not ${app}`);
  process.stdout.write(
    `smoke: bundle check ok: ${check.migrations} migrations on a fresh database, ${check.templates} templates, ${check.skills} bundled skills, a PDF through the extraction worker\n`,
  );
}

/**
 * Loads each native addon and the libraries pruned the hardest with the bundle's own runtime, from
 * the workspace package that depends on them: a file `prune-package-waste.mjs` took that the
 * runtime needs fails here, not on the owner's Mac. The Gateway boot does not reach all of them
 * (the vault, the browser and PDF extraction are lazy).
 */
function smokeNative(bundle, home) {
  const app = join(bundle, "app");
  const script = `
    import { createRequire } from "node:module";
    const need = createRequire(${JSON.stringify(`${app}/apps/gateway/dist/main.mjs`)});
    const Sqlite = need("better-sqlite3");
    const db = new Sqlite(":memory:");
    need("sqlite-vec").load(db);
    const Cipher = need("better-sqlite3-multiple-ciphers");
    const vault = new Cipher(${JSON.stringify(join(home, "native-check.db"))});
    vault.pragma("cipher='sqlcipher'");
    vault.pragma("key='smoke'");
    vault.prepare("create table t (a)").run();
    if (typeof need("playwright-core").chromium.launch !== "function") throw new Error("playwright-core");
    if (typeof need("onnxruntime-node").InferenceSession !== "function") throw new Error("onnxruntime-node");
    process.stdout.write(JSON.stringify({ sqlite: db.prepare("select sqlite_version() v").get().v, vec: db.prepare("select vec_version() v").get().v }));
  `;
  const out = execFileSync(
    join(bundle, "runtime/node"),
    ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script],
    {
      cwd: app,
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", HOME: home },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  const v = JSON.parse(out);
  process.stdout.write(
    `smoke: external packages load (sqlite ${v.sqlite}, sqlite-vec ${v.vec}, sqlcipher, playwright-core, onnxruntime)\n`,
  );
}

export const PSYCHED_LAUNCHER = `#!/bin/sh
# Psyche Gateway (psyched) from Psyche.app. Needs only PSYCHE_HOME; no Node, PATH or checkout.
# A 4 MB young generation keeps an idle Gateway near 200 MB instead of ≈ 330 MB.
${RESOLVE_HERE}
${COMPILE_CACHE}
exec "$here/runtime/node" --max-semi-space-size=4 --disable-warning=ExperimentalWarning "$here/app/apps/gateway/dist/main.mjs" "$@"
`;

export const PSYCHE_LAUNCHER = `#!/bin/sh
# The psyche CLI from Psyche.app, on the same runtime as psyched.
${RESOLVE_HERE}
${COMPILE_CACHE}
exec "$here/runtime/node" --disable-warning=ExperimentalWarning "$here/app/apps/cli/dist/main.mjs" "$@"
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
    smokeBundle(bundle, home);
    smokeNative(bundle, home);
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
  if (argv.includes("--smoke-only")) return smoke(bundle);
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
  // Sourcemaps stay in apps/web/dist for debugging; the shipped copy drops them (≈ 60 MB).
  walk(join(app, "apps/web/dist"), (p) => {
    if (p.endsWith(".map")) rmSync(p);
  });

  // 4. Drop what the runtime never reads.
  for (const p of PRUNE) rmSync(join(app, p), { recursive: true, force: true });
  rmSync(join(app, "node_modules/.cache"), { recursive: true, force: true });
  const cut = pruneToServerSubset(app);
  process.stdout.write(
    `pruned ${cut.workspaces} workspace package(s), ${cut.packages} unreachable package(s), ${cut.files} map/declaration file(s), ${cut.links} dangling link(s)\n`,
  );
  const shippedSkills = checkShippedSkills(app);
  process.stdout.write(`bundled skills: ${shippedSkills.join(", ")}\n`);
  const missing = checkImports(app);
  if (missing.length) throw new Error(`imports that no longer resolve:\n${missing.join("\n")}`);

  const bundles = await bundleGateway(app, { root: ROOT });
  const dropped = discardSources(app);
  const sizes = Object.entries(bundles)
    .map(([f, n]) => `${f} ${(n / 1e6).toFixed(1)} MB`)
    .join(", ");
  process.stdout.write(
    `bundled with esbuild: ${sizes}; sources dropped, ${dropped.external.length} external package(s) kept (${dropped.external.join(", ")}), ${dropped.packages} more pnpm entries removed\n`,
  );

  const pruned = pruneForeignPrebuilds(app, arch);
  process.stdout.write(`pruned ${pruned} prebuilt addon(s) for other platforms\n`);
  const waste = prunePackageWaste(app);
  process.stdout.write(
    `pruned ${(waste.installed / 1e6).toFixed(0)} MB of docs/tests/sources from ${waste.packages} package(s), ${(waste.workspaces / 1e6).toFixed(1)} MB of workspace tests, ${(waste.dupes / 1e6).toFixed(0)} MB of duplicate libraries\n`,
  );
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
  stripRuntime(join(bundle, "runtime/node"));
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
  process.stdout.write(`${checkBudget("psychedMB", treeSize(bundle))}\n`);

  if (argv.includes("--smoke")) await smoke(bundle);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`build-psyched: ${err.message}\n`);
    process.exit(1);
  });
}
