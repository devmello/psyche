import type { MemoryRecallStatus, MemoryStoreStatus, MethodResult } from "@psyche/protocol";
import { MEMORY_REVIEW_ROUTE } from "@psyche/protocol";
import { Download, Trash2 } from "lucide-react";
import { type ReactElement, useId, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Label } from "../../components/ui/label.tsx";
import { useCall, useGatewayQuery } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { useMemoryReview } from "../../memory/hooks.ts";
import { usePersona, useSlots } from "../../slots.tsx";
import { useEverythingSetup } from "./EverythingMemorySection.tsx";
import { MapGroup } from "./MapSettings.tsx";
import { GRAPH_SETTING, readGraphSettings } from "./PeopleGraphSettings.tsx";
import {
  Advanced,
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
  StatusChip,
  SwitchField,
  useSettingsForm,
} from "./shared.tsx";
import { WidgetGroup } from "./WidgetSettings.tsx";

/**
 * Privacy & data (UI design §3.18, settings-2026): how long things are kept, what loads from the
 * web, export, and the destructive actions last. There is no training toggle: nothing is sent
 * anywhere. The memory switches live on the Memory page (`MemoryControlsSection`).
 */

/** The word typed to confirm a memory reset (compared as typed, so it stays one fixed word). */
export const RESET_WORD = "reset";

export type ExportFile = MethodResult<"memory.export">;

interface PanelBase extends SettingsFormProps, LoadProps {
  persona: string;
  /** Result line after an action ("Export ready: …"), or an error. */
  notice?: { kind: "ok" | "error"; text: string } | null;
  busy?: boolean;
}

export interface MemoryControlsPanelProps extends PanelBase {
  memoryPaused: boolean;
  onPauseMemory?: (paused: boolean) => void;
  /** Everything memory's switch (the shell runs its first-run consent when it turns on). */
  everything?: { on: boolean; onChange: (on: boolean) => void };
  /** People and projects' switch. */
  people?: { on: boolean; onChange: (on: boolean) => void };
  /** Facts waiting for review, with a way to jump to them. */
  reviewCount?: number;
  onOpenReview?: () => void;
}

export interface DataControlsPanelProps extends PanelBase {
  archivedThreads: number;
  onExport?: () => void;
  onDeleteArchived?: () => void;
  onReset?: () => void;
  /** Opens with the reset confirmation showing (stories). */
  defaultResetting?: boolean;
}

function storeTone(s: MemoryStoreStatus): "success" | "info" | "danger" {
  if (s.restartNeeded) return "info";
  return s.state === "ready" ? "success" : s.state === "unavailable" ? "danger" : "info";
}

/** One line saying where memory is now. */
export function storeText(s: MemoryStoreStatus): string {
  if (s.restartNeeded) return t("settings.data.encryptMemory.restart");
  if (s.state === "ready") return t("settings.data.encryptMemory.on");
  if (s.state === "pending") return t("settings.data.encryptMemory.pending");
  return t("settings.data.encryptMemory.unavailable", { why: s.reason ?? "" });
}

/** One line saying how memory recall works now. */
export function recallStatusText(r: MemoryRecallStatus): string {
  if (r.state === "semantic")
    return t("settings.data.recallState.semantic", {
      vectors: r.vectors ?? 0,
      chunks: Math.max(r.chunks ?? 0, r.vectors ?? 0),
    });
  if (r.state === "text_only")
    return t(
      r.fallback === "model_missing"
        ? "settings.data.recallState.modelMissing"
        : r.fallback === "cloud_not_allowed"
          ? "settings.data.recallState.cloudBlocked"
          : "settings.data.recallState.textOnly",
    );
  return t("settings.data.recallState.off");
}

