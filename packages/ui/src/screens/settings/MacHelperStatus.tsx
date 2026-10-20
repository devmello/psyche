import type { ReactElement } from "react";
import { t } from "../../i18n/core.ts";
import { StatusChip, type Tone } from "./shared.tsx";

/**
 * The bundled Mac helper as the desktop sees it (it launches the helper, which pairs with the
 * Gateway on its own). Shown in onboarding's Permissions step and Settings → Devices; nothing
 * waits on it.
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

export function MacHelperStatusRow({ state }: { state: MacHelperStatus }): ReactElement {
  const v = {
    tone: TONE[state.kind],
    chip: t(`settings.macHelper.${state.kind}.chip`),
    text: t(`settings.macHelper.${state.kind}.text`),
  };
  return (
    <div
      className="flex flex-col gap-1 rounded-lg border border-gray-6 bg-gray-2 p-3"
      data-testid="mac-helper-status"
    >
      <p className="flex flex-wrap items-center gap-2 font-medium">
        {t("settings.macHelper.name")}
        <StatusChip tone={v.tone}>{v.chip}</StatusChip>
      </p>
      <p className="text-sm text-muted-foreground">{v.text}</p>
      {state.kind === "offline" && state.reason ? (
        <p className="text-xs text-muted-foreground">
          {t("settings.macHelper.lastTry", { reason: state.reason })}
        </p>
      ) : null}
    </div>
  );
}
