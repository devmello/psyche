import type { ReactElement } from "react";
import { Button } from "../../components/ui/button.tsx";
import { t } from "../../i18n/core.ts";
import { StatusChip } from "./shared.tsx";

/**
 * What Linux asks for, in place of the macOS privacy panes (Settings → Computer use). On Wayland
 * the desktop's own dialog grants screen and input access once and keeps it until the owner
 * revokes it; X11 has no permission model; wlroots desktops have no consent step at all
 * (docs/design/linux-desktop-2026.md §6). The Gateway writes the helper's state to
 * `computerUse.linux`; Revoke sets `computerUse.linuxRevoke` and the Gateway acts on it.
 */

/** `computerUse.linux` as the Gateway writes it (compose/computer-linux.ts). */
export interface LinuxAccessState {
  session: "wayland" | "x11" | "headless";
  desktop: "gnome" | "kde" | "wlroots" | "other" | null;
  backend: "portal" | "wlroots" | "x11" | "none";
  /** A restore token is stored: screen and input access stays allowed until revoked. */
  allowed: boolean;
  /** Whether apps export their structure; null when unknown. */
  a11yEnabled: boolean | null;
  warnings: readonly string[];
  checkedAt: string;
}

const SESSIONS = ["wayland", "x11", "headless"];

/** The shared state, or undefined while the Gateway has not written one (or wrote nonsense). */
export function linuxAccessFromSettings(
  values: Readonly<Record<string, unknown>>,
): LinuxAccessState | undefined {
  const raw = values["computerUse.linux"] as Partial<LinuxAccessState> | null | undefined;
  if (typeof raw !== "object" || raw === null) return undefined;
  if (typeof raw.session !== "string" || !SESSIONS.includes(raw.session)) return undefined;
  return {
    session: raw.session as LinuxAccessState["session"],
    desktop: raw.desktop ?? null,
    backend: raw.backend ?? "none",
    allowed: raw.allowed === true,
    a11yEnabled: typeof raw.a11yEnabled === "boolean" ? raw.a11yEnabled : null,
    warnings: Array.isArray(raw.warnings)
      ? raw.warnings.filter((w): w is string => typeof w === "string")
      : [],
    checkedAt: typeof raw.checkedAt === "string" ? raw.checkedAt : "",
  };
}

export function LinuxAccessRows({
  persona,
  state,
  computerUseOn,
  onRevoke,
}: {
  persona: string;
  /** `computerUse.linux`; undefined until the Gateway has read the helper's state. */
  state?: LinuxAccessState | undefined;
  /** `computerUse.enabled`. */
  computerUseOn: boolean;
  /** Sets `computerUse.linuxRevoke`; the Gateway tells the helper to forget the grant. */
  onRevoke?: (() => void) | undefined;
}): ReactElement {
  const session = state?.session;
  const x11 = session === "x11" || state?.backend === "x11";
  const headless = session === "headless";
  const wlroots = state?.warnings.includes("wlroots") === true || state?.backend === "wlroots";
  const showX11 = state?.warnings.includes("x11") === true || x11;
  const allowed = state?.allowed === true && !x11 && !headless;

  const chip = headless ? (
    <StatusChip tone="neutral">{t("settings.computerUse.linux.screen.unavailable")}</StatusChip>
  ) : x11 ? (
    <StatusChip tone="neutral">{t("settings.computerUse.linux.screen.notNeeded")}</StatusChip>
  ) : allowed ? (
    <StatusChip tone="success">{t("settings.computerUse.linux.screen.allowed")}</StatusChip>
  ) : (
    <StatusChip tone="neutral">{t("settings.computerUse.linux.screen.asks")}</StatusChip>
  );

  return (
    <div className="flex flex-col gap-3" data-testid="linux-access">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{t("settings.computerUse.linux.screen.name")}</span>
        {chip}
        <span className="basis-full text-callout text-muted-foreground">
          {t("settings.computerUse.linux.screen.why", { persona })}
        </span>
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="ms-auto"
          disabled={!allowed || onRevoke === undefined}
          onClick={() => onRevoke?.()}
          aria-label={t("settings.computerUse.linux.revokeLabel")}
        >
          {t("settings.computerUse.linux.revoke")}
        </Button>
      </div>
      {headless ? (
        <p
          role="status"
          className="text-callout text-muted-foreground"
          data-testid="linux-headless"
        >
          {t("settings.computerUse.linux.headless")}
        </p>
      ) : null}
      {showX11 ? (
        <p role="note" className="text-callout text-muted-foreground" data-testid="linux-x11">
          {t("settings.computerUse.linux.warning.x11")}
        </p>
      ) : null}
      {wlroots ? (
        <p role="note" className="text-callout text-muted-foreground" data-testid="linux-wlroots">
          {t("settings.computerUse.linux.warning.wlroots")}
        </p>
      ) : null}
      {computerUseOn && state?.a11yEnabled === true ? (
        <p className="text-callout text-muted-foreground" data-testid="linux-a11y">
          {t("settings.computerUse.linux.accessibility")}
        </p>
      ) : null}
    </div>
  );
}
