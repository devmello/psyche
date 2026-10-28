import type { Connector, ConnectorCatalogueEntry } from "@psyche/protocol";
import { Plug } from "lucide-react";
import { type ReactElement, type ReactNode, useState } from "react";
import { usePrefillComposer } from "../../chat/prefill.ts";
import { EmptyState } from "../../components/page.tsx";
import { Button } from "../../components/ui/button.tsx";
import { useCall, useGatewayQuery } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { describeError } from "../../i18n/errors.ts";
import { formatRelative } from "../../lib/format.ts";
import { useNow } from "../../lib/use-now.ts";
import { usePersona } from "../../slots.tsx";
import { type ActionRule, liftedFloorsOf, withMatrixOverrides } from "./ActionMatrix.tsx";
import { AvailableConnectors } from "./CapabilityAvailable.tsx";
import { ConnectForm } from "./ConnectForm.tsx";
import { CapabilityCard } from "./ConnectorCapabilities.tsx";
import { ConnectorIcon } from "./ConnectorIcon.tsx";
import { ConnectedShortcutsCard, ObsidianCard } from "./ConnectorSettingsCards.tsx";
import {
  ConnectProgress,
  PermissionNotice,
  permissionOf,
  useConnectorConnect,
} from "./connect-flow.tsx";
import {
  CONNECTOR_CATALOG,
  SCOPE_MODE_LABEL,
  type ScopeMode,
  useImplementedTypes,
} from "./connector-catalog.tsx";
import { folderGrants, POLICY_KEY, policyWithFolders } from "./FileAccessSection.tsx";
import { McpServerRow } from "./McpServerDetail.tsx";
import { RowMoreMenu } from "./RowMoreMenu.tsx";
import { SegmentedRadio } from "./SegmentedRadio.tsx";
import {
  ErrorNotice,
  GROUP_ROWS,
  LoadGate,
  type LoadProps,
  SectionFrame,
  StatusChip,
  type Tone,
  useSettingsForm,
} from "./shared.tsx";
import { ConnectedTrustedSourcesCard, trustedAppOf } from "./TrustedSourcesCard.tsx";
import { type McpState, useMcp } from "./use-mcp.tsx";

/** Connectors (UI design §3.18; architecture §4.9): connected accounts and MCP servers, one list. */

export {
  CONNECTOR_CATALOG,
  ConnectAccessChoice,
  isSingleInstance,
  needsSetup,
  offeredCatalog,
  SCOPE_MODE_LABEL,
  type ScopeMode,
  useImplementedTypes,
} from "./connector-catalog.tsx";

const STATUS_TONE: Record<Connector["status"], Tone> = {
  connected: "success",
  disconnected: "neutral",
  error: "danger",
  needs_auth: "approval",
};

/** The trust tier as the owner reads it: the two built-in words are translated. */
function trustTierLabel(tier: string): string {
  if (tier === "built-in") return t("settings.connectors.trust.builtIn");
  if (tier === "unverified") return t("settings.connectors.trust.unverified");
  if (tier === "verified") return t("settings.connectors.trust.verified");
  return tier;
}

/** Trust tier: MCP servers carry one in config; built-in connectors are first-party. */
export function trustTier(c: Connector): string {
  const tier = c.config.trustTier;
  if (typeof tier === "string") return tier;
  return c.type === "mcp" ? "unverified" : "built-in";
}

function lastUsed(c: Connector): string | null {
  const at = c.lastSync?.at;
  return typeof at === "string" ? at : null;
}

export type ConnectorFilter = "all" | "apps" | "mcp";

