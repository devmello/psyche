import { Folder, Terminal } from "lucide-react";
import type { ReactElement } from "react";
import { Button } from "../../components/ui/button.tsx";
import { t } from "../../i18n/core.ts";
import { execHostEnabled, folderGrants } from "./FileAccessSection.tsx";
import { Group, StatusChip } from "./shared.tsx";

/**
 * "Files on this Mac" and "Terminal" in Connectors. Neither is a connector of its own: they show
 * what Permissions → File access decides (`permissions.policy.folders` and
 * `permissions.policy.exec.execHostEnabled`) and open it there, so the folders and the switch have
 * one home and one editor (settings-2026).
 */

export interface PolicyValues {
  values: Readonly<Record<string, unknown>>;
  onChange: (key: string, value: unknown) => void;
}

interface CardProps {
  values: Readonly<Record<string, unknown>>;
  persona: string;
  /** Opens Permissions → File access. */
  onOpenFileAccess?: () => void;
}

/** At most this many folders are named; the rest are counted. */
const SHOWN = 4;

function OpenFileAccess({ onOpen }: { onOpen?: (() => void) | undefined }): ReactElement | null {
  if (!onOpen) return null;
  return (
    <div>
      <Button type="button" variant="outline" size="sm" onClick={onOpen}>
        {t("settings.deviceAccess.open")}
      </Button>
    </div>
  );
}

export function FilesOnMacCard({ values, persona, onOpenFileAccess }: CardProps): ReactElement {
  const grants = folderGrants(values);
  return (
    <Group title={t("settings.deviceAccess.files.title")}>
      <p className="flex items-start gap-2 text-callout text-label-secondary">
        <Folder aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <span>{t("settings.deviceAccess.files.hint", { persona })}</span>
      </p>
      {grants.length === 0 ? (
        <p className="text-callout text-label-secondary">
          {t("settings.files.noFolders", { persona })}
        </p>
      ) : (
        <ul aria-label={t("settings.files.sharedFolders")} className="flex flex-col gap-1">
          {grants.slice(0, SHOWN).map((g) => (
            <li key={g.path} className="flex min-w-0 items-baseline gap-2">
              <code className="truncate font-mono text-callout text-label-primary">{g.path}</code>
              <span className="shrink-0 text-callout text-label-secondary">
                {g.access === "rw"
                  ? t("settings.permissions.folderRw")
                  : t("settings.permissions.folderRo")}
              </span>
            </li>
          ))}
          {grants.length > SHOWN ? (
            <li className="text-callout text-label-secondary">
              {t("settings.deviceAccess.files.more", { count: grants.length - SHOWN })}
            </li>
          ) : null}
        </ul>
      )}
      <OpenFileAccess onOpen={onOpenFileAccess} />
    </Group>
  );
}

export function TerminalCard({ values, persona, onOpenFileAccess }: CardProps): ReactElement {
  const folders = folderGrants(values).length;
  const on = execHostEnabled(values);
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
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-callout text-label-secondary">
        <StatusChip tone={on ? "success" : "neutral"}>
          {on ? t("settings.deviceAccess.terminal.on") : t("settings.deviceAccess.terminal.off")}
        </StatusChip>
        <span>{t("settings.deviceAccess.terminal.folders", { count: folders })}</span>
      </p>
      <OpenFileAccess onOpen={onOpenFileAccess} />
    </Group>
  );
}
