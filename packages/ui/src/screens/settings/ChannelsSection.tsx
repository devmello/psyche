import type { Channel, ChannelIdentity, DmPolicy, PairingRequest } from "@psyche/protocol";
import { TriangleAlert } from "lucide-react";
import { type ReactElement, useCallback, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { useCall, useGatewayQuery } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { formatRelative } from "../../lib/format.ts";
import { useNow } from "../../lib/use-now.ts";
import { usePersona } from "../../slots.tsx";
import {
  EmptyNotice,
  ErrorNotice,
  Group,
  hasCode,
  LoadGate,
  type LoadProps,
  messageOf,
  RadioField,
  SectionFrame,
  StatusChip,
  SwitchField,
} from "./shared.tsx";

/** Channels (UI design §3.18; architecture §4.10). */

export const MAX_PENDING = 3;

/** Product names stay as written; only the generic kinds are words to translate. */
const CHANNEL_NAME: Record<Exclude<Channel["type"], "email" | "sms">, string> = {
  webchat: "WebChat",
  telegram: "Telegram",
  imessage: "iMessage",
  whatsapp: "WhatsApp",
  signal: "Signal",
  slack: "Slack",
  discord: "Discord",
};

const channelName = (type: Channel["type"]): string =>
  type === "email" || type === "sms" ? t(`settings.channels.type.${type}`) : CHANNEL_NAME[type];

const STATUS_TONE: Record<Channel["status"], "success" | "danger" | "neutral"> = {
  active: "success",
  paused: "neutral",
  error: "danger",
  disconnected: "neutral",
};

function policyOptions(persona: string) {
  return [
    {
      value: "pairing" as const,
      label: t("settings.channels.policy.pairing"),
      hint: t("settings.channels.policy.pairingHint"),
    },
    {
      value: "allowlist" as const,
      label: t("settings.channels.policy.allowlist"),
      hint: t("settings.channels.policy.allowlistHint"),
    },
    {
      value: "open" as const,
      label: t("settings.channels.policy.open"),
      hint: t("settings.channels.policy.openHint", { persona }),
    },
    {
      value: "disabled" as const,
      label: t("settings.channels.policy.disabled"),
      hint: t("settings.channels.policy.disabledHint"),
    },
  ];
}

function displayMap(c: Channel, key: string): Record<string, string> {
  const raw = c.config[key];
  if (typeof raw !== "object" || raw === null) return {};
  return Object.fromEntries(
    Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === "string"),
  );
}

export interface ChannelsPanelProps extends LoadProps {
  channels: readonly Channel[];
  pairing: readonly PairingRequest[];
  identities: readonly ChannelIdentity[];
  persona: string;
  now?: number;
  onPolicyChange?: (channel: Channel, policy: DmPolicy) => void;
  onRequireMention?: (channel: Channel, on: boolean) => void;
  onApprove?: (request: PairingRequest) => void;
  onIgnore?: (request: PairingRequest) => void;
  pairingError?: string | null;
  identitiesError?: string | null;
  actionError?: string | null;
}