export interface ConnectorsPanelProps extends LoadProps {
  connectors: readonly Connector[];
  persona: string;
  now?: number;
  /** `config`: what a connector needs to connect (Obsidian's `vaultPath`). */
  onConnect?: (type: string, mode: ScopeMode, config?: Record<string, unknown>) => void;
  onReconnect?: (connector: Connector) => void;
  onDisconnect?: (connector: Connector) => void;
  onRemove?: (connector: Connector) => void;
  /** Shared folders (File access); Obsidian's vault is one of them. */
  sharedFolders?: readonly string[];
  /** Shares a folder through File access (read-only, or read-and-write for read and act). */
  onShareFolder?: (path: string, mode: ScopeMode) => void;
  /** Saves a connector's own settings (`connectors.configure`): shortcut rules, the vault. */
  onConfigure?: (connector: Connector, config: Record<string, unknown>) => void;
  /** Opens with the connect form showing (stories). */
  defaultAdding?: boolean;
  /** The sign-in under way, shown above the list (#505). */
  connectProgress?: ReactNode;
  /** Connector types the Gateway can connect; undefined offers every catalog row. */
  implemented?: ReadonlySet<string> | undefined;
  /** Opens another Settings section (the Slack row). */
  onOpenSection?: (section: "channels") => void;
  /** MCP servers, listed with the connectors and added from the catalogue's Custom MCP server row. */
  mcp?: McpState;
  /** Which connectors to list first (the old MCP route lands on `mcp`). */
  defaultFilter?: ConnectorFilter;
  /** The catalogue row the add form starts on (stories, the "Add MCP server" shortcut). */
  defaultAddType?: string;
  /** Re-reads a connector's state (`connectors.status`): a macOS grant given meanwhile (#549). */
  onCheck?: (connector: Connector) => void;
  /** "Open System Settings" for a connector waiting on a macOS grant (reconnects it, #549). */
  onGrant?: (connector: Connector) => void;
  /** `connectors.catalogue`: each type's action groups for the Apple app cards (#640). */
  catalogue?: readonly ConnectorCatalogueEntry[];
  /**
   * An action group's Allow / Ask / Deny, saved as `permissions.connectors.<id>`; `liftFloor` is
   * the owner's confirmed opt-in for a send / destructive / financial group (security §3.12).
   */
  onRuleChange?: (
    connector: Connector,
    action: string,
    rule: ActionRule,
    liftFloor?: boolean,
  ) => void;
  /** `permissions.liftedFloors.<id>` per connector id. */
  liftedFloors?: Readonly<Record<string, readonly string[]>>;
  /** "Try it": fills the chat composer with an example request. */
  onTry?: (text: string) => void;
  /** Opens the Apple app cards with their groups showing (stories). */
  defaultCapabilitiesOpen?: boolean;
}

