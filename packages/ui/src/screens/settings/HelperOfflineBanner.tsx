import { Loader, X } from "lucide-react";
import { type ReactElement, useEffect, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { useGatewayQuery } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import type { MacHelperStatus } from "./MacHelperStatus.tsx";

/** The Gateway's helper availability (`HelperAvailability`, published as this setting). */
export const HELPER_AVAILABILITY_KEY = "devices.helper.availability";

interface GatewayHelperStatus {
  connected: boolean;
  contactsDenied: boolean;
}

function parseStatus(v: unknown): GatewayHelperStatus | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as { connected?: unknown; contactsDenied?: unknown };
  if (typeof o.connected !== "boolean") return undefined;
  return { connected: o.connected, contactsDenied: o.contactsDenied === true };
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
