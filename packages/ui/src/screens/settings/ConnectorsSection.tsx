import type { Connector, ConnectorCatalogueEntry } from "@psyche/protocol";
import { Plug } from "lucide-react";
import { type ReactElement, type ReactNode, useEffect, useRef, useState } from "react";
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
import { ConnectForm, galleryEntries } from "./ConnectForm.tsx";
import { ConnectorDetail, lastUsed, trustTier } from "./ConnectorDetail.tsx";
import { AddMore } from "./ConnectorGallery.tsx";
import { ConnectorIcon } from "./ConnectorIcon.tsx";
import { ConnectorRow, DetailFrame } from "./ConnectorRow.tsx";
import { ConnectProgress, permissionOf, useConnectorConnect } from "./connect-flow.tsx";
import { CONNECTOR_CATALOG, type ScopeMode, useImplementedTypes } from "./connector-catalog.tsx";
import { FilesOnMacCard, type PolicyValues, TerminalCard } from "./DeviceAccessCards.tsx";
import {
  execHostEnabled,
  folderGrants,
  POLICY_KEY,
  policyWithFolders,
} from "./FileAccessSection.tsx";
import { McpFailureNotice } from "./McpFailureNotice.tsx";
import {
  McpServerDetail,
  McpServerIcon,
  mcpNeedsYou,
  mcpStatus,
  mcpSubtitle,
} from "./McpServerDetail.tsx";
import {
  Advanced,
  ErrorNotice,
  Group,
  LoadGate,
  type LoadProps,
  SectionFrame,
  StatusChip,
  type Tone,
  useSettingsForm,
} from "./shared.tsx";
import { type McpState, useMcp } from "./use-mcp.tsx";

/**
 * Connectors (UI design §3.18; architecture §4.9), one page that answers three questions: what is
 * connected and working, what needs me, and what can I add. Each connected thing is one compact
 * row; its details (what it can do, tools, trust, why it failed) open in a view of their own.
 * Your own tool servers and the registry search sit under Advanced.
 */

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
export { trustTier };

/** What the page shows: the list, the gallery to add from, or one item's detail. */
type View =
  | { kind: "list" }
  | { kind: "add"; type?: string | undefined }
  | { kind: "detail"; id: string };

/** The card of rows that need the owner: amber is for "needs you" only. */
const ATTENTION_CARD = "border-approval-border bg-approval-surface";

/** The ids of the two device rows, which are views onto Permissions rather than connectors. */
const FILES_ID = "device:files";
const TERMINAL_ID = "device:terminal";

interface RowData {
  key: string;
  name: string;
  icon: ReactElement;
  subtitle: string;
  status: { tone: Tone; label: string } | null;
  fix: { label: string; ariaLabel?: string; onClick: () => void } | null;
  group: "needs" | "working" | "paused";
  id: string;
}

export interface ConnectorsPanelProps extends LoadProps {
  connectors: readonly Connector[];
  persona: string;
  now?: number;
  /** `config`: what a connector needs to connect (Obsidian's `vaultPath`). */
  onConnect?: (type: string, mode: ScopeMode, config?: Record<string, unknown>) => void;
  onReconnect?: (connector: Connector) => void;
  onDisconnect?: (connector: Connector) => void;
  onRemove?: (connector: Connector) => void;
  /** Which rows offer Remove (default: all, when `onRemove` is given). */
  removable?: (connector: Connector) => boolean;
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
  onOpenSection?: (section: "channels" | "files") => void;
  /**
   * The settings that decide device access (`permissions.policy`): Files on this Mac and Terminal
   * are views onto them, shown above the list.
   */
  policy?: PolicyValues;
  /** MCP servers, listed with the connectors and added from the catalogue's Custom MCP server row. */
  mcp?: McpState;
  /** Opens Advanced (your own tool servers), where the old MCP route lands. */
  defaultAdvancedOpen?: boolean;
  /** Opens one connector's (or tool server's) detail straight away (stories). */
  defaultOpenId?: string;
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
  removable,
  defaultAdding = false,
  connectProgress,
  implemented,
  onOpenSection,
  policy,
  mcp,
  defaultAdvancedOpen = false,
  defaultOpenId,
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
  const [view, setView] = useState<View>(
    defaultAdding || defaultAddType !== undefined
      ? { kind: "add", type: defaultAddType }
      : defaultOpenId !== undefined
        ? { kind: "detail", id: defaultOpenId }
        : { kind: "list" },
  );
  const list = () => setView({ kind: "list" });
  // The old MCP route lands with Advanced open (`Advanced` has no `open` prop to pass).
  const advancedRef = useRef<HTMLDivElement>(null);
  const advancedOpened = useRef(false);
  // Runs each render: the fold mounts only once the list has loaded.
  useEffect(() => {
    const details = advancedRef.current?.querySelector("details");
    if (!details || !defaultAdvancedOpen || advancedOpened.current) return;
    details.open = true;
    advancedOpened.current = true;
  });
  const servers = mcp?.servers ?? [];
  const total = connectors.length + servers.length;
  const review = mcp?.review ?? null;

