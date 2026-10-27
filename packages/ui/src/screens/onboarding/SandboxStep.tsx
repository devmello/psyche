import { type ReactElement, useState } from "react";
import { t } from "../../i18n/core.ts";
import { SandboxSetup } from "../settings/SandboxSetup.tsx";

/**
 * Onboarding's optional Sandbox step: the same guided setup as Settings → Connectors. It says
 * what is lost without one; "Skip for now" (in the flow's nav) moves on, and a sandbox already
 * running shows Ready.
 */
export function SandboxStep({
  onReadyChange,
}: {
  onReadyChange?: ((ready: boolean) => void) | undefined;
}): ReactElement {
  const [ready, setReady] = useState(false);
  return (
    <div className="flex flex-col gap-4">
      <SandboxSetup
        onReadyChange={(r) => {
          setReady(r);
          onReadyChange?.(r);
        }}
      />
      {ready ? null : (
        <p className="text-callout text-label-secondary">{t("settings.sandbox.without")}</p>
      )}
    </div>
  );
}
