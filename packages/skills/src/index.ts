import { FsSkillLoader, type FsSkillLoaderOptions } from "./loader.ts";

export * from "./binding.ts";
export * from "./diff.ts";
export * from "./frontmatter.ts";
export * from "./gating.ts";
export * from "./handlers.ts";
export * from "./loader.ts";
export * from "./lock.ts";
export * from "./manifest.ts";
export * from "./policy.ts";
export * from "./prompt.ts";
export * from "./scanner.ts";
export * from "./sources.ts";
export * from "./state.ts";
export * from "./tools.ts";
export * from "./tree.ts";
export * from "./virustotal.ts";

/** Creates the file-system skill loader (see `FsSkillLoaderOptions`). */
export function createSkillLoader(options: FsSkillLoaderOptions): FsSkillLoader {
  return new FsSkillLoader(options);
}
