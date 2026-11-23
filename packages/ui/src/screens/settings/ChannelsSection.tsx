import type { Channel, ChannelIdentity, DmPolicy, PairingRequest } from "@psyche/protocol";
import { TriangleAlert } from "lucide-react";
import { type ReactElement, useCallback, useContext, useId, useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../components/ui/alert-dialog.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { useCall, useGatewayQuery } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { formatRelative } from "../../lib/format.ts";
import { useNow } from "../../lib/use-now.ts";
import { usePersona } from "../../slots.tsx";
import { AddChannelDialog } from "./AddChannelDialog.tsx";
import {
  approvalIdOf,
  EmptyNotice,
  ErrorNotice,
  Group,
  hasCode,
  LoadGate,
  type LoadProps,
  messageOf,
  RadioField,
  SectionFrame,
  SettingsApprovalContext,
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

/** The two allowlists of a channel that a person can edit (`channels.allowlist.update`). */
export type AllowlistList = "allowFrom" | "groupAllowFrom";

export interface AllowlistChange {
  add?: string[];
  remove?: string[];
}

export interface IdentityDraft {
  display: string;
  links: string[];
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
  /** Adds or removes a sender or group on one allowlist; the controls are absent without it. */
  onAllowlistChange?: (channel: Channel, list: AllowlistList, change: AllowlistChange) => void;
  /** Links a person's sender ids under one identity (`channels.identities.upsert`). */
  onIdentityLink?: (draft: IdentityDraft) => void;
  /** Removes an identity link; its senders fall back to per-sender sessions. */
  onIdentityUnlink?: (identity: ChannelIdentity) => void;
  /** Opens the guided Add a channel flow; the button is absent without it. */
  onAddChannel?: () => void;
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
  onAllowlistChange,
  onIdentityLink,
  onIdentityUnlink,
  onAddChannel,
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
          <EmptyNotice
            text={t("settings.channels.empty", { persona })}
            action={
              onAddChannel ? (
                <Button type="button" size="sm" onClick={onAddChannel}>
                  {t("settings.channels.add.button")}
                </Button>
              ) : undefined
            }
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
              {...(onAllowlistChange ? { onAllowlistChange } : {})}
            />
          ))
        )}

        {onAddChannel && channels.length > 0 ? (
          <div>
            <Button type="button" size="sm" variant="outline" onClick={onAddChannel}>
              {t("settings.channels.add.button")}
            </Button>
          </div>
        ) : null}

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
                <li key={i.id} className="flex flex-wrap items-center gap-2">
                  <span>
                    <span className="font-medium">{i.display}</span>{" "}
                    <span className="text-callout text-muted-foreground">
                      {i.links.join(" = ")}
                    </span>
                  </span>
                  {onIdentityUnlink ? (
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      className="ms-auto"
                      aria-label={t("settings.channels.identity.unlinkNamed", { name: i.display })}
                      onClick={() => onIdentityUnlink(i)}
                    >
                      {t("settings.channels.identity.unlink")}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {onIdentityLink ? <IdentityLinkForm onLink={onIdentityLink} /> : null}
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
                    <span className="text-callout text-muted-foreground">
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

/** Adds one id to an allowlist; an id already listed is not sent again. */
function AllowlistAdd({
  label,
  action,
  existing,
  onAdd,
}: {
  label: string;
  action: string;
  existing: readonly string[];
  onAdd: (id: string) => void;
}): ReactElement {
  const fieldId = useId();
  const [draft, setDraft] = useState("");
  const value = draft.trim();
  return (
    <form
      className="mt-2 flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (value === "") return;
        if (!existing.includes(value)) onAdd(value);
        setDraft("");
      }}
    >
      <label htmlFor={fieldId} className="text-callout text-muted-foreground">
        {label}
      </label>
      <Input
        id={fieldId}
        value={draft}
        maxLength={256}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        className="h-8 min-w-40 flex-1 text-sm"
      />
      <Button type="submit" size="xs" variant="outline" disabled={value === ""}>
        {action}
      </Button>
    </form>
  );
}

