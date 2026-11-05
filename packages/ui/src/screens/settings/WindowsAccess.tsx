import type { ReactElement } from "react";
import { Button } from "../../components/ui/button.tsx";
import { t } from "../../i18n/core.ts";
import { StatusChip } from "./shared.tsx";
import type { TccPermission, TccState } from "./types.ts";

/**
 * What Windows asks for, in place of the macOS privacy panes (Settings → Computer use, onboarding's
 * Safety step). Windows has no Accessibility or Screen Recording grant: UI Automation and screen
 * capture need no permission, and the one switch that matters is the microphone privacy toggle.
 * The rows say so instead of showing grants that don't exist (cross-platform-2026 §4.2,
 * `os.permissions`).
 */

const STATE_TONE: Record<TccState, "success" | "danger" | "neutral"> = {
  granted: "success",
  denied: "danger",
  not_determined: "neutral",
};

function Row({
  name,
  chip,
  why,
  action,
}: {
  name: string;
  chip: ReactElement;
  why: string;
  action?: ReactElement | null;
}): ReactElement {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="font-medium">{name}</span>
      {chip}
      <span className="basis-full text-callout text-muted-foreground">{why}</span>
      {action}
    </div>
  );
}

export function WindowsAccessRows({
  persona,
  microphone,
  onOpenSettings,
}: {
  persona: string;
  /** The microphone privacy toggle as the desktop reads it; undefined when it can't tell. */
  microphone?: TccState | undefined;
  /** Opens Windows Settings at the privacy page for `permission` (the desktop's permissions port). */
  onOpenSettings?: ((permission: TccPermission) => void) | undefined;
}): ReactElement {
  const noPermission = (
    <StatusChip tone="neutral">{t("platform.windows.access.noPermission")}</StatusChip>
  );
  const mic = microphone ?? "not_determined";
  const micName = t("platform.windows.access.microphone.name");
  return (
    <div className="flex flex-col gap-3" data-testid="windows-access">
      <Row
        name={t("platform.windows.access.uiAutomation.name")}
        chip={noPermission}
        why={t("platform.windows.access.uiAutomation.why", { persona })}
      />
      <Row
        name={t("platform.windows.access.screen.name")}
        chip={noPermission}
        why={t("platform.windows.access.screen.why")}
      />
      <Row
        name={micName}
        chip={
          <StatusChip tone={STATE_TONE[mic]}>
            {t(`platform.windows.access.state.${mic}`)}
          </StatusChip>
        }
        why={t("platform.windows.access.microphone.why")}
        action={
          mic !== "granted" && onOpenSettings ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => onOpenSettings("microphone")}
              aria-label={t("platform.windows.access.openSettingsFor", { name: micName })}
            >
              {t("platform.windows.access.openSettings")}
            </Button>
          ) : null
        }
      />
    </div>
  );
}
