import { FsSkillLoader, type FsSkillLoaderOptions } from "./loader.ts";

export * from "./author.ts";
export * from "./authors.ts";
export * from "./binding.ts";
export * from "./bundle.ts";
export * from "./bundle-url.ts";
export * from "./connector-bundle.ts";
export * from "./connector-ledger.ts";
export * from "./diff.ts";
export * from "./drafts.ts";
export * from "./frontmatter.ts";
export * from "./gating.ts";
export * from "./handlers.ts";
export * from "./loader.ts";
export * from "./lock.ts";
export * from "./manifest.ts";
export * from "./notice.ts";
export * from "./policy.ts";
export * from "./prompt.ts";
export * from "./recording.ts";
export * from "./rotation.ts";
export * from "./scanner.ts";
export * from "./sources.ts";
export * from "./specialists.ts";
export * from "./state.ts";
export * from "./tools.ts";
export * from "./tree.ts";
export * from "./virustotal.ts";
export * from "./widen.ts";

/** Creates the file-system skill loader (see `FsSkillLoaderOptions`). */
export function createSkillLoader(options: FsSkillLoaderOptions): FsSkillLoader {
  return new FsSkillLoader(options);
}
