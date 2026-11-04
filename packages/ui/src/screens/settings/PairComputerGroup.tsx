import type { MethodResult, SetupTokenScope } from "@psyche/protocol";
import { type ReactElement, useContext, useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { QrCode } from "../../components/QrCode.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Checkbox } from "../../components/ui/checkbox.tsx";
import { Label } from "../../components/ui/label.tsx";
import { useCall, useGatewayQuery } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { groupFingerprint } from "../../lib/fingerprint.ts";
import { formatRelative } from "../../lib/format.ts";
import { useNow } from "../../lib/use-now.ts";
import { useSlots } from "../../slots.tsx";
import { presenceUnavailable } from "./SettingsApproval.tsx";
import {
  approvalIdOf,
  EmptyNotice,
  ErrorNotice,
  Group,
  hasCode,
  messageOf,
  RadioField,
  SettingsApprovalContext,
  StatusChip,
} from "./shared.tsx";

/**
 * Settings → Server & remote access → Pair another computer (remote-gateway design §3.4). Makes a
 * one-time setup token and the link and QR code that carry it: `psyche-pair:v1` for the Host's
 * public (Tailscale) address, `psyche-pair:v2` when the owner picks "From this network" (LAN
 * listening must be running; the link then holds the Gateway key and certificate pin). The token lasts
 * ten minutes, works once and gives exactly the access ticked here: Admin is off unless the owner
 * ticks it. Making one is a security change, so it asks for Touch ID or a passkey like approving
 * a computer does. The QR code is drawn in this window; nothing is sent to anyone.
 */

const SCOPE_CHOICES: readonly SetupTokenScope[] = [
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.admin",
];

const DEFAULT_SCOPES: readonly SetupTokenScope[] = [
  "operator.read",
  "operator.write",
  "operator.approvals",
];

type Made = MethodResult<"devices.setupToken.create">;

function scopeWord(s: SetupTokenScope): string {
  return t(`settings.devices.scope.${s}`);
}

/** Where the other computer connects: this Mac's public address (a v1 link) or its network (v2). */
type Via = "address" | "lan";

function createError(err: unknown, via: Via): string {
  if (hasCode(err, "unavailable")) {
    return via === "lan" ? t("settings.pair.err.noLan") : t("settings.pair.err.noAddress");
  }
  if (hasCode(err, "rate_limited")) return t("settings.pair.err.tooMany");
  if (hasCode(err, "forbidden")) return t("settings.pair.err.forbidden");
  return t("settings.pair.err.failed", { reason: messageOf(err) });
}

export function PairComputerGroup({ now: fixedNow }: { now?: number }): ReactElement {
  const id = useId();
  const call = useCall();
  const { writeClipboard } = useSlots();
  const requestApproval = useContext(SettingsApprovalContext);
  const info = useGatewayQuery("gateway.info", {});
  const tokens = useGatewayQuery("devices.setupToken.list", {});
  const now = useNow(15_000, fixedNow);
  const [scopes, setScopes] = useState<SetupTokenScope[]>([...DEFAULT_SCOPES]);
  const [chosenVia, setChosenVia] = useState<Via | null>(null);
  const [made, setMade] = useState<Made | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [gone, setGone] = useState(false);
  const madeId = made?.setupToken.id;
  const madeExpiry = made?.setupToken.expiresAt;
  const reloadTokens = tokens.reload;

  // The link and its QR code are shown only while the token can still be used: they go as soon as
  // it is used, revoked or expired (this checks every few seconds), and with this screen.
  useEffect(() => {
    if (madeId === undefined) return;
    const timer = setInterval(reloadTokens, 5_000);
    return () => clearInterval(timer);
  }, [madeId, reloadTokens]);
  useEffect(() => {
    if (madeId === undefined || madeExpiry === undefined) return;
    const record = tokens.data?.setupTokens.find((s) => s.id === madeId);
    const lapsed = Date.parse(madeExpiry) <= now;
    if (record !== undefined && record.status === "used") {
      toast(t("settings.pair.usedToast"));
    } else if (record !== undefined ? record.status === "live" && !lapsed : !lapsed) {
      return;
    }
    setMade(null);
    setGone(true);
  }, [madeId, madeExpiry, tokens.data, now]);

  const address = info.data?.publicOrigin ?? null;
  const addressKnown = info.data !== undefined;
  // A link for this network is offered only while the Gateway is really listening on it with a
  // certificate: the link names that certificate.
  const lanInfo = info.data?.lan;
  const lanReady =
    lanInfo?.enabled === true &&
    lanInfo.listening.length > 0 &&
    lanInfo.certSpki !== null &&
    lanInfo.origin !== null;
  // The address is the default; a Mac with no public address but with its network on offers that.
  const via: Via = chosenVia ?? (address === null && lanReady ? "lan" : "address");
  const canMake = via === "lan" ? lanReady : !addressKnown || address !== null;
  const live = (tokens.data?.setupTokens ?? []).filter(
    (s) => s.status === "live" && Date.parse(s.expiresAt) > now,
  );

  const toggle = (s: SetupTokenScope, on: boolean) =>
    setScopes((prev) => (on ? [...new Set([...prev, s])] : prev.filter((x) => x !== s)));

  const finish = (result: Made) => {
    setMade(result);
    setCopied(false);
    setGone(false);
    toast(t("settings.pair.madeToast"));
    tokens.reload();
  };

  const make = () => {
    setBusy(true);
    setError(null);
    setMade(null);
    const chosen = SCOPE_CHOICES.filter((s) => scopes.includes(s));
    const extra = via === "lan" ? ({ via: "lan" } as const) : {};
    call("devices.setupToken.create", { scopes: chosen, ...extra }).then(
      (result) => {
        setBusy(false);
        finish(result);
      },
      (err: unknown) => {
        setBusy(false);
        const approvalId = approvalIdOf(err);
        if (approvalId === null) {
          setError(createError(err, via));
          return;
        }
        // Fresh presence: the same banner a security setting uses shows the card; once it is
        // approved the call is made again with the approval, and the link appears here.
        if (requestApproval === null) {
          setError(presenceUnavailable());
          return;
        }
        requestApproval({
          key: "devices.setupToken",
          label: t("settings.pair.title"),
          approvalId,
          retry: (approved) =>
            call("devices.setupToken.create", {
              scopes: chosen,
              ...extra,
              approvalId: approved,
            }).then(
              (result) => {
                finish(result);
                return result;
              },
              (retryErr: unknown) => {
                setError(createError(retryErr, via));
                throw retryErr;
              },
            ),
        });
      },
    );
  };

  const revoke = (tokenId: string) => {
    setError(null);
    call("devices.setupToken.revoke", { id: tokenId }).then(
      () => {
        if (made?.setupToken.id === tokenId) setMade(null);
        tokens.reload();
      },
      (err: unknown) => setError(t("settings.pair.err.failed", { reason: messageOf(err) })),
    );
  };

  return (
    <Group title={t("settings.pair.title")} description={t("settings.pair.description")}>
      {error ? <ErrorNotice what={error} did={t("settings.shared.nothingChanged")} /> : null}
      {addressKnown && address === null && !lanReady ? (
        <EmptyNotice text={t("settings.pair.needsAddress")} />
      ) : null}
      {lanReady ? (
        <RadioField
          label={t("settings.pair.via")}
          value={via}
          options={[
            { value: "address" as Via, label: t("settings.pair.viaAddress") },
            {
              value: "lan" as Via,
              label: t("settings.pair.viaLan"),
              hint: t("settings.pair.viaLanHint"),
            },
          ]}
          onChange={(v) => setChosenVia(v)}
        />
      ) : null}
      <fieldset className="m-0 flex min-w-0 flex-wrap gap-x-4 gap-y-1 border-0 p-0">
        <legend className="mb-1 text-callout text-muted-foreground">
          {t("settings.pair.scopes")}
        </legend>
        {SCOPE_CHOICES.map((s) => (
          <div key={s} className="flex items-center gap-1.5">
            <Checkbox
              id={`${id}-${s}`}
              checked={scopes.includes(s)}
              onCheckedChange={(v) => toggle(s, v === true)}
            />
            <Label htmlFor={`${id}-${s}`} className="font-normal">
              {scopeWord(s)}
            </Label>
          </div>
        ))}
      </fieldset>
      <p className="text-callout text-label-secondary">{t("settings.pair.adminHint")}</p>
      <div>
        <Button
          type="button"
          size="sm"
          disabled={busy || scopes.length === 0 || !canMake}
          onClick={make}
        >
          {t("settings.pair.make")}
        </Button>
      </div>

      {gone && made === null ? (
        <p role="status" className="text-callout text-label-secondary">
          {t("settings.pair.gone")}
        </p>
      ) : null}
      {made ? (
        <section
          aria-label={t("settings.pair.resultRegion")}
          className="flex flex-col gap-3 rounded-lg border border-gray-6 p-3"
          data-testid="pair-link"
        >
          <div className="flex flex-wrap items-start gap-4">
            <QrCode value={made.link} label={t("settings.pair.qrLabel", { host: made.hostName })} />
            <div className="flex min-w-56 flex-1 flex-col gap-2">
              <p className="text-callout">
                {t("settings.pair.scan", { host: made.hostName })}{" "}
                <span className="text-label-secondary">
                  {t("settings.pair.expires", {
                    when: formatRelative(made.setupToken.expiresAt, now),
                  })}
                </span>
              </p>
              <div className="flex items-start gap-2">
                <textarea
                  readOnly
                  rows={3}
                  value={made.link}
                  aria-label={t("settings.pair.linkLabel")}
                  onFocus={(e) => e.currentTarget.select()}
                  className="min-w-0 flex-1 resize-none rounded-md border border-gray-6 bg-gray-2 px-2 py-1 font-mono text-callout"
                />
                {writeClipboard ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      void writeClipboard(made.link, { clearAfterMs: 60_000 }).then(() => {
                        setCopied(true);
                        setTimeout(() => setCopied(false), 2000);
                      })
                    }
                  >
                    {copied ? t("settings.remote.copied") : t("settings.pair.copy")}
                  </Button>
                ) : null}
              </div>
              <p className="text-callout text-label-secondary">
                {t("settings.pair.gives", {
                  scopes: made.setupToken.scopes.map(scopeWord).join(", "),
                })}
              </p>
              <p className="text-callout text-label-secondary">
                {t("settings.pair.compare", {
                  fingerprint: groupFingerprint(made.gatewayFingerprint),
                })}
              </p>
              {made.version === 2 ? (
                <p className="text-callout text-label-secondary">{t("settings.pair.lanNote")}</p>
              ) : null}
              <p className="text-callout text-approval-text">{t("settings.pair.secret")}</p>
            </div>
          </div>
        </section>
      ) : null}

      {live.length > 0 ? (
        <ul className="flex flex-col divide-y divide-gray-6" aria-label={t("settings.pair.live")}>
          {live.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-2 py-2 first:pt-0 last:pb-0">
              <StatusChip tone="neutral">{t("settings.pair.unused")}</StatusChip>
              <span className="text-callout">
                {s.scopes.map(scopeWord).join(", ")}
                <span className="text-label-secondary">
                  {" · "}
                  {t("settings.pair.expires", { when: formatRelative(s.expiresAt, now) })}
                </span>
              </span>
              <span className="flex-1" />
              <Button
                type="button"
                size="xs"
                variant="ghost"
                aria-label={t("settings.pair.revokeNamed", {
                  when: formatRelative(s.createdAt, now),
                })}
                onClick={() => revoke(s.id)}
              >
                {t("settings.pair.revoke")}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </Group>
  );
}
