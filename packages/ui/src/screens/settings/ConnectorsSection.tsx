import type { Connector } from "@psyche/protocol";
import { Plug } from "lucide-react";
import { type ReactElement, type ReactNode, useId, useState } from "react";
import { EmptyState } from "../../components/page.tsx";
import { Button } from "../../components/ui/button.tsx";
import { NativeSelect } from "../../components/ui/native-select.tsx";
import { useGatewayQuery } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { formatRelative } from "../../lib/format.ts";
import { useNow } from "../../lib/use-now.ts";
import { usePersona } from "../../slots.tsx";
import { ConnectProgress, useConnectorConnect } from "./connect-flow.tsx";
import { RowMoreMenu } from "./RowMoreMenu.tsx";
import {
  Group,
  LoadGate,
  type LoadProps,
  RadioField,
  SectionFrame,
  StatusChip,
  type Tone,
} from "./shared.tsx";

/** Connectors (UI design §3.18; architecture §4.9). */

export type ScopeMode = Connector["scopeMode"];

/** "Read only" / "Read and act", read in the active language on each access. */
export const SCOPE_MODE_LABEL: Readonly<Record<ScopeMode, string>> = {
  get read() {
    return t("settings.connectors.scope.read");
  },
  get read_act() {
    return t("settings.connectors.scope.read_act");
  },
};

/** Read-only vs read-and-act, asked on every connect (Muse asks whether to read mail or also send). */
export function ConnectAccessChoice({
  label,
  value,
  onChange,
  persona,
}: {
  label: string;
  value: ScopeMode;
  onChange: (mode: ScopeMode) => void;
  persona: string;
}): ReactElement {
  return (
    <RadioField
      label={label}
      value={value}
      onChange={onChange}
      options={[
        {
          value: "read",
          label: SCOPE_MODE_LABEL.read,
          hint: t("settings.connectors.scope.readHint", { persona }),
        },
        {
          value: "read_act",
          label: SCOPE_MODE_LABEL.read_act,
          hint: t("settings.connectors.scope.readActHint", { persona }),
        },
      ]}
    />
  );
}

/** Connector types offered in the connect flow (and onboarding). */
type CatalogType =
  | "google"
  | "microsoft"
  | "imap"
  | "apple:notes"
  | "apple:reminders"
  | "apple:calendar"
  | "apple:mail"
  | "mcp";

/** Message ids for connector types (ids can't hold the type's colon). */
const CATALOG_ID = {
  google: "google",
  microsoft: "microsoft",
  imap: "imap",
  "apple:notes": "appleNotes",
  "apple:reminders": "appleReminders",
  "apple:calendar": "appleCalendar",
  "apple:mail": "appleMail",
  mcp: "mcp",
} as const satisfies Record<CatalogType, string>;

const catalogEntry = <T extends CatalogType>(type: T) => ({
  type,
  /** The connector's name, in the active language. */
  get label(): string {
    return t(`settings.connectors.catalog.${CATALOG_ID[type as CatalogType]}`);
  },
});

export const CONNECTOR_CATALOG = [
  catalogEntry("google"),
  catalogEntry("microsoft"),
  catalogEntry("imap"),
  catalogEntry("apple:notes"),
  catalogEntry("apple:reminders"),
  catalogEntry("apple:calendar"),
  catalogEntry("apple:mail"),
  catalogEntry("mcp"),
] as const;

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

