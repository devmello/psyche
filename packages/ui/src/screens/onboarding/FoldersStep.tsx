import type { StarterFolderId } from "@psyche/protocol";
import { type ReactElement, useId } from "react";
import { t } from "../../i18n/core.ts";
import { GROUP_ROWS } from "../settings/shared.tsx";

/**
 * The opt-in folders step: Documents, Desktop and Downloads, shared read only. Every box starts
 * unticked; ticking one only records the choice, and the host writes it (read only, through
 * `settings.set`) when onboarding finishes. The Gateway decides which folders are offered
 * (`files.starterFolders`: never a sensitive root, never the home folder).
 */

export interface StarterFolderOption {
  id: StarterFolderId;
  path: string;
}

const LABEL: Record<StarterFolderId, () => string> = {
  documents: () => t("onboarding.folders.documents"),
  desktop: () => t("onboarding.folders.desktop"),
  downloads: () => t("onboarding.folders.downloads"),
};

export function FoldersStep({
  persona,
  options,
  ticked,
  onChange,
}: {
  persona: string;
  options: readonly StarterFolderOption[];
  ticked: readonly StarterFolderId[];
  onChange: (next: StarterFolderId[]) => void;
}): ReactElement {
  const headingId = useId();
  const toggle = (id: StarterFolderId, on: boolean) =>
    onChange(on ? [...ticked.filter((x) => x !== id), id] : ticked.filter((x) => x !== id));
  return (
    <div className="flex flex-col gap-5" data-testid="onboarding-folders">
      <p className="text-reading text-label-secondary" id={headingId}>
        {t("onboarding.folders.lead", { name: persona })}
      </p>
      <fieldset className="flex flex-col gap-1 border-0 p-0" aria-labelledby={headingId}>
        <legend className="sr-only">{t("onboarding.folders.group")}</legend>
        <div className={GROUP_ROWS}>
          {options.map((o) => (
            <label key={o.id} className="flex min-h-9 cursor-default items-center gap-3 py-1">
              <input
                type="checkbox"
                className="size-4"
                checked={ticked.includes(o.id)}
                onChange={(e) => toggle(o.id, e.currentTarget.checked)}
              />
              <span className="flex min-w-0 flex-col">
                <span className="text-body text-label-primary">{LABEL[o.id]()}</span>
                <code className="truncate font-mono text-callout text-label-secondary">
                  {o.path}
                </code>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <p className="text-callout text-label-secondary">{t("onboarding.folders.hint")}</p>
    </div>
  );
}
