import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where the files that ship next to the code live: SQL migrations, `templates/`, `skills/`, the built
 * web client, the sandbox image context, the MCP stdio bridge. They sit at the same paths below one
 * root in the source tree and in the bundled Gateway (Psyche.app's `Resources/psyched/app`), so
 * `assetPath("packages/db/migrations")` is right in both and no module needs `import.meta.url` to
 * find a sibling file.
 *
 * The root is, in order:
 * 1. `PSYCHE_ASSETS_ROOT` (tests, unusual layouts);
 * 2. three directories above the esbuild bundle's entry file (`<root>/apps/gateway/dist/main.mjs`),
 *    which the bundle announces in `globalThis.__PSYCHE_BUNDLE_URL__` (deploy/scripts/bundle-gateway.mjs);
 * 3. the repository root, three directories above this file (`packages/assets/src`).
 */

declare global {
  // Set by the banner of each bundled entry; absent when running from source.
  var __PSYCHE_BUNDLE_URL__: string | undefined;
}

export function assetsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.PSYCHE_ASSETS_ROOT;
  if (fromEnv !== undefined && fromEnv !== "") return resolve(fromEnv);
  const bundle = globalThis.__PSYCHE_BUNDLE_URL__;
  if (bundle !== undefined) return resolve(dirname(fileURLToPath(bundle)), "../../..");
  return resolve(import.meta.dirname, "../../..");
}

/** `assetPath("skills")`, `assetPath("packages", "db", "migrations")`: a path below the root; never outside it. */
export function assetPath(...segments: string[]): string {
  const root = assetsRoot();
  const rel = normalize(join(...segments));
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error(`asset path escapes the assets root: ${segments.join("/")}`);
  }
  return join(root, rel);
}

/** A directory asset with the trailing separator `new URL("dir/", …)` paths had. */
export function assetDir(...segments: string[]): string {
  return `${assetPath(...segments)}${sep}`;
}

/**
 * A module another thread or process starts (`new Worker(url)`). From source that is `sourceUrl`
 * (`new URL("./worker.ts", import.meta.url)`); in the bundle it is the entry `bundledName` built
 * next to the main bundle.
 */
export function entryUrl(sourceUrl: URL, bundledName: string): URL {
  const bundle = globalThis.__PSYCHE_BUNDLE_URL__;
  return bundle === undefined ? sourceUrl : new URL(bundledName, bundle);
}