export interface ConnectorsPanelProps extends LoadProps {
  connectors: readonly Connector[];
  persona: string;
  now?: number;
  onConnect?: (type: string, mode: ScopeMode) => void;
  onReconnect?: (connector: Connector) => void;
  onDisconnect?: (connector: Connector) => void;
  onRemove?: (connector: Connector) => void;
  /** Opens with the connect form showing (stories). */
  defaultAdding?: boolean;
  /** The sign-in under way, shown above the list (#505). */
  connectProgress?: ReactNode;
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
  loading,
  error,
  onRetry,
}: ConnectorsPanelProps): ReactElement {
  const clock = useNow(30_000, now);
  const [adding, setAdding] = useState(defaultAdding);
  const addButton = onConnect ? (
    <Button type="button" size="sm" onClick={() => setAdding(true)} disabled={adding}>
      <Plug aria-hidden="true" /> {t("settings.connectors.connect")}
    </Button>
  ) : null;
  return (
    <SectionFrame
      title={t("settings.connectors.title")}
      description={t("settings.connectors.description")}
      // One primary action: the header's button, or the empty state's when nothing is connected.
      actions={connectors.length > 0 || loading || error ? addButton : null}
    >
      <LoadGate
        label={t("settings.connectors.loadLabel")}
        loading={loading ?? false}
        error={error ?? null}
        {...(onRetry ? { onRetry } : {})}
      >
        {connectProgress}
        {adding && onConnect ? (
          <ConnectForm
            persona={persona}
            onCancel={() => setAdding(false)}
            onConnect={(type, mode) => {
              onConnect(type, mode);
              setAdding(false);
            }}
          />
        ) : null}
        {connectors.length === 0 ? (
          adding ? null : (
            <EmptyState
              icon={Plug}
              className="elevation-1 py-10"
              {...(onConnect
                ? {
                    action: {
                      label: t("settings.connectors.connect"),
                      onClick: () => setAdding(true),
                    },
                  }
                : {})}
            >
              {t("settings.connectors.empty", { persona })}
            </EmptyState>
          )
        ) : (
          <ul className="flex flex-col gap-3">
            {connectors.map((c) => {
              const used = lastUsed(c);
              return (
                <li key={c.id}>
                  <article
                    aria-label={c.label}
                    className="rounded-lg border border-gray-6 bg-gray-2 p-4 text-sm"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-base font-semibold">{c.label}</h3>
                      <StatusChip tone={STATUS_TONE[c.status]}>
                        {t(`settings.connectors.status.${c.status}`)}
                      </StatusChip>
                      <StatusChip tone="neutral">{SCOPE_MODE_LABEL[c.scopeMode]}</StatusChip>
                      <StatusChip tone={trustTier(c) === "built-in" ? "info" : "approval"}>
                        {t("settings.connectors.trust", { tier: trustTierLabel(trustTier(c)) })}
                      </StatusChip>
                    </div>
                    <dl className="mt-2 grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1">
                      <dt className="text-muted-foreground">{t("settings.connectors.account")}</dt>
                      <dd>{c.account ?? t("settings.connectors.noAccount")}</dd>
                      <dt className="text-muted-foreground">{t("settings.connectors.scopes")}</dt>
                      <dd className="flex flex-wrap gap-1">
                        {c.scopes.map((s) => (
                          <code key={s} className="rounded bg-gray-4 px-1 font-mono text-xs">
                            {s}
                          </code>
                        ))}
                      </dd>
                      <dt className="text-muted-foreground">
                        {t("settings.credentials.col.lastUsed")}
                      </dt>
                      <dd>
                        {used === null
                          ? t("settings.credentials.never")
                          : formatRelative(used, clock)}
                      </dd>
                    </dl>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {c.status === "needs_auth" && onReconnect ? (
                        <Button type="button" size="sm" onClick={() => onReconnect(c)}>
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
                      {onRemove ? (
                        <RowMoreMenu
                          name={c.label}
                          destructive={[
                            {
                              label: t("common.remove"),
                              title: t("settings.connectors.removeTitle", { name: c.label }),
                              description: t("settings.connectors.removeDescription", {
                                name: c.label,
                              }),
                              confirm: t("common.remove"),
                              onConfirm: () => onRemove(c),
                            },
                          ]}
                        />
                      ) : null}
                    </div>
                  </article>
                </li>
              );
            })}
          </ul>
        )}
      </LoadGate>
    </SectionFrame>
  );
}

function ConnectForm({
  persona,
  onConnect,
  onCancel,
}: {
  persona: string;
  onConnect: (type: string, mode: ScopeMode) => void;
  onCancel: () => void;
}): ReactElement {
  const id = useId();
  const [type, setType] = useState<string>(CONNECTOR_CATALOG[0].type);
  const [mode, setMode] = useState<ScopeMode>("read");
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
          {CONNECTOR_CATALOG.map((c) => (
            <option key={c.type} value={c.type}>
              {c.label}
            </option>
          ))}
        </NativeSelect>
      </div>
      <ConnectAccessChoice
        label={t("settings.connectors.whatCan", { persona })}
        value={mode}
        onChange={setMode}
        persona={persona}
      />
      <div className="flex gap-2">
        <Button type="button" size="sm" onClick={() => onConnect(type, mode)}>
          {t("settings.connectors.continue")}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      </div>
    </Group>
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
}

export function ConnectorsSection({ persona, ...props }: ConnectorsSectionProps): ReactElement {
  const fallback = usePersona();
  const q = useGatewayQuery("connectors.list", {});
  // Connect drives the real sign-in unless the host supplies its own (#505).
  const flow = useConnectorConnect();
  const builtIn = props.onConnect === undefined;
  return (
    <ConnectorsPanel
      {...props}
      {...(builtIn
        ? {
            onConnect: (type: string, mode: ScopeMode) =>
              void flow.start(
                type,
                mode,
                CONNECTOR_CATALOG.find((c) => c.type === type)?.label ?? type,
              ),
            connectProgress: (
              <ConnectProgress
                state={flow.state}
                onOpen={(url) => void flow.open(url)}
                onCancel={flow.cancel}
                onRetry={flow.retry}
              />
            ),
          }
        : {})}
      persona={persona ?? fallback.name}
      connectors={q.data?.connectors ?? []}
      loading={q.loading && q.data === undefined}
      error={q.error}
      onRetry={q.reload}
    />
  );
}
