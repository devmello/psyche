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
  /** `windows_hello` from the Windows helper (with `algorithm`, e.g. "RSA-2048"). */
  kind?: "keychain" | "enclave_file" | "windows_hello";
  algorithm?: string;
  error?: string;
}

/** `devices.presence.allowDevFileKey` (Gateway `DEV_FILE_KEY_SETTING`). */
export const DEV_FILE_KEY_SETTING = "devices.presence.allowDevFileKey";

/** Key kinds a Windows helper reports for its Windows Hello key (KeyCredentialManager / TPM). */
const WINDOWS_HELLO_KINDS = new Set(["windows_hello", "hello", "ngc", "tpm"]);

/** "RSA-2048" for the ids helpers and the Gateway use ("rsa-2048", "RS256", "RSA2048"). */
function algorithmName(alg: string): string {
  const a = alg.trim().toUpperCase().replace(/_/g, "-");
  // The Windows helper reports "rsa-2048-pkcs1-sha256" (apps/win-helper presence key).
  if (a === "RS256" || a === "RSA" || /^RSA-?2048(-|$)/.test(a)) return "RSA-2048";
  if (a === "ES256" || a === "P-256" || a === "P256" || a === "ECDSA-P256") return "ECDSA P-256";
  return alg;
}

/**
 * Which presence key a helper signs approvals with: what the helper reports, in plain words. The
 * key's kind decides, not the platform this window runs on: Devices lists a Mac's Touch ID key
 * and a PC's Windows Hello key side by side. A Windows Hello key says its algorithm (RSA-2048:
 * Windows Hello keys are TPM-backed RSA keys) when the Gateway reports it. `nodeKind` names the
 * helper when the key's kind is missing.
 */
export function presenceKeyText(
  k: { kind?: string | undefined; algorithm?: string | undefined },
  nodeKind?: string,
): string {
  const hello =
    (k.kind !== undefined && WINDOWS_HELLO_KINDS.has(k.kind)) ||
    (k.kind === undefined && nodeKind === "win-helper") ||
    (k.kind === undefined && k.algorithm !== undefined && /^rs|^rsa/i.test(k.algorithm));
  if (hello)
    return k.algorithm
      ? t("settings.devices.presenceKey.windowsHello", { algorithm: algorithmName(k.algorithm) })
      : t("settings.devices.presenceKey.windowsHelloNoAlgorithm");
  return k.kind === "enclave_file"
    ? t("settings.devices.presenceKey.enclaveFile")
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
  /** The helper node's kind (`mac-helper`, `win-helper`): names a key whose kind is not reported. */
  nodeKind?: string | undefined;
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
  nodeKind,
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
        <span data-testid="presence-key">{presenceKeyText(registered, nodeKind)}</span>
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
          <p data-testid="presence-key">{presenceKeyText(bundled, nodeKind)}</p>
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
