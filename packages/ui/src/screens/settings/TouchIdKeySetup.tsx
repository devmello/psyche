import type { MethodResult } from "@psyche/protocol";
import { type ReactElement, useId, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { t } from "../../i18n/core.ts";
import { describeError } from "../../i18n/errors.ts";

/** A registered helper Touch ID key (`devices.presenceKey.list`). */
export type PresenceKeyRow = MethodResult<"devices.presenceKey.list">["presenceKeys"][number];

/** What the helper inside this app reports about itself (`psyche-helper --print-identity`). */
export interface BundledHelperKey {
  deviceId: string;
  keyId?: string;
  /** `windows_hello` from the Windows helper (with `algorithm`, e.g. "RSA-2048"). */
  kind?: "windows_hello" | "device_identity";
  algorithm?: string;
  error?: string;
}

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
  return k.kind === "device_identity"
    ? t("settings.devices.presenceKey.deviceIdentity")
    : t("settings.devices.presenceKey.unknown");
}

/** What the bundled helper's key problem means, in plain words. */
function bundledErrorText(error: string | undefined): string {
  return t("settings.devices.touchId.noBundledKey", { reason: error ?? "unknown" });
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
  /** Registers the key: the bundled helper's (desktop) or the one with `expectKeyId`. */
  onRegister: (expectKeyId?: string, confirmReplacesKeyId?: string) => Promise<unknown>;
  onRemove: () => Promise<unknown>;
}

/**
 * A helper's presence key in Settings → Devices (security §10). A Mac helper has nothing to set up:
 * it signs with its own device key after the system's owner sheet (Touch ID or the Mac password),
 * so the row only says so. A Windows helper's Windows Hello key shows its kind and key id, Remove,
 * and registering a key only after the owner sees its id: on the desktop the id the helper inside
 * this app prints, never just whichever node answered on the socket.
 */
export function TouchIdKeySetup({
  deviceId,
  nodeKind,
  registered,
  bundled,
  onRegister,
  onRemove,
}: TouchIdKeySetupProps): ReactElement {
  const inputId = useId();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replace, setReplace] = useState<{ previous: string; expect: string | undefined } | null>(
    null,
  );
  /** Registers; when the Gateway needs the owner to confirm a replacement, asks naming the old key. */
  const register = (expect?: string, confirm?: string) => {
    setBusy(true);
    setError(null);
    (confirm !== undefined
      ? onRegister(expect, confirm)
      : expect !== undefined
        ? onRegister(expect)
        : onRegister()
    ).then(
      () => {
        setBusy(false);
        setReplace(null);
      },
      (err: unknown) => {
        setBusy(false);
        const d = (err as { details?: { reason?: unknown; replacesKeyId?: unknown } | null } | null)
          ?.details;
        if (d?.reason === "replace_confirmation_required" && typeof d.replacesKeyId === "string") {
          setReplace({ previous: d.replacesKeyId, expect });
          return;
        }
        setError(describeError(err));
      },
    );
  };
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

  if (nodeKind === "mac-helper" || registered?.kind === "device_identity") {
    return (
      <div
        className="flex flex-col gap-1 text-callout text-muted-foreground"
        data-testid="touch-id-key"
      >
        <p data-testid="presence-key">{t("settings.devices.presenceKey.deviceIdentity")}</p>
      </div>
    );
  }

  let body: ReactElement;
  if (registered !== undefined) {
    body = (
      <div className="flex flex-wrap items-center gap-2">
        <span data-testid="presence-key">{presenceKeyText(registered, nodeKind)}</span>
        <code className="font-mono text-label-secondary">{keyIdShort(registered.keyId)}</code>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => act(onRemove)}>
          {t("settings.devices.touchId.remove")}
        </Button>
        {bundled !== undefined && bundled !== null && bundled.deviceId === deviceId ? (
          bundled.error !== undefined ? (
            <p className="basis-full" role="status" data-testid="bundled-key-problem">
              {bundledErrorText(bundled.error)}
            </p>
          ) : bundled.keyId !== undefined && bundled.keyId !== registered.keyId ? (
            <p
              className="basis-full text-danger-text"
              role="alert"
              data-testid="bundled-key-mismatch"
            >
              {t("settings.devices.touchId.keyMismatch", {
                shown: keyIdShort(bundled.keyId),
                registered: keyIdShort(registered.keyId),
              })}
            </p>
          ) : null
        ) : null}
      </div>
    );
  } else if (bundled !== undefined && bundled !== null) {
    body =
      bundled.deviceId !== deviceId ? (
        <p data-testid="touch-id-not-bundled">{t("settings.devices.touchId.notBundled")}</p>
      ) : bundled.keyId === undefined ? (
        <p data-testid="touch-id-no-key">{bundledErrorText(bundled.error)}</p>
      ) : (
        <div className="flex flex-col gap-2">
          <p>
            {t("settings.devices.touchId.bundled")}{" "}
            <code className="font-mono" data-testid="bundled-key-id">
              {keyIdShort(bundled.keyId)}
            </code>
          </p>
          <p data-testid="presence-key">{presenceKeyText(bundled, nodeKind)}</p>
          <div>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => register()}>
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
            onClick={() => register(typed.trim())}
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
      {replace !== null ? (
        <div
          role="alert"
          className="flex flex-col gap-2 text-danger-text"
          data-testid="confirm-replace"
        >
          <p>
            {t("settings.devices.touchId.confirmReplace", {
              previous: keyIdShort(replace.previous),
            })}
          </p>
          <div>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => register(replace.expect, replace.previous)}
            >
              {t("settings.devices.touchId.confirmReplaceButton")}
            </Button>
          </div>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-danger-text">
          {error}
        </p>
      ) : null}
    </div>
  );
}
