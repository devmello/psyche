import {
  AboutSection,
  AppearanceSection,
  DataControlsSection,
  DevicesSection,
  describeError,
  FileAccessPanel,
  type FolderGrant,
  SETTINGS_SECTIONS,
  SettingsScreen,
  type SettingsSectionId,
  t,
  usePersona,
  useSettingsForm,
  VoiceSection,
} from "@psyche/ui";
import { type ReactElement, type ReactNode, useEffect, useMemo, useState } from "react";
import type { DictationPort, ShellPlatform, SystemDictationStatus } from "../shell/platform.ts";
import { useAboutInfo } from "./about.ts";
import { BackupsPanel } from "./backups.tsx";
import { DesktopDevicesSettings, useThisDeviceId } from "./helper.tsx";
import { LogViewer } from "./logs.tsx";
import { PasskeysPanel } from "./passkeys.tsx";
import { ComputerUseSettings } from "./permissions.tsx";
import { ZoomSetting } from "./ZoomSetting.tsx";

/**
 * Settings in the composed app (docs/06 §3.18): the kit's `SettingsScreen` at
 * `/settings/:section`, with S11's own File access section. The kit's section keeps folder
 * grants under a UI-local key; the Gateway applies `permissions.policy.folders` to the broker
 * (INT-1), so this section reads and writes the policy and, on the desktop, adds a native folder
 * picker ("Settings does not have a folder picker yet" in the README). Data controls gains the
 * Backups panel (U4), About the log viewer (U5), and on the web Devices & nodes this browser's
 * passkeys (issue #79).
 */

/** The broker policy setting (security §10: admin-only). */
export const POLICY_KEY = "permissions.policy";
/** The kit's UI-local key for `FileAccessPanel`'s folder list. */
const FOLDERS_KEY = "permissions.folders";

