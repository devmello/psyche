import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  REACT_BUNDLER_RUNTIME,
  reactBundlerHeaders,
  reactBundlerPage,
} from "../core/react-artifact.ts";

/**
 * Node-only entry (`@psyche/viewers/bundler`) for the Gateway: the files of the self-hosted
 * React artifact bundler, built from this package's own dependencies (React 19 production CJS
 * builds and `@babel/standalone`), so the bundler origin serves everything itself. Mount it on a
 * dedicated loopback port (or a `bundler.` host), never on the app or artifacts origin.
 *
 * ```ts
 * const res = await reactBundlerResponse(url.pathname, { appOrigin, bundlerOrigin });
 * if (res) { reply.status(200).headers(res.headers).send(res.body) } else { reply.status(404) }
 * ```
 */

const require = createRequire(import.meta.url);

/** A package's root directory (its main entry sits at the root for react, react-dom, scheduler). */
const pkgDir = (name: string, from = require) => dirname(from.resolve(name));

/** Vendored modules: bundler module id → CommonJS file (production builds only). */
const VENDOR: Record<string, () => string> = {
  react: () => join(pkgDir("react"), "cjs/react.production.js"),
  "react/jsx-runtime": () => join(pkgDir("react"), "cjs/react-jsx-runtime.production.js"),
  "react/jsx-dev-runtime": () => join(pkgDir("react"), "cjs/react-jsx-dev-runtime.production.js"),
  "react-dom": () => join(pkgDir("react-dom"), "cjs/react-dom.production.js"),
  "react-dom/client": () => join(pkgDir("react-dom"), "cjs/react-dom-client.production.js"),
  // scheduler is react-dom's own dependency, resolved from react-dom's location.
  scheduler: () =>
    join(
      pkgDir("scheduler", createRequire(join(pkgDir("react-dom"), "index.js"))),
      "cjs/scheduler.production.js",
    ),
};

let vendorJs: Promise<string> | undefined;

/** One script that registers each vendored module as `function(module, exports, require, process)`. */
export function bundlerVendorScript(): Promise<string> {
  vendorJs ??= (async () => {
    const parts = await Promise.all(
      Object.entries(VENDOR).map(async ([id, file]) => {
        const src = await readFile(file(), "utf8");
        return `V[${JSON.stringify(id)}]=function(module,exports,require,process){${src}\n};`;
      }),
    );
    return `(function(){var V=window.__psycheVendor={};\n${parts.join("\n")}\n})();`;
  })();
  return vendorJs;
}

let babelJs: Promise<string> | undefined;

function babelScript(): Promise<string> {
  babelJs ??= readFile(join(pkgDir("@babel/standalone"), "babel.min.js"), "utf8");
  return babelJs;
}

export interface BundlerResponse {
  headers: Record<string, string>;
  body: string;
}

const JS = "text/javascript; charset=utf-8";

/** The bundler's files by path (`/`, `/runtime.js`, `/vendor.js`, `/babel.min.js`), or undefined. */
export async function reactBundlerResponse(
  path: string,
  origins: { appOrigin: string; bundlerOrigin: string },
): Promise<BundlerResponse | undefined> {
  const p = path.split(/[?#]/)[0];
  switch (p) {
    case "/":
    case "/index.html":
      return { headers: reactBundlerHeaders(origins), body: reactBundlerPage() };
    case "/runtime.js":
      return { headers: reactBundlerHeaders(origins, JS), body: REACT_BUNDLER_RUNTIME };
    case "/vendor.js":
      return { headers: reactBundlerHeaders(origins, JS), body: await bundlerVendorScript() };
    case "/babel.min.js":
      return { headers: reactBundlerHeaders(origins, JS), body: await babelScript() };
    default:
      return undefined;
  }
}
