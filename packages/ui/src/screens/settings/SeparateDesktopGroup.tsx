import type { ReactElement } from "react";
import { useId } from "react";
import { Button } from "../../components/ui/button.tsx";
import { Label } from "../../components/ui/label.tsx";
import { NativeSelect } from "../../components/ui/native-select.tsx";
import { t } from "../../i18n/core.ts";
import { ErrorNotice, Group, type SettingsFormProps, StatusChip, type Tone } from "./shared.tsx";

/**
 * Settings › Computer use › Separate desktop (Linux; docs/design/linux-desktop-2026.md §8): the
 * container desktop's state as the Gateway last reported it, its memory limit and a reset. All
 * three keys are `computerUse.*`, so a change needs the owner's presence like the other computer
 * use settings. What the desktop may reach (folders, internet, clipboard) is decided per task on
 * cards, not here.
 */

export const SEPARATE_DESKTOP_KEYS = {
  memory: "computerUse.separateDesktop.memory",
  state: "computerUse.separateDesktop.state",
  reset: "computerUse.separateDesktop.reset",
} as const;

export type SeparateDesktopPhase = "off" | "starting" | "running" | "stopping" | "failed";

export interface SeparateDesktopView {
  phase: SeparateDesktopPhase;
  engine?: string;
  rootless?: boolean;
  error?: string;
  shares: string[];
  internet: boolean;
}

export const MEMORY_CHOICES = ["1g", "2g", "4g", "8g"] as const;
const PHASES: readonly SeparateDesktopPhase[] = [
  "off",
  "starting",
  "running",
  "stopping",
  "failed",
];
const TONE: Record<SeparateDesktopPhase, Tone> = {
  off: "neutral",
  starting: "info",
  running: "success",
  stopping: "info",
  failed: "danger",
};

/** Whether this UI runs on Linux (the only place the separate desktop is offered). */
export function isLinuxUi(): boolean {
  if (typeof document === "undefined") return false;
  const raw = document.documentElement.dataset.platform?.toLowerCase();
  if (raw !== undefined) return raw === "linux";
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  const data = (nav as { userAgentData?: { platform?: string } } | undefined)?.userAgentData;
  return /^linux$/i.test(data?.platform ?? "");
}

/** The Gateway's state row, defensively: anything unexpected reads as "not running". */
export function separateDesktopOf(values: Readonly<Record<string, unknown>>): SeparateDesktopView {
  const raw = values[SEPARATE_DESKTOP_KEYS.state];
  const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const phase = PHASES.find((p) => p === o.phase) ?? "off";
  const shares = Array.isArray(o.shares)
    ? o.shares.flatMap((s) =>
        typeof s === "object" && s !== null && typeof (s as { name?: unknown }).name === "string"
          ? [
              `${(s as { name: string }).name}${(s as { readWrite?: unknown }).readWrite === true ? " (rw)" : ""}`,
            ]
          : [],
      )
    : [];
  return {
    phase,
    ...(typeof o.engine === "string" ? { engine: o.engine } : {}),
    ...(typeof o.rootless === "boolean" ? { rootless: o.rootless } : {}),
    ...(typeof o.error === "string" ? { error: o.error } : {}),
    shares,
    internet: o.internet === true,
  };
}

export function SeparateDesktopGroup({ values, onChange }: SettingsFormProps): ReactElement {
  const id = useId();
  const view = separateDesktopOf(values);
  const memory = values[SEPARATE_DESKTOP_KEYS.memory];
  const current =
    typeof memory === "string" && (MEMORY_CHOICES as readonly string[]).includes(memory)
      ? memory
      : "2g";
  return (
    <Group
      title={t("settings.separateDesktop.title")}
      description={t("settings.separateDesktop.description")}
    >
      <div className="flex flex-wrap items-center gap-2" data-testid="separate-desktop-state">
        <StatusChip tone={TONE[view.phase]}>
          {t(`settings.separateDesktop.state.${view.phase}`)}
        </StatusChip>
        {view.engine !== undefined ? (
          <span className="text-callout text-muted-foreground">
            {t("settings.separateDesktop.engine", { engine: view.engine })}
          </span>
        ) : null}
        {view.internet ? (
          <span className="text-callout text-muted-foreground">
            {t("settings.separateDesktop.internet")}
          </span>
        ) : null}
      </div>
      {view.rootless === false ? (
        <ErrorNotice what={t("settings.separateDesktop.rootful")} did="" />
      ) : null}
      {view.phase === "failed" && view.error !== undefined ? (
        <ErrorNotice what={view.error} did="" />
      ) : null}
      {view.shares.length > 0 ? (
        <p className="text-callout text-muted-foreground">
          {t("settings.separateDesktop.shares", { names: view.shares.join(", ") })}
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={`${id}-memory`}>{t("settings.separateDesktop.memory")}</Label>
        <NativeSelect
          id={`${id}-memory`}
          className="max-w-xs"
          value={current}
          onChange={(e) => onChange(SEPARATE_DESKTOP_KEYS.memory, e.target.value)}
        >
          {MEMORY_CHOICES.map((m) => (
            <option key={m} value={m}>
              {t("settings.separateDesktop.memoryOption", { gb: m.slice(0, -1) })}
            </option>
          ))}
        </NativeSelect>
      </div>
      <p className="text-callout text-muted-foreground">
        {t("settings.separateDesktop.memoryHint")}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={() => onChange(SEPARATE_DESKTOP_KEYS.reset, Date.now())}
        >
          {t("settings.separateDesktop.reset")}
        </Button>
        <span className="text-callout text-muted-foreground">
          {t("settings.separateDesktop.resetHint")}
        </span>
      </div>
    </Group>
  );
}
