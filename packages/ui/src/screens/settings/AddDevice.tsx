import { type ReactElement, useEffect, useId, useRef, useState } from "react";
import { QrCode } from "../../components/QrCode.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Label } from "../../components/ui/label.tsx";
import { t } from "../../i18n/core.ts";
import { useNow } from "../../lib/use-now.ts";
import { ErrorNotice, Group, messageOf } from "./shared.tsx";

/**
 * Settings → Devices → Add phone or computer (remote-gateway design §3.4, mobile companion §2.2).
 * Makes a pairing link on the Gateway and shows it as text and as a QR code of the same payload,
 * with the time it has left. The link is not a URL and is never opened: a phone scans it with its
 * own scanner, and another computer pastes it into Add a Gateway. It holds no long-lived secret;
 * the owner still approves the new device (and its scopes) under "Waiting to pair".
 */

export interface PairingLink {
  link: string;
  expiresAt: string;
}

export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function AddDeviceGroup({
  create,
  publicOrigin,
  now: fixedNow,
}: {
  /** `devices.pairing.createLink`; the address is only passed when the Gateway has none. */
  create: (gatewayUrl?: string) => Promise<PairingLink>;
  /** `gateway.info`'s `publicOrigin`: when null the owner types the address others reach it at. */
  publicOrigin: string | null;
  now?: number;
}): ReactElement {
  const id = useId();
  const [made, setMade] = useState<PairingLink | null>(null);
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const clock = useNow(1000, fixedNow);
  // The link as last copied to the clipboard, so it can be taken back when it stops working.
  const copiedLink = useRef<string | null>(null);

  const remaining = made ? new Date(made.expiresAt).getTime() - clock : 0;
  const expired = made !== null && remaining <= 0;
  // An expired link is dropped from the page: nothing to copy or scan that no longer works.
  // If the clipboard still holds the copied link it is cleared too; a clipboard that holds
  // anything else, or that cannot be read, is left alone.
  useEffect(() => {
    if (!expired) return;
    setCopied(false);
    const link = copiedLink.current;
    copiedLink.current = null;
    if (link === null) return;
    void navigator.clipboard.readText().then(
      (now) => (now === link ? navigator.clipboard.writeText("") : undefined),
      () => undefined,
    );
  }, [expired]);

  const needsAddress = publicOrigin === null;
  const make = () => {
    setBusy(true);
    setError(null);
    create(needsAddress ? address.trim() : undefined).then(
      (result) => {
        setBusy(false);
        setMade(result);
      },
      (err: unknown) => {
        setBusy(false);
        setError(messageOf(err));
      },
    );
  };
  const copy = () => {
    if (!made) return;
    navigator.clipboard.writeText(made.link).then(
      () => {
        copiedLink.current = made.link;
        setCopied(true);
      },
      () => setError(t("settings.devices.add.copyFailed")),
    );
  };

  const live = made !== null && !expired;
  return (
    <Group
      title={t("settings.devices.add.title")}
      description={t("settings.devices.add.description")}
    >
      {needsAddress && !live ? (
        <div className="flex max-w-md flex-col gap-1">
          <Label htmlFor={`${id}-address`}>{t("settings.devices.add.addressLabel")}</Label>
          <Input
            id={`${id}-address`}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder={t("settings.devices.add.addressPlaceholder")}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            inputMode="url"
          />
          <p className="text-callout text-label-secondary">
            {t("settings.devices.add.addressHint")}
          </p>
        </div>
      ) : null}
      {live ? (
        <div className="flex flex-wrap items-start gap-4" data-testid="pairing-link">
          <QrCode
            text={made.link}
            label={t("settings.devices.add.qrLabel")}
            className="size-44 shrink-0 overflow-hidden rounded-md border border-gray-6 bg-white [&>svg]:size-full"
          />
          <div className="flex min-w-56 flex-1 flex-col gap-2">
            <p className="text-callout text-label-secondary">{t("settings.devices.add.howTo")}</p>
            <code
              className="max-h-24 overflow-y-auto break-all rounded bg-gray-4 p-2 font-mono text-callout"
              data-testid="pairing-link-text"
            >
              {made.link}
            </code>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" variant="outline" size="sm" onClick={copy}>
                {copied ? t("settings.devices.add.copied") : t("settings.devices.add.copy")}
              </Button>
              <span
                className="text-callout text-label-secondary tabular-nums"
                data-testid="pairing-link-countdown"
              >
                {t("settings.devices.add.expiresIn", { time: formatCountdown(remaining) })}
              </span>
            </div>
            <p className="text-callout text-label-secondary">
              {t("settings.devices.add.afterwards")}
            </p>
          </div>
        </div>
      ) : null}
      {expired ? (
        <p className="text-callout text-label-secondary" role="status">
          {t("settings.devices.add.expired")}
        </p>
      ) : null}
      {error ? <ErrorNotice what={error} did={t("settings.shared.nothingChanged")} /> : null}
      {live ? null : (
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || (needsAddress && address.trim() === "")}
            onClick={make}
          >
            {expired ? t("settings.devices.add.again") : t("settings.devices.add.button")}
          </Button>
        </div>
      )}
    </Group>
  );
}
