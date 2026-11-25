import { appCap } from "@psyche/permissions/apps";
import type { MachineInfo } from "@psyche/protocol";
import { Lock } from "lucide-react";
import { type ReactElement, useState } from "react";
import { Kbd } from "../../components/ui/kbd.tsx";
import { useHostOs } from "../../data/host-os.ts";
import { t } from "../../i18n/core.ts";
import { isLinux, isWindows, type UiPlatform, uiPlatform } from "../../lib/platform.ts";
import { HelperPermissionRow } from "../../points/HelperPermissionRow.tsx";
import { POINTS_ENABLED_KEY, PointsSettingsGroup } from "../../points/PointsSettings.tsx";
import { usePersona, useSlots } from "../../slots.tsx";
import { LinuxAccessRows, linuxAccessFromSettings } from "./LinuxAccess.tsx";
import { HOST_CHOICE, MachineAppsGroup, MachinePicker } from "./MachinePicker.tsx";
import { useMachines } from "./MachinesGroup.tsx";
import { SegmentedRadio } from "./SegmentedRadio.tsx";
import { isLinuxUi, SeparateDesktopGroup } from "./SeparateDesktopGroup.tsx";
import {
  bool,
  EmptyNotice,
  ErrorNotice,
  Group,
  LoadGate,
  type LoadProps,
  SectionFrame,
  SettingHint,
  type SettingsFormProps,
  SwitchField,
  useSettingsForm,
} from "./shared.tsx";
import type { AppTier, ComputerUseApp, TccPermission, TccState } from "./types.ts";
import { WindowsAccessRows } from "./WindowsAccess.tsx";

/** Computer use (UI design §3.18; architecture §6). */

const tier = (value: AppTier) => ({
  value,
  get label(): string {
    return t(`settings.computerUse.tier.${value}`);
  },
});

export const TIERS: readonly { value: AppTier; readonly label: string }[] = [
  tier("ask"),
  tier("off"),
  tier("read"),
  tier("interact"),
];

type LockReason = "browser" | "terminal" | "ide" | "passwords" | "banking";

/**
 * A locked row: an app the Gateway caps (`@psyche/permissions/apps`, the lists the broker
 * enforces), shown by its product name. The cap is read from those lists, never restated here.
 */
function lockedApp(id: string, name: string, reason: LockReason): ComputerUseApp {
  const { cap } = appCap(id);
  if (cap === "interact") throw new Error(`${id} is not a capped app`);
  return {
    id,
    // App names are product names.
    name,
    tier: cap === "off" ? "off" : "read",
    locked: {
      cap,
      get reason(): string {
        return t(`settings.computerUse.locked.${reason}`);
      },
    },
  };
}

const banking: ComputerUseApp = {
  id: "banking",
  get name(): string {
    return t("settings.computerUse.bankingApps");
  },
  tier: "off",
  locked: {
    cap: "off",
    get reason(): string {
      return t("settings.computerUse.locked.banking");
    },
  },
};

/** Fixed caps (architecture §6): browsers read-only, terminals and IDEs click-only, money Off. */
export const LOCKED_APPS: readonly ComputerUseApp[] = [
  lockedApp("com.apple.Safari", "Safari", "browser"),
  lockedApp("com.google.Chrome", "Google Chrome", "browser"),
  lockedApp("com.apple.Terminal", "Terminal", "terminal"),
  lockedApp("com.microsoft.VSCode", "Visual Studio Code", "ide"),
  lockedApp("com.1password.1password", "1Password", "passwords"),
  banking,
];

/** The same caps as the Windows helper names apps: by their lowercase executable. */
export const WINDOWS_LOCKED_APPS: readonly ComputerUseApp[] = [
  lockedApp("msedge.exe", "Microsoft Edge", "browser"),
  lockedApp("chrome.exe", "Google Chrome", "browser"),
  lockedApp("windowsterminal.exe", "Windows Terminal", "terminal"),
  lockedApp("powershell.exe", "Windows PowerShell", "terminal"),
  lockedApp("code.exe", "Visual Studio Code", "ide"),
  lockedApp("1password.exe", "1Password", "passwords"),
  banking,
];

