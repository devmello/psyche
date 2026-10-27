// Drops what the Gateway bundle's dependencies carry but never load (app size, phase 1: docs/design/app-size-2026.md).
//
// build-psyched.mjs runs `prunePackageWaste(appDir)` after `pruneToServerSubset`. Everything here is
// "no behaviour change": native-module sources and build leftovers, docs, tests, examples and the
// builds of a package the Gateway does not import (pdfjs-dist's browser build and viewer, playwright's
// trace viewer). A file the runtime needs would surface in the bundle smoke (build-psyched.mjs --smoke).
import {
  lstatSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";

/** Directories at the top of an installed package that never carry runtime code. */
const DEAD_DIRS = new Set([
  "test",
  "tests",
  "__tests__",
  "spec",
  "docs",
  "doc",
  "example",
  "examples",
  "demo",
  "benchmark",
  "benchmarks",
  "coverage",
  "man",
  ".github",
  ".yarn",
  ".vscode",
]);

/** Dot-files and configs at the top of a package that only matter to its own development. */
const DEAD_FILE =
  /^(\.[a-z]+rc(\.(json|js|cjs|ya?ml))?|\.(npmignore|gitignore|gitattributes|gitmodules|editorconfig|nvmrc|travis\.yml|prettierignore|eslintignore)|tsconfig[\w.-]*\.json|yarn\.lock|\.mocharc\.json)$/;

/** Markdown anywhere in a package: docs, changelogs, READMEs. Licences stay (they are legally required). */
const DEAD_MARKDOWN = /\.(md|markdown)$/i;
const KEEP_LEGAL = /^(licen[cs]e|notice|copying|patents|third[-_ ]?party)/i;

/** Sourcemaps, declaration files and TypeScript build info. */
const DEAD_ANYWHERE = /\.(map|d\.ts|d\.mts|d\.cts|tsbuildinfo)$/;

/**
 * Per package: top-level paths (relative to the package root) that the Gateway never loads.
 * - better-sqlite3 and its fork ship the SQLite amalgamation (`deps/`), the addon sources and
 *   node-gyp leftovers next to the prebuilt `prebuilds/darwin-<arch>.node`.
 * - pdfjs-dist: Node imports `legacy/build/pdf.mjs` plus the font and cMap data and wasm decoders;
 *   the browser `build/`, the `web/` viewer, `image_decoders/` and the minified copies are for pages.
 * - playwright-core: `lib/vite` is the trace viewer, recorder, dashboard and HTML report UIs.
 */
export const PACKAGE_WASTE = {
  "better-sqlite3": ["deps", "src", "build", "binding.gyp"],
  "better-sqlite3-multiple-ciphers": ["deps", "src", "build", "binding.gyp"],
  "pdfjs-dist": [
    "build",
    "web",
    "image_decoders",
    "types",
    "legacy/web",
    "legacy/image_decoders",
    "legacy/build/pdf.min.mjs",
    "legacy/build/pdf.worker.min.mjs",
    "legacy/build/pdf.sandbox.mjs",
    "legacy/build/pdf.sandbox.min.mjs",
  ],
  "playwright-core": ["lib/vite"],
};

/** Workspace folders (`apps/*`, `packages/*`) hold sources only: tests and configs never run. */
const WORKSPACE_DEAD_DIRS = new Set(["test", "tests", "__tests__", "docs", "testing"]);
const WORKSPACE_DEAD_FILE =
  /(\.test\.m?[jt]sx?|\.spec\.m?[jt]sx?|^vitest\.config\.\w+|^CHANGELOG\.md)$/;

function entries(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Real (non-symlink) package roots of the pnpm store: `.pnpm/<id>/node_modules/<name | @scope/name>`. */
export function installedPackages(appDir) {
  const out = [];
  const store = join(appDir, "node_modules", ".pnpm");
  for (const id of entries(store)) {
    const nm = join(store, id, "node_modules");
    for (const e of entries(nm)) {
      const names = e.startsWith("@") ? entries(join(nm, e)).map((s) => `${e}/${s}`) : [e];
      for (const name of names) {
        const dir = join(nm, name);
        const st = lstatSync(dir, { throwIfNoEntry: false });
        if (st?.isDirectory() && !st.isSymbolicLink()) out.push({ name, dir });
      }
    }
  }
  return out;
}

/** Removes `p` if present; returns the bytes it held (0 when absent). */
function drop(p) {
  const st = lstatSync(p, { throwIfNoEntry: false });
  if (!st) return 0;
  const bytes = st.isDirectory() ? treeBytes(p) : st.size;
  rmSync(p, { recursive: true, force: true });
  return bytes;
}

export function treeBytes(dir) {
  let n = 0;
  for (const e of entries(dir)) {
    const p = join(dir, e);
    const st = lstatSync(p, { throwIfNoEntry: false });
    if (!st || st.isSymbolicLink()) continue;
    n += st.isDirectory() ? treeBytes(p) : st.size;
  }
  return n;
}

function pruneTree(dir, { top, dead }) {
  let bytes = 0;
  for (const e of entries(dir)) {
    const p = join(dir, e);
    const st = lstatSync(p, { throwIfNoEntry: false });
    if (!st || st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      if (top && DEAD_DIRS.has(e)) bytes += drop(p);
      else bytes += pruneTree(p, { top: false, dead });
    } else if (dead(e, top)) bytes += drop(p);
  }
  return bytes;
}

/**
 * Cuts documentation, tests, sourcemaps and the per-package waste of `PACKAGE_WASTE` out of every
 * installed dependency; returns `{ bytes, packages }` removed.
 */
export function pruneInstalledPackages(appDir, waste = PACKAGE_WASTE) {
  let bytes = 0;
  const packages = installedPackages(appDir);
  for (const { name, dir } of packages) {
    for (const rel of waste[name] ?? []) bytes += drop(join(dir, ...rel.split("/")));
    bytes += pruneTree(dir, {
      top: true,
      dead: (file, top) =>
        DEAD_ANYWHERE.test(file) ||
        (top && DEAD_FILE.test(file)) ||
        (DEAD_MARKDOWN.test(file) && !KEEP_LEGAL.test(file)),
    });
  }
  return { bytes, packages: packages.length };
}

/** Tests, configs and changelogs of the shipped workspace sources. */
export function pruneWorkspaceTests(appDir) {
  let bytes = 0;
  for (const group of ["apps", "packages"]) {
    for (const name of entries(join(appDir, group))) {
      const root = join(appDir, group, name);
      if (!lstatSync(root).isDirectory()) continue;
      for (const e of entries(root)) {
        if (WORKSPACE_DEAD_DIRS.has(e)) bytes += drop(join(root, e));
      }
      bytes += pruneTree(join(root, "src"), {
        top: false,
        dead: (file) => WORKSPACE_DEAD_FILE.test(file),
      });
      for (const e of entries(root)) {
        if (WORKSPACE_DEAD_FILE.test(e)) bytes += drop(join(root, e));
      }
    }
  }
  return bytes;
}

/**
 * onnxruntime-node ships `libonnxruntime.1.dylib` and `libonnxruntime.1.30.0.dylib` as two full
 * copies (44 MB each) where upstream has a symlink. Keeps the versioned file and links the other
 * name to it. Returns the bytes saved.
 */
export function dedupeSiblingCopies(appDir) {
  let saved = 0;
  for (const { name, dir } of installedPackages(appDir)) {
    if (name !== "onnxruntime-node") continue;
    const stack = [join(dir, "bin")];
    while (stack.length) {
      const d = stack.pop();
      const files = entries(d).filter((e) => /^libonnxruntime\.[\d.]+\.dylib$/.test(e));
      for (const e of entries(d)) {
        const st = lstatSync(join(d, e), { throwIfNoEntry: false });
        if (st?.isDirectory()) stack.push(join(d, e));
      }
      // The longest name carries the full version; shorter ones link to it when the bytes match.
      files.sort((a, b) => b.length - a.length);
      const [full, ...aliases] = files;
      for (const alias of aliases) {
        const a = join(d, alias);
        const f = join(d, full);
        const st = lstatSync(a);
        if (st.isSymbolicLink() || st.size !== statSync(f).size) continue;
        if (!readFileSync(a).equals(readFileSync(f))) continue;
        unlinkSync(a);
        symlinkSync(full, a);
        saved += st.size;
      }
    }
  }
  return saved;
}

/** Everything above, in order; returns the megabytes each step removed. */
export function prunePackageWaste(appDir) {
  const installed = pruneInstalledPackages(appDir);
  const workspaces = pruneWorkspaceTests(appDir);
  const dupes = dedupeSiblingCopies(appDir);
  return { installed: installed.bytes, workspaces, dupes, packages: installed.packages };
}
