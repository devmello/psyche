import { ShieldOff } from "lucide-react";
import { useState } from "react";
import { t } from "../i18n/core.ts";

export interface FullAccessBannerProps {
  /** The thread's mode: the banner shows only for `full`. */
  mode: string | undefined;
  /** Turns Full access off (back to Balanced). One tap, no confirmation. */
  onTurnOff: () => Promise<unknown>;
  disabled?: boolean;
}

/**
 * The persistent Full access indicator above the composer (owner, 2026-11-25): it stays while
 * the chat is in Full access and turns it off in one tap. Sends and payments still ask, and the
 * line says so.
 */
export function FullAccessBanner({ mode, onTurnOff, disabled }: FullAccessBannerProps) {
  const [busy, setBusy] = useState(false);
  if (mode !== "full") return null;
  return (
    <div
      role="status"
      aria-label={t("agent.mode.full")}
      className="mx-auto mb-2 flex w-full max-w-3xl items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-1.5 text-callout text-warning-text"
    >
      <ShieldOff aria-hidden className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">{t("chat.fullAccess.banner")}</span>
      <button
        type="button"
        disabled={disabled === true || busy}
        onClick={() => {
          setBusy(true);
          void onTurnOff()
            .catch(() => {})
            .finally(() => setBusy(false));
        }}
        className="shrink-0 rounded px-2 py-0.5 font-medium underline-offset-2 hover:underline disabled:opacity-50"
      >
        {t("chat.fullAccess.turnOff")}
      </button>
    </div>
  );
}
