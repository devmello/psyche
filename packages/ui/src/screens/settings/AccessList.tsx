import type { MethodResult } from "@psyche/protocol";
import { type ReactElement, useEffect, useId, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { NativeSelect } from "../../components/ui/native-select.tsx";
import { useCall, useGatewayQuery } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { formatRelative } from "../../lib/format.ts";
import { EmptyNotice, ErrorNotice, messageOf, SectionSkeleton } from "./shared.tsx";
import type { FolderGrant } from "./types.ts";

/**
 * Settings → Permissions → Access (settings-2026 §7): one list of what Psyche can reach, from
 * `access.list`: shared folders (always, or for one chat) and standing grants. Psyche asks in the
 * chat when it needs something and the answer is remembered here; this list is where it is seen
 * and taken back, not the main way to give access.
 */

export type AccessEntry = MethodResult<"access.list">["entries"][number];

export interface AccessListViewProps {
  entries: readonly AccessEntry[];
  persona: string;
  now?: number;
  /** Ids being revoked, for disabled buttons. */
  revoking?: ReadonlySet<string>;
  onRevoke?: (entry: AccessEntry) => void;
  /** Read only / read and change for a folder kept until revoked (the policy). */
  onFolderMode?: (path: string, access: FolderGrant["access"]) => void;
}

function scopeWord(e: AccessEntry): string {
  return t(`settings.access.scope.${e.scope}`);
}

export function AccessListView({
  entries,
  persona,
  now = Date.now(),
  revoking,
  onRevoke,
  onFolderMode,
}: AccessListViewProps): ReactElement {
  const id = useId();
  if (entries.length === 0) return <EmptyNotice text={t("settings.access.empty", { persona })} />;
  return (
    <ul aria-label={t("settings.access.listLabel", { persona })} className="flex flex-col">
      {entries.map((e) => {
        const folder = e.type === "folder";
        const editable = folder && e.scope === "always" && e.path !== undefined && onFolderMode;
        const meta = [
          scopeWord(e),
          folder && !editable
            ? e.mode === "rw"
              ? t("settings.files.rw")
              : t("settings.files.ro")
            : null,
          e.lastUsedAt === undefined
            ? null
            : t("settings.access.used", { when: formatRelative(e.lastUsedAt, now) }),
        ].filter((x): x is string => x !== null);
        return (
          <li
            key={e.id}
            className="relative flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1 py-1.5 before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-separator first:before:hidden"
          >
            <div className="flex min-w-0 flex-1 flex-col">
              {folder ? (
                <code className="truncate font-mono text-callout text-label-primary">
                  {e.path ?? e.label}
                </code>
              ) : (
                <span className="truncate text-body text-label-primary">{e.label}</span>
              )}
              <span className="text-callout text-label-secondary">{meta.join(" · ")}</span>
            </div>
            {editable && e.path !== undefined ? (
              <>
                <label className="sr-only" htmlFor={`${id}-${e.id}`}>
                  {t("settings.files.accessTo", { path: e.path })}
                </label>
                <NativeSelect
                  id={`${id}-${e.id}`}
                  size="sm"
                  value={e.mode ?? "ro"}
                  onChange={(ev) =>
                    onFolderMode?.(e.path as string, ev.target.value as FolderGrant["access"])
                  }
                >
                  <option value="ro">{t("settings.files.ro")}</option>
                  <option value="rw">{t("settings.files.rw")}</option>
                </NativeSelect>
              </>
            ) : null}
            {onRevoke ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={revoking?.has(e.id) ?? false}
                onClick={() => onRevoke(e)}
                aria-label={t("settings.access.revokeNamed", { name: e.path ?? e.label })}
              >
                {t("settings.files.revoke")}
              </Button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** The list fed from `access.list`; Revoke calls `access.revoke` and reloads. */
export function ConnectedAccessList({
  persona,
  now,
  onFolderMode,
  reloadKey,
}: {
  persona: string;
  now?: number;
  onFolderMode?: (path: string, access: FolderGrant["access"]) => void;
  /** Changes when the folders change elsewhere (the policy), so the list reads again. */
  reloadKey?: unknown;
}): ReactElement {
  const call = useCall();
  const list = useGatewayQuery("access.list", {});
  const reload = list.reload;
  // biome-ignore lint/correctness/useExhaustiveDependencies: reads again when the folders change
  useEffect(() => {
    reload();
  }, [reloadKey]);
  const [revoking, setRevoking] = useState<ReadonlySet<string>>(new Set());
  const [failed, setFailed] = useState<string | null>(null);
  if (list.data === undefined) {
    if (list.error !== null)
      return <ErrorNotice what={t("settings.access.loadFailed", { reason: list.error })} did="" />;
    return <SectionSkeleton label={t("settings.access.loadLabel")} rows={2} />;
  }
  const revoke = (e: AccessEntry) => {
    setFailed(null);
    setRevoking((s) => new Set([...s, e.id]));
    call("access.revoke", { entryId: e.id })
      .then(() => list.reload())
      .catch((err: unknown) => setFailed(messageOf(err)))
      .finally(() =>
        setRevoking((s) => {
          const next = new Set(s);
          next.delete(e.id);
          return next;
        }),
      );
  };
  return (
    <div className="flex flex-col gap-2">
      <AccessListView
        entries={list.data.entries}
        persona={persona}
        revoking={revoking}
        onRevoke={revoke}
        {...(now === undefined ? {} : { now })}
        {...(onFolderMode ? { onFolderMode } : {})}
      />
      {failed ? <ErrorNotice what={failed} did={t("settings.access.unchanged")} /> : null}
    </div>
  );
}
