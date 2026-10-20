import type { MethodResult } from "@psyche/protocol";
import { Download, Trash2 } from "lucide-react";
import { type ReactElement, useId, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Label } from "../../components/ui/label.tsx";
import { useCall, useGatewayQuery } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { usePersona } from "../../slots.tsx";
import {
  bool,
  ErrorNotice,
  Group,
  LoadGate,
  type LoadProps,
  messageOf,
  num,
  RadioField,
  SectionFrame,
  type SettingsFormProps,
  SwitchField,
  useSettingsForm,
} from "./shared.tsx";

/** Data controls (UI design §3.18). There is no training toggle: nothing is sent anywhere. */

/** The word typed to confirm a memory reset (compared as typed, so it stays one fixed word). */
export const RESET_WORD = "reset";

export type ExportFile = MethodResult<"memory.export">;

export interface DataControlsPanelProps extends SettingsFormProps, LoadProps {
  persona: string;
  memoryPaused: boolean;
  onPauseMemory?: (paused: boolean) => void;
  archivedThreads: number;
  onExport?: () => void;
  onDeleteArchived?: () => void;
  onReset?: () => void;
  /** Result line after an action ("Export ready: …"), or an error. */
  notice?: { kind: "ok" | "error"; text: string } | null;
  busy?: boolean;
  /** Opens with the reset confirmation showing (stories). */
  defaultResetting?: boolean;
}

