import type { MemoryHit, Provenance } from "@psyche/protocol";
import {
  ChevronRight,
  Download,
  EyeOff,
  FileText,
  Pause,
  Play,
  Search,
  ShieldAlert,
  Upload,
} from "lucide-react";
import { type ReactElement, type ReactNode, useState } from "react";
import { GroupedList, GroupedRow } from "../components/page.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../components/ui/alert-dialog.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog.tsx";
import { Input } from "../components/ui/input.tsx";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { Textarea } from "../components/ui/textarea.tsx";
import { useCall, useGatewayQuery, useMemoryFile } from "../data/index.ts";
import { activeI18n, t } from "../i18n/core.ts";
import { describeError } from "../i18n/errors.ts";
import { cn } from "../lib/utils.ts";
import { PeopleSheetSection } from "../people/PeopleSheetSection.tsx";
import { usePersona, useSlots } from "../slots.tsx";
import { lessonsAt, useLessons } from "../teaching/hooks.ts";
import { LessonMark } from "../teaching/LessonMark.tsx";

/** Persona files and their budgets (architecture §4.2: 20k per file, 4k for USER.md). */
export const PERSONA_FILES = [
  { path: "SOUL.md", key: "soul", budget: 20_000 },
  { path: "IDENTITY.md", key: "identity", budget: 20_000 },
  { path: "USER.md", key: "user", budget: 4_000 },
  { path: "MEMORY.md", key: "memory", budget: 20_000 },
  { path: "AGENTS.md", key: "agents", budget: 20_000 },
] as const;

export function BudgetMeter({ used, budget }: { used: number; budget: number }): ReactElement {
  const pct = Math.min(100, Math.round((used / budget) * 100));
  const over = used > budget;
  return (
    <span className="inline-flex items-center gap-2 text-callout text-label-secondary">
      <meter
        className="sr-only"
        min={0}
        max={budget}
        value={used}
        aria-label={t("agent.memory.budget")}
      />
      <span
        className="h-1.5 w-20 overflow-hidden rounded-full bg-fill-secondary"
        aria-hidden="true"
      >
        <span
          className={cn(
            "block h-full",
            over ? "bg-danger" : pct > 85 ? "bg-approval" : "bg-accent-9",
          )}
          style={{ width: `${pct}%` }}
        />
      </span>
      {t("agent.memory.budgetUse", {
        used: Math.round(used / 100) / 10,
        budget: budget / 1000,
      })}
    </span>
  );
}

export function ProvenanceChip({ provenance }: { provenance: Provenance }): ReactElement {
  const untrusted = provenance === "untrusted";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-1.5 text-xs",
        untrusted ? "border-untrusted text-approval-text" : "border-separator text-label-secondary",
      )}
    >
      {untrusted ? <ShieldAlert className="size-3" aria-hidden="true" /> : null}
      {t(`agent.provenance.${provenance}`)}
    </span>
  );
}