export function ConnectorsPanel({
  connectors,
  persona,
  now,
  onConnect,
  onReconnect,
  onDisconnect,
  onRemove,
  defaultAdding = false,
  connectProgress,
  implemented,
  onOpenSection,
  mcp,
  defaultFilter = "all",
  defaultAddType,
  onCheck,
  onGrant,
  sharedFolders = [],
  onShareFolder,
  onConfigure,
  catalogue,
  onRuleChange,
  liftedFloors,
  onTry,
  defaultCapabilitiesOpen,
  loading,
  error,
  onRetry,
}: ConnectorsPanelProps): ReactElement {
  const clock = useNow(30_000, now);
  const [shownScopes, setShownScopes] = useState<ReadonlySet<string>>(new Set());
  const toggleScopes = (id: string) =>
    setShownScopes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const [adding, setAdding] = useState(defaultAdding || defaultAddType !== undefined);
  const [addType, setAddType] = useState(defaultAddType);
  const [filter, setFilter] = useState<ConnectorFilter>(defaultFilter);
  const isMcp = (c: Connector) => c.type === "mcp";
  const apps = connectors.filter((c) => !isMcp(c));
  const servers = mcp?.servers ?? [];
  const mcpConnectors = connectors.filter(isMcp);
  const showApps = filter !== "mcp";
  const showMcp = filter !== "apps";
  const rows = [...(showApps ? apps : []), ...(showMcp ? mcpConnectors : [])];
  const mcpCount = mcpConnectors.length + servers.length;
  const total = apps.length + mcpCount;
  const startAdding = (type?: string) => {
    setAddType(type);
    setAdding(true);
  };
  const addButton = onConnect ? (
    <Button type="button" size="sm" onClick={() => startAdding()} disabled={adding}>
      <Plug aria-hidden="true" /> {t("settings.connectors.connect")}
    </Button>
  ) : null;
  const review = mcp?.review ?? null;
  return (
    <SectionFrame
      title={t("settings.connectors.title")}
      description={t("settings.connectors.description")}
      // One primary action: the header's button, or the empty state's when nothing is connected.
      actions={total > 0 || loading || error ? addButton : null}
    >
      <LoadGate
        label={t("settings.connectors.loadLabel")}
        loading={loading ?? false}
        error={error ?? null}
        {...(onRetry ? { onRetry } : {})}
      >
        {connectProgress}
        <div role="status" className="text-sm empty:hidden">
          {mcp?.notice ? <p>{mcp.notice}</p> : null}
        </div>
        {mcp?.actionError ? (
          <ErrorNotice what={mcp.actionError} did={t("settings.skills.nothingChanged")} />
        ) : null}
        {review}
        {adding && onConnect ? (
          // Hidden, not unmounted, while the trust card is open: cancelling it returns to the form.
          <div hidden={review !== null}>
            <ConnectForm
              key={addType ?? "gallery"}
              persona={persona}
              initialType={addType}
              {...(onTry ? { onTry } : {})}
              {...(mcp ? { mcp } : {})}
              implemented={implemented}
              connectedTypes={
                new Set(connectors.filter((c) => c.status !== "disconnected").map((c) => c.type))
              }
              {...(onOpenSection ? { onOpenSection } : {})}
              sharedFolders={sharedFolders}
              {...(onShareFolder ? { onShareFolder } : {})}
              onCancel={() => setAdding(false)}
              onConnect={(type, mode, config) => {
                if (config === undefined) onConnect(type, mode);
                else onConnect(type, mode, config);
                setAdding(false);
              }}
            />
          </div>
        ) : null}
        {total > 0 || filter !== "all" ? (
          <SegmentedRadio
            label={t("settings.connectors.filter.label")}
            value={filter}
            onChange={setFilter}
            className="self-start"
            options={[
              { value: "all", label: t("settings.connectors.filter.all") },
              { value: "apps", label: t("settings.connectors.filter.apps") },
              { value: "mcp", label: t("settings.connectors.filter.mcp") },
            ]}
          />
        ) : null}
        {rows.length === 0 && (!showMcp || servers.length === 0) ? (
          adding ? null : (
            <EmptyState
              icon={Plug}
              className="elevation-1 py-10"
              {...(onConnect
                ? {
                    action: {
                      label:
                        filter === "mcp" ? t("settings.mcp.add") : t("settings.connectors.connect"),
                      onClick: () => startAdding(filter === "mcp" ? "mcp" : undefined),
                    },
                  }
                : {})}
            >
              {filter === "mcp"
                ? t("settings.mcp.empty")
                : t("settings.connectors.empty", { persona })}
            </EmptyState>
          )
        ) : (
          // A grouped inset list, one row per account (redesign §5.8); scopes are technical names.
          <ul className={GROUP_ROWS}>
            {rows.map((c) => {
              const used = lastUsed(c);
              const permission = permissionOf(c);
              const technical = shownScopes.has(c.id);
              return (
                <li key={c.id}>
                  <article aria-label={c.label} className="flex flex-col gap-1.5">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <ConnectorIcon type={c.type} />
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-headline text-label-primary">{c.label}</h3>
                          <StatusChip tone={permission ? "approval" : STATUS_TONE[c.status]}>
                            {permission
                              ? t("settings.connectors.status.needsPermission")
                              : t(`settings.connectors.status.${c.status}`)}
                          </StatusChip>
                          {isMcp(c) ? (
                            <StatusChip tone="neutral">{t("settings.mcp.badge")}</StatusChip>
                          ) : null}
                          <StatusChip tone="neutral">{SCOPE_MODE_LABEL[c.scopeMode]}</StatusChip>
                          <StatusChip tone={trustTier(c) === "built-in" ? "info" : "approval"}>
                            {t("settings.connectors.trust", { tier: trustTierLabel(trustTier(c)) })}
                          </StatusChip>
                        </div>
                        <p className="text-callout text-label-secondary">
                          <span>{c.account ?? t("settings.connectors.noAccount")}</span>
                          <span aria-hidden="true"> · </span>
                          <span>
                            {t("settings.credentials.col.lastUsed")}{" "}
                            {used === null
                              ? t("settings.credentials.never").toLocaleLowerCase()
                              : formatRelative(used, clock)}
                          </span>
                        </p>
                        {technical ? (
                          <p className="flex flex-wrap items-center gap-1 text-callout text-label-secondary">
                            <span>{t("settings.connectors.scopes")}</span>
                            {c.scopes.map((sc) => (
                              <code
                                key={sc}
                                className="rounded-xs bg-fill-tertiary px-1 font-mono text-mono"
                              >
                                {sc}
                              </code>
                            ))}
                          </p>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 flex-wrap items-center gap-2">
                        {permission && c.status === "needs_auth" ? (
                          <>
                            {onGrant && permission.state === "denied" ? (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => onGrant(c)}
                              >
                                {t("settings.connect.openSystemSettings")}
                              </Button>
                            ) : null}
                            {onCheck ? (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => onCheck(c)}
                              >
                                {t("settings.connect.checkAgain")}
                              </Button>
                            ) : null}
                          </>
                        ) : c.status === "needs_auth" && onReconnect ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => onReconnect(c)}
                          >
                            {t("settings.connectors.status.needs_auth")}
                          </Button>
                        ) : null}
                        {onDisconnect && c.status !== "disconnected" ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => onDisconnect(c)}
                            aria-label={t("settings.connectors.disconnectNamed", { name: c.label })}
                          >
                            {t("settings.connectors.disconnect")}
                          </Button>
                        ) : null}
                        <RowMoreMenu
                          name={c.label}
                          items={[
                            {
                              label: technical
                                ? t("settings.actions.hideKey")
                                : t("settings.actions.showKey"),
                              onClick: () => toggleScopes(c.id),
                            },
                          ]}
                          destructive={
                            onRemove
                              ? [
                                  {
                                    label: t("common.remove"),
                                    title: t("settings.connectors.removeTitle", { name: c.label }),
                                    description: t("settings.connectors.removeDescription", {
                                      name: c.label,
                                    }),
                                    confirm: t("common.remove"),
                                    onConfirm: () => onRemove(c),
                                  },
                                ]
                              : []
                          }
                        />
                      </div>
                    </div>
                    {permission && c.status === "needs_auth" ? (
                      <PermissionNotice name={c.label} permission={permission} />
                    ) : null}
                    <CapabilityCard
                      connector={c}
                      actions={catalogue?.find((e) => e.type === c.type)?.actions ?? []}
                      persona={persona}
                      lifted={liftedFloors?.[c.id] ?? []}
                      {...(onRuleChange
                        ? {
                            onRuleChange: (action: string, rule: ActionRule, lift?: boolean) =>
                              onRuleChange(c, action, rule, lift),
                          }
                        : {})}
                      {...(onTry ? { onTry } : {})}
                      {...(defaultCapabilitiesOpen ? { defaultOpen: true } : {})}
                    />
                    {c.type === "apple:shortcuts" && c.status === "connected" ? (
                      <ConnectedShortcutsCard
                        connector={c}
                        {...(onConfigure
                          ? {
                              onConfigure: (config: Record<string, unknown>) =>
                                onConfigure(c, config),
                            }
                          : {})}
                      />
                    ) : null}
                    {trustedAppOf(c.type) !== null && c.status === "connected" ? (
                      <ConnectedTrustedSourcesCard
                        connector={c}
                        app={trustedAppOf(c.type) ?? "reminders"}
                        {...(onConfigure
                          ? {
                              onConfigure: (config: Record<string, unknown>) =>
                                onConfigure(c, config),
                            }
                          : {})}
                      />
                    ) : null}
                    {c.type === "obsidian" ? (
                      <ObsidianCard
                        connector={c}
                        granted={sharedFolders}
                        {...(onShareFolder
                          ? { onShare: (path: string) => onShareFolder(path, c.scopeMode) }
                          : {})}
                        {...(onConfigure
                          ? {
                              onConfigure: (config: Record<string, unknown>) =>
                                onConfigure(c, config),
                            }
                          : {})}
                      />
                    ) : null}
                  </article>
                </li>
              );
            })}
            {showMcp
              ? servers.map((s) => (
                  <li key={s.id}>
                    <McpServerRow
                      server={s}
                      {...(mcp ? { onRemove: mcp.remove, onSetEnabled: mcp.setEnabled } : {})}
                      {...(onTry ? { onTry } : {})}
                      {...(now === undefined ? {} : { now })}
                    />
                  </li>
                ))
              : null}
          </ul>
        )}
        {mcp && showMcp && onConnect ? (
          <AvailableConnectors
            mcp={mcp}
            onPreset={(id) => {
              setAddType(`preset:${id}`);
              setAdding(true);
            }}
          />
        ) : null}
      </LoadGate>
    </SectionFrame>
  );
}