/** Links one person's sender ids under a new identity (comma separated). */
function IdentityLinkForm({ onLink }: { onLink: (draft: IdentityDraft) => void }): ReactElement {
  const nameId = useId();
  const sendersId = useId();
  const [display, setDisplay] = useState("");
  const [senders, setSenders] = useState("");
  const name = display.trim();
  const links = senders
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  const ready = name !== "" && links.length > 0;
  return (
    <form
      className="mt-3 flex flex-col gap-2 border-t border-gray-6 pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        onLink({ display: name, links });
        setDisplay("");
        setSenders("");
      }}
    >
      <div className="flex flex-col gap-1">
        <label htmlFor={nameId} className="font-medium">
          {t("settings.channels.identity.name")}
        </label>
        <Input
          id={nameId}
          value={display}
          maxLength={200}
          autoComplete="off"
          onChange={(e) => setDisplay(e.target.value)}
          className="h-8 text-sm"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={sendersId} className="font-medium">
          {t("settings.channels.identity.senders")}
        </label>
        <Input
          id={sendersId}
          value={senders}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setSenders(e.target.value)}
          className="h-8 text-sm"
        />
      </div>
      <div>
        <Button type="submit" size="sm" variant="outline" disabled={!ready}>
          {t("settings.channels.identity.link")}
        </Button>
      </div>
    </form>
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
  onAllowlistChange,
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
  onAllowlistChange?: (channel: Channel, list: AllowlistList, change: AllowlistChange) => void;
}): ReactElement {
  const [confirmOpen, setConfirmOpen] = useState(false);
  // The id of a group-list sender whose removal would leave nobody on it (see the confirm below).
  const [emptying, setEmptying] = useState<string | null>(null);
  const allow = displayMap(c, "allowFromDisplay");
  const name = channelName(c.type);
  // An empty group list means "everyone allowed in direct messages", so removing the last sender
  // widens who can trigger Psyche in groups: the Gateway asks for a card, and this says why first.
  const removingLastGroupSender = (id: string): boolean =>
    c.groupAllowFrom.length === 1 && c.groupAllowFrom[0] === id && c.allowFrom.length > 0;
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
                <span className="text-callout text-muted-foreground">
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
                <li key={s} className="flex flex-wrap items-center gap-2">
                  <span>
                    {allow[s] ?? s}
                    {c.ownerIds.includes(s) ? (
                      <span className="text-callout text-muted-foreground">
                        {t("settings.channels.owner")}
                      </span>
                    ) : null}
                  </span>
                  {onAllowlistChange ? (
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      className="ms-auto"
                      aria-label={t("settings.channels.allow.removeNamed", {
                        name: allow[s] ?? s,
                      })}
                      onClick={() => onAllowlistChange(c, "allowFrom", { remove: [s] })}
                    >
                      {t("settings.channels.allow.remove")}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {onAllowlistChange ? (
            <AllowlistAdd
              label={t("settings.channels.allow.senderLabel")}
              action={t("settings.channels.allow.addSender")}
              existing={c.allowFrom}
              onAdd={(id) => onAllowlistChange(c, "allowFrom", { add: [id] })}
            />
          ) : null}
        </div>
        <div>
          <h4 className="font-medium">{t("settings.channels.groups")}</h4>
          {c.groupAllowFrom.length === 0 ? (
            <p className="text-muted-foreground">{t("settings.channels.noGroups")}</p>
          ) : (
            <ul className="mt-1 flex flex-col gap-0.5">
              {c.groupAllowFrom.map((g) => (
                <li key={g} className="flex flex-wrap items-center gap-2">
                  <span>{allow[g] ?? g}</span>
                  {onAllowlistChange ? (
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      className="ms-auto"
                      aria-label={t("settings.channels.allow.removeNamed", {
                        name: allow[g] ?? g,
                      })}
                      onClick={() => {
                        if (removingLastGroupSender(g)) setEmptying(g);
                        else onAllowlistChange(c, "groupAllowFrom", { remove: [g] });
                      }}
                    >
                      {t("settings.channels.allow.remove")}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {onAllowlistChange ? (
            <>
              <AllowlistAdd
                label={t("settings.channels.allow.groupLabel")}
                action={t("settings.channels.allow.addGroup")}
                existing={c.groupAllowFrom}
                onAdd={(id) => onAllowlistChange(c, "groupAllowFrom", { add: [id] })}
              />
              <AlertDialog
                open={emptying !== null}
                onOpenChange={(open) => {
                  if (!open) setEmptying(null);
                }}
              >
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {t("settings.channels.allow.removeNamed", {
                        name: allow[emptying ?? ""] ?? emptying ?? "",
                      })}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {t("settings.channels.allow.groupEmptied", {
                        name: allow[emptying ?? ""] ?? emptying ?? "",
                      })}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                    <Button
                      type="button"
                      variant="destructive"
                      onClick={() => {
                        const id = emptying;
                        setEmptying(null);
                        if (id !== null) onAllowlistChange(c, "groupAllowFrom", { remove: [id] });
                      }}
                    >
                      {t("settings.channels.allow.remove")}
                    </Button>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </>
          ) : null}
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

const allowlistError = (err: unknown): string =>
  hasCode(err, "forbidden")
    ? t("settings.channels.allow.forbidden")
    : t("settings.channels.allow.failed", { reason: messageOf(err) });

const identityError = (err: unknown): string =>
  hasCode(err, "forbidden")
    ? t("settings.channels.identity.forbidden")
    : t("settings.channels.identity.failed", { reason: messageOf(err) });

export function ChannelsSection({ now }: { now?: number }): ReactElement {
  const persona = usePersona();
  const call = useCall();
  const channelsQ = useGatewayQuery("channels.list", {});
  const pairingQ = useGatewayQuery("channels.pairing.list", { status: "pending" });
  const identitiesQ = useGatewayQuery("channels.identities.list", {});
  const [actionError, setActionError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const requestApproval = useContext(SettingsApprovalContext);
  const reload = useCallback(() => {
    channelsQ.reload();
    pairingQ.reload();
    identitiesQ.reload();
  }, [channelsQ.reload, pairingQ.reload, identitiesQ.reload]);
  const run = (action: ChannelAction, p: Promise<unknown>) => {
    setActionError(null);
    p.then(reload, (err: unknown) => setActionError(channelError(action, err)));
  };
  // Adding a sender or linking an identity is presence-gated (an admin call that widens access):
  // the Gateway answers `approval_required` with a card. The Settings banner shows it and sends
  // the same params again with the `approvalId` once it is approved, as AddChannelDialog does.
  // Removing entries needs no approval, so those calls never reach the banner.
  const gated = <P extends object>(
    params: P,
    send: (p: P & { approvalId?: string }) => Promise<unknown>,
    approval: { key: string; label: string },
    failure: (err: unknown) => string,
  ) => {
    setActionError(null);
    send(params).then(reload, (err: unknown) => {
      const approvalId = approvalIdOf(err);
      if (approvalId === null) {
        setActionError(failure(err));
        return;
      }
      if (requestApproval === null) {
        setActionError(t("settings.shared.needsPresence", { label: approval.label }));
        return;
      }
      requestApproval({
        ...approval,
        approvalId,
        retry: async (aid) => {
          await send({ ...params, approvalId: aid });
          reload();
        },
      });
    });
  };
  return (
    <>
      <ChannelsPanel
        persona={persona.name}
        onAddChannel={() => setAdding(true)}
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
        onAllowlistChange={(c, list, change) =>
          gated(
            { channelId: c.id, list, ...change },
            (p) => call("channels.allowlist.update", p),
            list === "allowFrom"
              ? {
                  key: "channels.allowlist.allowFrom",
                  label: t("settings.channels.allow.senderApproval"),
                }
              : {
                  key: "channels.allowlist.groupAllowFrom",
                  label: t("settings.channels.allow.groupApproval"),
                },
            allowlistError,
          )
        }
        onIdentityLink={(d) =>
          gated(
            { display: d.display, links: d.links },
            (p) => call("channels.identities.upsert", p),
            { key: "channels.identities.upsert", label: t("settings.channels.identity.approval") },
            identityError,
          )
        }
        onIdentityUnlink={(i) => {
          setActionError(null);
          call("channels.identities.delete", { identityId: i.id }).then(reload, (err: unknown) =>
            setActionError(identityError(err)),
          );
        }}
        {...(now === undefined ? {} : { now })}
      />
      <AddChannelDialog
        open={adding}
        persona={persona.name}
        onClose={() => setAdding(false)}
        onAdded={(outcome) => {
          reload();
          toast(
            outcome.inactive
              ? t("settings.channels.add.addedInactive", { env: outcome.env })
              : t("settings.channels.add.added", { persona: persona.name, env: outcome.env }),
          );
        }}
      />
    </>
  );
}