  // A server added from the form shows up in the list: go back to it.
  const serverCount = useRef(servers.length);
  useEffect(() => {
    if (servers.length > serverCount.current && view.kind === "add") setView({ kind: "list" });
    serverCount.current = servers.length;
  }, [servers.length, view.kind]);

  const connectedTypes = new Set(
    connectors.filter((c) => c.status !== "disconnected").map((c) => c.type),
  );
  const open = (id: string) => () => setView({ kind: "detail", id });
  const folders = policy ? folderGrants(policy.values).length : 0;

  const rows: RowData[] = [
    ...connectors.map((c): RowData => {
      const permission = permissionOf(c);
      const waiting = permission !== null && c.status === "needs_auth";
      const used = lastUsed(c);
      const status: RowData["status"] = waiting
        ? { tone: "approval", label: t("settings.connectors.status.needsPermission") }
        : c.status === "needs_auth"
          ? { tone: "approval", label: t("settings.connectors.page.status.signInExpired") }
          : c.status === "error"
            ? { tone: "approval", label: t("settings.connectors.page.status.notWorking") }
            : c.status === "connected"
              ? { tone: "success", label: t("settings.connectors.status.connected") }
              : { tone: "neutral", label: t("settings.connectors.status.disconnected") };
      const fix: RowData["fix"] =
        waiting && onGrant && permission.state === "denied"
          ? {
              label: t("settings.connect.openSystemSettings"),
              ariaLabel: `${t("settings.connect.openSystemSettings")}: ${c.label}`,
              onClick: () => onGrant(c),
            }
          : waiting && onCheck
            ? {
                label: t("settings.connect.checkAgain"),
                ariaLabel: `${t("settings.connect.checkAgain")}: ${c.label}`,
                onClick: () => onCheck(c),
              }
            : !waiting && c.status === "needs_auth" && onReconnect
              ? {
                  label: t("settings.connectors.status.needs_auth"),
                  ariaLabel: `${t("settings.connectors.status.needs_auth")}: ${c.label}`,
                  onClick: () => onReconnect(c),
                }
              : c.status === "error"
                ? {
                    label: t("settings.connectors.page.fix.seeWhy"),
                    ariaLabel: `${t("settings.connectors.page.fix.seeWhy")}: ${c.label}`,
                    onClick: open(c.id),
                  }
                : null;
      const parts = [
        c.account,
        used === null
          ? t("settings.connectors.page.row.never")
          : t("settings.connectors.page.row.lastUsed", { when: formatRelative(used, clock) }),
        c.type === "mcp" && trustTier(c) === "unverified"
          ? t("settings.connectors.page.row.unverified")
          : null,
      ];
      return {
        key: `c:${c.id}`,
        id: c.id,
        name: c.label,
        icon: <ConnectorIcon type={c.type} />,
        subtitle: parts.filter((p) => p !== null).join(" · "),
        status,
        fix,
        group:
          c.status === "disconnected" ? "paused" : c.status === "connected" ? "working" : "needs",
      };
    }),
    ...servers.map((s): RowData => {
      const needs = mcpNeedsYou(s);
      return {
        key: `m:${s.id}`,
        id: s.id,
        name: s.name,
        icon: <McpServerIcon server={s} />,
        subtitle: mcpSubtitle(s),
        status: mcpStatus(s),
        fix: needs
          ? {
              label: t("settings.connectors.page.fix.seeWhy"),
              ariaLabel: `${t("settings.connectors.page.fix.seeWhy")}: ${s.name}`,
              onClick: open(s.id),
            }
          : null,
        group: needs ? "needs" : s.enabled === false ? "paused" : "working",
      };
    }),
  ];
  const renderRows = (group: RowData["group"]) =>
    rows
      .filter((r) => r.group === group)
      .map((r) => (
        <ConnectorRow
          key={r.key}
          name={r.name}
          icon={r.icon}
          subtitle={r.subtitle}
          status={r.status}
          fix={r.fix}
          onOpen={open(r.id)}
        />
      ));
  const has = (group: RowData["group"]) => rows.some((r) => r.group === group);

  const addButton = onConnect ? (
    <Button type="button" size="sm" onClick={() => setView({ kind: "add" })}>
      <Plug aria-hidden="true" /> {t("settings.connectors.connect")}
    </Button>
  ) : null;

