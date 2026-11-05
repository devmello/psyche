import { Loader } from "lucide-react";
import { type ReactElement, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { t } from "../../i18n/core.ts";
import { describeError } from "../../i18n/errors.ts";
import { StatusChip, type Tone } from "./shared.tsx";

/**
 * The bundled helper as the desktop sees it (it launches the helper, which pairs with the Gateway
 * on its own): the Mac helper on macOS, the Windows helper (`win-helper`) on Windows; the copy
 * names the right one (`t()` platform variants). Shown in onboarding's Safety step and Settings →
 * Devices; nothing waits on it.
 */
export type MacHelperStatus =
  | { kind: "unbundled" }
  | { kind: "starting" }
  | { kind: "paired" }
  | { kind: "offline"; reason?: string };

const TONE: Record<MacHelperStatus["kind"], Tone> = {
  paired: "success",
  starting: "info",
  offline: "neutral",
  unbundled: "neutral",
};

export function MacHelperStatusRow({
  state,
  onRestart,
}: {
  state: MacHelperStatus;
  /**
   * Starts the bundled helper again (the desktop's launcher) and resolves with its new state.
   * Offered while it is connected or offline; absent where the host cannot start it.
   */
  onRestart?: (() => Promise<MacHelperStatus>) | undefined;
}): ReactElement {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const v = {
    tone: TONE[state.kind],
    chip: t(`settings.macHelper.${state.kind}.chip`),
    text: t(`settings.macHelper.${state.kind}.text`),
  };
  const canRestart = onRestart && (state.kind === "paired" || state.kind === "offline");
  const restart = () => {
    if (!onRestart) return;
    setBusy(true);
    setError(null);
    onRestart().then(
      (next) => {
        setBusy(false);
        if (next.kind === "offline")
          setError(t("platform.helper.restartFailed", { reason: next.reason ?? "unknown" }));
      },
      (err: unknown) => {
        setBusy(false);
        setError(t("platform.helper.restartFailed", { reason: describeError(err) }));
      },
    );
  };
  return (
    <div
      className="flex flex-col gap-1 rounded-lg border border-gray-6 bg-gray-2 p-3"
      data-testid="mac-helper-status"
    >
      <div className="flex flex-wrap items-center gap-2">
        <p className="flex flex-1 flex-wrap items-center gap-2 font-medium">
          {t("settings.macHelper.name")}
          <StatusChip tone={v.tone}>{v.chip}</StatusChip>
        </p>
        {canRestart ? (
          <Button type="button" variant="outline" size="xs" disabled={busy} onClick={restart}>
            {busy ? <Loader className="motion-safe:animate-spin" aria-hidden="true" /> : null}
            {busy ? t("platform.helper.restarting") : t("platform.helper.restart")}
          </Button>
        ) : null}
      </div>
      <p className="text-sm text-muted-foreground">{v.text}</p>
      {state.kind === "offline" && state.reason ? (
        <p className="text-callout text-muted-foreground">
          {t("settings.macHelper.lastTry", { reason: state.reason })}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-callout text-danger-text">
          {error}
        </p>
      ) : null}
    </div>
  );
}
