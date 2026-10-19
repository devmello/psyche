import type { Connector } from "@psyche/protocol";
import { Plug } from "lucide-react";
import { type ReactElement, useId, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { useGatewayQuery } from "../../data/hooks.ts";
import { formatRelative } from "../../lib/format.ts";
import { useNow } from "../../lib/use-now.ts";
import { usePersona } from "../../slots.tsx";
import {
  EmptyNotice,
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

export const SCOPE_MODE_LABEL: Record<ScopeMode, string> = {
  read: "Read only",
  read_act: "Read and act",
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
          hint: `${persona} can read and search. Nothing is sent, changed or deleted.`,
        },
        {
          value: "read_act",
          label: SCOPE_MODE_LABEL.read_act,
          hint: `${persona} can also send, create and change things. Each action still follows your permissions.`,
        },
      ]}
    />
  );
}

/** Connector types offered in the connect flow (and onboarding). */
export const CONNECTOR_CATALOG = [
  { type: "google", label: "Google (Gmail, Calendar, Drive)" },
  { type: "microsoft", label: "Microsoft (Outlook, Calendar)" },
  { type: "imap", label: "Other email (IMAP)" },
  { type: "apple:notes", label: "Apple Notes" },
  { type: "apple:reminders", label: "Apple Reminders" },
  { type: "mcp", label: "MCP server" },
] as const;

const STATUS: Record<Connector["status"], { tone: Tone; text: string }> = {
  connected: { tone: "success", text: "Connected" },
  disconnected: { tone: "neutral", text: "Disconnected" },
  error: { tone: "danger", text: "Error" },
  needs_auth: { tone: "approval", text: "Sign in again" },
};

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
  loading,
  error,
  onRetry,
}: ConnectorsPanelProps): ReactElement {
  const clock = useNow(30_000, now);
  const [adding, setAdding] = useState(defaultAdding);
  const addButton = onConnect ? (
    <Button type="button" size="sm" onClick={() => setAdding(true)} disabled={adding}>
      <Plug aria-hidden="true" /> Connect an account
    </Button>
  ) : null;
  return (
    <SectionFrame
      title="Connectors"
      description="Decide which accounts to connect. Disconnect pauses one and keeps its settings; Remove deletes it."
      actions={addButton}
    >
      <LoadGate
        label="connectors"
        loading={loading ?? false}
        error={error ?? null}
        {...(onRetry ? { onRetry } : {})}
      >
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
          <EmptyNotice
            text={`No accounts connected. ${persona} works with what you connect here.`}
            action={addButton && !adding ? addButton : null}
          />
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
                      <StatusChip tone={STATUS[c.status].tone}>{STATUS[c.status].text}</StatusChip>
                      <StatusChip tone="neutral">{SCOPE_MODE_LABEL[c.scopeMode]}</StatusChip>
                      <StatusChip tone={trustTier(c) === "built-in" ? "info" : "approval"}>
                        Trust: {trustTier(c)}
                      </StatusChip>
                    </div>
                    <dl className="mt-2 grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1">
                      <dt className="text-muted-foreground">Account</dt>
                      <dd>{c.account ?? "None"}</dd>
                      <dt className="text-muted-foreground">Scopes</dt>
                      <dd className="flex flex-wrap gap-1">
                        {c.scopes.map((s) => (
                          <code key={s} className="rounded bg-gray-4 px-1 font-mono text-xs">
                            {s}
                          </code>
                        ))}
                      </dd>
                      <dt className="text-muted-foreground">Last used</dt>
                      <dd>{used === null ? "Never" : formatRelative(used, clock)}</dd>
                    </dl>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {c.status === "needs_auth" && onReconnect ? (
                        <Button type="button" size="sm" onClick={() => onReconnect(c)}>
                          Sign in again
                        </Button>
                      ) : null}
                      {onDisconnect && c.status !== "disconnected" ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => onDisconnect(c)}
                          aria-label={`Disconnect ${c.label}`}
                        >
                          Disconnect
                        </Button>
                      ) : null}
                      {onRemove ? (
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          onClick={() => onRemove(c)}
                          aria-label={`Remove ${c.label}`}
                        >
                          Remove
                        </Button>
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
    <Group title="Connect an account">
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-type`} className="font-medium">
          Account type
        </label>
        <select
          id={`${id}-type`}
          className="h-8 max-w-sm rounded-lg border border-input bg-background px-2 text-sm"
          value={type}
          onChange={(e) => setType(e.target.value)}
        >
          {CONNECTOR_CATALOG.map((c) => (
            <option key={c.type} value={c.type}>
              {c.label}
            </option>
          ))}
        </select>
      </div>
      <ConnectAccessChoice
        label={`What can ${persona} do with it?`}
        value={mode}
        onChange={setMode}
        persona={persona}
      />
      <div className="flex gap-2">
        <Button type="button" size="sm" onClick={() => onConnect(type, mode)}>
          Continue to sign in
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Group>
  );
}

export interface ConnectorsSectionProps {
  persona?: string;
  now?: number;
  /** Connect flows run in the shell (OAuth windows); the Gateway has no connectors.connect yet. */
  onConnect?: (type: string, mode: ScopeMode) => void;
  onReconnect?: (connector: Connector) => void;
  onDisconnect?: (connector: Connector) => void;
  onRemove?: (connector: Connector) => void;
}

export function ConnectorsSection({ persona, ...props }: ConnectorsSectionProps): ReactElement {
  const fallback = usePersona();
  const q = useGatewayQuery("connectors.list", {});
  return (
    <ConnectorsPanel
      {...props}
      persona={persona ?? fallback.name}
      connectors={q.data?.connectors ?? []}
      loading={q.loading && q.data === undefined}
      error={q.error}
      onRetry={q.reload}
    />
  );
}
