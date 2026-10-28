import type { Connector } from "@psyche/protocol";
import { type ReactElement, useCallback, useEffect, useId, useState } from "react";
import { useCall, useGatewayQuery } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { describeError } from "../../i18n/errors.ts";
import { GROUP_ROWS, StatusChip, SwitchField } from "./shared.tsx";

/**
 * "These are mine — treat as trusted" for Reminders lists, Notes folders and the owner's own
 * calendars (security §3.6). Reading a trusted source does not make the chat ask again. The
 * choice is saved on the connector as `config.trustedSources` through `connectors.configure`,
 * which only Settings (the owner) can call. Shared or read-only sources show "Shared" and cannot
 * be turned on.
 */

export type TrustedApp = "reminders" | "notes" | "calendar";

/** The helper capability that lists each app's sources, and the key its result uses. */
const SOURCES: Record<TrustedApp, { capability: string; key: string }> = {
  reminders: { capability: "reminders.list_lists", key: "lists" },
  calendar: { capability: "calendar.list_calendars", key: "calendars" },
  notes: { capability: "notes.folders", key: "folders" },
};

export interface TrustSource {
  id: string;
  name: string;
  shared: boolean;
}

/** The app a connector type is, when it has trustable sources. */
export function trustedAppOf(type: string): TrustedApp | null {
  return type === "apple:reminders"
    ? "reminders"
    : type === "apple:notes"
      ? "notes"
      : type === "apple:calendar"
        ? "calendar"
        : null;
}

/** `config.trustedSources` of the connector: the ids the owner marked as theirs. */
export function trustedSources(c: Connector): string[] {
  const raw = c.config.trustedSources;
  return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : [];
}

function sourcesOf(app: TrustedApp, result: unknown): TrustSource[] {
  const list = (result as Record<string, unknown> | undefined)?.[SOURCES[app].key];
  if (!Array.isArray(list)) return [];
  const out: TrustSource[] = [];
  for (const s of list) {
    const o = s as { id?: unknown; title?: unknown; name?: unknown; writable?: unknown };
    if (typeof o?.id !== "string") continue;
    const name = typeof o.title === "string" ? o.title : typeof o.name === "string" ? o.name : o.id;
    // A list or calendar the owner cannot write to is shared, subscribed or a system calendar.
    out.push({ id: o.id, name, shared: o.writable === false });
  }
  return out;
}

/** The app's lists, folders or calendars, read from the paired helper (`nodes.invoke`). */
export function useHelperSources(
  app: TrustedApp,
  enabled: boolean,
): { sources: TrustSource[] | null; loading: boolean; error: string | null } {
  const call = useCall();
  const nodes = useGatewayQuery("nodes.list", {}, { enabled });
  const helper = nodes.data?.nodes.find((n) => n.kind === "mac-helper" && n.status === "online");
  const [state, setState] = useState<{ sources: TrustSource[] | null; error: string | null }>({
    sources: null,
    error: null,
  });
  const helperId = helper?.id ?? null;
  const load = useCallback(
    (nodeId: string) =>
      call("nodes.invoke", { nodeId, capability: SOURCES[app].capability, params: {} }).then(
        (r) =>
          r.ok
            ? setState({ sources: sourcesOf(app, r.result), error: null })
            : setState({
                sources: null,
                error: r.error ? describeError(r.error) : t("settings.trusted.failed"),
              }),
        (err: unknown) => setState({ sources: null, error: describeError(err) }),
      ),
    [call, app],
  );
  useEffect(() => {
    if (enabled && helperId !== null) void load(helperId);
  }, [enabled, helperId, load]);
  if (!enabled) return { sources: null, loading: false, error: null };
  if (nodes.data !== undefined && helperId === null)
    return { sources: null, loading: false, error: t("settings.trusted.noHelper") };
  return { ...state, loading: state.sources === null && state.error === null };
}

export interface TrustedSourcesCardProps {
  connector: Connector;
  app: TrustedApp;
  sources: readonly TrustSource[] | null;
  loading?: boolean;
  error?: string | null;
  /** Absent: read-only (no way to save). */
  onToggle?: (sourceId: string, trusted: boolean) => void;
}

export function TrustedSourcesCard({
  connector,
  app,
  sources,
  loading = false,
  error = null,
  onToggle,
}: TrustedSourcesCardProps): ReactElement {
  const id = useId();
  const trusted = new Set(trustedSources(connector));
  return (
    <div className="flex flex-col gap-2">
      <span id={`${id}-list`} className="text-callout text-label-secondary">
        {t(`settings.trusted.title.${app}`)}
      </span>
      {error ? (
        <p role="status" className="text-callout text-label-secondary">
          {error}
        </p>
      ) : loading || sources === null ? (
        <p className="text-callout text-label-tertiary">{t("settings.trusted.loading")}</p>
      ) : sources.length === 0 ? (
        <p className="text-callout text-label-tertiary">{t(`settings.trusted.none.${app}`)}</p>
      ) : (
        <ul aria-labelledby={`${id}-list`} className={GROUP_ROWS}>
          {sources.map((s) => (
            <li key={s.id} data-shared={s.shared}>
              <fieldset>
                <legend className="sr-only">{s.name}</legend>
                <SwitchField
                  label={t("settings.trusted.toggle")}
                  description={
                    <>
                      <span className="text-label-primary">{s.name}</span>{" "}
                      {s.shared ? (
                        <StatusChip tone="neutral">{t("settings.trusted.shared")}</StatusChip>
                      ) : null}
                    </>
                  }
                  checked={trusted.has(s.id) && !s.shared}
                  disabled={s.shared || onToggle === undefined}
                  onChange={(v) => onToggle?.(s.id, v)}
                />
              </fieldset>
            </li>
          ))}
        </ul>
      )}
      <p className="text-callout text-label-tertiary">{t("settings.trusted.hint")}</p>
    </div>
  );
}

/** The card with its sources read from the helper and the choice saved on the connector. */
export function ConnectedTrustedSourcesCard({
  connector,
  app,
  onConfigure,
}: {
  connector: Connector;
  app: TrustedApp;
  onConfigure?: (config: Record<string, unknown>) => void;
}): ReactElement {
  const list = useHelperSources(app, connector.status === "connected");
  return (
    <TrustedSourcesCard
      connector={connector}
      app={app}
      sources={list.sources}
      loading={list.loading}
      error={list.error}
      {...(onConfigure
        ? {
            onToggle: (sourceId: string, on: boolean) => {
              const next = new Set(trustedSources(connector));
              if (on) next.add(sourceId);
              else next.delete(sourceId);
              onConfigure({ trustedSources: [...next] });
            },
          }
        : {})}
    />
  );
}