/** The same caps as the Linux helper names apps: by desktop-file id. */
export const LINUX_LOCKED_APPS: readonly ComputerUseApp[] = [
  lockedApp("firefox", "Firefox", "browser"),
  lockedApp("google-chrome", "Google Chrome", "browser"),
  lockedApp("gnome-terminal", "GNOME Terminal", "terminal"),
  lockedApp("code", "Visual Studio Code", "ide"),
  lockedApp("keepassxc", "KeePassXC", "passwords"),
  banking,
];

/** The locked rows for the Host's platform (computer use runs on the Host, never remotely). */
export function lockedApps(platform: UiPlatform = uiPlatform()): readonly ComputerUseApp[] {
  return platform === "windows"
    ? WINDOWS_LOCKED_APPS
    : platform === "linux"
      ? LINUX_LOCKED_APPS
      : LOCKED_APPS;
}

function isApp(v: unknown): v is ComputerUseApp {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as ComputerUseApp).id === "string" &&
    typeof (v as ComputerUseApp).name === "string" &&
    TIERS.some((x) => x.value === (v as ComputerUseApp).tier)
  );
}

export function appsFromSettings(values: Readonly<Record<string, unknown>>): ComputerUseApp[] {
  const raw = values["computerUse.apps"];
  return Array.isArray(raw) ? raw.filter(isApp) : [];
}

export interface ComputerUsePanelProps extends SettingsFormProps, LoadProps {
  persona: string;
  tcc: Partial<Record<TccPermission, TccState>>;
  /**
   * Asks for `permission` for Psyche Helper, the process that does computer use (macOS keeps each
   * app's grant apart): its prompt, then its pane in System Settings.
   */
  onOpenSystemSettings?: (permission: TccPermission) => void;
  /** Psyche Helper is not connected: its permissions are unknown, never shown as Granted. */
  helperOffline?: boolean;
  /** Linux computers the owner paired: with any, the page offers a computer picker. */
  machines?: readonly MachineInfo[];
}

