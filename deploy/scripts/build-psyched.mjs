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
// script checks every .node file's architecture and refuses a mismatch. The build fails when the
// bundled skills folder (app/skills) is missing or a skill has no SKILL.md (#506). --smoke starts
// the built psyched with only PSYCHE_HOME set, waits for /healthz, then loads and lists the shipped
// skills with the bundle's runtime.
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
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { builtinModules } from "node:module";
import { homedir, arch as hostArch, platform, tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

/** The workspace packages psyched and the CLI start from; their workspace closure ships. */
const ENTRY_WORKSPACES = ["apps/gateway", "apps/cli"];

/**
 * Workspace packages the Gateway uses only a server-side corner of. Just these sources ship, and
 * only these dependencies are followed: `@psyche/viewers` would otherwise install the whole viewer
 * UI (Univer, Sandpack, CodeMirror, React, …), about 600 MB that psyched never loads
 * (reports/v1-bundle-size.md).
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

/** Dependency names in a node_modules dir (scoped ones as `@scope/name`), skipping dot entries. */
function depNames(nm) {
  if (!existsSync(nm)) return [];
  const names = [];
  for (const e of readdirSync(nm)) {
    if (e.startsWith(".")) continue;
    if (e.startsWith("@")) for (const sub of readdirSync(join(nm, e))) names.push(`${e}/${sub}`);
    else names.push(e);
  }
  return names;
}

/** Removes symlinks that point nowhere (left by dropped packages), recursing into scopes. */
function removeDanglingLinks(dir) {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = lstatSync(p, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isSymbolicLink()) {
      if (!existsSync(p)) unlinkSync(p);
    } else if (st.isDirectory() && (e.startsWith("@") || e === ".bin")) {
      removeDanglingLinks(p);
      if (readdirSync(p).length === 0) rmdirSync(p);
    }
  }
}

/** Every link in the tree that points nowhere, wherever it is; returns how many were removed. */
function removeAllDanglingLinks(dir) {
  let n = 0;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = lstatSync(p, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isSymbolicLink()) {
      if (!existsSync(p)) {
        unlinkSync(p);
        n++;
      }
    } else if (st.isDirectory()) n += removeAllDanglingLinks(p);
  }
  return n;
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

  // Mark every .pnpm entry reachable through the symlink graph.
  // Real path: symlinks resolve to it (macOS's /var is /private/var).
  const pnpm = realpathSync(join(appDir, "node_modules", ".pnpm"));
  const keep = new Set();
  const queue = [];
  const follow = (nm, self) => {
    for (const dep of depNames(nm)) {
      if (dep === self || drop.includes(dep)) continue;
      let real;
      try {
        real = realpathSync(join(nm, dep));
      } catch {
        continue;
      }
      const rel = relative(pnpm, real);
      if (rel.startsWith("..")) continue; // a workspace package
      const id = rel.split(sep)[0];
      if (keep.has(id)) continue;
      keep.add(id);
      queue.push([join(pnpm, id, "node_modules"), dep]);
    }
  };
  for (const [, pkg] of closure) follow(join(appDir, pkg.dir, "node_modules"), null);
  while (queue.length) follow(...queue.pop());
  for (const id of readdirSync(pnpm)) {
    if (id === "node_modules" || id.startsWith(".") || keep.has(id)) continue;
    if (!lstatSync(join(pnpm, id)).isDirectory()) continue;
    rmSync(join(pnpm, id), { recursive: true, force: true });
    stats.packages++;
  }
  for (const id of keep) removeDanglingLinks(join(pnpm, id, "node_modules"));
  removeDanglingLinks(join(pnpm, "node_modules"));
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
 * Loads the shipped skills with the bundle's own runtime and `@psyche/skills`, the way the
 * Gateway does, and prints each with its status. Tool gating is left open here (the smoke has no
 * agent); a skill that is invalid, blocked or fails its hash fails the smoke.
 */
function smokeSkills(bundle, home) {
  const app = join(bundle, "app");
  const script = `
    const { createSkillLoader } = await import(${JSON.stringify(pathToFileURL(join(app, "packages/skills/src/index.ts")).href)});
    const loader = createSkillLoader({ homeDir: ${JSON.stringify(join(home, "skills"))}, bundledDir: ${JSON.stringify(join(app, "skills"))} });
    const skills = (await loader.listDetailed()).filter((s) => s.source === "bundled");
    process.stdout.write(JSON.stringify(skills.map((s) => ({ name: s.name, status: s.status, reasons: s.reasons }))));
  `;
  const out = execFileSync(
    join(bundle, "runtime/node"),
    ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script],
    { cwd: app, encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: home } },
  );
  const skills = JSON.parse(out);
  const shipped = checkShippedSkills(app);
  const bad = skills.filter((s) => ["invalid", "blocked", "hash_mismatch"].includes(s.status));
  for (const s of skills)
    process.stdout.write(
      `smoke: skill ${s.name}: ${s.status}${s.reasons.length ? ` (${s.reasons.join("; ")})` : ""}\n`,
    );
  if (skills.length !== shipped.length)
    throw new Error(`the bundle loads ${skills.length} of ${shipped.length} shipped skills`);
  if (bad.length)
    throw new Error(`bundled skills that do not load: ${bad.map((s) => s.name).join(", ")}`);
  process.stdout.write(`smoke: ${skills.length} bundled skills load\n`);
}

export const PSYCHED_LAUNCHER = `#!/bin/sh
# Psyche Gateway (psyched) from Psyche.app. Needs only PSYCHE_HOME; no Node, PATH or checkout.
# A 4 MB young generation keeps an idle Gateway near 200 MB instead of ≈ 330 MB.
${RESOLVE_HERE}
${COMPILE_CACHE}
exec "$here/runtime/node" --max-semi-space-size=4 --disable-warning=ExperimentalWarning "$here/app/apps/gateway/src/main.ts" "$@"
`;

export const PSYCHE_LAUNCHER = `#!/bin/sh
# The psyche CLI from Psyche.app, on the same runtime as psyched.
${RESOLVE_HERE}
${COMPILE_CACHE}
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
    smokeSkills(bundle, home);
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

  if (argv.includes("--smoke")) await smoke(bundle);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`build-psyched: ${err.message}\n`);
    process.exit(1);
  });
}