/** One workspace file in the editor slot (or a plain textarea), with Save / Discard. */
export function MemoryFileEditor({ path, budget }: { path: string; budget: number }): ReactElement {
  const { file, loading, error, save } = useMemoryFile(path);
  const slots = useSlots();
  // The draft belongs to the file it was typed in: switching files drops it.
  const [edit, setEdit] = useState<{ path: string; value: string } | null>(null);
  const draft = edit !== null && edit.path === path ? edit.value : null;
  const setDraft = (value: string | null) => setEdit(value === null ? null : { path, value });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  if (file === null) {
    return loading ? (
      <Skeleton className="h-48" />
    ) : (
      <p className="text-sm">
        {t("agent.memory.openFailed", { path, reason: error ?? "", hasReason: Boolean(error) })}
      </p>
    );
  }
  const value = draft ?? file.content;
  const dirty = draft !== null && draft !== file.content;
  const onSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await save(value);
      setDraft(null);
    } catch (err) {
      setSaveError(
        err instanceof Error && /conflict|changed/i.test(err.message)
          ? t("agent.memory.changed", { path })
          : describeError(err),
      );
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <BudgetMeter used={value.length} budget={budget} />
        <span className="ms-auto flex gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={!dirty || saving}
            onClick={() => setDraft(null)}
          >
            {t("agent.memory.discard")}
          </Button>
          <Button size="sm" disabled={!dirty || saving} onClick={() => void onSave()}>
            {t("common.save")}
          </Button>
        </span>
      </div>
      {path === "MEMORY.md" ? (
        <p className="text-callout text-label-secondary">{t("agent.memory.dreaming")}</p>
      ) : null}
      <FileLessons path={path} />
      {slots.renderEditor ? (
        slots.renderEditor({ path, value, onChange: setDraft, budget })
      ) : (
        <Textarea
          aria-label={t("agent.memory.contents", { path })}
          className="field-sizing-fixed h-[50vh] resize-y bg-canvas font-mono text-[13px] leading-5"
          value={value}
          onChange={(e) => setDraft(e.target.value)}
        />
      )}
      {saveError ? (
        <p className="text-sm text-danger-text" role="alert">
          {saveError}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Lines the teaching loop wrote in this file (teaching loop §5.2), each with its mark: "Learned
 * from you · 25 Oct · Refined 3 times", opening the statement, sources, change and Keep / Edit /
 * Forget.
 */
function FileLessons({ path }: { path: string }): ReactElement | null {
  const lessons = lessonsAt(useLessons({ destination: "file" }).lessons, path);
  if (lessons.length === 0) return null;
  return (
    <section aria-label={t("screens.lessons.fileList")} data-testid="file-lessons">
      <h3 className="mb-1 text-caption text-label-secondary">{t("screens.lessons.fileList")}</h3>
      <ul className="flex flex-col gap-1.5">
        {lessons.map((l) => (
          <li key={l.id} className="flex flex-col gap-0.5 border-s-2 border-separator-strong ps-2">
            <span className="font-mono text-mono text-label-primary">{l.value}</span>
            <LessonMark lesson={l} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function MemorySearch({ onClose }: { onClose?: () => void }): ReactElement {
  const call = useCall();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<MemoryHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    if (query.trim() === "") return;
    try {
      const res = await call("memory.search", { query: query.trim(), limit: 20 });
      setHits(res.hits);
      setError(null);
    } catch (err) {
      setError(describeError(err));
    }
  };
  return (
    <section aria-label={t("agent.memory.search")} className="flex flex-col gap-2">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <Input
          aria-label={t("agent.memory.search")}
          placeholder={t("agent.memory.search")}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Escape" && onClose) {
              e.stopPropagation();
              onClose();
            }
          }}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Button type="submit" variant="ghost" size="icon" aria-label={t("agent.memory.searchGo")}>
          <Search aria-hidden="true" />
        </Button>
      </form>
      {error ? <p className="text-sm text-danger-text">{error}</p> : null}
      {hits !== null ? (
        hits.length === 0 ? (
          <p className="text-sm text-label-secondary">{t("agent.memory.noHits")}</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {hits.map((h) => (
              <li key={h.chunk.id} className="flex items-start gap-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{h.chunk.text}</span>
                  <span className="block font-mono text-xs text-label-secondary">
                    {h.chunk.source}:{h.chunk.lineStart}
                  </span>
                </span>
                <ProvenanceChip provenance={h.chunk.provenance} />
              </li>
            ))}
          </ul>
        )
      ) : null}
    </section>
  );
}

function ResetDialog({
  persona,
  onReset,
}: {
  persona: string;
  onReset: () => Promise<void>;
}): ReactElement {
  const [typed, setTyped] = useState("");
  const phrase = t("agent.memory.resetPhrase", { name: persona });
  return (
    <AlertDialog>
      <AlertDialogTrigger
        render={<Button size="sm" variant="ghost" className="text-danger-text" />}
      >
        {t("agent.memory.resetOpen", { name: persona })}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("agent.memory.resetTitle", { name: persona })}</AlertDialogTitle>
          <AlertDialogDescription>{t("agent.memory.resetBody", { phrase })}</AlertDialogDescription>
        </AlertDialogHeader>
        <Input
          aria-label={t("agent.memory.confirmation")}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
        />
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={typed.trim() !== phrase}
            onClick={() => void onReset()}
          >
            {t("agent.memory.reset")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Agent sheet → Soul & Memory (UI design §3.17). */
export function SoulMemoryPanel({
  initialFile,
  initialEntity,
  onStartIncognito,
  onImport,
  onExported,
}: {
  initialFile?: string;
  /** Opens this person's or project's card (`/agent/soul?entity=`). */
  initialEntity?: string;
  onStartIncognito?: () => void;
  /** The shell picks the export file to import (format + content) and calls back. */
  onImport?: () => void;
  /** Receives the export zip (base64) to save. */
  onExported?: (file: { filename: string; data: string }) => void;
}): ReactElement {
  const persona = usePersona();
  const call = useCall();
  const [path, setPath] = useState<string>(initialFile ?? "SOUL.md");
  const status = useGatewayQuery("memory.status", {});
  const daily = useGatewayQuery("memory.daily.list", { limit: 7 });
  const [notice, setNotice] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const paused = status.data?.paused ?? false;
  const fileBudget = PERSONA_FILES.find((f) => f.path === path)?.budget ?? 20_000;

  const fileLessons = useLessons({ destination: "file" }).lessons;
  const notes = daily.data?.notes ?? [];
  // Rows open the Markdown editor in a level-3 sheet; "Open in editor" links arrive with a file.
  const [editing, setEditing] = useState<string | null>(initialFile ?? null);
  const open = (next: string) => {
    setPath(next);
    setEditing(next);
  };
  const chevron = (
    <ChevronRight className="size-4 text-label-tertiary rtl:rotate-180" aria-hidden="true" />
  );
  const row = (file: string, label: ReactNode, description?: ReactNode) => (
    <button
      key={file}
      type="button"
      onClick={() => open(file)}
      aria-label={t("screens.soul.openFile", { file })}
      className="block w-full rounded-lg text-start transition-colors hover:bg-fill-quaternary focus-visible:outline-2 focus-visible:outline-ring"
    >
      <GroupedRow
        label={label}
        {...(description ? { description } : {})}
        leading={<FileText className="size-4" aria-hidden="true" />}
        control={chevron}
      />
    </button>
  );

  return (
    <div className="flex flex-col gap-5 pb-2">
      {searching ? (
        <MemorySearch onClose={() => setSearching(false)} />
      ) : (
        <Button
          size="sm"
          variant="ghost"
          className="self-end"
          aria-expanded={false}
          onClick={() => setSearching(true)}
        >
          <Search aria-hidden="true" />
          {t("agent.memory.search")}
        </Button>
      )}

      <GroupedList title={t("agent.memory.files")}>
        {PERSONA_FILES.map((f) =>
          row(
            f.path,
            <span className="text-mono">{f.path}</span>,
            <>
              {t(`screens.soul.file.${f.key}`, { name: persona.name })}
              {lessonsAt(fileLessons, f.path).length > 0 ? (
                <span className="block">
                  {t("screens.lessons.inFile", { n: lessonsAt(fileLessons, f.path).length })}
                </span>
              ) : null}
            </>,
          ),
        )}
      </GroupedList>

      <PeopleSheetSection {...(initialEntity ? { initialEntity } : {})} />

      <GroupedList
        title={t("agent.memory.dailyNotes")}
        {...(notes.length === 0 ? { footer: t("agent.memory.noDaily") } : {})}
      >
        {notes.map((n) =>
          row(
            n.path,
            `${dayName(n.date)} ${shortDate(n.date)}`,
            <span className="text-mono">{n.path}</span>,
          ),
        )}
      </GroupedList>

      <GroupedList title={t("agent.memory.controls")}>
        <GroupedRow
          label={t("agent.memory.memory")}
          control={
            <>
              <Badge variant={paused ? "approval" : "success"}>
                {paused ? t("agent.memory.paused") : t("common.on")}
              </Badge>
              <Button
                size="sm"
                variant="outline"
                onClick={async () => {
                  await call("memory.pause", { paused: !paused });
                  status.reload();
                }}
              >
                {paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
                {paused ? t("agent.activity.resume") : t("agent.task.pause")}
              </Button>
            </>
          }
        />
        {onStartIncognito ? (
          <GroupedRow
            label={t("agent.memory.incognito")}
            leading={<EyeOff className="size-4" aria-hidden="true" />}
            control={
              <Button size="sm" variant="ghost" onClick={onStartIncognito}>
                {t("screens.soul.start")}
              </Button>
            }
          />
        ) : null}
      </GroupedList>

      <fieldset aria-label={t("agent.memory.importExport")} className="m-0 min-w-0 border-0 p-0">
        <GroupedList>
          {onImport ? (
            <GroupedRow
              label={t("agent.memory.import")}
              leading={<Upload className="size-4" aria-hidden="true" />}
              control={
                <Button size="sm" variant="ghost" onClick={onImport}>
                  {t("screens.soul.choose")}
                </Button>
              }
            />
          ) : null}
          <GroupedRow
            label={t("agent.memory.export")}
            leading={<Download className="size-4" aria-hidden="true" />}
            control={
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  const res = await call("memory.export", {});
                  onExported?.({ filename: res.filename, data: res.data });
                  setNotice(t("agent.memory.exported", { file: res.filename }));
                }}
              >
                {t("screens.soul.exportGo")}
              </Button>
            }
          />
          <GroupedRow
            label={t("screens.soul.resetRow", { name: persona.name })}
            control={
              <ResetDialog
                persona={persona.name}
                onReset={async () => {
                  const res = await call("memory.reset", {});
                  setNotice(
                    t("agent.memory.resetDone", { files: res.files.length, claims: res.claims }),
                  );
                }}
              />
            }
          />
        </GroupedList>
      </fieldset>
      {notice ? (
        <p className="text-callout text-label-secondary" role="status">
          {notice}
        </p>
      ) : null}

      {/* The editor in a level-3 sheet (§5.7); Rich / Source / Diff come from the editor slot. */}
      <Dialog
        open={editing !== null}
        onOpenChange={(next) => {
          if (!next) setEditing(null);
        }}
      >
        <DialogContent className="flex max-h-[85vh] w-[min(720px,calc(100vw-2rem))] max-w-none flex-col gap-3 sm:max-w-none">
          <DialogHeader>
            <DialogTitle className="text-mono text-label-primary">{editing ?? path}</DialogTitle>
          </DialogHeader>
          {editing !== null ? <MemoryFileEditor path={editing} budget={fileBudget} /> : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** "2026-10-18" → "Sun" in the region format (the calendar strip, §3.17). */
function dayName(date: string): string {
  const ms = Date.parse(`${date}T12:00:00Z`);
  return Number.isNaN(ms) ? "" : activeI18n().date(ms, { weekday: "short", timeZone: "UTC" });
}

/** "2026-10-18" → "Oct 18" in the region format. */
function shortDate(date: string): string {
  const ms = Date.parse(`${date}T12:00:00Z`);
  return Number.isNaN(ms)
    ? date
    : activeI18n().date(ms, { month: "short", day: "numeric", timeZone: "UTC" });
}