export function ChannelsPanel({
  channels,
  pairing,
  identities,
  persona,
  now,
  onPolicyChange,
  onRequireMention,
  onApprove,
  onIgnore,
  pairingError = null,
  identitiesError = null,
  actionError = null,
  loading,
  error,
  onRetry,
}: ChannelsPanelProps): ReactElement {
  const clock = useNow(30_000, now);
  const designated = identities.filter((i) => i.delegatedPersona !== null);
  return (
    <SectionFrame
      title={t("settings.channels.title")}
      description={t("settings.channels.description", { persona })}
    >
      <LoadGate
        label={t("settings.channels.loadLabel")}
        loading={loading ?? false}
        error={error ?? null}
        {...(onRetry ? { onRetry } : {})}
      >
        {actionError ? (
          <ErrorNotice what={actionError} did={t("settings.shared.nothingChanged")} />
        ) : null}
        {channels.length === 0 ? (
          <EmptyNotice text={t("settings.channels.empty", { persona })} />
        ) : (
          channels.map((c) => (
            <ChannelCard
              key={c.id}
              channel={c}
              persona={persona}
              now={clock}
              pending={pairing.filter(
                (p) =>
                  p.kind === "channel-sender" && p.channelId === c.id && p.status === "pending",
              )}
              pairingError={pairingError}
              {...(onPolicyChange ? { onPolicyChange } : {})}
              {...(onRequireMention ? { onRequireMention } : {})}
              {...(onApprove ? { onApprove } : {})}
              {...(onIgnore ? { onIgnore } : {})}
            />
          ))
        )}

        <Group
          title={t("settings.channels.identities")}
          description={t("settings.channels.identitiesDescription")}
        >
          {identitiesError ? (
            <ErrorNotice
              what={t("settings.channels.identitiesFailed", { reason: identitiesError })}
            />
          ) : identities.length === 0 ? (
            <EmptyNotice text={t("settings.channels.noIdentities")} />
          ) : (
            <ul className="flex flex-col gap-1">
              {identities.map((i) => (
                <li key={i.id}>
                  <span className="font-medium">{i.display}</span>{" "}
                  <span className="text-xs text-muted-foreground">{i.links.join(" = ")}</span>
                </li>
              ))}
            </ul>
          )}
        </Group>

        <Group
          title={t("settings.channels.designated")}
          description={t("settings.channels.designatedDescription", { persona })}
        >
          {identitiesError ? null : designated.length === 0 ? (
            <p className="text-muted-foreground">{t("settings.channels.noDesignated")}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {designated.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{i.display}</span>
                  <StatusChip tone="accent">
                    {t("settings.channels.delegated", { persona: i.delegatedPersona ?? null })}
                  </StatusChip>
                  {i.toolAllow ? (
                    <span className="text-xs text-muted-foreground">
                      {t("settings.channels.tools", { tools: i.toolAllow.join(", ") })}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Group>
      </LoadGate>
    </SectionFrame>
  );
}

function ChannelCard({
  channel: c,
  persona,
  now,
  pending,
  pairingError,
  onPolicyChange,
  onRequireMention,
  onApprove,
  onIgnore,
}: {
  channel: Channel;
  persona: string;
  now: number;
  pending: readonly PairingRequest[];
  pairingError: string | null;
  onPolicyChange?: (channel: Channel, policy: DmPolicy) => void;
  onRequireMention?: (channel: Channel, on: boolean) => void;
  onApprove?: (request: PairingRequest) => void;
  onIgnore?: (request: PairingRequest) => void;
}): ReactElement {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const allow = displayMap(c, "allowFromDisplay");
  const groups = displayMap(c, "groupsDisplay");
  const name = channelName(c.type);
  return (
    <Group
      title={t("settings.channels.cardTitle", { name, account: c.account })}
      actions={
        <StatusChip tone={STATUS_TONE[c.status]}>
          {t(`settings.channels.status.${c.status}`)}
        </StatusChip>
      }
    >
      <RadioField
        label={t("settings.channels.directMessages")}
        inline
        value={confirmOpen ? "open" : c.dmPolicy}
        options={policyOptions(persona)}
        onChange={(v) => {
          if (v === "open") setConfirmOpen(true);
          else {
            setConfirmOpen(false);
            onPolicyChange?.(c, v);
          }
        }}
      >
        {confirmOpen || c.dmPolicy === "open" ? (
          <div
            role="alert"
            className="flex flex-col gap-2 rounded-md border border-approval-border bg-approval-surface p-3"
          >
            <p className="flex items-start gap-1.5 text-approval-text">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              {t("settings.channels.openWarning", { account: c.account, persona })}
            </p>
            {confirmOpen ? (
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  onClick={() => {
                    setConfirmOpen(false);
                    onPolicyChange?.(c, "open");
                  }}
                >
                  {t("settings.channels.openAnyway")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setConfirmOpen(false)}
                >
                  {t("settings.channels.keepPolicy", { policy: c.dmPolicy })}
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </RadioField>

      <div className="flex flex-col gap-1.5">
        <h4 className="font-medium">
          {t("settings.channels.pending", { n: pending.length, max: MAX_PENDING })}
        </h4>
        {pairingError ? (
          <ErrorNotice what={t("settings.channels.pairingFailed", { reason: pairingError })} />
        ) : pending.length === 0 ? (
          <p className="text-muted-foreground">{t("settings.channels.noPending")}</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {pending.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{p.display}</span>
                <span>
                  {t("settings.channels.code")} <code className="font-mono">{p.code}</code>
                </span>
                <span className="text-xs text-muted-foreground">
                  {t("settings.channels.expires", { when: formatRelative(p.expiresAt, now) })}
                </span>
                <span className="ms-auto flex gap-1.5">
                  {onApprove ? (
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      onClick={() => onApprove(p)}
                      aria-label={t("settings.channels.approveSender", { name: p.display })}
                    >
                      {t("settings.channels.approve")}
                    </Button>
                  ) : null}
                  {onIgnore ? (
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      onClick={() => onIgnore(p)}
                      aria-label={t("settings.channels.ignoreSender", { name: p.display })}
                    >
                      {t("settings.channels.ignore")}
                    </Button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <h4 className="font-medium">{t("settings.channels.policy.allowlist")}</h4>
          {c.allowFrom.length === 0 ? (
            <p className="text-muted-foreground">{t("settings.channels.noOneYet")}</p>
          ) : (
            <ul className="mt-1 flex flex-col gap-0.5">
              {c.allowFrom.map((s) => (
                <li key={s}>
                  {allow[s] ?? s}
                  {c.ownerIds.includes(s) ? (
                    <span className="text-xs text-muted-foreground">
                      {t("settings.channels.owner")}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h4 className="font-medium">{t("settings.channels.groups")}</h4>
          {c.groupAllowFrom.length === 0 ? (
            <p className="text-muted-foreground">{t("settings.channels.noGroups")}</p>
          ) : (
            <ul className="mt-1 flex flex-col gap-0.5">
              {c.groupAllowFrom.map((g) => (
                <li key={g}>{groups[g] ?? g}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <SwitchField
        label={t("settings.channels.requireMention")}
        checked={c.requireMention}
        onChange={(v) => onRequireMention?.(c, v)}
        disabled={onRequireMention === undefined}
      />
    </Group>
  );
}

type ChannelAction = "policy" | "mention" | "approve" | "ignore";

function channelError(action: ChannelAction, err: unknown): string {
  return hasCode(err, "forbidden")
    ? t("settings.channels.err.forbidden", { action })
    : t("settings.channels.err.failed", { action, reason: messageOf(err) });
}

export function ChannelsSection({ now }: { now?: number }): ReactElement {
  const persona = usePersona();
  const call = useCall();
  const channelsQ = useGatewayQuery("channels.list", {});
  const pairingQ = useGatewayQuery("channels.pairing.list", { status: "pending" });
  const identitiesQ = useGatewayQuery("channels.identities.list", {});
  const [actionError, setActionError] = useState<string | null>(null);
  const reload = useCallback(() => {
    channelsQ.reload();
    pairingQ.reload();
    identitiesQ.reload();
  }, [channelsQ.reload, pairingQ.reload, identitiesQ.reload]);
  const run = (action: ChannelAction, p: Promise<unknown>) => {
    setActionError(null);
    p.then(reload, (err: unknown) => setActionError(channelError(action, err)));
  };
  return (
    <ChannelsPanel
      persona={persona.name}
      channels={channelsQ.data?.channels ?? []}
      pairing={pairingQ.data?.requests ?? []}
      identities={identitiesQ.data?.identities ?? []}
      loading={channelsQ.loading && channelsQ.data === undefined}
      error={channelsQ.error}
      onRetry={reload}
      pairingError={pairingQ.error}
      identitiesError={identitiesQ.error}
      actionError={actionError}
      onPolicyChange={(c, dmPolicy) =>
        run("policy", call("channels.configure", { channelId: c.id, dmPolicy }))
      }
      onRequireMention={(c, requireMention) =>
        run("mention", call("channels.configure", { channelId: c.id, requireMention }))
      }
      onApprove={(r) => run("approve", call("channels.pairing.approve", { requestId: r.id }))}
      onIgnore={(r) => run("ignore", call("channels.pairing.deny", { requestId: r.id }))}
      {...(now === undefined ? {} : { now })}
    />
  );
}