  // What the detail view is about: a connector, a tool server or one of the two Mac rows.
  const detailId = view.kind === "detail" ? view.id : null;
  const connector = connectors.find((c) => c.id === detailId);
  const server = connector ? undefined : servers.find((s) => s.id === detailId);
  const device = detailId === FILES_ID || detailId === TERMINAL_ID ? detailId : null;
  const showing: "list" | "add" | "detail" =
    view.kind === "add" ? "add" : connector || server || device ? "detail" : "list";

  const statusLine = (tone: Tone, label: string, rest: ReactNode) => (
    <span className="flex flex-wrap items-center gap-x-2">
      <StatusChip tone={tone}>{label}</StatusChip>
      {rest}
    </span>
  );
  const rowStatus = connector ? rows.find((r) => r.id === connector.id)?.status : null;
  // A detail or the gallery takes the title's place, with Back above it.
  const detailFrame =
    showing === "add"
      ? { title: t("settings.connectors.page.gallery.title"), status: undefined }
      : connector
        ? {
            title: connector.label,
            status: statusLine(
              rowStatus?.tone ?? "neutral",
              rowStatus?.label ?? "",
              connector.account ? <span>{connector.account}</span> : null,
            ),
          }
        : server
          ? {
              title: server.name,
              status: statusLine(
                mcpStatus(server).tone,
                mcpStatus(server).label,
                <span>{mcpSubtitle(server)}</span>,
              ),
            }
          : showing === "detail"
            ? { title: t("settings.connectors.page.onThisMac"), status: undefined }
            : null;

