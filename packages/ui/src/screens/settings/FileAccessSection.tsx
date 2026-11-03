import { FolderPlus } from "lucide-react";
import { type ReactElement, type ReactNode, useId, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { NativeSelect } from "../../components/ui/native-select.tsx";
import { t } from "../../i18n/core.ts";
import { usePersona } from "../../slots.tsx";
import { AccessListView, ConnectedAccessList } from "./AccessList.tsx";
import {
  Advanced,
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
import type { FolderGrant } from "./types.ts";

/**
 * Access (UI design §3.18, settings-2026 §7): what Psyche can reach, with Revoke; folder grants
 * ro / rw. Psyche asks in the chat for a folder it needs and the
 * answer is remembered (`request_folder_access`); adding one here is the manual way. Folder grants
 * live in the broker policy the Gateway applies (`permissions.policy.folders`, `{path, mode}`),
 * the same setting the CLI and other devices write; `permissions.folders` is the kit's older
 * UI-local key, read only as a fallback when the policy has no folder list.
 */

export const POLICY_KEY = "permissions.policy";
export const FOLDERS_KEY = "permissions.folders";

function isFolder(v: unknown): v is FolderGrant {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as FolderGrant).path === "string" &&
    ((v as FolderGrant).access === "ro" || (v as FolderGrant).access === "rw")
  );
}

