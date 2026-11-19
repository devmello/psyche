import { Loader, X } from "lucide-react";
import { type ReactElement, useEffect, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { useCall, useGatewayQuery } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import type { MacHelperStatus } from "./MacHelperStatus.tsx";

/** The Gateway's helper availability (`HelperAvailability`, published as this setting). */
export const HELPER_AVAILABILITY_KEY = "devices.helper.availability";

/** The setting that pins the Host's helper by device id (an admin setting, like any `devices.*`). */
export const HOST_HELPER_PIN_KEY = "devices.hostHelperDeviceId";

export interface HelperCandidate {
  deviceId: string;
  name: string;
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
        const h = c as { deviceId?: unknown; name?: unknown };
        return typeof h?.deviceId === "string" && typeof h.name === "string"
          ? [{ deviceId: h.deviceId, name: h.name }]
          : [];
      })
    : [];
  return { connected: o.connected, contactsDenied: o.contactsDenied === true, ambiguous };
}

/**
 * Two Host helpers are connected and Psyche will not guess: name both and let the owner choose
 * with one tap. The choice is the existing admin setting write; nothing here picks for them.
 */
export function HelperChoiceBanner({
  candidates,
  onChoose,
}: {
  candidates: HelperCandidate[];
  /** Pins the helper (`settings.set` of {@link HOST_HELPER_PIN_KEY}). */
  onChoose: (deviceId: string) => Promise<void>;
}): ReactElement {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const choose = (deviceId: string) => {
    setBusy(deviceId);
    setError(null);
    onChoose(deviceId).then(
      () => setBusy(null),
      (err: unknown) => {
        setBusy(null);
        setError(
          t("platform.helper.choose.failed", {
            reason: err instanceof Error ? err.message : String(err),
          }),
        );
      },
    );
  };
  return (
    <section
      role="status"
      aria-label={t("platform.helper.choose.title")}
      data-testid="helper-choice-banner"
      className="fixed inset-x-4 bottom-4 z-50 mx-auto flex max-w-xl flex-col gap-2 rounded-lg border border-gray-6 bg-gray-2 p-3 shadow-sm"
    >
      <p className="font-medium">{t("platform.helper.choose.title")}</p>
      <p className="text-sm text-muted-foreground">{t("platform.helper.choose.text")}</p>
      <div className="flex flex-wrap items-center gap-2">
        {candidates.map((c) => (
          <Button
            key={c.deviceId}
            type="button"
            size="sm"
            disabled={busy !== null}
            onClick={() => choose(c.deviceId)}
          >
            {busy === c.deviceId ? (
              <Loader className="motion-safe:animate-spin" aria-hidden="true" />
            ) : null}
            {t("platform.helper.choose.use", { name: c.name })}
          </Button>
        ))}
      </div>
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
  const q = useGatewayQuery("settings.get", { keys: [HELPER_AVAILABILITY_KEY] });
  const call = useCall();
  const gateway = parseStatus(q.data?.settings?.[HELPER_AVAILABILITY_KEY]);
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
  if (gateway !== undefined && gateway.ambiguous.length > 1) {
    return (
      <HelperChoiceBanner
        candidates={gateway.ambiguous}
        onChoose={async (deviceId) => {
          await call("settings.set", { key: HOST_HELPER_PIN_KEY, value: deviceId });
        }}
      />
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
