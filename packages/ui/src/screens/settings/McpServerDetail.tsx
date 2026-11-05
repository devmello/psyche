import { sanitizeDisplay } from "@psyche/permissions/cards";
import type { McpServerStatus } from "@psyche/protocol";
import type { ReactElement } from "react";
import { Button } from "../../components/ui/button.tsx";
import { t } from "../../i18n/core.ts";
import { type ConnectorBundlesState, ConnectorShare } from "./ConnectorBundles.tsx";
import { ConnectorIcon } from "./ConnectorIcon.tsx";
import { Disclosure, FactRows } from "./ConnectorRow.tsx";
import { McpCodePanel } from "./McpCodePanel.tsx";
import { McpFailureNotice } from "./McpFailureNotice.tsx";
import { McpLoadingGroup, McpServerPanels } from "./McpServerPanels.tsx";
import { presetText } from "./mcp-preset-build.ts";
import { MCP_PRESETS } from "./mcp-presets.ts";
import { Facts, Group, type Tone } from "./shared.tsx";
import type { McpState } from "./use-mcp.tsx";

/**
 * One tool server's row and detail in Settings → Connectors. The row says what it is and whether
 * it works; the detail holds everything else: why it failed, its tools, its secrets, how it runs
 * and the buttons that turn it off or remove it.
 */

const show = (s: string, max = 100) => sanitizeDisplay(s, max);

/** The trust tier as the owner reads it. */
export function mcpTrustLabel(trust: McpServerStatus["trust"]): string {
  return t(
    trust === "bundled"
      ? "settings.connectors.page.source.builtIn"
      : trust === "verified"
        ? "settings.connectors.page.source.verified"
        : "settings.connectors.page.source.unverified",
  );
}

/** Where the server runs, in plain words. */
const runsLabel = (server: McpServerStatus): string =>
  server.transport === "http"
    ? t("settings.connectors.page.row.remote")
    : t("settings.connectors.page.row.local");

/** A server that is on but did not start needs the owner. */
export const mcpNeedsYou = (server: McpServerStatus): boolean =>
  server.enabled !== false && !server.connected;

export function mcpStatus(server: McpServerStatus): { tone: Tone; label: string } {
  if (server.enabled === false)
    return { tone: "neutral", label: t("settings.connectors.page.status.paused") };
  return server.connected
    ? { tone: "success", label: t("settings.connectors.status.connected") }
    : { tone: "approval", label: t("settings.connectors.page.status.notWorking") };
}

/** The line under the row's name: where it runs, and a word of caution when nobody vouches for it. */
export function mcpSubtitle(server: McpServerStatus): string {
  const parts = [
    server.madeBy === "psyche" ? t("settings.mcp.madeBy") : runsLabel(server),
    server.trust === "unknown" ? t("settings.connectors.page.row.unverified") : null,
  ];
  return parts.filter((p) => p !== null).join(" · ");
}

export function McpServerIcon({ server }: { server: McpServerStatus }): ReactElement {
  const preset = MCP_PRESETS.find((p) => p.id === server.id);
  return <ConnectorIcon type="mcp" {...(preset ? { icon: preset.icon } : {})} />;
}

export function McpServerDetail({
  server,
  mcp,
  bundles,
  onRemove,
  onSetEnabled,
  onTry,
  now,
}: {
  server: McpServerStatus;
  /** Sharing this connector as a signed file. */
  bundles?: ConnectorBundlesState;
  /** For the launch failure the last attempt left, shown with its next step. */
  mcp?: Pick<McpState, "reload" | "actionError" | "actionFailure">;
  onRemove?: (server: McpServerStatus) => void;
  /** Turns the server off (kept, not running) or back on. */
  onSetEnabled?: (server: McpServerStatus, enabled: boolean) => void;
  /** "Try it": fills the chat composer (a ready-made server has an example). */
  onTry?: (text: string) => void;
  /** The clock the approval card counts down against (stories, tests). */
  now?: number;
}): ReactElement {
  const preset = MCP_PRESETS.find((p) => p.id === server.id);
  const example = preset ? presetText(preset, "example") : null;
  const name = show(server.name);
  return (
    <div className="flex flex-col gap-4">
      {mcpNeedsYou(server) ? (
        <div
          role="status"
          className="flex flex-col gap-1 rounded-lg border border-approval-border bg-approval-surface p-3 text-body text-approval-text"
        >
          <p>{t("settings.connectors.page.attention.server", { name })}</p>
          <p className="text-callout">{t("settings.connectors.page.attention.serverHint")}</p>
          {mcp?.actionError ? (
            <McpFailureNotice message={mcp.actionError} failure={mcp.actionFailure} mcp={mcp} />
          ) : null}
        </div>
      ) : null}
      {example !== null && onTry && server.connected && server.enabled !== false ? (
        <p className="flex flex-wrap items-center gap-2 text-callout text-label-secondary">
          <span>{t("gallery.tryAsking")}</span>
          <q className="text-label-primary">{example}</q>
          <Button type="button" variant="ghost" size="sm" onClick={() => onTry(example)}>
            {t("settings.connectors.try.title")}
          </Button>
        </p>
      ) : null}
      <Group title={t("settings.connectors.page.detail.about")}>
        <FactRows
          items={[
            {
              term: t("settings.connectors.page.detail.type"),
              value:
                server.transport === "http"
                  ? t("settings.connectors.page.server.remote")
                  : t("settings.connectors.page.server.local"),
            },
            {
              term: t("settings.mcp.trust.network"),
              value: server.network
                ? t("settings.connectors.page.server.network")
                : t("settings.connectors.page.server.noNetwork"),
            },
            {
              term: t("settings.connectors.page.detail.source"),
              value: mcpTrustLabel(server.trust),
            },
          ]}
        />
      </Group>
      <McpServerPanels
        server={server}
        {...(onSetEnabled ? { onSetEnabled: (on: boolean) => onSetEnabled(server, on) } : {})}
        {...(onRemove ? { onRemove: () => onRemove(server) } : {})}
      />
      {bundles ? <ConnectorShare server={server} state={bundles} /> : null}
      <Disclosure label={t("settings.connectors.page.detail.technical")}>
        <Facts
          className="text-callout"
          items={[{ term: t("settings.mcp.trust.id"), value: <code>{server.id}</code> }]}
        />
        <McpLoadingGroup server={server} />
        {server.madeBy === "psyche" ? (
          <McpCodePanel server={server} {...(now === undefined ? {} : { now })} />
        ) : null}
      </Disclosure>
    </div>
  );
}
