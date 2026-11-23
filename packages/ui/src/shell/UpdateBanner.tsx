import { X } from "lucide-react";
import { type ReactElement, useEffect, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { t } from "../i18n/core.ts";
import { describeError } from "../i18n/errors.ts";
import type { UpdatePort, UpdateStatusView } from "../screens/settings/types.ts";

/**
 * The app's own update, as the desktop main reports it. Without a port (the web, or a desktop
 * that does not update itself) the status stays idle and nothing shows.
 */
export function useUpdateStatus(port: UpdatePort | undefined): UpdateStatusView {
  const [status, setStatus] = useState<UpdateStatusView>({ state: "idle" });
  useEffect(() => {
    if (!port) return;
    let live = true;
    const off = port.subscribe((s) => {
      if (live) setStatus(s);
    });
    void port.status().then(
      (s) => {
        if (live) setStatus(s);
      },
      () => undefined,
    );
    return () => {
      live = false;
      off();
    };
  }, [port]);
  return port ? status : { state: "idle" };
}

/**
 * The quiet line at the top of the sidebar when a verified update is ready: the version, "Restart
 * to update" and a dismiss. Dismissing hides it until the next launch. Shows nothing otherwise.
 */
export function UpdateBanner({ port }: { port?: UpdatePort }): ReactElement | null {
  const status = useUpdateStatus(port);
  const [dismissed, setDismissed] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  if (!port || status.state !== "ready" || dismissed === status.release) return null;
  const restart = (): void => {
    setError(undefined);
    port.restart().catch((err: unknown) => setError(describeError(err)));
  };
  return (
    <div
      role="status"
      data-testid="update-banner"
      className="mx-2 mb-2 flex flex-col gap-1.5 rounded-lg border border-separator bg-surface-raised p-2.5"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-callout text-label-primary">
          {status.mandatory
            ? t("shell.update.readyRequired", { version: status.release })
            : t("shell.update.ready", { version: status.release })}
        </p>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t("shell.update.dismiss")}
          onClick={() => setDismissed(status.release)}
          className="text-label-tertiary"
        >
          <X aria-hidden="true" />
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" onClick={restart}>
          {t("shell.update.restart")}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-footnote text-danger-text">
          {error}
        </p>
      ) : null}
    </div>
  );
}
