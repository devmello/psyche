import pkg from "../package.json" with { type: "json" };

/** Replaced at bundle time by `--define` in the release build; the package version otherwise. */
export const CLI_VERSION: string = pkg.version;