/** Settings → Memory → Remembering & learning: pause, recall and the teaching loop. */
export function MemoryControlsPanel({
  values,
  onChange,
  needsApproval,
  persona,
  memoryPaused,
  onPauseMemory,
  everything,
  people,
  reviewCount = 0,
  onOpenReview,
  notice = null,
  busy = false,
  loading,
  error,
  onRetry,
}: MemoryControlsPanelProps): ReactElement {
  return (
    <SectionFrame
      needsApproval={needsApproval}
      title={t("settings.memoryControls.title")}
      description={t("settings.memoryControls.description", { persona })}
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
            <p role="status" className="rounded-md bg-fill-tertiary px-3 py-2 text-callout">
              {notice.text}
            </p>
          )
        ) : null}
        <Group title={t("memoryBasics.group")}>
          <SwitchField
            label={t("memoryBasics.chats")}
            description={memoryPaused ? t("memoryBasics.paused") : t("memoryBasics.chatsHint")}
            checked={!memoryPaused}
            onChange={(on) => onPauseMemory?.(!on)}
            disabled={onPauseMemory === undefined || busy}
          />
          <SwitchField
            label={t("memoryBasics.feedback")}
            description={t("memoryBasics.feedbackHint")}
            checked={bool(values, "teaching.enabled", true)}
            onChange={(on) => onChange("teaching.enabled", on)}
          />
          {everything === undefined ? null : (
            <SwitchField
              label={t("memoryBasics.everything")}
              description={t("memoryBasics.everythingHint")}
              checked={everything.on}
              settingKey="memory.everything"
              onChange={everything.onChange}
            />
          )}
          {people === undefined ? null : (
            <SwitchField
              label={t("memoryBasics.people")}
              description={t("memoryBasics.peopleHint")}
              checked={people.on}
              settingKey="memory.graph"
              onChange={people.onChange}
            />
          )}
        </Group>
        {onOpenReview === undefined ? null : reviewCount > 0 ? (
          <div
            data-testid="review-waiting"
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-approval-bg px-3 py-2"
          >
            <StatusChip tone="approval">{t("memoryReview.waiting", { n: reviewCount })}</StatusChip>
            <Button type="button" variant="outline" size="sm" onClick={onOpenReview}>
              {t("memoryReview.open")}
            </Button>
          </div>
        ) : (
          <p className="px-1 text-callout text-label-secondary">{t("memoryReview.caughtUp")}</p>
        )}
      </LoadGate>
    </SectionFrame>
  );
}

export interface MemoryStoreGroupsProps extends SettingsFormProps {
  persona: string;
  /** How memory recall works now (`memory.status.recall`), under "How memory is recalled". */
  recall?: MemoryRecallStatus;
  /** Where memory lives (`memory.status.store`): the "Encrypt memory" switch and its state. */
  store?: MemoryStoreStatus;
  onEncryptMemory?: (on: boolean) => void;
  busy?: boolean;
}

/**
 * How memory is recalled, and (once the Gateway reports where memory lives) whether it is
 * encrypted on disk. Shown under Advanced on the Memory page.
 */
export function MemoryStoreGroups({
  values,
  onChange,
  persona,
  recall,
  store,
  onEncryptMemory,
  busy = false,
}: MemoryStoreGroupsProps): ReactElement {
  return (
    <>
      <Group title={t("memoryAdvanced.recall")}>
        <RadioField<"markdown" | "embeddings">
          label={t("settings.key.memory.recall.mode")}
          description={t("settings.data.recallModeHint")}
          value={values["memory.recall.mode"] === "embeddings" ? "embeddings" : "markdown"}
          settingKey="memory.recall.mode"
          onChange={(v) => onChange("memory.recall.mode", v)}
          options={[
            {
              value: "markdown",
              label: t("settings.data.recallMode.markdown"),
              hint: t("settings.data.recallMode.markdownHint"),
            },
            {
              value: "embeddings",
              label: t("settings.data.recallMode.embeddings"),
              hint: t("settings.data.recallMode.embeddingsHint"),
            },
          ]}
        />
        {recall !== undefined && recall.mode === "embeddings" ? (
          <p role="status" className="text-callout text-label-secondary">
            {recallStatusText(recall)}
          </p>
        ) : null}
      </Group>
      {store === undefined ? null : (
        <Group title={t("memoryAdvanced.encryption")}>
          <SwitchField
            label={t("settings.data.encryptMemory")}
            description={t("settings.data.encryptMemoryHint", { persona })}
            checked={store.encrypted}
            onChange={(v) => onEncryptMemory?.(v)}
            disabled={onEncryptMemory === undefined || busy}
          >
            {store.restartNeeded || store.state !== "off" ? (
              <div role="status" className="pt-1">
                <StatusChip tone={storeTone(store)}>{storeText(store)}</StatusChip>
              </div>
            ) : null}
          </SwitchField>
        </Group>
      )}
    </>
  );
}

