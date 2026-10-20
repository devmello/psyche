import { FolderPlus } from "lucide-react";
import { type ReactElement, useId, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { usePersona } from "../../slots.tsx";
import {
  EmptyNotice,
  ErrorNotice,
  Group,
  LoadGate,
  type LoadProps,
  SectionFrame,
  SettingHint,
  type SettingsFormProps,
  useSettingsForm,
} from "./shared.tsx";
import type { FolderGrant } from "./types.ts";

/**
 * File access (UI design §3.18): folder grants ro / rw; VirtioFS shares in VM mode. Folder grants
 * live in the broker policy the Gateway applies (`permissions.policy.folders`, `{path, mode}`),
 * the same setting the CLI and other devices write; `permissions.folders` is the kit's older
 * UI-local key, read only as a fallback when the policy has no folder list.
 */

export const POLICY_KEY = "permissions.policy";
export const FOLDERS_KEY = "permissions.folders";
export const VM_SHARES_KEY = "vm.shares";

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

function FolderList({
  label,
  folders,
  onChange,
  emptyText,
  addLabel,
  defaultAccess,
}: {
  label: string;
  folders: readonly FolderGrant[];
  onChange: (next: FolderGrant[]) => void;
  emptyText: string;
  addLabel: string;
  defaultAccess: FolderGrant["access"];
}): ReactElement {
  const id = useId();
  const [draft, setDraft] = useState("");
  const add = () => {
    const path = draft.trim();
    if (path === "" || folders.some((f) => f.path === path)) return;
    onChange([...folders, { path, access: defaultAccess }]);
    setDraft("");
  };
  return (
    <div className="flex flex-col gap-2">
      {folders.length === 0 ? (
        <EmptyNotice text={emptyText} />
      ) : (
        <ul className="flex flex-col divide-y divide-gray-6" aria-label={label}>
          {folders.map((f) => (
            <li key={f.path} className="flex flex-wrap items-center gap-3 py-1.5">
              <code className="min-w-0 flex-1 font-mono text-xs">{f.path}</code>
              <label className="sr-only" htmlFor={`${id}-${f.path}`}>
                Access to {f.path}
              </label>
              <select
                id={`${id}-${f.path}`}
                className="h-7 rounded-md border border-input bg-background px-1 text-xs"
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
                <option value="ro">Read only</option>
                <option value="rw">Read and write</option>
              </select>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => onChange(folders.filter((x) => x.path !== f.path))}
                aria-label={`Stop sharing ${f.path}`}
              >
                Remove
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
          placeholder="~/Documents/Taxes"
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

export interface FileAccessPanelProps extends SettingsFormProps, LoadProps {
  persona: string;
  vmMode?: boolean;
}

export function FileAccessPanel({
  values,
  onChange,
  needsApproval,
  persona,
  vmMode = false,
  loading,
  error,
  onRetry,
}: FileAccessPanelProps): ReactElement {
  return (
    <SectionFrame
      needsApproval={needsApproval}
      title="File access"
      description={`${persona} sees only the folders you share. Everything else on this Mac is off limits.`}
    >
      <LoadGate
        label="file access"
        loading={loading ?? false}
        error={error ?? null}
        {...(onRetry ? { onRetry } : {})}
      >
        <Group
          title="Folders"
          description="Read only lets it open and search; read and write also lets it save changes, each one shown in the Diff pane."
        >
          <FolderList
            label="Shared folders"
            folders={folderGrants(values)}
            onChange={(next) => onChange(POLICY_KEY, policyWithFolders(values, next))}
            emptyText={`No folders shared. ${persona} works only in its own workspace.`}
            addLabel="Share a folder"
            defaultAccess="ro"
          />
          <SettingHint settingKey={POLICY_KEY} />
        </Group>
        <Group
          title="VM shares"
          description={
            vmMode
              ? "Folders shared into the VM over VirtioFS. Read only by default."
              : "Used in VM mode: folders shared into the guest over VirtioFS, read only by default."
          }
        >
          <FolderList
            label="VM shares"
            folders={foldersFromSettings(values, VM_SHARES_KEY)}
            onChange={(next) => onChange(VM_SHARES_KEY, next)}
            emptyText="Nothing shared into the VM. The guest sees only its own disk."
            addLabel="Share into the VM"
            defaultAccess="ro"
          />
          <SettingHint settingKey={VM_SHARES_KEY} />
        </Group>
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
        loading={form.loading && Object.keys(form.values).length === 0}
        error={form.error}
        onRetry={form.reload}
      />
      {form.writeError ? <ErrorNotice what={form.writeError} did="" /> : null}
    </div>
  );
}