export interface ConnectorsSectionProps {
  persona?: string;
  now?: number;
  /** Overrides the built-in `connectors.connect` flow (stories, tests). */
  onConnect?: (type: string, mode: ScopeMode) => void;
  onReconnect?: (connector: Connector) => void;
  onDisconnect?: (connector: Connector) => void;
  onRemove?: (connector: Connector) => void;
  onOpenSection?: (section: "channels") => void;
  /** Where the section opens: the MCP servers only, or with the Add MCP server form showing. */
  view?: ConnectorsView;
}

export type ConnectorsView = "mcp" | "add-mcp";

export function ConnectorsSection({
  persona,
  view,
  now,
  ...props
}: ConnectorsSectionProps): ReactElement {
  const fallback = usePersona();
  const mcp = useMcp(now);
  const q = useGatewayQuery("connectors.list", {});
  const implemented = useImplementedTypes();
  const catalogue = useGatewayQuery("connectors.catalogue", {}).data?.entries;
  // Action-group rules are the Permissions section's `permissions.connectors.<id>` overrides.
  const form = useSettingsForm();
  const connectors = withMatrixOverrides(q.data?.connectors ?? [], form.values);
  const onTry = usePrefillComposer();
  const call = useCall();
  const [configureError, setConfigureError] = useState<string | null>(null);
  // Built in unless the host supplies them: reconnect (for a macOS grant, the helper opens
  // System Settings) and re-check (#549).
  const reconnect = async (c: Connector, action: "check" | "open_settings") => {
    const catalogueId = await call("connectors.catalogue", {})
      .then((r) => r.entries.find((e) => e.type === c.type)?.id ?? c.type)
      .catch(() => c.type);
    await call("connectors.connect", {
      catalogueId,
      scopeMode: c.scopeMode,
      label: c.label,
      connectorId: c.id,
      config: { permissionAction: action },
    }).catch(() => undefined);
    q.reload();
  };
  // Check again asks macOS when it has not decided yet (#570), not just re-reading the state.
  const check = (c: Connector) => void reconnect(c, "check");
  // Connect drives the real sign-in unless the host supplies its own (#505).
  const flow = useConnectorConnect();
  const builtIn = props.onConnect === undefined;
  return (
    <div className="flex flex-col gap-3">
      <ConnectorsPanel
        // A new landing (⌘K "Add MCP server") starts the panel over on that view.
        key={view ?? "default"}
        {...props}
        {...(now === undefined ? {} : { now })}
        mcp={mcp}
        {...(view === undefined ? {} : { defaultFilter: "mcp" as const })}
        {...(view === "add-mcp" ? { defaultAddType: "mcp" } : {})}
        {...(builtIn
          ? {
              onConnect: (type: string, mode: ScopeMode, config?: Record<string, unknown>) =>
                void flow.start(
                  type,
                  mode,
                  CONNECTOR_CATALOG.find((c) => c.type === type)?.label ?? type,
                  config,
                ),
              connectProgress: (
                <ConnectProgress
                  state={flow.state}
                  onOpen={(url) => void flow.open(url)}
                  onCancel={flow.cancel}
                  onRetry={flow.retry}
                  onOpenSettings={() => void flow.openSettings()}
                  onRecheck={() => void flow.recheck()}
                />
              ),
            }
          : {})}
        onGrant={(c: Connector) => void reconnect(c, "open_settings")}
        onCheck={check}
        persona={persona ?? fallback.name}
        implemented={implemented}
        {...(catalogue ? { catalogue } : {})}
        liftedFloors={liftedFloorsOf(form.values)}
        onRuleChange={(c: Connector, action: string, rule: ActionRule, lift?: boolean) => {
          form.onChange(`permissions.connectors.${c.id}`, { ...c.actionMatrix, [action]: rule });
          if (lift !== undefined) {
            const key = `permissions.liftedFloors.${c.id}`;
            const was = liftedFloorsOf(form.values)[c.id] ?? [];
            const next = lift ? [...new Set([...was, action])] : was.filter((a) => a !== action);
            if (next.length !== was.length) form.onChange(key, next);
          }
        }}
        {...(onTry ? { onTry } : {})}
        sharedFolders={folderGrants(form.values).map((g) => g.path)}
        onShareFolder={(path: string, mode: ScopeMode) => {
          const grants = folderGrants(form.values).filter((g) => g.path !== path);
          form.onChange(
            POLICY_KEY,
            policyWithFolders(form.values, [
              ...grants,
              { path, access: mode === "read_act" ? "rw" : "ro" },
            ]),
          );
        }}
        onConfigure={(c: Connector, config: Record<string, unknown>) => {
          setConfigureError(null);
          void call("connectors.configure", { connectorId: c.id, config }).then(
            () => q.reload(),
            (err: unknown) => {
              setConfigureError(
                t("settings.connectors.configureFailed", {
                  name: c.label,
                  reason: describeError(err),
                }),
              );
              q.reload();
            },
          );
        }}
        connectors={connectors}
        loading={q.loading && q.data === undefined}
        error={q.error}
        onRetry={q.reload}
      />
      {form.writeError ? <ErrorNotice what={form.writeError} did="" /> : null}
      {configureError ? <ErrorNotice what={configureError} /> : null}
    </div>
  );
}
