import pkg from "../package.json" with { type: "json" };

/** Set by the release bundlers (`--define __PSYCHE_VERSION__=…`); absent when run from source. */
declare const __PSYCHE_VERSION__: string | undefined;

export const CLI_VERSION: string =
  typeof __PSYCHE_VERSION__ === "string" ? __PSYCHE_VERSION__ : pkg.version;