export interface PolicyFolder {
  path: string;
  mode: "ro" | "rw";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isPolicyFolder(v: unknown): v is PolicyFolder {
  return (
    isRecord(v) &&
    typeof v.path === "string" &&
    v.path.length > 0 &&
    (v.mode === "ro" || v.mode === "rw")
  );
}

/** The stored policy object, or `{}` when unset or malformed. */
export function policyOf(values: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const raw = values[POLICY_KEY];
  return isRecord(raw) ? raw : {};
}

/** Folder grants of the stored policy in the kit's `{path, access}` shape. */
export function folderGrantsFromPolicy(values: Readonly<Record<string, unknown>>): FolderGrant[] {
  const folders = policyOf(values).folders;
  if (!Array.isArray(folders)) return [];
  return folders.filter(isPolicyFolder).map((f) => ({ path: f.path, access: f.mode }));
}

/** The stored policy with its `folders` replaced; every other policy key is kept as is. */
export function policyWithFolders(
  values: Readonly<Record<string, unknown>>,
  grants: readonly FolderGrant[],
): Record<string, unknown> {
  const seen = new Set<string>();
  const folders: PolicyFolder[] = [];
  for (const g of grants) {
    const path = g.path.trim();
    if (path === "" || seen.has(path)) continue;
    seen.add(path);
    folders.push({ path, mode: g.access });
  }
  return { ...policyOf(values), folders };
}

export function FileAccessSettings({ platform }: { platform: ShellPlatform }): ReactElement {
  const form = useSettingsForm();
  const persona = usePersona();
  const [pickError, setPickError] = useState<string | null>(null);
  const values = useMemo(
    () => ({ ...form.values, [FOLDERS_KEY]: folderGrantsFromPolicy(form.values) }),
    [form.values],
  );
  const needsApproval = useMemo(() => {
    const keys = new Set(form.needsApproval);
    if (keys.has(POLICY_KEY)) keys.add(FOLDERS_KEY);
    return keys;
  }, [form.needsApproval]);
  const onChange = (key: string, value: unknown) => {
    if (key !== FOLDERS_KEY) {
      form.onChange(key, value);
      return;
    }
    const grants = Array.isArray(value) ? (value as FolderGrant[]) : [];
    form.onChange(POLICY_KEY, policyWithFolders(form.values, grants));
  };
  const pickFolder = platform.dialogs?.pickFolder;
  const choose = async () => {
    if (!pickFolder) return;
    setPickError(null);
    let path: string | null;
    try {
      path = await pickFolder({ title: t("web.files.shareTitle", { persona: persona.name }) });
    } catch (err) {
      setPickError(t("web.files.pickError", { error: describeError(err) }));
      return;
    }
    if (path === null) return;
    const current = folderGrantsFromPolicy(form.values);
    if (current.some((f) => f.path === path)) return;
    onChange(FOLDERS_KEY, [...current, { path, access: "ro" }]);
  };
  return (
    <div className="flex flex-col gap-3" data-testid="settings-files">
      {pickFolder ? (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <button
            type="button"
            className="inline-flex h-8 items-center rounded-md border border-input bg-background px-3 font-medium shadow-xs hover:bg-gray-3"
            onClick={() => void choose()}
          >
            {t("web.files.choose")}
          </button>
          <span className="text-muted-foreground">{t("web.files.chooseHint")}</span>
        </div>
      ) : null}
      {pickError ? (
        <p role="alert" className="text-sm text-danger-text">
          {pickError}
        </p>
      ) : null}
      <FileAccessPanel
        values={values}
        onChange={onChange}
        needsApproval={needsApproval}
        persona={persona.name}
        loading={form.loading && Object.keys(form.values).length === 0}
        error={form.error}
        onRetry={form.reload}
      />
      {form.writeError ? (
        <p role="alert" className="text-sm text-danger-text">
          {form.writeError}
        </p>
      ) : null}
    </div>
  );
}

/** `/settings/:section`, falling back to the first section for unknown or missing ids. */
/** Settings → Devices on the web: the Gateway's devices with this browser marked, and its passkeys. */
export function WebDevicesSettings({ platform }: { platform: ShellPlatform }): ReactElement {
  const deviceId = useThisDeviceId(platform);
  return (
    <div className="flex flex-col gap-4">
      <DevicesSection {...(deviceId === undefined ? {} : { thisDeviceId: deviceId })} />
      <PasskeysPanel host={platform.passkeys} />
    </div>
  );
}

export function settingsSectionOf(route: string): SettingsSectionId | null {
  const m = /^\/settings(?:\/([^/?#]+))?/.exec(route);
  if (m === null) return null;
  return SETTINGS_SECTIONS.find((s) => s.id === m[1])?.id ?? "model";
}

/** Voice & dictation with the desktop's system-wide dictation status (J9, Q2). */
export function SystemVoiceSettings({ dictation }: { dictation: DictationPort }): ReactElement {
  const [status, setStatus] = useState<SystemDictationStatus | null>(null);
  useEffect(() => {
    let live = true;
    void dictation.getStatus().then(
      (s) => live && setStatus(s),
      () => undefined,
    );
    const off = dictation.onStatus((s) => setStatus(s));
    return () => {
      live = false;
      off();
    };
  }, [dictation]);
  return (
    <VoiceSection
      system={status ?? { helper: "offline", accessibility: "unknown", watching: false }}
      onOpenAccessibility={() => dictation.openAccessibilitySettings()}
      onRecheck={() => {
        void dictation.recheck().then(setStatus, () => undefined);
      }}
      {...(dictation.checkHotkey
        ? {
            onCheckShortcut: (a: string) =>
              dictation.checkHotkey?.(a) ?? Promise.resolve("ok" as const),
          }
        : {})}
    />
  );
}

/** About with live versions: the app's from the build, the Gateway's from `/version`. */
function AboutLive(): ReactElement {
  const info = useAboutInfo();
  return <AboutSection info={info} />;
}

export function settingsRoute(
  route: string,
  navigate: (to: string) => void,
  platform: ShellPlatform,
): ReactNode | null {
  const section = settingsSectionOf(route);
  if (section === null) return null;
  return (
    <section
      className="flex min-h-0 flex-1 flex-col overflow-auto"
      aria-label={t("web.settings.label")}
      data-testid="settings"
    >
      <SettingsScreen
        section={section}
        onSectionChange={(id) => navigate(`/settings/${id}`)}
        onOpenTask={(taskId) => navigate(`/agent/activity/${taskId}`)}
        {...(platform.dialogs?.pickFolder
          ? {
              onPickSkillFolder: () =>
                platform.dialogs?.pickFolder({ title: t("web.settings.pickSkillFolder") }) ??
                Promise.resolve(null),
            }
          : {})}
        {...(platform.browser?.openRealChromeProfile
          ? {
              onOpenRealChromeProfile: (profile: string) =>
                platform.browser?.openRealChromeProfile?.(profile) ??
                Promise.reject(new Error("not available")),
            }
          : {})}
        sections={{
          "computer-use": <ComputerUseSettings platform={platform} />,
          files: <FileAccessSettings platform={platform} />,
          ...(platform.dictation
            ? { voice: <SystemVoiceSettings dictation={platform.dictation} /> }
            : {}),
          ...(platform.kind === "web"
            ? {
                devices: <WebDevicesSettings platform={platform} />,
              }
            : platform.helper
              ? { devices: <DesktopDevicesSettings platform={platform} /> }
              : {}),
          appearance: (
            <div className="flex flex-col gap-4">
              <AppearanceSection />
              {platform.kind === "desktop" ? <ZoomSetting /> : null}
            </div>
          ),
          data: (
            <div className="flex flex-col gap-4">
              <DataControlsSection />
              <BackupsPanel />
            </div>
          ),
          about: (
            <div className="flex flex-col gap-4">
              <AboutLive />
              <LogViewer />
            </div>
          ),
        }}
      />
    </section>
  );
}
