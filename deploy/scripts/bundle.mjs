// Bundles psyched and the psyche CLI into single ESM files with esbuild (deploy/Dockerfile).
// Usage: node bundle.mjs <repo-root> <out-dir> <version>
// Native modules stay external; the Dockerfile installs them for the target platform.
import { build } from "esbuild";

const [root, out, version = "0.0.0-dev"] = process.argv.slice(2);
if (!root || !out) {
  console.error("usage: node bundle.mjs <repo-root> <out-dir> [version]");
  process.exit(2);
}

const common = {
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  legalComments: "none",
  // CommonJS dependencies (ws, better-sqlite3's loader) call require().
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  define: { __PSYCHE_VERSION__: JSON.stringify(version) },
  logLevel: "info",
};

await build({
  ...common,
  entryPoints: [`${root}/apps/gateway/src/main.ts`],
  outfile: `${out}/bin/psyched.mjs`,
  external: ["better-sqlite3", "better-sqlite3-multiple-ciphers", "bufferutil", "utf-8-validate"],
});
await build({
  ...common,
  entryPoints: [`${root}/apps/cli/src/main.ts`],
  outfile: `${out}/bin/psyche.mjs`,
});
