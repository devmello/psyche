import type { ReactElement } from "react";
import { Button } from "../components/ui/button.tsx";
import { t } from "../i18n/core.ts";
import { StatusChip } from "../screens/settings/shared.tsx";
import type { TccPermission, TccState } from "../screens/settings/types.ts";

const tccLabel = (p: TccPermission) => ({
  /** The macOS pane's name, in the active language. */
  get name(): string {
    return t(`settings.computerUse.tcc.${p}.name`);
  },
  /** Why Psyche needs it: "lets Wren see app windows". */
  why: (persona: string): string => t(`settings.computerUse.tcc.${p}.why`, { persona }),
});

export const TCC_LABEL: Record<
  TccPermission,
  { readonly name: string; why: (persona: string) => string }
> = {
  accessibility: tccLabel("accessibility"),
  screenRecording: tccLabel("screenRecording"),
  notifications: tccLabel("notifications"),
  microphone: tccLabel("microphone"),
};

const TCC_TONE: Record<TccState, "success" | "danger" | "neutral"> = {
  granted: "success",
  denied: "danger",
  not_determined: "neutral",
};

export interface HelperPermissionRowProps {
  permission: TccPermission;
  state: TccState;
  persona: string;
  /** Psyche Helper is not connected: its permission is unknown, never shown as Granted. */
  offline?: boolean;
  /** Asks the helper for the permission (its prompt, then its pane in System Settings). */
  onAllow?: ((permission: TccPermission) => void) | undefined;
}

/**
 * One Psyche Helper permission: its name, state and Allow. Settings → Computer use and the Psyche
 * points start sheet show the same row (docs/design/psyche-points-2026.md §6.1).
 */
export function HelperPermissionRow({
  permission,
  state,
  persona,
  offline = false,
  onAllow,
}: HelperPermissionRowProps): ReactElement {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="font-medium">{TCC_LABEL[permission].name}</span>
      {offline ? (
        <StatusChip tone="neutral">{t("settings.computerUse.tccState.offline")}</StatusChip>
      ) : (
        <StatusChip tone={TCC_TONE[state]}>
          {t(`settings.computerUse.tccState.${state}`)}
        </StatusChip>
      )}
      <span className="text-callout text-muted-foreground">
        {TCC_LABEL[permission].why(persona)}
      </span>
      {!offline && state !== "granted" && onAllow ? (
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="ms-auto"
          onClick={() => onAllow(permission)}
          aria-label={t("settings.computerUse.helperAccess.allowFor", {
            name: TCC_LABEL[permission].name,
          })}
        >
          {t("settings.computerUse.helperAccess.allow")}
        </Button>
      ) : null}
    </div>
  );
}
