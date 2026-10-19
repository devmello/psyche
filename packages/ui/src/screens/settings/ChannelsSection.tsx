import type { Channel, ChannelIdentity, DmPolicy, PairingRequest } from "@psyche/protocol";
import { TriangleAlert } from "lucide-react";
import { type ReactElement, useCallback, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { useCall, useGatewayQuery } from "../../data/hooks.ts";
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

const CHANNEL_NAME: Record<Channel["type"], string> = {
  webchat: "WebChat",
  telegram: "Telegram",
  imessage: "iMessage",
  whatsapp: "WhatsApp",
  signal: "Signal",
  slack: "Slack",
  discord: "Discord",
  email: "Email",
  sms: "SMS",
};

const STATUS: Record<Channel["status"], { tone: "success" | "danger" | "neutral"; text: string }> =
  {
    active: { tone: "success", text: "Connected" },
    paused: { tone: "neutral", text: "Paused" },
    error: { tone: "danger", text: "Error" },
    disconnected: { tone: "neutral", text: "Disconnected" },
  };

function policyOptions(persona: string) {
  return [
    {
      value: "pairing" as const,
      label: "Pairing",
      hint: "New senders get a code; you approve them here.",
    },
    { value: "allowlist" as const, label: "Allowlist", hint: "Only people on the list below." },
    { value: "open" as const, label: "Open", hint: `Anyone can message ${persona}.` },
    { value: "disabled" as const, label: "Disabled", hint: "Direct messages are ignored." },
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
      title="Channels"
      description={`Where people can reach ${persona}, and who is allowed to.`}
    >
      <LoadGate
        label="channels"
        loading={loading ?? false}
        error={error ?? null}
        {...(onRetry ? { onRetry } : {})}
      >
        {actionError ? <ErrorNotice what={actionError} did="Nothing was changed." /> : null}
        {channels.length === 0 ? (
          <EmptyNotice
            text={`No channels yet. Connect Telegram, iMessage or Slack to reach ${persona} away from this Mac.`}
          />
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
          title="Identity links"
          description="One person across channels. Links change only from a paired device."
        >
          {identitiesError ? (
            <ErrorNotice what={`Psyche couldn't load identity links (${identitiesError}).`} />
          ) : identities.length === 0 ? (
            <EmptyNotice text="No identity links. Each sender is treated as a separate person." />
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
          title="Designated people"
          description={`${persona} answers them with a delegated persona and a smaller tool set. Their approvals come to you.`}
        >
          {identitiesError ? null : designated.length === 0 ? (
            <p className="text-muted-foreground">No one designated.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {designated.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{i.display}</span>
                  <StatusChip tone="accent">delegated: {i.delegatedPersona}</StatusChip>
                  {i.toolAllow ? (
                    <span className="text-xs text-muted-foreground">
                      tools: {i.toolAllow.join(", ")}
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
  const name = CHANNEL_NAME[c.type];
  return (
    <Group
      title={`${name} ${c.account}`}
      actions={<StatusChip tone={STATUS[c.status].tone}>{STATUS[c.status].text}</StatusChip>}
    >
      <RadioField
        label="Direct messages (dmPolicy)"
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
              Open lets anyone who finds {c.account} message {persona}, and their messages can try
              to steer it. Pairing is safer.
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
                  Open it anyway
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setConfirmOpen(false)}
                >
                  Keep {c.dmPolicy}
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </RadioField>

      <div className="flex flex-col gap-1.5">
        <h4 className="font-medium">
          Pending ({pending.length} of {MAX_PENDING})
        </h4>
        {pairingError ? (
          <ErrorNotice what={`Psyche couldn't load pairing requests (${pairingError}).`} />
        ) : pending.length === 0 ? (
          <p className="text-muted-foreground">No one is waiting. Codes expire after 1 hour.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {pending.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{p.display}</span>
                <span>
                  code <code className="font-mono">{p.code}</code>
                </span>
                <span className="text-xs text-muted-foreground">
                  expires {formatRelative(p.expiresAt, now)}
                </span>
                <span className="ml-auto flex gap-1.5">
                  {onApprove ? (
                    <Button
                      type="button"
                      size="xs"
                      onClick={() => onApprove(p)}
                      aria-label={`Approve ${p.display}`}
                    >
                      Approve
                    </Button>
                  ) : null}
                  {onIgnore ? (
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      onClick={() => onIgnore(p)}
                      aria-label={`Ignore ${p.display}`}
                    >
                      Ignore
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
          <h4 className="font-medium">Allowlist</h4>
          {c.allowFrom.length === 0 ? (
            <p className="text-muted-foreground">No one yet.</p>
          ) : (
            <ul className="mt-1 flex flex-col gap-0.5">
              {c.allowFrom.map((s) => (
                <li key={s}>
                  {allow[s] ?? s}
                  {c.ownerIds.includes(s) ? (
                    <span className="text-xs text-muted-foreground"> · owner</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h4 className="font-medium">Groups</h4>
          {c.groupAllowFrom.length === 0 ? (
            <p className="text-muted-foreground">No groups.</p>
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
        label="Only answer in groups when mentioned (requireMention)"
        checked={c.requireMention}
        onChange={(v) => onRequireMention?.(c, v)}
        disabled={onRequireMention === undefined}
      />
    </Group>
  );
}

function channelError(what: string, err: unknown): string {
  return hasCode(err, "forbidden")
    ? `${what} needs approval on this device. Use a device paired as admin.`
    : `Psyche couldn't ${what.toLowerCase()} (${messageOf(err)}).`;
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
  const run = (what: string, p: Promise<unknown>) => {
    setActionError(null);
    p.then(reload, (err: unknown) => setActionError(channelError(what, err)));
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
        run("Change who can message", call("channels.configure", { channelId: c.id, dmPolicy }))
      }
      onRequireMention={(c, requireMention) =>
        run(
          "Change group mentions",
          call("channels.configure", { channelId: c.id, requireMention }),
        )
      }
      onApprove={(r) =>
        run("Approve the sender", call("channels.pairing.approve", { requestId: r.id }))
      }
      onIgnore={(r) => run("Ignore the sender", call("channels.pairing.deny", { requestId: r.id }))}
      {...(now === undefined ? {} : { now })}
    />
  );
}
