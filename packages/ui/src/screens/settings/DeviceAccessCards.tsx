import { Folder, Terminal } from "lucide-react";
import type { ReactElement } from "react";
import { Button } from "../../components/ui/button.tsx";
import { t } from "../../i18n/core.ts";
import {
  execHostEnabled,
  FolderList,
  folderGrants,
  POLICY_KEY,
  policyWithExecHost,
  policyWithFolders,
} from "./FileAccessSection.tsx";
import { Group, SwitchField } from "./shared.tsx";

/**
 * "Files on this Mac" and "Terminal" in Connectors. Neither is a connector of its own: they are
 * views onto the settings that already decide this (`permissions.policy.folders` from File access,
 * and `permissions.policy.exec.execHostEnabled`), so there is one list of folders and one switch.
 */

export interface PolicyValues {
  values: Readonly<Record<string, unknown>>;
  onChange: (key: string, value: unknown) => void;
}

export function FilesOnMacCard({
  values,
  onChange,
  persona,
}: PolicyValues & { persona: string }): ReactElement {
  const grants = folderGrants(values);
  return (
    <Group title={t("settings.deviceAccess.files.title")}>
      <p className="flex items-start gap-2 text-callout text-label-secondary">
        <Folder aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <span>{t("settings.deviceAccess.files.hint", { persona })}</span>
      </p>
      <FolderList
        label={t("settings.files.sharedFolders")}
        folders={grants}
        onChange={(next) => onChange(POLICY_KEY, policyWithFolders(values, next))}
        emptyText={t("settings.files.noFolders", { persona })}
        addLabel={t("settings.files.shareFolder")}
        defaultAccess="ro"
      />
    </Group>
  );
}

export function TerminalCard({
  values,
  onChange,
  persona,
  onOpenFileAccess,
}: PolicyValues & { persona: string; onOpenFileAccess?: () => void }): ReactElement {
  const folders = folderGrants(values).length;
  return (
    <Group title={t("settings.deviceAccess.terminal.title")}>
      <p className="flex items-start gap-2 text-callout text-label-secondary">
        <Terminal aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <span>{t("settings.deviceAccess.terminal.hint", { persona })}</span>
      </p>
      <ul className="list-disc ps-8! text-callout text-label-secondary">
        <li>{t("settings.deviceAccess.terminal.where")}</li>
        <li>{t("settings.deviceAccess.terminal.asks")}</li>
        <li>{t("settings.deviceAccess.terminal.sandbox")}</li>
      </ul>
      <SwitchField
        label={t("settings.deviceAccess.terminal.switch", { persona })}
        checked={execHostEnabled(values)}
        onChange={(on) => onChange(POLICY_KEY, policyWithExecHost(values, on))}
      />
      <p className="flex flex-wrap items-center gap-2 text-callout text-label-secondary">
        <span>{t("settings.deviceAccess.terminal.folders", { count: folders })}</span>
        {onOpenFileAccess ? (
          <Button type="button" variant="ghost" size="sm" onClick={onOpenFileAccess}>
            {t("settings.deviceAccess.terminal.manage")}
          </Button>
        ) : null}
      </p>
    </Group>
  );
}
