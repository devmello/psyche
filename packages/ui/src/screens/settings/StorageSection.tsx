import type { StorageCategory, StorageCategoryId } from "@psyche/protocol";
import { type ReactElement, useState } from "react";
import { formatBytes } from "../../blocks/ArtifactCard.tsx";
import { Button } from "../../components/ui/button.tsx";
import { useCall, useGatewayQuery } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { ErrorNotice, Group, messageOf } from "./shared.tsx";

/**
 * Storage (Settings > Data): disk use under the data folder by category, and one "Clear" for the
 * two categories Psyche can rebuild or that expire anyway (caches, recordings older than 7 days).
 * The clear sits behind a confirm; nothing else on the list has a button.
 */

const LABEL = {
  database: () => t("settings.storage.cat.database"),
  memoryIndex: () => t("settings.storage.cat.memoryIndex"),
  library: () => t("settings.storage.cat.library"),
  browserProfiles: () => t("settings.storage.cat.browserProfiles"),
  recordings: () => t("settings.storage.cat.recordings"),
  logs: () => t("settings.storage.cat.logs"),
  caches: () => t("settings.storage.cat.caches"),
  other: () => t("settings.storage.cat.other"),
} satisfies Record<StorageCategoryId, () => string>;

export interface StoragePanelProps {
  categories: readonly StorageCategory[] | null;
  totalBytes?: number;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  /** Runs the clear after the owner confirms; resolves with the bytes freed. */
  onClear?: () => Promise<number>;
  /** Opens with the confirm showing (stories and tests). */
  defaultConfirming?: boolean;
}

export function StoragePanel({
  categories,
  totalBytes = 0,
  loading = false,
  error = null,
  onRetry,
  onClear,
  defaultConfirming = false,
}: StoragePanelProps): ReactElement {
  const [confirming, setConfirming] = useState(defaultConfirming);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const clearable = (categories ?? []).filter((c) => c.clearable);
  const clearableBytes = clearable.reduce((a, c) => a + c.bytes, 0);

  const run = async (): Promise<void> => {
    if (!onClear) return;
    setBusy(true);
    setConfirming(false);
    try {
      const freed = await onClear();
      setNotice({ kind: "ok", text: t("settings.storage.cleared", { size: formatBytes(freed) }) });
    } catch (err) {
      setNotice({
        kind: "error",
        text: t("settings.storage.clearFailed", { reason: messageOf(err) }),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Group
      title={t("settings.storage.title")}
      description={t("settings.storage.hint")}
      actions={
        onClear && !confirming && clearable.length > 0 ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy || clearableBytes === 0}
            onClick={() => setConfirming(true)}
          >
            {t("settings.storage.clear")}
          </Button>
        ) : undefined
      }
    >
      {error ? (
        <ErrorNotice
          what={t("settings.storage.failed", { reason: error })}
          {...(onRetry ? { onRetry } : {})}
        />
      ) : loading && categories === null ? (
        <p className="text-callout text-label-secondary">{t("common.loading")}</p>
      ) : (
        <div className="flex flex-col gap-3">
          <ul className="flex flex-col divide-y divide-separator">
            {(categories ?? []).map((c) => (
              <li key={c.id} className="flex items-baseline justify-between gap-3 py-1.5">
                <span>{LABEL[c.id]()}</span>
                <span className="text-label-secondary tabular-nums">{formatBytes(c.bytes)}</span>
              </li>
            ))}
            <li className="flex items-baseline justify-between gap-3 py-1.5 font-medium">
              <span>{t("settings.storage.total")}</span>
              <span className="tabular-nums">{formatBytes(totalBytes)}</span>
            </li>
          </ul>
          {confirming ? (
            <div
              role="alertdialog"
              aria-label={t("settings.storage.confirm.title")}
              className="flex flex-col gap-2"
            >
              <p className="font-medium">{t("settings.storage.confirm.title")}</p>
              <p className="text-label-secondary">
                {t("settings.storage.confirm.body", { size: formatBytes(clearableBytes) })}
              </p>
              <div className="flex gap-2">
                <Button type="button" size="sm" variant="destructive" onClick={() => void run()}>
                  {t("settings.storage.confirm.clear")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setConfirming(false)}
                >
                  {t("common.cancel")}
                </Button>
              </div>
            </div>
          ) : null}
          {notice ? (
            <p
              role={notice.kind === "error" ? "alert" : "status"}
              className={notice.kind === "error" ? "text-danger-text" : "text-label-secondary"}
            >
              {notice.text}
            </p>
          ) : null}
        </div>
      )}
    </Group>
  );
}

/** Storage wired to `storage.usage` and `storage.clearCache` (admin scope). */
export function StorageSection(): ReactElement {
  const call = useCall();
  const q = useGatewayQuery("storage.usage", {});
  return (
    <StoragePanel
      categories={q.data?.categories ?? null}
      totalBytes={q.data?.totalBytes ?? 0}
      loading={q.loading}
      error={q.error}
      onRetry={q.reload}
      onClear={async () => {
        const r = await call("storage.clearCache", {});
        q.reload();
        return r.freedBytes;
      }}
    />
  );
}
