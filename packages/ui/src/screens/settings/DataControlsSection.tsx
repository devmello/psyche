import type { MethodResult } from "@psyche/protocol";
import { Download, Trash2 } from "lucide-react";
import { type ReactElement, useId, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Label } from "../../components/ui/label.tsx";
import { useCall, useGatewayQuery } from "../../data/hooks.ts";
import { plural } from "../../lib/format.ts";
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
      title="Data controls"
      description={`Everything ${persona} keeps lives on this machine. There is no training toggle because nothing is sent for training.`}
    >
      <LoadGate
        label="data controls"
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
        <Group title="Memory">
          <SwitchField
            label="Pause memory"
            description={`While paused, ${persona} doesn't remember, flush or index anything from chats.`}
            checked={memoryPaused}
            onChange={(v) => onPauseMemory?.(v)}
            disabled={onPauseMemory === undefined || busy}
          />
          <SwitchField
            label="Transcript recall"
            description="Lets the agent search old chat transcripts, not only memory files."
            checked={bool(values, "data.transcriptRecall", true)}
            settingKey="data.transcriptRecall"
            onChange={(v) => onChange("data.transcriptRecall", v)}
          />
          <RadioField
            label="Keep task replays for"
            inline
            value={retention}
            settingKey="data.replayRetentionDays"
            onChange={(v) => onChange("data.replayRetentionDays", Number(v))}
            options={[
              { value: "7", label: "7 days" },
              { value: "30", label: "30 days" },
              { value: "90", label: "90 days" },
            ]}
          />
        </Group>

        <Group
          title="Export"
          description="A zip of the workspace (SOUL.md, memory, notes) and every claim."
        >
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onExport}
              disabled={!onExport || busy}
            >
              <Download aria-hidden="true" /> Export everything
            </Button>
          </div>
        </Group>

        <Group
          title="Delete threads"
          description={`Deleting a chat doesn't delete what ${persona} learned from it. To forget that too, reset memory below.`}
        >
          {confirmDelete ? (
            <div className="flex flex-wrap items-center gap-2">
              <p>
                Delete {plural(archivedThreads, "archived thread")}? Receipts and the audit log
                stay.
              </p>
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
                Delete
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setConfirmDelete(false)}
              >
                Cancel
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
                {archivedThreads === 0
                  ? "No archived threads"
                  : `Delete ${plural(archivedThreads, "archived thread")}`}
              </Button>
            </div>
          )}
        </Group>

        <Group
          title="Reset"
          description={`Deletes every memory file, index and claim and starts ${persona} fresh. Chats stay.`}
          className="border-danger/40"
        >
          {resetting ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-confirm`}>
                Type “{RESET_WORD}” to confirm. This can't be undone.
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
                  Reset memory
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
                  Cancel
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
                Reset memory…
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

  const act = async (fn: () => Promise<string>, failed: string) => {
    setBusy(true);
    setNotice(null);
    try {
      setNotice({ kind: "ok", text: await fn() });
    } catch (err) {
      setNotice({ kind: "error", text: `${failed} (${messageOf(err)}). Nothing was changed.` });
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
          return paused ? "Memory paused." : "Memory resumed.";
        }, "Psyche couldn't change memory")
      }
      onExport={() =>
        void act(async () => {
          const file = await call("memory.export", {});
          onExportReady?.(file);
          return `Export ready: ${file.filename}.`;
        }, "Psyche couldn't export")
      }
      onDeleteArchived={() =>
        void act(async () => {
          for (const t of archived) await call("threads.delete", { threadId: t.thread.id });
          threads.reload();
          return `Deleted ${plural(archived.length, "archived thread")}.`;
        }, "Psyche couldn't delete the threads")
      }
      onReset={() =>
        void act(async () => {
          const r = await call("memory.reset", {});
          status.reload();
          return `Memory reset: ${plural(r.files.length, "file")} and ${plural(r.claims, "claim")} removed.`;
        }, "Psyche couldn't reset memory")
      }
    />
  );
}