export function ComputerUsePanel({
  values,
  onChange,
  needsApproval,
  persona,
  tcc,
  onOpenSystemSettings,
  helperOffline = false,
  machines = [],
  loading,
  error,
  onRetry,
}: ComputerUsePanelProps): ReactElement {
  // Which computer's app access the page shows; the Host unless the owner picks a paired one.
  const [shown, setShown] = useState(HOST_CHOICE);
  const machine = machines.find((m) => m.id === shown);
  const enabled = bool(values, "computerUse.enabled", false);
  const apps = appsFromSettings(values);
  const setTier = (app: ComputerUseApp, tier: AppTier) =>
    onChange(
      "computerUse.apps",
      apps.map((a) => (a.id === app.id ? { ...a, tier } : a)),
    );

  return (
    <SectionFrame
      needsApproval={needsApproval}
      title={t("settings.computerUse.title")}
      description={
        <>
          {t("settings.computerUse.description", { persona })}{" "}
          <Kbd>{t("settings.computerUse.escKey")}</Kbd> {t("settings.computerUse.escStops")}
        </>
      }
    >
      <LoadGate
        label={t("settings.computerUse.loadLabel")}
        loading={loading ?? false}
        error={error ?? null}
        {...(onRetry ? { onRetry } : {})}
      >
        <MachinePicker
          machines={machines}
          values={values}
          selected={machine?.id ?? HOST_CHOICE}
          onSelect={setShown}
          onChange={onChange}
        />

        {machine ? (
          <MachineAppsGroup
            machine={machine}
            values={values}
            tiers={TIERS}
            enabled={enabled}
            onChange={onChange}
          />
        ) : null}

        {machine ? null : (
          <Group
            title={t("settings.computerUse.macPermissions")}
            description={t("settings.computerUse.macPermissionsHint")}
          >
            {isWindows() ? (
              <WindowsAccessRows
                persona={persona}
                microphone={tcc.microphone}
                onOpenSettings={onOpenSystemSettings}
              />
            ) : isLinux() ? (
              <LinuxAccessRows
                persona={persona}
                state={linuxAccessFromSettings(values)}
                computerUseOn={enabled}
                onRevoke={() => onChange("computerUse.linuxRevoke", new Date().toISOString())}
              />
            ) : (
              <>
                <p className="text-callout text-muted-foreground">
                  {helperOffline
                    ? t("settings.computerUse.helperAccess.offline")
                    : t("settings.computerUse.helperAccess.hint")}
                </p>
                {(["accessibility", "screenRecording"] as const).map((p) => (
                  <HelperPermissionRow
                    key={p}
                    permission={p}
                    state={tcc[p] ?? "not_determined"}
                    persona={persona}
                    offline={helperOffline}
                    onAllow={onOpenSystemSettings}
                  />
                ))}
              </>
            )}
          </Group>
        )}

        {machine ? null : (
          <Group
            title={t("settings.computerUse.apps")}
            description={t("settings.computerUse.appsHint")}
          >
            <SwitchField
              label={t("settings.key.computerUse.enabled")}
              description={t("settings.computerUse.enabledHint")}
              checked={enabled}
              settingKey="computerUse.enabled"
              onChange={(v) => onChange("computerUse.enabled", v)}
            />
            <SettingHint settingKey="computerUse.apps" />
            {/* One row per app with a segmented tier control; fixed caps are locked rows (§5.8). */}
            {apps.length === 0 ? (
              <EmptyNotice text={t("settings.computerUse.noApps")} />
            ) : (
              <>
                {apps.map((a) => (
                  <div key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="min-w-0 flex-1 text-body text-label-primary">{a.name}</span>
                    <SegmentedRadio
                      label={a.name}
                      options={TIERS}
                      value={a.tier}
                      disabled={!enabled}
                      onChange={(tier) => setTier(a, tier)}
                      segmentLabel={(o) =>
                        t("settings.matrix.cell", { row: a.name, column: o.label })
                      }
                    />
                  </div>
                ))}
                {lockedApps().map((a) => (
                  <div key={a.id} data-locked="true" className="flex items-center gap-3">
                    <Lock className="size-3.5 shrink-0 text-label-tertiary" aria-hidden="true" />
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="text-body text-label-primary">{a.name}</span>
                      <span className="text-callout text-label-secondary">{a.locked?.reason}</span>
                    </div>
                    <span className="shrink-0 text-body text-label-secondary">
                      {a.locked ? t(`settings.computerUse.cap.${a.locked.cap}`) : ""}
                    </span>
                  </div>
                ))}
              </>
            )}
          </Group>
        )}

        {machine || isWindows() || isLinux() ? null : (
          <PointsSettingsGroup
            enabled={bool(values, POINTS_ENABLED_KEY, false)}
            onChange={(v) => onChange(POINTS_ENABLED_KEY, v)}
          />
        )}

        {isLinuxUi() && !machine ? (
          <SeparateDesktopGroup values={values} onChange={onChange} />
        ) : null}
      </LoadGate>
    </SectionFrame>
  );
}

export interface ComputerUseSectionProps {
  tcc?: Partial<Record<TccPermission, TccState>>;
  onOpenSystemSettings?: (permission: TccPermission) => void;
  helperOffline?: boolean;
}

export function ComputerUseSection({
  tcc = {},
  onOpenSystemSettings,
  helperOffline = false,
}: ComputerUseSectionProps): ReactElement {
  const form = useSettingsForm();
  const persona = usePersona();
  const { remoteHost } = useSlots();
  const hostOs = useHostOs();
  const { machines } = useMachines();
  // Driving a Mac nobody can see is unsafe, and the Host's screen may be locked: computer use
  // stays at the Host (owner decision G5), whatever the Host's own switch says. A Linux Host runs
  // it on its own private screen, which a Client watches and takes over (B3); `direct` stays off.
  if (remoteHost !== undefined) {
    return (
      <p className="text-callout text-label-secondary" data-testid="computer-use-remote">
        {hostOs === "linux"
          ? t("settings.computerUse.remoteLinux", { host: remoteHost })
          : t("settings.computerUse.remote", { host: remoteHost })}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <ComputerUsePanel
        values={form.values}
        onChange={form.onChange}
        needsApproval={form.needsApproval}
        persona={persona.name}
        tcc={tcc}
        helperOffline={helperOffline}
        machines={machines}
        loading={form.loading && Object.keys(form.values).length === 0}
        error={form.error}
        onRetry={form.reload}
        {...(onOpenSystemSettings ? { onOpenSystemSettings } : {})}
      />
      {form.writeError ? <ErrorNotice what={form.writeError} did="" /> : null}
    </div>
  );
}
