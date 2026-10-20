import type { ProviderConfig } from "../config.ts";
import type { CliDialect } from "./adapter.ts";
import { claudeCodeDialect } from "./claude-code.ts";
import { codexDialect } from "./codex.ts";

export * from "./adapter.ts";
export * from "./bridge.ts";
export * from "./claude-code.ts";
export * from "./codex.ts";
export * from "./probe.ts";
export * from "./prompt.ts";
export * from "./resolve.ts";
export * from "./run.ts";

/** The dialect for a subscription-CLI provider config. */
export function cliDialectFor(config: ProviderConfig): CliDialect {
  switch (config.kind) {
    case "claude-code":
      return claudeCodeDialect(config.id);
    case "codex":
      return codexDialect(config.id);
    default:
      throw new Error(`provider "${config.id}" (${config.kind}) is not a subscription CLI`);
  }
}
