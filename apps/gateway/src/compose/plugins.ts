import { join } from "node:path";
import type { PsycheAgentLoop } from "@psyche/agent-core";
import { getSetting, type PsycheDb } from "@psyche/db";
import { createPluginsHandlers, PluginManager } from "@psyche/plugins";
import type { PermissionBroker } from "@psyche/protocol";
import type { Logger } from "../log.ts";
import type { Gateway } from "../server.ts";
import { mountParamsOnly } from "./handlers.ts";
import type { ComposedPart } from "./services.ts";

/**
 * Code plugins (feature T4; architecture §13 "Plugins"). Installed under `$PSYCHE_HOME/plugins`
 * through the skill trust card (`plugins.proposeInstall` → device-only `skill_install` with
 * `details.kind: "plugin"` → `plugins.install`). They run only while the admin setting
 * `plugins.enabled` is on (default off) and each one's own switch is on, every plugin in its own
 * permission-restricted Node process, wired into the agent loop's plugin registry. A settings
 * change starts or stops them at once.
 */

export const PLUGINS_SETTING = "plugins.enabled";

export interface PluginsSetup {
  db: PsycheDb;
  home: string;
  /** The executor broker: the install card is announced like the other executors' cards. */
  broker: PermissionBroker;
  loop: PsycheAgentLoop;
  logger?: Logger;
}

export function composePlugins(setup: PluginsSetup): ComposedPart & { manager: PluginManager } {
  const enabled = () => getSetting(setup.db, PLUGINS_SETTING)?.value === true;
  const manager = new PluginManager({
    dir: join(setup.home, "plugins"),
    broker: setup.broker,
    registry: setup.loop.plugins,
    enabled,
    surfaces: ["desktop", "web"],
    log: (message, data) => setup.logger?.log("info", `plugins: ${message}`, data ?? {}),
  });
  let unsubscribe: (() => void) | undefined;
  return {
    manager,
    handlers: mountParamsOnly(createPluginsHandlers(manager, enabled) as never),
    async start(gateway: Gateway) {
      unsubscribe = gateway.bus.subscribe(["operator.read"], (frame) => {
        const f = JSON.parse(frame) as {
          event?: string;
          payload?: { entries?: { key: string }[] };
        };
        if (
          f.event === "settings.changed" &&
          f.payload?.entries?.some((e) => e.key === PLUGINS_SETTING)
        ) {
          void manager.sync();
        }
      });
      await manager.sync();
    },
    async stop() {
      unsubscribe?.();
      await manager.stopAll();
    },
  };
}
