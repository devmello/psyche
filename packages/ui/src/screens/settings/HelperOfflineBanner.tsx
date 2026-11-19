import { Loader, X } from "lucide-react";
import { type ReactElement, useContext, useEffect, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { useCall, useGatewayQuery } from "../../data/hooks.ts";
import { activeI18n, t } from "../../i18n/core.ts";
import { HOST_HELPER_STATUS_KEY } from "./HostHelperCheckGroup.tsx";
import type { MacHelperStatus } from "./MacHelperStatus.tsx";
import { SettingsApprovalProvider } from "./SettingsApproval.tsx";
import { settingLabel } from "./setting-labels.ts";
import { approvalIdOf, messageOf, SettingsApprovalContext } from "./shared.tsx";

/** The Gateway's helper availability (`HelperAvailability`, published as this setting). */
export const HELPER_AVAILABILITY_KEY = "devices.helper.availability";

/** The setting that pins the Host's helper by device id (an admin setting, like any `devices.*`). */
export const HOST_HELPER_PIN_KEY = "devices.hostHelperDeviceId";

export interface HelperCandidate {
  deviceId: string;
  /** What the helper calls itself: a claim, and the same for every Mac helper. */
  name: string;
  /** When the Gateway paired this device (ISO). The Gateway's own record, unlike the name. */
  pairedAt: string | null;
}

interface GatewayHelperStatus {
  connected: boolean;
  contactsDenied: boolean;
  ambiguous: HelperCandidate[];
}

function parseStatus(v: unknown): GatewayHelperStatus | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as { connected?: unknown; contactsDenied?: unknown; ambiguous?: unknown };
  if (typeof o.connected !== "boolean") return undefined;
  const ambiguous = Array.isArray(o.ambiguous)
    ? o.ambiguous.flatMap((c: unknown): HelperCandidate[] => {
        const h = c as { deviceId?: unknown; name?: unknown; pairedAt?: unknown };
        return typeof h?.deviceId === "string" && typeof h.name === "string"
          ? [
              {
                deviceId: h.deviceId,
                name: h.name,
                pairedAt: typeof h.pairedAt === "string" ? h.pairedAt : null,
              },
            ]
          : [];
      })
    : [];
  return { connected: o.connected, contactsDenied: o.contactsDenied === true, ambiguous };
}

/** The last four characters of a device id: enough to tell two apart, never a secret. */
function idSuffix(deviceId: string): string {
  return deviceId.slice(-4);
}

