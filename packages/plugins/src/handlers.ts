import type { MethodParams, MethodResult } from "@psyche/protocol";
import type { PluginManager } from "./manager.ts";

/** `plugins.*` method handlers over a `PluginManager` (scopes and schemas: protocol `methods/plugins.ts`). */
export interface PluginsHandlers {
  "plugins.list": () => Promise<MethodResult<"plugins.list">>;
  "plugins.getProposal": (
    p: MethodParams<"plugins.getProposal">,
  ) => Promise<MethodResult<"plugins.getProposal">>;
  "plugins.proposeInstall": (
    p: MethodParams<"plugins.proposeInstall">,
  ) => Promise<MethodResult<"plugins.proposeInstall">>;
  "plugins.install": (
    p: MethodParams<"plugins.install">,
  ) => Promise<MethodResult<"plugins.install">>;
  "plugins.setEnabled": (
    p: MethodParams<"plugins.setEnabled">,
  ) => Promise<MethodResult<"plugins.setEnabled">>;
  "plugins.remove": (p: MethodParams<"plugins.remove">) => Promise<MethodResult<"plugins.remove">>;
}

export function createPluginsHandlers(
  manager: PluginManager,
  enabled: () => boolean,
): PluginsHandlers {
  return {
    "plugins.list": async () => ({ enabled: enabled(), plugins: manager.list() }),
    "plugins.getProposal": async (p) => ({ proposal: manager.getProposal(p.proposalId) }),
    "plugins.proposeInstall": (p) => manager.proposeInstall(p.path),
    "plugins.install": async (p) => ({ plugin: await manager.install(p.proposalId, p.approvalId) }),
    "plugins.setEnabled": async (p) => ({ plugin: await manager.setEnabled(p.name, p.enabled) }),
    "plugins.remove": async (p) => {
      await manager.remove(p.name);
      return { ok: true as const };
    },
  };
}
