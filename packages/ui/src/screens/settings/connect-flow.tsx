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
  | { phase: "not-configured"; type: string; label: string };

export function useConnectorConnect() {
  const store = useStore();
  const { openExternal } = useSlots();
  const [state, setState] = useState<ConnectState>({ phase: "idle" });
  const pending = useRef<{ connectorId: string; type: string; label: string } | null>(null);
  const last = useRef<{ type: string; mode: ScopeMode; label: string } | null>(null);

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

  const start = useCallback(
    async (type: string, mode: ScopeMode, label: string) => {
      last.current = { type, mode, label };
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
        });
        if (res.connector.status === "connected") {
          setState({ phase: "connected", type, label, connector: res.connector });
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

  const cancel = useCallback(() => {
    pending.current = null;
    setState({ phase: "idle" });
  }, []);

  const retry = useCallback(() => {
    const l = last.current;
    if (l) void start(l.type, l.mode, l.label);
  }, [start]);

  return { state, start, cancel, retry, open };
}

/** What the connect flow is doing, under the Connect button. */
export function ConnectProgress({
  state,
  onOpen,
  onCancel,
  onRetry,
}: {
  state: ConnectState;
  onOpen: (url: string) => void;
  onCancel: () => void;
  onRetry?: () => void;
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
  }
}
