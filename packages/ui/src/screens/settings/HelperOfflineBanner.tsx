import { Loader, X } from "lucide-react";
import { type ReactElement, useEffect, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { t } from "../../i18n/core.ts";
import type { MacHelperStatus } from "./MacHelperStatus.tsx";

/**
 * "Psyche Helper isn't connected": one dismissable notice while the bundled helper is offline,
 * with a Reconnect action that starts it again. Dismissing hides it until the helper connects
 * and goes offline once more. Nothing here blocks the app; the sources and jobs that need the
 * helper wait for it.
 */
export function HelperOfflineBanner({
  state,
  onReconnect,
}: {
  state: MacHelperStatus | undefined;
  /** Starts the bundled helper and resolves with its new state. */
  onReconnect: () => Promise<MacHelperStatus>;
}): ReactElement | null {
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const offline = state?.kind === "offline";

  useEffect(() => {
    // Connected again: the next outage is news, so the banner comes back.
    if (!offline) setDismissed(false);
  }, [offline]);

  if (!offline || dismissed) return null;

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
