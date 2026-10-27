import { ArrowLeft } from "lucide-react";
import type { ReactElement } from "react";
import { useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { t } from "../../i18n/core.ts";
import type { MessageId } from "../../i18n/messages/index.ts";
import { ConnectorGallery, type GalleryEntry, type GalleryGroup } from "./ConnectorGallery.tsx";
import { VaultField } from "./ConnectorSettingsCards.tsx";
import {
  ConnectAccessChoice,
  isSingleInstance,
  needsSetup,
  offeredCatalog,
  type ScopeMode,
} from "./connector-catalog.tsx";
import { McpAddForm } from "./McpAddForm.tsx";
import { McpPresetForm } from "./McpPresetForm.tsx";
import { presetText } from "./mcp-preset-build.ts";
import { MCP_PRESETS } from "./mcp-presets.ts";
import { Group } from "./shared.tsx";
import type { McpState } from "./use-mcp.tsx";

/** Where each built-in connector sits in the gallery. */
const BUILT_IN_GROUP: Readonly<Record<string, GalleryGroup>> = {
  google: "productivity",
  microsoft: "productivity",
  imap: "comms",
  "apple:notes": "productivity",
  "apple:reminders": "productivity",
  "apple:calendar": "productivity",
  "apple:mail": "comms",
  "apple:shortcuts": "everyday",
  obsidian: "files",
  slack: "comms",
};

/** Message ids for a built-in's one-line description (`gallery.builtin.<id>`). */
const BUILT_IN_ID: Readonly<Record<string, string>> = {
  google: "google",
  microsoft: "microsoft",
  imap: "imap",
  "apple:notes": "appleNotes",
  "apple:reminders": "appleReminders",
  "apple:calendar": "appleCalendar",
  "apple:mail": "appleMail",
  "apple:shortcuts": "appleShortcuts",
  obsidian: "obsidian",
  slack: "slack",
};

/**
 * Add connector: a searchable gallery of built-in connectors, ready-made MCP servers and a custom
 * one. The picked tile's connect options (or its server form) replace the gallery.
 */
export function ConnectForm({
  persona,
  initialType,
  implemented,
  connectedTypes,
  onConnect,
  onCancel,
  onOpenSection,
  mcp,
  onTry,
  sharedFolders,
  onShareFolder,
}: {
  persona: string;
  /** The tile to open straight away (`mcp`: the custom MCP server form). */
  initialType: string | undefined;
  implemented: ReadonlySet<string> | undefined;
  connectedTypes: ReadonlySet<string>;
  onConnect: (type: string, mode: ScopeMode, config?: Record<string, unknown>) => void;
  onCancel: () => void;
  onOpenSection?: (section: "channels") => void;
  /** Present: ready-made and custom MCP servers are offered, and their forms check the server here. */
  mcp?: McpState;
  /** "Try it": fills the chat composer with an example request. */
  onTry?: (text: string) => void;
  sharedFolders: readonly string[];
  onShareFolder?: (path: string, mode: ScopeMode) => void;
}): ReactElement {
  const rows = offeredCatalog(implemented).filter(
    (c) => c.type !== "mcp" && (c.type !== "slack" || onOpenSection !== undefined),
  );
  // A one-per-machine connector that is already there is listed as Connected, not offered.
  const taken = (type: string) => isSingleInstance(type) && connectedTypes.has(type);
  const [picked, setPicked] = useState<string | null>(initialType ?? null);
  const [mode, setMode] = useState<ScopeMode>("read");
  // Obsidian connects to a vault folder shared through File access (#640).
  const [vault, setVault] = useState("");
  const vaultPath = vault.trim();

  const entries: GalleryEntry[] = [
    ...rows.map((c) => ({
      key: c.type,
      label: c.label,
      description: t(`gallery.builtin.${BUILT_IN_ID[c.type] ?? c.type}` as MessageId),
      group: BUILT_IN_GROUP[c.type] ?? "productivity",
      category: BUILT_IN_GROUP[c.type] ?? "productivity",
      type: c.type,
      badge: "builtIn" as const,
      taken: taken(c.type),
      onPick: () => setPicked(c.type),
    })),
    ...(mcp
      ? [
          ...MCP_PRESETS.map((p) => ({
            key: `preset:${p.id}`,
            label: p.label,
            description: presetText(p, "desc"),
            group: p.popular ? ("popular" as const) : p.category,
            category: p.category,
            icon: p.icon,
            badge: p.official ? ("official" as const) : ("community" as const),
            onPick: () => setPicked(`preset:${p.id}`),
          })),
          {
            key: "mcp",
            label: t("settings.connectors.catalog.mcp"),
            description: t("gallery.custom.desc"),
            group: "custom" as const,
            category: "custom" as const,
            type: "mcp",
            badge: null,
            onPick: () => setPicked("mcp"),
          },
        ]
      : []),
  ];

  const preset = picked?.startsWith("preset:")
    ? MCP_PRESETS.find((p) => `preset:${p.id}` === picked)
    : undefined;
  const builtIn = rows.find((c) => c.type === picked);
  const title =
    picked === "mcp"
      ? t("settings.connectors.catalog.mcp")
      : (preset?.label ?? builtIn?.label ?? t("settings.connectors.connect"));

  if (picked === null || (preset === undefined && builtIn === undefined && picked !== "mcp")) {
    return (
      <Group title={t("settings.connectors.connect")}>
        <ConnectorGallery entries={entries} />
        <div className="flex gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
        </div>
      </Group>
    );
  }

  const back = () => setPicked(null);
  const opens = builtIn?.opens;
  const needsVault = needsSetup(picked);
  const vaultReady = !needsVault || (vaultPath !== "" && sharedFolders.includes(vaultPath));
  return (
    <Group
      title={title}
      actions={
        <Button type="button" variant="ghost" size="sm" onClick={back}>
          <ArrowLeft aria-hidden="true" /> {t("gallery.back")}
        </Button>
      }
    >
      {picked === "mcp" && mcp ? (
        <McpAddForm
          commandsAllowed={mcp.launcher !== "none"}
          checking={mcp.checking}
          onCheck={mcp.check}
          onCancel={onCancel}
          onSandboxReady={mcp.reload}
        />
      ) : preset && mcp ? (
        <McpPresetForm preset={preset} mcp={mcp} onCancel={onCancel} onTry={onTry} />
      ) : (
        <>
          {opens !== undefined ? (
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
                  {...(onShareFolder
                    ? { onShare: (path: string) => onShareFolder(path, mode) }
                    : {})}
                />
              ) : null}
            </>
          )}
          <div className="flex gap-2">
            {opens !== undefined ? (
              <Button type="button" size="sm" onClick={() => onOpenSection?.(opens)}>
                {t("settings.connectors.openChannels")}
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                disabled={!vaultReady}
                onClick={() =>
                  needsVault ? onConnect(picked, mode, { vaultPath }) : onConnect(picked, mode)
                }
              >
                {t("settings.connectors.continue")}
              </Button>
            )}
            <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
              {t("common.cancel")}
            </Button>
          </div>
        </>
      )}
    </Group>
  );
}
