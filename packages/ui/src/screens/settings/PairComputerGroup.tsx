import type { MethodResult, SetupTokenScope } from "@psyche/protocol";
import { type ReactElement, useContext, useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { QrCode } from "../../components/QrCode.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Checkbox } from "../../components/ui/checkbox.tsx";
import { Label } from "../../components/ui/label.tsx";
import { useCall, useGatewayQuery, useSettings } from "../../data/hooks.ts";
import { isMessageId, t } from "../../i18n/core.ts";
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

function scopeWord(s: string): string {
  const key = `settings.devices.scope.${s}`;
  return isMessageId(key) ? t(key) : s;
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

/**
 * The link made here and the one-time token behind it. The link and its QR code are shown only
 * while the token can still be used: they go as soon as it is used, revoked or expired (this
 * checks every few seconds), and with this screen.
 */
function useMadeLink(now: number) {
  const tokens = useGatewayQuery("devices.setupToken.list", {});
  const [made, setMade] = useState<Made | null>(null);
  const [gone, setGone] = useState(false);
  const madeId = made?.setupToken.id;
  const madeExpiry = made?.setupToken.expiresAt;
  const reloadTokens = tokens.reload;
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
  const finish = (result: Made) => {
    setMade(result);
    setGone(false);
    toast(t("settings.pair.madeToast"));
    tokens.reload();
  };
  return { tokens, made, setMade, gone, finish };
}

/** The QR code, the link to copy and what it gives: shown only while the token is live. */
function MadeLink({
  made,
  now,
  scan,
  lan,
}: {
  made: Made;
  now: number;
  scan: string;
  lan: boolean;
}): ReactElement {
  const { writeClipboard } = useSlots();
  const [copied, setCopied] = useState(false);
  return (
    <section
      aria-label={t("settings.pair.resultRegion")}
      className="flex flex-col gap-3 rounded-lg border border-gray-6 p-3"
      data-testid="pair-link"
    >
      <div className="flex flex-wrap items-start gap-4">
        <QrCode value={made.link} label={t("settings.pair.qrLabel", { host: made.hostName })} />
        <div className="flex min-w-56 flex-1 flex-col gap-2">
          <p className="text-callout">
            {scan}{" "}
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
          {lan && made.version === 2 ? (
            <p className="text-callout text-label-secondary">{t("settings.pair.lanNote")}</p>
          ) : null}
          <p className="text-callout text-approval-text">{t("settings.pair.secret")}</p>
        </div>
      </div>
    </section>
  );
}

export function PairComputerGroup({ now: fixedNow }: { now?: number }): ReactElement {
  const id = useId();
  const call = useCall();
  const requestApproval = useContext(SettingsApprovalContext);
  const info = useGatewayQuery("gateway.info", {});
  const now = useNow(15_000, fixedNow);
  const { tokens, made, setMade, gone, finish } = useMadeLink(now);
  const [scopes, setScopes] = useState<SetupTokenScope[]>([...DEFAULT_SCOPES]);
  const [chosenVia, setChosenVia] = useState<Via | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        <MadeLink
          made={made}
          now={now}
          scan={t("settings.pair.scan", { host: made.hostName })}
          lan
        />
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

const LAN_SETTING = "gateway.lan";

/**
 * Settings → Devices → Pair iPhone. One button: it makes a pairing link for this network with the
 * access a phone always gets (read, write and approvals, never admin) and shows the QR code. If
 * the network listener is off, the same tap turns it on: the owner's tap is the opt-in, the group
 * says so plainly and offers to turn it off again. Making the link is the same security change as
 * in "Pair another computer", so it asks for the same approval.
 */
export function PairIphoneGroup({ now: fixedNow }: { now?: number }): ReactElement {
  const call = useCall();
  const { set } = useSettings();
  const requestApproval = useContext(SettingsApprovalContext);
  const info = useGatewayQuery("gateway.info", {});
  const now = useNow(15_000, fixedNow);
  const { made, setMade, gone, finish } = useMadeLink(now);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lanNote, setLanNote] = useState<"on" | "off" | null>(null);
  const lan = info.data?.lan;
  const lanReady =
    lan?.enabled === true &&
    lan.listening.length > 0 &&
    lan.certSpki !== null &&
    lan.origin !== null;
  const reloadInfo = info.reload;

  const createLink = (waitForListener: boolean, attempt = 0): void => {
    const params: { scopes: SetupTokenScope[]; via: "lan" } = {
      scopes: [...DEFAULT_SCOPES],
      via: "lan",
    };
    call("devices.setupToken.create", params).then(
      (result) => {
        setBusy(false);
        finish(result);
      },
      (err: unknown) => {
        const approvalId = approvalIdOf(err);
        if (approvalId === null) {
          // Just turned on: the listener and its certificate can take a moment to come up.
          if (waitForListener && hasCode(err, "unavailable") && attempt < 4) {
            setTimeout(() => createLink(true, attempt + 1), 750);
            return;
          }
          setBusy(false);
          setError(
            hasCode(err, "unavailable")
              ? t("simplifyB4.pairIphone.noNetwork")
              : createError(err, "lan"),
          );
          return;
        }
        setBusy(false);
        if (requestApproval === null) {
          setError(presenceUnavailable());
          return;
        }
        requestApproval({
          key: "devices.setupToken",
          label: t("simplifyB4.pairIphone.title"),
          approvalId,
          retry: (approved) =>
            call("devices.setupToken.create", { ...params, approvalId: approved }).then(
              (result) => {
                finish(result);
                return result;
              },
              (retryErr: unknown) => {
                setError(createError(retryErr, "lan"));
                throw retryErr;
              },
            ),
        });
      },
    );
  };

  /** Writes the network setting the way the network group does, keeping the owner's choices. */
  const writeLan = (enabled: boolean, onDone: () => void, onFail: (err: unknown) => void) => {
    const value = {
      enabled,
      interfaces: lan?.interfaces ?? [],
      port: lan?.port ?? 7979,
      ipv6: lan?.ipv6 ?? false,
    };
    const done = () => {
      reloadInfo();
      onDone();
    };
    set(LAN_SETTING, value).then(done, (err: unknown) => {
      const approvalId = approvalIdOf(err);
      if (approvalId === null) return onFail(err);
      if (requestApproval === null) return onFail(new Error(presenceUnavailable()));
      setBusy(false);
      requestApproval({
        key: LAN_SETTING,
        approvalId,
        retry: (approved) => set(LAN_SETTING, value, approved).then(done),
      });
    });
  };

  const pair = () => {
    setBusy(true);
    setError(null);
    setMade(null);
    if (lanReady) {
      createLink(false);
      return;
    }
    if (lan === undefined) {
      setBusy(false);
      setError(t("simplifyB4.pairIphone.noNetwork"));
      return;
    }
    writeLan(
      true,
      () => {
        setLanNote("on");
        createLink(true);
      },
      (err) => {
        setBusy(false);
        setError(t("simplifyB4.pairIphone.enableFailed", { reason: messageOf(err) }));
      },
    );
  };

  const turnOff = () => {
    setError(null);
    writeLan(
      false,
      () => {
        setLanNote("off");
        setMade(null);
      },
      (err) => setError(t("simplifyB4.pairIphone.turnOffFailed", { reason: messageOf(err) })),
    );
  };

  return (
    <Group
      title={t("simplifyB4.pairIphone.title")}
      description={t("simplifyB4.pairIphone.description")}
    >
      {error ? <ErrorNotice what={error} did={t("settings.shared.nothingChanged")} /> : null}
      <div>
        <Button type="button" size="sm" disabled={busy} onClick={pair}>
          {t("simplifyB4.pairIphone.button")}
        </Button>
      </div>
      {lanNote === "on" && lan?.enabled === true ? (
        <p role="status" className="flex flex-wrap items-center gap-2 text-callout">
          <span className="text-label-secondary">{t("simplifyB4.pairIphone.lanOn")}</span>
          <Button type="button" size="xs" variant="outline" onClick={turnOff}>
            {t("simplifyB4.pairIphone.turnOff")}
          </Button>
        </p>
      ) : null}
      {lanNote === "off" ? (
        <p role="status" className="text-callout text-label-secondary">
          {t("simplifyB4.pairIphone.lanOff")}
        </p>
      ) : null}
      {gone && made === null ? (
        <p role="status" className="text-callout text-label-secondary">
          {t("settings.pair.gone")}
        </p>
      ) : null}
      {made ? (
        <MadeLink made={made} now={now} scan={t("simplifyB4.pairIphone.scan")} lan={false} />
      ) : null}
    </Group>
  );
}
