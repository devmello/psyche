import type { MethodResult } from "@psyche/protocol";
import { type ReactElement, useId, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { t } from "../../i18n/core.ts";
import { describeError } from "../../i18n/errors.ts";
import { SwitchField } from "./shared.tsx";

/** A registered helper Touch ID key (`devices.presenceKey.list`). */
export type PresenceKeyRow = MethodResult<"devices.presenceKey.list">["presenceKeys"][number];

/** What the helper inside this app reports about itself (`psyche-helper --print-identity`). */
export interface BundledHelperKey {
  deviceId: string;
  keyId?: string;
  kind?: "keychain" | "enclave_keychain_acl" | "enclave_file";
  error?: string;
}

/** `devices.presence.allowDevFileKey` (Gateway `DEV_FILE_KEY_SETTING`). */
export const DEV_FILE_KEY_SETTING = "devices.presence.allowDevFileKey";

/** Which Touch ID key a helper signs approvals with: what the helper reports, in plain words. */
export function presenceKeyText(k: { kind?: string | undefined }): string {
  return k.kind === "enclave_file"
    ? t("settings.devices.presenceKey.enclaveFile")
    : k.kind === "enclave_keychain_acl"
      ? t("settings.devices.presenceKey.enclaveKeychainAcl")
      : k.kind === "keychain"
        ? t("settings.devices.presenceKey.keychain")
        : t("settings.devices.presenceKey.unknown");
}

/** `0123 4567 89ab cdef …`: the start of a key id, grouped so the owner can compare it. */
export function keyIdShort(keyId: string): string {
  return `${(keyId.slice(0, 16).match(/.{1,4}/g) ?? []).join(" ")} …`;
}

export interface TouchIdKeySetupProps {
  /** The helper node's device. */
  deviceId: string;
  registered?: PresenceKeyRow | undefined;
  /**
   * The desktop: what the helper bundled with this app reports (null when the app bundles none,
   * a development build). Undefined on hosts that cannot ask (the web client): the owner types
   * the key id the helper prints.
   */
  bundled?: BundledHelperKey | null | undefined;
  allowDevFileKey: boolean;
  /** Registers the key: the bundled helper's (desktop) or the one with `expectKeyId`. */
  onRegister: (expectKeyId?: string) => Promise<unknown>;
  onRemove: () => Promise<unknown>;
  onAllowDevFileKey: (on: boolean) => Promise<unknown>;
}

/**
 * A helper's Touch ID key in Settings → Devices (security §10): the key it reports and its kind,
 * Remove (to recover after a fingerprint change), and registering a key only after the owner
 * sees its id: on the desktop the id the helper inside this app prints, never just whichever node
 * answered on the socket.
 */
export function TouchIdKeySetup({
  deviceId,
  registered,
  bundled,
  allowDevFileKey,
  onRegister,
  onRemove,
  onAllowDevFileKey,
}: TouchIdKeySetupProps): ReactElement {
  const inputId = useId();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = (p: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    p().then(
      () => setBusy(false),
      (err: unknown) => {
        setBusy(false);
        setError(describeError(err));
      },
    );
  };

  let body: ReactElement;
  if (registered !== undefined) {
    body = (
      <div className="flex flex-wrap items-center gap-2">
        <span data-testid="presence-key">{presenceKeyText(registered)}</span>
        <code className="font-mono text-label-secondary">{keyIdShort(registered.keyId)}</code>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => act(onRemove)}>
          {t("settings.devices.touchId.remove")}
        </Button>
      </div>
    );
  } else if (bundled !== undefined && bundled !== null) {
    const fileKey = bundled.kind === "enclave_file";
    body =
      bundled.deviceId !== deviceId ? (
        <p data-testid="touch-id-not-bundled">{t("settings.devices.touchId.notBundled")}</p>
      ) : bundled.keyId === undefined ? (
        <p>{t("settings.devices.touchId.noBundledKey", { reason: bundled.error ?? "unknown" })}</p>
      ) : (
        <div className="flex flex-col gap-2">
          <p>
            {t("settings.devices.touchId.bundled")}{" "}
            <code className="font-mono" data-testid="bundled-key-id">
              {keyIdShort(bundled.keyId)}
            </code>
          </p>
          <p data-testid="presence-key">{presenceKeyText(bundled)}</p>
          {fileKey ? (
            <SwitchField
              label={t("settings.devices.touchId.allowDevFileKey")}
              description={t("settings.devices.touchId.devFileKey")}
              checked={allowDevFileKey}
              disabled={busy}
              onChange={(on) => act(() => onAllowDevFileKey(on))}
            />
          ) : null}
          <div>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || (fileKey && !allowDevFileKey)}
              onClick={() => act(() => onRegister())}
            >
              {t("settings.devices.touchId.register")}
            </Button>
          </div>
        </div>
      );
  } else {
    const valid = /^[0-9a-f]{64}$/.test(typed.trim());
    body = (
      <div className="flex flex-col gap-2">
        <label htmlFor={inputId}>{t("settings.devices.touchId.manualLabel")}</label>
        <p>{t("settings.devices.touchId.manualHint")}</p>
        <div className="flex gap-2">
          <Input
            id={inputId}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
          />
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !valid}
            onClick={() => act(() => onRegister(typed.trim()))}
          >
            {t("settings.devices.touchId.register")}
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div
      className="flex flex-col gap-1 text-callout text-muted-foreground"
      data-testid="touch-id-key"
    >
      {registered === undefined ? <p>{t("settings.devices.touchId.none")}</p> : null}
      {body}
      {error ? (
        <p role="alert" className="text-danger-text">
          {error}
        </p>
      ) : null}
    </div>
  );
}
