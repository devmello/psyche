import { join } from "node:path";
import type { PsycheAgentLoop } from "@psyche/agent-core";
import { getSetting, type PsycheDb } from "@psyche/db";
import type { PsycheNotifier } from "@psyche/notifications";
import type { PsychePermissionBroker } from "@psyche/permissions";
import { createPluginsHandlers, PluginManager } from "@psyche/plugins";
import type { EventPayload, PermissionBroker } from "@psyche/protocol";
import type { Logger } from "../log.ts";
import { failureFields } from "../process-errors.ts";
import type { Gateway } from "../server.ts";
import { mountParamsOnly } from "./handlers.ts";
import { approvedInstallReason, reportApprovedInstallFailed } from "./install-failed.ts";
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
  /** The raw broker's decisions: an approved card installs the plugin, whatever screen is open. */
  events: Pick<PsychePermissionBroker, "subscribe">;
  notifier: Pick<PsycheNotifier, "notify">;
  loop: PsycheAgentLoop;
  logger?: Logger;
  /** Publishes `plugins.changed` so Settings reloads the list after an approved install or switch. */
  publish?: (event: "plugins.changed", payload: EventPayload<"plugins.changed">) => void;
}

export function composePlugins(setup: PluginsSetup): ComposedPart & { manager: PluginManager } {
  const enabled = () => getSetting(setup.db, PLUGINS_SETTING)?.value === true;
  const manager = new PluginManager({
    dir: join(setup.home, "plugins"),
    broker: setup.broker,
    registry: setup.loop.plugins,
    enabled,
    surfaces: ["desktop", "offMac"],
    onChange: (name, change) => setup.publish?.("plugins.changed", { name, change }),
    log: (message, data) => setup.logger?.log("info", `plugins: ${message}`, data ?? {}),
  });
  let unsubscribe: (() => void) | undefined;
  // The owner's approval of a plugin card installs it (the card is the consent). Denied or expired
  // cards never reach here; `installApproved` checks the approval itself. A failure is reported.
  const unsubscribeInstall = setup.events.subscribe((e) => {
    if (e.type !== "approval.decided" || e.approval.kind !== "skill_install") return;
    if (e.approval.details.kind !== "plugin") return;
    void manager.installApproved(e.approval).catch((err: unknown) => {
      const reason = approvedInstallReason(err);
      setup.logger?.log("warn", "plugin install after approval failed", {
        approvalId: e.approval.id,
        reason,
      });
      reportApprovedInstallFailed({
        broker: setup.broker,
        notifier: setup.notifier,
        approval: e.approval,
        kind: "plugin",
        reason,
      });
    });
  });
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
          void manager
            .sync()
            .catch((err: unknown) =>
              setup.logger?.log("warn", "plugins: sync failed", failureFields(err)),
            );
        }
      });
      await manager.sync();
    },
    async stop() {
      unsubscribeInstall();
      unsubscribe?.();
      await manager.stopAll();
    },
  };
}
