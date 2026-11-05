// Bundles apps/node into one ESM file for the Windows guest image (Node 24 runs it directly;
// there is no node_modules in the guest). Usage: node bundle-node.mjs <outfile>
import { build } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const out = resolve(process.argv[2] ?? "deploy/windows/guest-image/out/work/psyche-node.mjs");
const result = await build({
  entryPoints: [resolve(root, "apps/node/src/main.ts")],
  outfile: out,
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  banner: {
    js: "import { createRequire as __psycheCreateRequire } from 'node:module';\nconst require = __psycheCreateRequire(import.meta.url);",
  },
  logLevel: "warning",
  metafile: true,
  legalComments: "none",
  // Browser automation is not part of the guest image (no Chromium); the dynamic import fails soft.
  external: ["playwright-core", "playwright", "chromium-bidi", "electron"],
});
const bytes = Object.values(result.metafile.outputs)[0].bytes;
console.log(`bundled apps/node -> ${out} (${bytes} bytes)`);
