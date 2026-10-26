import { type ReactElement, useId, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { NativeSelect } from "../../components/ui/native-select.tsx";
import { t } from "../../i18n/core.ts";
import { VaultField } from "./ConnectorSettingsCards.tsx";
import {
  ConnectAccessChoice,
  isSingleInstance,
  needsSetup,
  offeredCatalog,
  type ScopeMode,
} from "./connector-catalog.tsx";
import { McpAddForm } from "./McpAddForm.tsx";
import { Group } from "./shared.tsx";
import type { McpState } from "./use-mcp.tsx";

/** Add connector: pick a catalogue row; its connect options (or, for MCP, its server form) follow. */
export function ConnectForm({
  persona,
  initialType,
  implemented,
  connectedTypes,
  onConnect,
  onCancel,
  onOpenSection,
  mcp,
  sharedFolders,
  onShareFolder,
}: {
  persona: string;
  /** The catalogue row to start on; the first one by default. */
  initialType: string | undefined;
  implemented: ReadonlySet<string> | undefined;
  connectedTypes: ReadonlySet<string>;
  onConnect: (type: string, mode: ScopeMode, config?: Record<string, unknown>) => void;
  onCancel: () => void;
  onOpenSection?: (section: "channels") => void;
  /** Present: the Custom MCP server row is offered, and its form checks the server here. */
  mcp?: McpState;
  sharedFolders: readonly string[];
  onShareFolder?: (path: string, mode: ScopeMode) => void;
}): ReactElement {
  const id = useId();
  const rows = offeredCatalog(implemented).filter((c) =>
    c.type === "mcp" ? mcp !== undefined : c.type !== "slack" || onOpenSection !== undefined,
  );
  // A one-per-machine connector that is already there is listed as Connected, not offered.
  const taken = (type: string) => isSingleInstance(type) && connectedTypes.has(type);
  const open = rows.filter((c) => !taken(c.type));
  const [picked, setType] = useState<string>(initialType ?? open[0]?.type ?? "");
  const type = open.some((c) => c.type === picked) ? picked : (open[0]?.type ?? "");
  const opens = rows.find((c) => c.type === type)?.opens;
  const [mode, setMode] = useState<ScopeMode>("read");
  // Obsidian connects to a vault folder shared through File access (#640).
  const [vault, setVault] = useState("");
  const vaultPath = vault.trim();
  const needsVault = needsSetup(type);
  const vaultReady = !needsVault || (vaultPath !== "" && sharedFolders.includes(vaultPath));
  return (
    <Group title={t("settings.connectors.connect")}>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-type`} className="font-medium">
          {t("settings.connectors.accountType")}
        </label>
        <NativeSelect
          id={`${id}-type`}
          className="min-w-56"
          value={type}
          onChange={(e) => setType(e.target.value)}
        >
          {rows.map((c) => (
            <option key={c.type} value={c.type} disabled={taken(c.type)}>
              {taken(c.type)
                ? t("settings.connectors.catalog.connected", { name: c.label })
                : c.label}
            </option>
          ))}
        </NativeSelect>
      </div>
      {type === "mcp" && mcp ? (
        <McpAddForm
          commandsAllowed={mcp.launcher !== "none"}
          checking={mcp.checking}
          onCheck={mcp.check}
          onCancel={onCancel}
        />
      ) : opens !== undefined ? (
        <p className="text-sm text-muted-foreground">{t("settings.connectors.slackExplain")}</p>
      ) : (
        <>
          <ConnectAccessChoice
            label={t("settings.connectors.whatCan", { persona })}
            value={mode}
            onChange={setMode}
            persona={persona}
          />
          {needsVault ? (
            <VaultField
              value={vault}
              onChange={setVault}
              granted={sharedFolders}
              {...(onShareFolder ? { onShare: (path: string) => onShareFolder(path, mode) } : {})}
            />
          ) : null}
        </>
      )}
      {type === "mcp" && mcp ? null : (
        <div className="flex gap-2">
          {opens !== undefined ? (
            <Button type="button" size="sm" onClick={() => onOpenSection?.(opens)}>
              {t("settings.connectors.openChannels")}
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              disabled={type === "" || !vaultReady}
              onClick={() =>
                needsVault ? onConnect(type, mode, { vaultPath }) : onConnect(type, mode)
              }
            >
              {t("settings.connectors.continue")}
            </Button>
          )}
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
        </div>
      )}
    </Group>
  );
}
