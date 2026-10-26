import { sanitizeDisplay } from "@psyche/permissions/cards";
import type { McpServerStatus } from "@psyche/protocol";
import { type ReactElement, useState } from "react";
import { t } from "../../i18n/core.ts";
import { ConnectorIcon } from "./ConnectorIcon.tsx";
import { RowMoreMenu } from "./RowMoreMenu.tsx";
import { Facts, StatusChip, type Tone } from "./shared.tsx";

/**
 * One MCP server in the Connectors list: the same row as a built-in connector (icon, name, status,
 * trust, ⋯), plus an "MCP" chip. Details (how it runs, what it reaches, its id) open under it.
 */

const show = (s: string, max = 100) => sanitizeDisplay(s, max);

/** The trust tier as the owner reads it. */
export function mcpTrustLabel(trust: McpServerStatus["trust"]): string {
  return t(
    trust === "bundled"
      ? "settings.connectors.trust.builtIn"
      : trust === "verified"
        ? "settings.connectors.trust.verified"
        : "settings.connectors.trust.unverified",
  );
}

export function McpServerRow({
  server,
  onRemove,
  defaultOpen = false,
}: {
  server: McpServerStatus;
  onRemove?: (server: McpServerStatus) => void;
  defaultOpen?: boolean;
}): ReactElement {
  const [open, setOpen] = useState(defaultOpen);
  const trustTone: Tone = server.trust === "unknown" ? "approval" : "info";
  const transport =
    server.transport === "http" ? t("settings.mcp.kind.url") : t("settings.mcp.kind.command");
  return (
    <article aria-label={server.name} className="flex flex-col gap-1.5">
      <div className="flex items-center gap-3">
        <ConnectorIcon type="mcp" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-headline text-label-primary">{show(server.name)}</h3>
            <StatusChip tone={server.connected ? "success" : "danger"}>
              {server.connected ? t("settings.mcp.connected") : t("settings.mcp.notConnected")}
            </StatusChip>
            <StatusChip tone="neutral">{t("settings.mcp.badge")}</StatusChip>
            <StatusChip tone={trustTone}>
              {t("settings.connectors.trust", { tier: mcpTrustLabel(server.trust) })}
            </StatusChip>
          </div>
          <p className="text-callout text-label-secondary">
            {transport}
            {server.network ? ` · ${t("settings.mcp.network")}` : ""}
          </p>
        </div>
        <RowMoreMenu
          name={server.name}
          items={[
            {
              label: open ? t("settings.mcp.hideDetails") : t("settings.mcp.showDetails"),
              onClick: () => setOpen((o) => !o),
            },
          ]}
          destructive={
            onRemove
              ? [
                  {
                    label: t("common.remove"),
                    title: t("settings.mcp.removeTitle", { name: show(server.name, 64) }),
                    description: t("settings.mcp.removeDescription"),
                    confirm: t("common.remove"),
                    onConfirm: () => onRemove(server),
                  },
                ]
              : []
          }
        />
      </div>
      {open ? (
        <Facts
          className="ms-11 text-callout"
          items={[
            { term: t("settings.mcp.how"), value: transport },
            {
              term: t("settings.mcp.trust.network"),
              value: server.network ? t("settings.mcp.network") : t("settings.mcp.trust.noNetwork"),
            },
            { term: t("settings.mcp.trust.id"), value: <code>{server.id}</code> },
          ]}
        />
      ) : null}
    </article>
  );
}
