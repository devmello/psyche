import type { Connector, ConnectorAuthorization } from "@psyche/protocol";
import { Check, ExternalLink, Loader } from "lucide-react";
import { type ReactElement, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { useStore } from "../../data/index.ts";
import { t } from "../../i18n/core.ts";
import { describeError, errorCode } from "../../i18n/errors.ts";
import { useSlots } from "../../slots.tsx";
import type { ScopeMode } from "./ConnectorsSection.tsx";

/**
 * Connecting an account for real (#505): `connectors.connect` starts the sign-in, the consent
 * page opens in the owner's browser (unless the Gateway already opened it on its machine), and
 * the connector counts as connected only when the Gateway says so (`connectors.updated` with a
 * stored token). Onboarding and Settings → Connectors share this flow and read the same
 * `connectors.list`.
 */
export type ConnectState =
  | { phase: "idle" }
  | { phase: "starting"; type: string; label: string }
  | {
      phase: "signing-in";
      type: string;
      label: string;
      connectorId: string;
      authorization: ConnectorAuthorization;
    }
  | { phase: "connected"; type: string; label: string; connector: Connector }
  | { phase: "failed"; type: string; label: string; reason: string }
  | { phase: "unavailable"; type: string; label: string }
  /** The Gateway knows the connector but has no OAuth client for it (#524: Google's guide). */
  | { phase: "not-configured"; type: string; label: string }
  /** One per machine and already there (#549). */
  | { phase: "already-connected"; type: string; label: string; connectorId: string }
  /** Connected to the helper, but macOS has not allowed it yet (#549). */
  | {
      phase: "needs-permission";
      type: string;
      label: string;
      connectorId: string;
      mode: ScopeMode;
      permission: ConnectorPermission;
      checking?: boolean;
    };

/** A connector's wait on a macOS grant (#549, #570): `config.permission` as the UI reads it. */
export interface ConnectorPermission {
  settingsPath: string;
  /** `denied` (allow it in System Settings) or `notDetermined` (macOS has not asked yet). */
  state: string;
  /** Psyche asked macOS on the last try, and what the helper said when nothing came of it. */
  requested: boolean;
  reason: string | null;
}

/** `config.permission` of a connector waiting on a macOS grant, if any. */
export function permissionOf(c: Connector): ConnectorPermission | null {
  const p = c.config.permission;
  if (typeof p !== "object" || p === null || Array.isArray(p)) return null;
  const o = p as Record<string, unknown>;
  return {
    settingsPath: typeof o.settingsPath === "string" ? o.settingsPath : "",
    state: typeof o.state === "string" ? o.state : "denied",
    requested: o.requested === true,
    reason: typeof o.reason === "string" && o.reason !== "" ? o.reason : null,
  };
}

/**
 * What to tell the owner about a missing grant: where to allow a denied one, that macOS has
 * not asked yet, and the helper's reason when asking showed no prompt (#570).
 */
export function PermissionNotice({
  name,
  permission,
}: {
  name: string;
  permission: ConnectorPermission;
}): ReactElement {
  return (
    <>
      <p role="status">
        {permission.state === "denied" ? (
          <>
            {t("settings.connect.needsPermission", { name })}{" "}
            <span className="font-medium">{permission.settingsPath}</span>
          </>
        ) : (
          t("settings.connect.notAskedYet", { name })
        )}
      </p>
      {permission.requested && permission.reason ? (
        <p className="text-muted-foreground">
          {t("settings.connect.noPrompt", { reason: permission.reason })}
        </p>
      ) : null}
    </>
  );
}

export function useConnectorConnect() {
  const store = useStore();
  const { openExternal } = useSlots();
  const [state, setState] = useState<ConnectState>({ phase: "idle" });
  const pending = useRef<{ connectorId: string; type: string; label: string } | null>(null);
  const last = useRef<{
    type: string;
    mode: ScopeMode;
    label: string;
    config?: Record<string, unknown>;
  } | null>(null);

  const open = useCallback(
    async (url: string) => {
      if (openExternal) {
        try {
          await openExternal(url);
          return;
        } catch {
          // Fall back to the browser's own window.
        }
      }
      globalThis.open?.(url, "_blank", "noopener,noreferrer");
    },
    [openExternal],
  );

  // The sign-in finishes elsewhere; the Gateway announces the outcome.
  useEffect(
    () =>
      store.client.subscribe((e) => {
        if (e.event !== "connectors.updated") return;
        const p = pending.current;
        const { connector, reason, error } = e.payload;
        if (p === null || connector.id !== p.connectorId) return;
        if (connector.status === "connected") {
          pending.current = null;
          setState({ phase: "connected", type: p.type, label: p.label, connector });
        } else if (connector.status === "needs_auth" && permissionOf(connector) !== null) {
          // Still waiting on macOS: keep the permission card (a re-check answered).
          setState((s) => (s.phase === "needs-permission" ? { ...s, checking: false } : s));
        } else if (reason === "authorization_failed" || connector.status === "error") {
          pending.current = null;
          setState({
            phase: "failed",
            type: p.type,
            label: p.label,
            reason: error ?? t("settings.connect.signInFailed"),
          });
        }
      }),
    [store],
  );

  // A consent page that is never finished expires.
  useEffect(() => {
    if (state.phase !== "signing-in") return;
    const left = state.authorization.expiresAt - Date.now();
    const timer = setTimeout(
      () => {
        if (pending.current?.connectorId !== state.connectorId) return;
        pending.current = null;
        setState({
          phase: "failed",
          type: state.type,
          label: state.label,
          reason: t("settings.connect.expired"),
        });
      },
      Math.max(0, left),
    );
    return () => clearTimeout(timer);
  }, [state]);

  /**
   * One `connectors.connect` and what it leads to: connected, a macOS permission to give, a
   * sign-in to finish, or a refusal. `connectorId` resumes an existing instance (#620): a
   * waiting macOS grant is asked for again (`permissionAction: "check"`, #570), an OAuth one
   * restarts its sign-in.
   */
  const connectWith = useCallback(
    async (
      type: string,
      mode: ScopeMode,
      label: string,
      resume?: { connectorId: string; permission: boolean },
      config?: Record<string, unknown>,
    ): Promise<void> => {
      setState({ phase: "starting", type, label });
      try {
        // The catalogue names the entry to connect; older Gateways without it take the type.
        const catalogueId = await store
          .call("connectors.catalogue", {})
          .then((r) => r.entries.find((e) => e.type === type)?.id ?? type)
          .catch(() => type);
        const res = await store.call("connectors.connect", {
          catalogueId,
          scopeMode: mode,
          label,
          ...(config === undefined ? {} : { config }),
          ...(resume === undefined
            ? {}
            : {
                connectorId: resume.connectorId,
                ...(resume.permission ? { config: { permissionAction: "check" } } : {}),
              }),
        });
        const permission = permissionOf(res.connector);
        if (res.connector.status === "connected") {
          setState({ phase: "connected", type, label, connector: res.connector });
        } else if (permission !== null) {
          pending.current = { connectorId: res.connector.id, type, label };
          setState({
            phase: "needs-permission",
            type,
            label,
            connectorId: res.connector.id,
            mode,
            permission,
          });
        } else if (res.authorization) {
          pending.current = { connectorId: res.connector.id, type, label };
          setState({
            phase: "signing-in",
            type,
            label,
            connectorId: res.connector.id,
            authorization: res.authorization,
          });
          if (!res.authorization.opened) void open(res.authorization.url);
        } else {
          setState({ phase: "failed", type, label, reason: t("settings.connect.noSignIn") });
        }
      } catch (err) {
        const code = errorCode(err);
        const reason = (err as { details?: { reason?: unknown } }).details?.reason;
        if (code === "conflict" && reason === "already_connected" && resume === undefined) {
          // One per machine and already there (#549). Only a connected one is done; one still
          // waiting on a permission, a sign-in or an error is resumed instead (#620).
          const id = (err as { details?: { connectorId?: unknown } }).details?.connectorId;
          const existing = await store
            .call("connectors.list", {})
            .then((r) => r.connectors.find((c) => c.id === id))
            .catch(() => undefined);
          if (existing !== undefined && existing.status !== "connected") {
            await connectWith(type, existing.scopeMode, label, {
              connectorId: existing.id,
              permission: permissionOf(existing) !== null,
            });
            return;
          }
          setState({
            phase: "already-connected",
            type,
            label,
            connectorId: typeof id === "string" ? id : "",
          });
          return;
        }
        setState(
          code === "not_implemented" || code === "unknown_method"
            ? { phase: "unavailable", type, label }
            : code === "unavailable" && reason === "not_configured"
              ? { phase: "not-configured", type, label }
              : { phase: "failed", type, label, reason: describeError(err) },
        );
      }
    },
    [store, open],
  );

  const start = useCallback(
    /** `config`: non-secret settings the connector needs to connect (Obsidian's `vaultPath`). */
    async (type: string, mode: ScopeMode, label: string, config?: Record<string, unknown>) => {
      last.current = { type, mode, label, ...(config ? { config } : {}) };
      await connectWith(type, mode, label, undefined, config);
    },
    [connectWith],
  );

  /** Continues an instance that is not connected yet: its permission, sign-in or error (#620). */
  const resume = useCallback(
    async (connector: Connector, label: string) => {
      last.current = { type: connector.type, mode: connector.scopeMode, label };
      await connectWith(connector.type, connector.scopeMode, label, {
        connectorId: connector.id,
        permission: permissionOf(connector) !== null,
      });
    },
    [connectWith],
  );

  const cancel = useCallback(() => {
    pending.current = null;
    setState({ phase: "idle" });
  }, []);

  const retry = useCallback(() => {
    const l = last.current;
    if (l) void start(l.type, l.mode, l.label, l.config);
  }, [start]);

  /**
   * Retries a connector waiting on a macOS grant (#570): `check` asks macOS again while it has
   * not decided (the prompt appears on the Mac); `open_settings` opens System Settings when it
   * denied. Both re-read the grant and show where it stands.
   */
  const retryPermission = useCallback(
    async (action: "check" | "open_settings") => {
      const s = state;
      if (s.phase !== "needs-permission") return;
      setState({ ...s, checking: true });
      const catalogueId = await store
        .call("connectors.catalogue", {})
        .then((r) => r.entries.find((e) => e.type === s.type)?.id ?? s.type)
        .catch(() => s.type);
      await store
        .call("connectors.connect", {
          catalogueId,
          scopeMode: s.mode,
          label: s.label,
          connectorId: s.connectorId,
          config: { permissionAction: action },
        })
        .then((res) => {
          if (res.connector.status === "connected") {
            pending.current = null;
            setState({
              phase: "connected",
              type: s.type,
              label: s.label,
              connector: res.connector,
            });
          } else {
            const permission = permissionOf(res.connector) ?? s.permission;
            setState({ ...s, permission, checking: false });
          }
        })
        .catch((err: unknown) =>
          setState({ phase: "failed", type: s.type, label: s.label, reason: describeError(err) }),
        );
    },
    [state, store],
  );
  const openSettings = useCallback(() => retryPermission("open_settings"), [retryPermission]);
  const recheck = useCallback(() => retryPermission("check"), [retryPermission]);

  return { state, start, resume, cancel, retry, open, openSettings, recheck };
}

/** What the connect flow is doing, under the Connect button. */
export function ConnectProgress({
  state,
  onOpen,
  onCancel,
  onRetry,
  onOpenSettings,
  onRecheck,
}: {
  state: ConnectState;
  onOpen: (url: string) => void;
  onCancel: () => void;
  onRetry?: () => void;
  onOpenSettings?: () => void;
  onRecheck?: () => void;
}): ReactElement | null {
  switch (state.phase) {
    case "idle":
      return null;
    case "starting":
      return (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader className="size-4 motion-safe:animate-spin" aria-hidden="true" />
          {t("settings.connect.starting", { name: state.label })}
        </p>
      );
    case "signing-in":
      return (
        <div
          className="flex flex-col gap-2 rounded-lg border border-gray-6 bg-gray-2 p-3 text-sm"
          data-testid="connect-signing-in"
        >
          <p className="flex items-center gap-2" role="status">
            <Loader className="size-4 motion-safe:animate-spin" aria-hidden="true" />
            {state.authorization.opened
              ? t("settings.connect.finishOpened", { name: state.label })
              : t("settings.connect.finish", { name: state.label })}
          </p>
          {state.authorization.userCode ? (
            <p>
              {t("settings.connect.enterCode")}{" "}
              <code className="rounded bg-gray-4 px-1.5 py-0.5 font-mono text-base tracking-widest select-all">
                {state.authorization.userCode}
              </code>
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => onOpen(state.authorization.url)}
            >
              <ExternalLink aria-hidden="true" />
              {t("settings.connect.openPage")}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      );
    case "connected":
      return (
        <p className="flex items-center gap-2 text-sm text-success-text" role="status">
          <Check className="size-4" aria-hidden="true" />
          {state.connector.account
            ? t("settings.connect.connectedAs", {
                name: state.label,
                account: state.connector.account,
              })
            : t("settings.connect.connected", { name: state.label })}
        </p>
      );
    case "failed":
      return (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <p className="text-danger-text" role="alert">
            {t("settings.connect.failed", { name: state.label, reason: state.reason })}
          </p>
          {onRetry ? (
            <Button type="button" size="sm" variant="outline" onClick={onRetry}>
              {t("common.tryAgain")}
            </Button>
          ) : null}
        </div>
      );
    case "not-configured":
      return (
        <p className="text-sm text-muted-foreground" role="status">
          {t("settings.connect.notConfigured", { name: state.label })}
        </p>
      );
    case "unavailable":
      return (
        <p className="text-sm text-muted-foreground" role="status">
          {t("settings.connect.unavailable", { name: state.label })}
        </p>
      );
    case "already-connected":
      return (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Check className="size-4" aria-hidden="true" />
          {t("settings.connect.alreadyConnected", { name: state.label })}
        </p>
      );
    case "needs-permission":
      return (
        <div
          className="flex flex-col gap-2 rounded-lg border border-approval-border bg-gray-2 p-3 text-sm"
          data-testid="connect-needs-permission"
        >
          <PermissionNotice name={state.label} permission={state.permission} />
          <div className="flex flex-wrap gap-2">
            {/* macOS asks only once: System Settings is the way only after a denial (#570). */}
            {onOpenSettings && state.permission.state === "denied" ? (
              <Button
                type="button"
                size="sm"
                onClick={onOpenSettings}
                disabled={state.checking === true}
              >
                <ExternalLink aria-hidden="true" />
                {t("settings.connect.openSystemSettings")}
              </Button>
            ) : null}
            {onRecheck ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={onRecheck}
                disabled={state.checking === true}
              >
                {t("settings.connect.checkAgain")}
              </Button>
            ) : null}
            <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
              {t("common.close")}
            </Button>
          </div>
        </div>
      );
  }
}
