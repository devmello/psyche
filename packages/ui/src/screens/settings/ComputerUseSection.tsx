import { appCap } from "@psyche/permissions/apps";
import { Lock } from "lucide-react";
import type { ReactElement } from "react";
import { Button } from "../../components/ui/button.tsx";
import { Kbd } from "../../components/ui/kbd.tsx";
import { t } from "../../i18n/core.ts";
import { isLinux, isWindows, type UiPlatform, uiPlatform } from "../../lib/platform.ts";
import { usePersona, useSlots } from "../../slots.tsx";
import { LinuxAccessRows, linuxAccessFromSettings } from "./LinuxAccess.tsx";
import { SegmentedRadio } from "./SegmentedRadio.tsx";
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
  StatusChip,
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
  /** Opens System Settings at the pane for `permission` (the shell asks macOS). */
  onOpenSystemSettings?: (permission: TccPermission) => void;
}

export function ComputerUsePanel({
  values,
  onChange,
  needsApproval,
  persona,
  tcc,
  onOpenSystemSettings,
  loading,
  error,
  onRetry,
}: ComputerUsePanelProps): ReactElement {
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
              {(["accessibility", "screenRecording"] as const).map((p) => {
                const state = tcc[p] ?? "not_determined";
                return (
                  <div key={p} className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{TCC_LABEL[p].name}</span>
                    <StatusChip tone={TCC_TONE[state]}>
                      {t(`settings.computerUse.tccState.${state}`)}
                    </StatusChip>
                    <span className="text-callout text-muted-foreground">
                      {TCC_LABEL[p].why(persona)}
                    </span>
                    {state !== "granted" && onOpenSystemSettings ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        className="ms-auto"
                        onClick={() => onOpenSystemSettings(p)}
                        aria-label={t("settings.computerUse.openSystemSettingsFor", {
                          name: TCC_LABEL[p].name,
                        })}
                      >
                        {t("settings.computerUse.openSystemSettings")}
                      </Button>
                    ) : null}
                  </div>
                );
              })}
            </>
          )}
        </Group>

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
      </LoadGate>
    </SectionFrame>
  );
}

export interface ComputerUseSectionProps {
  tcc?: Partial<Record<TccPermission, TccState>>;
  onOpenSystemSettings?: (permission: TccPermission) => void;
}

export function ComputerUseSection({
  tcc = {},
  onOpenSystemSettings,
}: ComputerUseSectionProps): ReactElement {
  const form = useSettingsForm();
  const persona = usePersona();
  const { remoteHost } = useSlots();
  // Driving a Mac nobody can see is unsafe, and the Host's screen may be locked: computer use
  // stays at the Host (owner decision G5), whatever the Host's own switch says.
  if (remoteHost !== undefined) {
    return (
      <p className="text-callout text-label-secondary" data-testid="computer-use-remote">
        {t("settings.computerUse.remote", { host: remoteHost })}
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
        loading={form.loading && Object.keys(form.values).length === 0}
        error={form.error}
        onRetry={form.reload}
        {...(onOpenSystemSettings ? { onOpenSystemSettings } : {})}
      />
      {form.writeError ? <ErrorNotice what={form.writeError} did="" /> : null}
    </div>
  );
}