  const body = (
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
      {mcp?.actionError && !(server && mcpNeedsYou(server)) ? (
        <McpFailureNotice message={mcp.actionError} failure={mcp.actionFailure} mcp={mcp} />
      ) : null}
      {review}
      {showing === "add" && onConnect ? (
        // Hidden, not unmounted, while the trust card is open: cancelling it returns to the form.
        <div hidden={review !== null}>
          <ConnectForm
            key={view.kind === "add" ? (view.type ?? "gallery") : "gallery"}
            persona={persona}
            initialType={view.kind === "add" ? view.type : undefined}
            {...(onTry ? { onTry } : {})}
            {...(mcp ? { mcp } : {})}
            implemented={implemented}
            connectedTypes={connectedTypes}
            {...(onOpenSection ? { onOpenSection } : {})}
            sharedFolders={sharedFolders}
            {...(onShareFolder ? { onShareFolder } : {})}
            onCancel={list}
            onConnect={(type, mode, config) => {
              if (config === undefined) onConnect(type, mode);
              else onConnect(type, mode, config);
              list();
            }}
          />
        </div>
      ) : null}
      {showing === "detail" && connector ? (
        <ConnectorDetail
          connector={connector}
          persona={persona}
          now={clock}
          actions={catalogue?.find((e) => e.type === connector.type)?.actions ?? []}
          lifted={liftedFloors?.[connector.id] ?? []}
          sharedFolders={sharedFolders}
          {...(onReconnect ? { onReconnect } : {})}
          {...(onDisconnect ? { onDisconnect } : {})}
          {...(onRemove
            ? {
                onRemove: (c: Connector) => {
                  onRemove(c);
                  list();
                },
              }
            : {})}
          {...(removable ? { removable } : {})}
          {...(onGrant ? { onGrant } : {})}
          {...(onCheck ? { onCheck } : {})}
          {...(onRuleChange ? { onRuleChange } : {})}
          {...(onTry ? { onTry } : {})}
          {...(onShareFolder ? { onShareFolder } : {})}
          {...(onConfigure ? { onConfigure } : {})}
          {...(defaultCapabilitiesOpen ? { defaultCapabilitiesOpen } : {})}
        />
      ) : null}
      {showing === "detail" && server ? (
        <McpServerDetail
          server={server}
          {...(mcp ? { mcp } : {})}
          {...(mcp
            ? {
                onRemove: (s: typeof server) => {
                  mcp.remove(s);
                  list();
                },
                onSetEnabled: mcp.setEnabled,
              }
            : {})}
          {...(onTry ? { onTry } : {})}
          {...(now === undefined ? {} : { now })}
        />
      ) : null}
      {showing === "detail" && device === FILES_ID && policy ? (
        <FilesOnMacCard
          values={policy.values}
          persona={persona}
          {...(onOpenSection ? { onOpenFileAccess: () => onOpenSection("files") } : {})}
        />
      ) : null}
      {showing === "detail" && device === TERMINAL_ID && policy ? (
        <TerminalCard
          values={policy.values}
          persona={persona}
          {...(onOpenSection ? { onOpenFileAccess: () => onOpenSection("files") } : {})}
        />
      ) : null}
      {showing === "list" ? (
        <>
          {has("needs") ? (
            <Group title={t("settings.connectors.page.needsYou")} className={ATTENTION_CARD}>
              {renderRows("needs")}
            </Group>
          ) : null}
          {total === 0 ? (
            <EmptyState
              icon={Plug}
              className="elevation-1 py-10"
              {...(onConnect
                ? {
                    action: {
                      label: t("settings.connectors.connect"),
                      onClick: () => setView({ kind: "add" }),
                    },
                  }
                : {})}
            >
              {t("settings.connectors.empty", { persona })}
            </EmptyState>
          ) : has("working") ? (
            <Group title={t("settings.connectors.page.connected")}>{renderRows("working")}</Group>
          ) : null}
          {has("paused") ? (
            <Group title={t("settings.connectors.page.paused")}>{renderRows("paused")}</Group>
          ) : null}
          {policy ? (
            <Group title={t("settings.connectors.page.onThisMac")}>
              <ConnectorRow
                name={t("settings.deviceAccess.files.title")}
                icon={<ConnectorIcon type={FILES_ID} />}
                subtitle={t("settings.connectors.page.row.files", { count: folders })}
                onOpen={open(FILES_ID)}
              />
              <ConnectorRow
                name={t("settings.deviceAccess.terminal.title")}
                icon={<ConnectorIcon type={TERMINAL_ID} />}
                subtitle={
                  execHostEnabled(policy.values)
                    ? t("settings.connectors.page.row.terminal.on")
                    : t("settings.connectors.page.row.terminal.off")
                }
                status={
                  execHostEnabled(policy.values)
                    ? { tone: "success", label: t("settings.connectors.page.status.on") }
                    : { tone: "neutral", label: t("settings.connectors.page.status.off") }
                }
                onOpen={open(TERMINAL_ID)}
              />
            </Group>
          ) : null}
          {onConnect && total > 0 ? (
            <AddMore
              entries={galleryEntries({
                implemented,
                connectedTypes,
                mcp: mcp !== undefined,
                slack: onOpenSection !== undefined,
                pick: (type) => setView({ kind: "add", type }),
              })}
              onBrowse={() => setView({ kind: "add" })}
            />
          ) : null}
          {onConnect && mcp ? (
            <div ref={advancedRef}>
              <Advanced description={t("settings.connectors.page.advanced.hint")}>
                <Group
                  title={t("settings.connectors.page.advanced.custom")}
                  description={t("settings.connectors.page.advanced.customHint")}
                  actions={
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setView({ kind: "add", type: "mcp" })}
                    >
                      {t("settings.connectors.page.advanced.customAction")}
                    </Button>
                  }
                />
                <AvailableConnectors
                  mcp={mcp}
                  onPreset={(id) => setView({ kind: "add", type: `preset:${id}` })}
                />
              </Advanced>
            </div>
          ) : null}
        </>
      ) : null}
    </LoadGate>
  );
  return detailFrame ? (
    <DetailFrame title={detailFrame.title} status={detailFrame.status} onBack={list}>
      {body}
    </DetailFrame>
  ) : (
    <SectionFrame
      title={t("settings.connectors.title")}
      description={t("settings.connectors.page.description", { persona })}
      // One primary action: the header's button, or the empty state's when nothing is connected.
      actions={total > 0 || loading || error ? addButton : null}
    >
      {body}
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
  onOpenSection?: (section: "channels" | "files") => void;
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
  // Disconnect, Sign in again and Remove call the Gateway unless the host supplies its own; only
  // a custom connector can be removed (`connectors.removeCustom`), so only its row offers it.
  const act = (method: "connectors.disconnect" | "connectors.removeCustom", c: Connector) => {
    setConfigureError(null);
    void call(method, { connectorId: c.id }).then(
      () => q.reload(),
      (err: unknown) => {
        setConfigureError(
          t("settings.connectors.actionFailed", { name: c.label, reason: describeError(err) }),
        );
        q.reload();
      },
    );
  };
  const builtInActions = {
    onDisconnect: props.onDisconnect ?? ((c: Connector) => act("connectors.disconnect", c)),
    onReconnect: props.onReconnect ?? ((c: Connector) => void flow.resume(c, c.label)),
    ...(props.onRemove
      ? {}
      : {
          onRemove: (c: Connector) => act("connectors.removeCustom", c),
          removable: (c: Connector) => c.type === "custom",
        }),
  };
  return (
    <div className="flex flex-col gap-3">
      <ConnectorsPanel
        // A new landing (⌘K "Add MCP server") starts the panel over on that view.
        key={view ?? "default"}
        {...props}
        {...builtInActions}
        {...(now === undefined ? {} : { now })}
        mcp={mcp}
        {...(view === undefined ? {} : { defaultAdvancedOpen: true })}
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
        policy={{ values: form.values, onChange: form.onChange }}
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