/** "Use the helper paired Nov 13, 5:27 AM (...a1f3)": facts the Gateway knows, not the name. */
function chooseLabel(c: HelperCandidate): string {
  const id = idSuffix(c.deviceId);
  if (c.pairedAt === null) return t("platform.helper.choose.useNoTime", { id });
  const when = activeI18n().date(c.pairedAt, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return t("platform.helper.choose.use", { when, id });
}

/**
 * More than one Host helper is connected and Psyche will not guess: list them by what the Gateway
 * knows (when each was paired, a short id) and let the owner choose with one tap. The choice is
 * the existing admin setting write, so with a verifier enrolled it comes back as a plain-tap
 * approval card, which this shows and then retries the write with. It is a tie-breaker: it applies
 * while the helpers are all connected.
 */
export function HelperChoiceBanner({
  candidates,
  onChoose,
}: {
  candidates: HelperCandidate[];
  /** Pins the helper (`settings.set` of {@link HOST_HELPER_PIN_KEY}), with the approval if any. */
  onChoose: (deviceId: string, approvalId?: string) => Promise<void>;
}): ReactElement {
  const requestApproval = useContext(SettingsApprovalContext);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const choose = (deviceId: string) => {
    setBusy(deviceId);
    setError(null);
    onChoose(deviceId).then(
      () => setBusy(null),
      (err: unknown) => {
        setBusy(null);
        const approvalId = approvalIdOf(err);
        if (approvalId !== null && requestApproval) {
          requestApproval({
            key: HOST_HELPER_PIN_KEY,
            label: settingLabel(HOST_HELPER_PIN_KEY),
            approvalId,
            retry: (id) => onChoose(deviceId, id),
          });
          return;
        }
        setError(t("platform.helper.choose.failed", { reason: messageOf(err) }));
      },
    );
  };
  return (
    <section
      role="status"
      aria-label={t("platform.helper.choose.title")}
      data-testid="helper-choice-banner"
      className="flex flex-col gap-2 rounded-lg border border-gray-6 bg-gray-2 p-3 shadow-sm"
    >
      <p className="font-medium">{t("platform.helper.choose.title")}</p>
      <p className="text-sm text-muted-foreground">{t("platform.helper.choose.text")}</p>
      <ul className="flex flex-col gap-2">
        {candidates.map((c) => (
          <li key={c.deviceId} className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              disabled={busy !== null}
              onClick={() => choose(c.deviceId)}
            >
              {busy === c.deviceId ? (
                <Loader className="motion-safe:animate-spin" aria-hidden="true" />
              ) : null}
              {chooseLabel(c)}
            </Button>
            <span className="text-xs text-muted-foreground">
              {t("platform.helper.choose.name", { name: c.name })}
            </span>
          </li>
        ))}
      </ul>
      {error !== null ? (
        <p role="alert" className="text-sm text-destructive" data-testid="helper-choice-error">
          {error}
        </p>
      ) : null}
    </section>
  );
}

/**
 * The Psyche Helper notice. The Gateway's own view decides whether the helper is down (the
 * sources and jobs that need it are paused by then), so the banner follows what Psyche sees, with
 * the desktop launcher's state as the fallback before the Gateway has reported. One dismissable
 * banner with Reconnect while it is offline; a one-line hint when Contacts lacks permission.
 */
export function HelperOfflineBanner({
  state,
  onReconnect,
}: {
  state: MacHelperStatus | undefined;
  /** Starts the bundled helper and resolves with its new state. */
  onReconnect: () => Promise<MacHelperStatus>;
}): ReactElement | null {
  const q = useGatewayQuery("settings.get", {
    keys: [HELPER_AVAILABILITY_KEY, HOST_HELPER_STATUS_KEY],
  });
  const call = useCall();
  const gateway = parseStatus(q.data?.settings?.[HELPER_AVAILABILITY_KEY]);
  // The registry resets its own status at every start, so it decides whether the conflict is real
  // now; the persisted candidate list alone could be left over from a previous run.
  const conflict =
    (q.data?.settings?.[HOST_HELPER_STATUS_KEY] as { ambiguous?: unknown } | undefined)
      ?.ambiguous === true;
  const offline = gateway !== undefined ? !gateway.connected : state?.kind === "offline";
  const contactsDenied = gateway?.contactsDenied === true;

  const [dismissed, setDismissed] = useState(false);
  const [hintDismissed, setHintDismissed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Back up again: the next outage is news, so the banner comes back.
    if (!offline) setDismissed(false);
  }, [offline]);
  useEffect(() => {
    if (!contactsDenied) setHintDismissed(false);
  }, [contactsDenied]);

  // Two helpers are running: "isn't connected" would be wrong, and Reconnect would add a third.
  if (conflict && gateway !== undefined && gateway.ambiguous.length > 1) {
    return (
      <div className="fixed inset-x-4 bottom-4 z-50 mx-auto flex max-w-xl flex-col gap-2">
        <SettingsApprovalProvider>
          <HelperChoiceBanner
            candidates={gateway.ambiguous}
            onChoose={async (deviceId, approvalId) => {
              await call("settings.set", {
                key: HOST_HELPER_PIN_KEY,
                value: deviceId,
                ...(approvalId === undefined ? {} : { approvalId }),
              });
            }}
          />
        </SettingsApprovalProvider>
      </div>
    );
  }

  if (offline && !dismissed) {
    const reconnect = () => {
      setBusy(true);
      onReconnect().then(
        () => setBusy(false),
        () => setBusy(false),
      );
    };
    return (
      <section
        role="status"
        aria-label={t("platform.helper.offline.title")}
        data-testid="helper-offline-banner"
        className="fixed inset-x-4 bottom-4 z-50 mx-auto flex max-w-xl flex-wrap items-start gap-3 rounded-lg border border-gray-6 bg-gray-2 p-3 shadow-sm"
      >
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="font-medium">{t("platform.helper.offline.title")}</p>
          <p className="text-sm text-muted-foreground">{t("platform.helper.offline.text")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" disabled={busy} onClick={reconnect}>
            {busy ? <Loader className="motion-safe:animate-spin" aria-hidden="true" /> : null}
            {t("platform.helper.offline.reconnect")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("platform.helper.offline.dismiss")}
            onClick={() => setDismissed(true)}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
      </section>
    );
  }

  if (!offline && contactsDenied && !hintDismissed) {
    return (
      <section
        role="status"
        data-testid="helper-contacts-hint"
        className="fixed inset-x-4 bottom-4 z-50 mx-auto flex max-w-xl items-center gap-3 rounded-lg border border-gray-6 bg-gray-2 p-3 shadow-sm"
      >
        <p className="min-w-0 flex-1 text-sm">{t("platform.helper.contactsPermission")}</p>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t("platform.helper.offline.dismiss")}
          onClick={() => setHintDismissed(true)}
        >
          <X aria-hidden="true" />
        </Button>
      </section>
    );
  }

  return null;
}