export function DataControlsPanel({
  values,
  onChange,
  needsApproval,
  persona,
  memoryPaused,
  onPauseMemory,
  archivedThreads,
  onExport,
  onDeleteArchived,
  onReset,
  notice = null,
  busy = false,
  defaultResetting = false,
  loading,
  error,
  onRetry,
}: DataControlsPanelProps): ReactElement {
  const id = useId();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [resetting, setResetting] = useState(defaultResetting);
  const [typed, setTyped] = useState("");
  const retention = String(num(values, "data.replayRetentionDays", 30));
  return (
    <SectionFrame
      needsApproval={needsApproval}
      title={t("settings.data.title")}
      description={t("settings.data.description", { persona })}
    >
      <LoadGate
        label={t("settings.data.loadLabel")}
        loading={loading ?? false}
        error={error ?? null}
        {...(onRetry ? { onRetry } : {})}
      >
        {notice ? (
          notice.kind === "error" ? (
            <ErrorNotice what={notice.text} did="" />
          ) : (
            <p role="status" className="rounded-md bg-gray-3 px-3 py-2 text-sm">
              {notice.text}
            </p>
          )
        ) : null}
        <Group title={t("settings.data.memory")}>
          <SwitchField
            label={t("settings.data.pauseMemory")}
            description={t("settings.data.pauseMemoryHint", { persona })}
            checked={memoryPaused}
            onChange={(v) => onPauseMemory?.(v)}
            disabled={onPauseMemory === undefined || busy}
          />
          <SwitchField
            label={t("settings.key.data.transcriptRecall")}
            description={t("settings.data.transcriptRecallHint")}
            checked={bool(values, "data.transcriptRecall", true)}
            settingKey="data.transcriptRecall"
            onChange={(v) => onChange("data.transcriptRecall", v)}
          />
          <RadioField
            label={t("settings.key.data.replayRetentionDays")}
            inline
            value={retention}
            settingKey="data.replayRetentionDays"
            onChange={(v) => onChange("data.replayRetentionDays", Number(v))}
            options={[
              { value: "7", label: t("settings.data.days", { n: 7 }) },
              { value: "30", label: t("settings.data.days", { n: 30 }) },
              { value: "90", label: t("settings.data.days", { n: 90 }) },
            ]}
          />
        </Group>

        <Group title={t("settings.data.export")} description={t("settings.data.exportHint")}>
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onExport}
              disabled={!onExport || busy}
            >
              <Download aria-hidden="true" /> {t("settings.data.exportEverything")}
            </Button>
          </div>
        </Group>

        <Group
          title={t("settings.data.deleteThreads")}
          description={t("settings.data.deleteThreadsHint", { persona })}
        >
          {confirmDelete ? (
            <div className="flex flex-wrap items-center gap-2">
              <p>{t("settings.data.confirmDelete", { n: archivedThreads })}</p>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setConfirmDelete(false);
                  onDeleteArchived?.();
                }}
              >
                {t("common.delete")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setConfirmDelete(false)}
              >
                {t("common.cancel")}
              </Button>
            </div>
          ) : (
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={archivedThreads === 0 || !onDeleteArchived || busy}
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 aria-hidden="true" />
                {t("settings.data.deleteArchived", { n: archivedThreads })}
              </Button>
            </div>
          )}
        </Group>

        <Group
          title={t("settings.data.reset")}
          description={t("settings.data.resetHint", { persona })}
          className="border-danger/40"
        >
          {resetting ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-confirm`}>
                {t("settings.data.typeToConfirm", { word: RESET_WORD })}
              </Label>
              <Input
                id={`${id}-confirm`}
                className="max-w-xs"
                autoComplete="off"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
              />
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  disabled={typed.trim().toLowerCase() !== RESET_WORD || busy}
                  onClick={() => {
                    setResetting(false);
                    setTyped("");
                    onReset?.();
                  }}
                >
                  {t("settings.data.resetMemory")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setResetting(false);
                    setTyped("");
                  }}
                >
                  {t("common.cancel")}
                </Button>
              </div>
            </div>
          ) : (
            <div>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={!onReset}
                onClick={() => setResetting(true)}
              >
                {t("settings.data.resetMemoryEllipsis")}
              </Button>
            </div>
          )}
        </Group>
      </LoadGate>
    </SectionFrame>
  );
}

export interface DataControlsSectionProps {
  /** Receives the export zip; the shell saves it to disk. */
  onExportReady?: (file: ExportFile) => void;
}

export function DataControlsSection({ onExportReady }: DataControlsSectionProps): ReactElement {
  const form = useSettingsForm();
  const call = useCall();
  const persona = usePersona();
  const status = useGatewayQuery("memory.status", {});
  const threads = useGatewayQuery("threads.list", { includeArchived: true });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<DataControlsPanelProps["notice"]>(null);
  const archived = (threads.data?.threads ?? []).filter(
    (t) => t.thread.archivedAt !== null && t.thread.archivedAt !== undefined,
  );

  type Action = "pause" | "export" | "delete" | "reset";
  const act = async (fn: () => Promise<string>, action: Action) => {
    setBusy(true);
    setNotice(null);
    try {
      setNotice({ kind: "ok", text: await fn() });
    } catch (err) {
      setNotice({
        kind: "error",
        text: t("settings.data.failed", { action, reason: messageOf(err) }),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <DataControlsPanel
      persona={persona.name}
      values={form.values}
      onChange={form.onChange}
      needsApproval={form.needsApproval}
      memoryPaused={status.data?.paused ?? false}
      archivedThreads={archived.length}
      busy={busy}
      notice={notice ?? (form.writeError ? { kind: "error", text: form.writeError } : null)}
      loading={form.loading && Object.keys(form.values).length === 0}
      error={form.error}
      onRetry={form.reload}
      onPauseMemory={(paused) =>
        void act(async () => {
          await call("memory.pause", { paused });
          status.reload();
          return paused ? t("settings.data.paused") : t("settings.data.resumed");
        }, "pause")
      }
      onExport={() =>
        void act(async () => {
          const file = await call("memory.export", {});
          onExportReady?.(file);
          return t("settings.data.exportReady", { filename: file.filename });
        }, "export")
      }
      onDeleteArchived={() =>
        void act(async () => {
          for (const t of archived) await call("threads.delete", { threadId: t.thread.id });
          threads.reload();
          return t("settings.data.deleted", { n: archived.length });
        }, "delete")
      }
      onReset={() =>
        void act(async () => {
          const r = await call("memory.reset", {});
          status.reload();
          return t("settings.data.resetDone", { files: r.files.length, claims: r.claims });
        }, "reset")
      }
    />
  );
}