export function foldersFromSettings(
  values: Readonly<Record<string, unknown>>,
  key: string,
): FolderGrant[] {
  const raw = values[key];
  return Array.isArray(raw) ? raw.filter(isFolder) : [];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The stored broker policy, or `{}` when unset or malformed. */
export function policyOf(values: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const raw = values[POLICY_KEY];
  return isRecord(raw) ? raw : {};
}

/**
 * The folder grants the broker applies (`permissions.policy.folders`) in the kit's
 * `{path, access}` shape; the UI-local `permissions.folders` only when the policy has no list.
 */
export function folderGrants(values: Readonly<Record<string, unknown>>): FolderGrant[] {
  const folders = policyOf(values).folders;
  if (!Array.isArray(folders)) return foldersFromSettings(values, FOLDERS_KEY);
  return folders.flatMap((f): FolderGrant[] =>
    isRecord(f) &&
    typeof f.path === "string" &&
    f.path !== "" &&
    (f.mode === "ro" || f.mode === "rw")
      ? [{ path: f.path, access: f.mode }]
      : [],
  );
}

/** The stored policy with its `folders` replaced (deduped, trimmed); other keys are kept. */
export function policyWithFolders(
  values: Readonly<Record<string, unknown>>,
  grants: readonly FolderGrant[],
): Record<string, unknown> {
  const seen = new Set<string>();
  const folders: { path: string; mode: FolderGrant["access"] }[] = [];
  for (const g of grants) {
    const path = g.path.trim();
    if (path === "" || seen.has(path)) continue;
    seen.add(path);
    folders.push({ path, mode: g.access });
  }
  return { ...policyOf(values), folders };
}

export function FolderList({
  label,
  folders,
  onChange,
  emptyText,
  addLabel,
  defaultAccess,
  addOnly = false,
}: {
  label: string;
  folders: readonly FolderGrant[];
  onChange: (next: FolderGrant[]) => void;
  emptyText: string;
  addLabel: string;
  defaultAccess: FolderGrant["access"];
  /** Only the add row: the folders are listed elsewhere (the Access list). */
  addOnly?: boolean;
}): ReactElement {
  const id = useId();
  const [draft, setDraft] = useState("");
  const add = () => {
    // Several folders at once: one per line or separated by semicolons.
    const paths = draft
      .split(/[\n;]/)
      .map((p) => p.trim())
      .filter((p) => p !== "");
    const fresh = [...new Set(paths)].filter((p) => !folders.some((f) => f.path === p));
    if (fresh.length === 0) return;
    onChange([...folders, ...fresh.map((path) => ({ path, access: defaultAccess }))]);
    setDraft("");
  };
  return (
    <div className="flex flex-col gap-2">
      {addOnly ? null : folders.length === 0 ? (
        <EmptyNotice text={emptyText} />
      ) : (
        <ul className="flex flex-col divide-y divide-gray-6" aria-label={label}>
          {folders.map((f) => (
            <li key={f.path} className="flex flex-wrap items-center gap-3 py-1.5">
              <code className="min-w-0 flex-1 font-mono text-callout">{f.path}</code>
              <label className="sr-only" htmlFor={`${id}-${f.path}`}>
                {t("settings.files.accessTo", { path: f.path })}
              </label>
              <NativeSelect
                id={`${id}-${f.path}`}
                size="sm"
                value={f.access}
                onChange={(e) =>
                  onChange(
                    folders.map((x) =>
                      x.path === f.path
                        ? { ...x, access: e.target.value as FolderGrant["access"] }
                        : x,
                    ),
                  )
                }
              >
                <option value="ro">{t("settings.files.ro")}</option>
                <option value="rw">{t("settings.files.rw")}</option>
              </NativeSelect>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => onChange(folders.filter((x) => x.path !== f.path))}
                aria-label={t("settings.files.stopSharing", { path: f.path })}
              >
                {t("settings.files.revoke")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`${id}-new`} className="sr-only">
          {addLabel}
        </label>
        <Input
          id={`${id}-new`}
          placeholder={t("settings.files.pathPlaceholder")}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
          className="max-w-xs"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={add}
          disabled={draft.trim() === ""}
        >
          <FolderPlus aria-hidden="true" /> {addLabel}
        </Button>
      </div>
    </div>
  );
}

/** `permissions.policy.exec.execHostEnabled` (security §5.4); off unless set to true. */
export function execHostEnabled(values: Readonly<Record<string, unknown>>): boolean {
  const exec = policyOf(values).exec;
  return isRecord(exec) && exec.execHostEnabled === true;
}

/**
 * `permissions.policy.exec.readOnlyWithoutAsking` (security §5.4): read-only commands run without
 * a card; on unless set to false.
 */
export function readOnlyWithoutAsking(values: Readonly<Record<string, unknown>>): boolean {
  const exec = policyOf(values).exec;
  return !(isRecord(exec) && exec.readOnlyWithoutAsking === false);
}

/** The stored policy with `exec.readOnlyWithoutAsking` set, everything else kept. */
export function policyWithReadOnlyQuiet(
  values: Readonly<Record<string, unknown>>,
  on: boolean,
): Record<string, unknown> {
  const policy = policyOf(values);
  const exec = isRecord(policy.exec) ? policy.exec : {};
  return { ...policy, exec: { ...exec, readOnlyWithoutAsking: on } };
}

/** The stored policy with `exec.execHostEnabled` set, everything else kept. */
export function policyWithExecHost(
  values: Readonly<Record<string, unknown>>,
  on: boolean,
): Record<string, unknown> {
  const policy = policyOf(values);
  const exec = isRecord(policy.exec) ? policy.exec : {};
  return { ...policy, exec: { ...exec, execHostEnabled: on } };
}

export interface FileAccessPanelProps extends SettingsFormProps, LoadProps {
  persona: string;
  /** Kept for callers; VM shares have no reader yet, so the panel no longer shows them. */
  vmMode?: boolean;
  /**
   * The list of what Psyche can reach (`ConnectedAccessList`). Without it the panel lists the
   * folders kept in the policy (stories, a Gateway without `access.list`).
   */
  access?: ReactNode;
  /** Desktop: the native folder chooser, inside "Add a folder yourself". */
  onChooseFolder?: () => void;
  chooseError?: string | null;
}

/** The policy with one folder's access changed, everything else kept. */
export function policyWithFolderMode(
  values: Readonly<Record<string, unknown>>,
  path: string,
  access: FolderGrant["access"],
): Record<string, unknown> {
  return policyWithFolders(
    values,
    folderGrants(values).map((f) => (f.path === path ? { ...f, access } : f)),
  );
}

export function FileAccessPanel({
  values,
  onChange,
  needsApproval,
  persona,
  access,
  onChooseFolder,
  chooseError = null,
  loading,
  error,
  onRetry,
}: FileAccessPanelProps): ReactElement {
  const folders = folderGrants(values);
  const setFolders = (next: readonly FolderGrant[]) =>
    onChange(POLICY_KEY, policyWithFolders(values, next));
  return (
    <SectionFrame
      needsApproval={needsApproval}
      title={t("settings.files.title")}
      description={t("settings.files.description", { persona })}
    >
      <LoadGate
        label={t("settings.files.loadLabel")}
        loading={loading ?? false}
        error={error ?? null}
        {...(onRetry ? { onRetry } : {})}
      >
        {/* What is granted, with its kind and Revoke (settings-2026 §7); asking is the way in. */}
        <Group
          title={t("settings.access.title", { persona })}
          description={t("settings.files.foldersHint", { persona })}
        >
          <div>
            {access ?? (
              <AccessListView
                persona={persona}
                entries={folders.map((f) => ({
                  id: `folder:always:${f.path}`,
                  type: "folder",
                  scope: "always",
                  label: f.path,
                  path: f.path,
                  mode: f.access,
                }))}
                onRevoke={(e) => setFolders(folders.filter((f) => f.path !== e.path))}
                onFolderMode={(path, mode) =>
                  onChange(POLICY_KEY, policyWithFolderMode(values, path, mode))
                }
              />
            )}
          </div>
          <SettingHint settingKey={POLICY_KEY} />
        </Group>
        {/* Security §5.4: off by default; anything outside the read-only class asks on the Mac. */}
        <Advanced description={t("settings.files.advancedHint")}>
          <Group
            title={t("settings.files.execHost")}
            description={t("settings.files.execHostHint", { persona })}
          >
            <SwitchField
              label={t("settings.files.execHostSwitch")}
              checked={execHostEnabled(values)}
              onChange={(on) => onChange(POLICY_KEY, policyWithExecHost(values, on))}
            />
            {/* A security setting: either way needs fresh presence (Touch ID or a passkey). */}
            <SwitchField
              label={t("settings.files.readOnlyQuiet")}
              description={t("settings.files.readOnlyQuietHint", { persona })}
              checked={readOnlyWithoutAsking(values)}
              disabled={!execHostEnabled(values)}
              onChange={(on) => onChange(POLICY_KEY, policyWithReadOnlyQuiet(values, on))}
            />
          </Group>
        </Advanced>
        <details className="group flex flex-col gap-2 px-1">
          <summary className="w-fit cursor-default text-body text-label-primary outline-none marker:text-label-tertiary focus-visible:ring-2 focus-visible:ring-ring">
            {t("settings.files.addYourself")}
          </summary>
          <div className="flex flex-col gap-2 pt-2">
            <p className="text-callout text-label-secondary">
              {t("settings.files.addYourselfHint", { persona })}
            </p>
            {onChooseFolder ? (
              <div>
                <Button type="button" variant="outline" size="sm" onClick={onChooseFolder}>
                  <FolderPlus aria-hidden="true" /> {t("web.files.choose")}
                </Button>
              </div>
            ) : null}
            {chooseError ? (
              <p role="alert" className="text-callout text-danger-text">
                {chooseError}
              </p>
            ) : null}
            <FolderList
              label={t("settings.files.sharedFolders")}
              folders={folders}
              onChange={setFolders}
              emptyText={t("settings.files.noFolders", { persona })}
              addLabel={t("settings.files.shareFolder")}
              defaultAccess="ro"
              addOnly
            />
          </div>
        </details>
      </LoadGate>
    </SectionFrame>
  );
}

export function FileAccessSection({ vmMode }: { vmMode?: boolean }): ReactElement {
  const form = useSettingsForm();
  const persona = usePersona();
  return (
    <div className="flex flex-col gap-3">
      <FileAccessPanel
        values={form.values}
        onChange={form.onChange}
        needsApproval={form.needsApproval}
        persona={persona.name}
        vmMode={vmMode ?? false}
        access={
          <ConnectedAccessList
            persona={persona.name}
            reloadKey={form.values[POLICY_KEY]}
            onFolderMode={(path, mode) =>
              form.onChange(POLICY_KEY, policyWithFolderMode(form.values, path, mode))
            }
          />
        }
        loading={form.loading && Object.keys(form.values).length === 0}
        error={form.error}
        onRetry={form.reload}
      />
      {form.writeError ? <ErrorNotice what={form.writeError} did="" /> : null}
    </div>
  );
}