export function DataControlsPanel({
  values,
  onChange,
  needsApproval,
  persona,
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
  // Run trace §4.3: both default to 7 days; 0 is Off.
  const retention = String(num(values, "data.replayRetentionDays", 7));
  const reasoning = String(num(values, "data.reasoningRetentionDays", 7));
  const days = (n: number) => ({
    value: String(n),
    label: n === 0 ? t("common.off") : t("settings.data.days", { n }),
  });
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
        <Group title={t("settings.data.keep")} description={t("settings.data.keepHint")}>
          <RadioField
            label={t("settings.key.data.reasoningRetentionDays")}
            description={t("settings.data.reasoningRetentionHint")}
            inline
            value={reasoning}
            settingKey="data.reasoningRetentionDays"
            onChange={(v) => onChange("data.reasoningRetentionDays", Number(v))}
            options={[0, 1, 7, 30].map(days)}
          />
          <RadioField
            label={t("settings.key.data.replayRetentionDays")}
            description={t("settings.data.replayRetentionHint", { persona })}
            inline
            value={retention}
            settingKey="data.replayRetentionDays"
            onChange={(v) => onChange("data.replayRetentionDays", Number(v))}
            options={[0, 1, 7, 30, 90].map(days)}
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

        <Advanced description={t("settings.data.advancedHint")}>
          <MapGroup values={values} onChange={onChange} />
          <WidgetGroup values={values} onChange={onChange} />
        </Advanced>

        {/* Destructive actions sit apart, last, under their own heading (settings-2026 §4). */}
        <section
          aria-labelledby={`${id}-danger`}
          className="flex flex-col gap-5 border-t border-separator pt-5"
        >
          <p id={`${id}-danger`} className="px-1 text-headline text-danger">
            {t("settings.data.danger")}
          </p>
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
        </section>
      </LoadGate>
    </SectionFrame>
  );
}

/** Saves the export zip as a download, when the shell has no save of its own. */
export function downloadExport(file: ExportFile): void {
  if (typeof URL.createObjectURL !== "function" || typeof document === "undefined") return;
  const bytes = Uint8Array.from(atob(file.data), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: file.mime }));
  const link = document.createElement("a");
  link.href = url;
  link.download = file.filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export interface DataControlsSectionProps {
  /** Receives the export zip; without it the zip is saved as a download (`downloadExport`). */
  onExportReady?: (file: ExportFile) => void;
}

/** Settings → Memory → Basics, fed from the Gateway. */
export function MemoryControlsSection(): ReactElement {
  const setup = useEverythingSetup();
  const { form } = setup;
  const call = useCall();
  const persona = usePersona();
  const { navigate } = useSlots();
  const status = useGatewayQuery("memory.status", {});
  const review = useMemoryReview();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<MemoryControlsPanelProps["notice"]>(null);
  const act = useAction(setBusy, setNotice);
  const graph = readGraphSettings(form.values);
  return (
    <>
      <MemoryControlsPanel
        persona={persona.name}
        values={form.values}
        onChange={form.onChange}
        needsApproval={form.needsApproval}
        memoryPaused={status.data?.paused ?? false}
        busy={busy}
        notice={notice ?? (form.writeError ? { kind: "error", text: form.writeError } : null)}
        loading={form.loading && Object.keys(form.values).length === 0}
        error={form.error}
        onRetry={form.reload}
        everything={{
          on: setup.value.enabled,
          onChange: (on) => (on ? setup.turnOn() : setup.turnOff()),
        }}
        people={{
          on: graph.enabled,
          onChange: (enabled) => form.onChange(GRAPH_SETTING, { ...graph, enabled }),
        }}
        reviewCount={review.counts.pending}
        {...(navigate ? { onOpenReview: () => navigate(MEMORY_REVIEW_ROUTE) } : {})}
        onPauseMemory={(paused) =>
          void act(async () => {
            await call("memory.pause", { paused });
            status.reload();
            return paused ? t("settings.data.paused") : t("settings.data.resumed");
          }, "pause")
        }
      />
      {setup.dialog}
    </>
  );
}

type Action = "pause" | "export" | "delete" | "reset" | "forget" | "encrypt";
export type Notice = PanelBase["notice"];

/** Runs one action with a busy flag, then shows its result line or its error. */
export function useAction(setBusy: (b: boolean) => void, setNotice: (n: Notice) => void) {
  return async (fn: () => Promise<string>, action: Action) => {
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

  const act = useAction(setBusy, setNotice);

  return (
    <DataControlsPanel
      persona={persona.name}
      values={form.values}
      onChange={form.onChange}
      needsApproval={form.needsApproval}
      archivedThreads={archived.length}
      busy={busy}
      notice={notice ?? (form.writeError ? { kind: "error", text: form.writeError } : null)}
      loading={form.loading && Object.keys(form.values).length === 0}
      error={form.error}
      onRetry={form.reload}
      onExport={() =>
        void act(async () => {
          const file = await call("memory.export", {});
          (onExportReady ?? downloadExport)(file);
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
