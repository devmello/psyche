// Bundles the Gateway and the CLI of the exported tree with esbuild (docs/design/app-size-2026.md).
//
// build-psyched.mjs runs `bundleGateway(appDir)` on the pnpm-installed copy of the workspace, then
// `discardSources` and `linkExternals`, so Psyche.app carries four JS files and only the packages that
// cannot be bundled, instead of ~65 MB of node_modules and every workspace source:
//
//   apps/gateway/dist/main.mjs            psyched
//   apps/gateway/dist/extract-worker.mjs  the document-extraction worker thread (@psyche/files)
//   apps/cli/dist/main.mjs                the psyche CLI
//
// Files that live next to the code (migrations, templates, skills, the web client, …) stay at the
// same paths below the app dir; @psyche/assets finds them from the bundle's location.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, relative } from "node:path";
import { prunePnpmStore, removeAllDanglingLinks } from "./pnpm-store.mjs";

/** Output (relative to the app dir, no extension) → entry source. */
export const ENTRIES = {
  "apps/gateway/dist/main": "apps/gateway/src/main.ts",
  "apps/gateway/dist/extract-worker": "packages/files/src/extract/worker.ts",
  "apps/cli/dist/main": "apps/cli/src/main.ts",
};

/**
 * Packages that stay on disk: native addons, and libraries that read their own files at run time
 * (pdf.js fonts, cMaps and wasm; playwright's registry; the platform package of sqlite-vec). Optional
 * `ws` accelerators are absent and `ws` catches their absence.
 */
export const EXTERNAL = [
  "better-sqlite3",
  "better-sqlite3-multiple-ciphers",
  "sqlite-vec",
  "onnxruntime-node",
  "playwright-core",
  "pdfjs-dist",
  "@napi-rs/canvas",
  "bufferutil",
  "utf-8-validate",
];

/** What survives next to the bundles, relative to the app dir (whole folders unless a file). */
export const ASSET_PATHS = [
  "skills",
  "templates",
  "deploy/sandbox-image",
  "apps/web/dist",
  "packages/db/migrations",
  "packages/connectors/migrations",
  "packages/notifications/migrations",
  "packages/model-router/src/cli/mcp-stdio-bridge.mjs",
  "apps/gateway/dist",
  "apps/cli/dist",
];

/**
 * Each bundle announces where it is, so `assetsRoot()` (three directories up) and `entryUrl()` work;
 * `require`, `__dirname` and `__filename` are what CommonJS dependencies expect in an ES module.
 */
export const BANNER = [
  "globalThis.__PSYCHE_BUNDLE_URL__ = import.meta.url;",
  'import { createRequire as __psycheRequire } from "node:module";',
  'import { dirname as __psycheDirname } from "node:path";',
  'import { fileURLToPath as __psycheFileURL } from "node:url";',
  "const require = __psycheRequire(import.meta.url);",
  "const __filename = __psycheFileURL(import.meta.url);",
  "const __dirname = __psycheDirname(__filename);",
].join("\n");

/**
 * Runs esbuild (from the repository's own install) over the entries; returns `{ file: bytes }` for
 * every output, chunks included. Entries are built per output folder with code splitting, so a
 * dynamic `import()` (AI SDK providers, the MCP SDK) becomes a chunk next to its entry that is read
 * only when first used, instead of source text every Gateway keeps in memory
 * (docs/design/lightweight-2026.md). Chunks share their entry's folder, so the banner's bundle URL
 * gives the same assets root whichever file sets it.
 */
export async function bundleGateway(appDir, { root, entries = ENTRIES, external = EXTERNAL } = {}) {
  const { build } = createRequire(join(root, "package.json"))("esbuild");
  const byDir = new Map();
  for (const [out, src] of Object.entries(entries)) {
    const dir = dirname(out);
    byDir.set(dir, { ...byDir.get(dir), [basename(out)]: src });
  }
  const out = {};
  for (const [dir, entryPoints] of byDir) {
    const res = await build({
      absWorkingDir: appDir,
      entryPoints,
      outdir: dir,
      bundle: true,
      splitting: true,
      chunkNames: "chunk-[hash]",
      platform: "node",
      format: "esm",
      target: "node24",
      minify: true,
      legalComments: "none",
      banner: { js: BANNER },
      external,
      logLevel: "error",
      metafile: true,
      outExtension: { ".js": ".mjs" },
      write: true,
    });
    for (const [file, meta] of Object.entries(res.metafile.outputs)) out[file] = meta.bytes;
  }
  return out;
}

/** Deletes every file of `dir` that is neither on a keep path nor a folder leading to one. */
function keepOnly(dir, base, keep) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const rel = relative(base, p);
    if (keep.some((k) => rel === k || rel.startsWith(`${k}/`))) continue;
    if (lstatSync(p).isDirectory() && keep.some((k) => k.startsWith(`${rel}/`))) {
      keepOnly(p, base, keep);
      continue;
    }
    rmSync(p, { recursive: true, force: true });
  }
}

/**
 * The first install of each `external` package found under the workspace, as a path inside the pnpm
 * store (a workspace package links its direct dependencies there).
 */
function externalInstalls(appDir, external) {
  const found = new Map();
  for (const group of ["apps", "packages"]) {
    if (!existsSync(join(appDir, group))) continue;
    for (const ws of readdirSync(join(appDir, group))) {
      for (const name of external) {
        if (found.has(name)) continue;
        const link = join(appDir, group, ws, "node_modules", name);
        if (existsSync(link)) found.set(name, realpathSync(link));
      }
    }
  }
  return found;
}

/**
 * After bundling: drops the workspace sources (keeping `ASSET_PATHS`), links the external packages
 * into `<app>/node_modules` where Node finds them from the bundles, and deletes every pnpm store
 * entry they do not reach. Returns `{ external: names linked, packages: store entries removed }`.
 */
export function discardSources(appDir, { external = EXTERNAL, keep = ASSET_PATHS } = {}) {
  const installs = externalInstalls(appDir, external);
  const nm = join(realpathSync(appDir), "node_modules");
  for (const e of readdirSync(nm))
    if (e !== ".pnpm") rmSync(join(nm, e), { recursive: true, force: true });
  for (const [name, real] of installs) {
    const link = join(nm, name);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(relative(dirname(link), real), link);
  }
  const packages = prunePnpmStore(appDir, [nm]);
  for (const name of readdirSync(appDir)) {
    if (name === "node_modules") continue;
    const p = join(appDir, name);
    const rel = name;
    if (keep.some((k) => k === rel || k.startsWith(`${rel}/`))) {
      if (statSync(p).isDirectory() && !keep.includes(rel)) keepOnly(p, appDir, keep);
    } else rmSync(p, { recursive: true, force: true });
  }
  // The store's workspace links (`.pnpm/node_modules/@psyche/*`) point at the sources just deleted, and
  // codesign cannot seal a link to nothing.
  removeAllDanglingLinks(appDir);
  return { external: [...installs.keys()], packages };
}
