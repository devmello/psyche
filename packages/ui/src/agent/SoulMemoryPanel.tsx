import type { MemoryHit, Provenance } from "@psyche/protocol";
import { Download, EyeOff, Pause, Play, Search, ShieldAlert, Upload } from "lucide-react";
import { type ReactElement, useEffect, useState } from "react";
import { SectionLabel } from "../components/page.tsx";
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
import { Input } from "../components/ui/input.tsx";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs.tsx";
import { Textarea } from "../components/ui/textarea.tsx";
import { useCall, useGatewayQuery, useMemoryFile } from "../data/index.ts";
import { activeI18n, t } from "../i18n/core.ts";
import { describeError } from "../i18n/errors.ts";
import { cn } from "../lib/utils.ts";
import { usePersona, useSlots } from "../slots.tsx";

/** Persona files and their budgets (architecture §4.2: 20k per file, 4k for USER.md). */
export const PERSONA_FILES = [
  { path: "SOUL.md", budget: 20_000 },
  { path: "IDENTITY.md", budget: 20_000 },
  { path: "USER.md", budget: 4_000 },
  { path: "MEMORY.md", budget: 20_000 },
  { path: "AGENTS.md", budget: 20_000 },
] as const;

export function BudgetMeter({ used, budget }: { used: number; budget: number }): ReactElement {
  const pct = Math.min(100, Math.round((used / budget) * 100));
  const over = used > budget;
  return (
    <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
      <meter
        className="sr-only"
        min={0}
        max={budget}
        value={used}
        aria-label={t("agent.memory.budget")}
      />
      <span className="h-1.5 w-20 overflow-hidden rounded-full bg-gray-4" aria-hidden="true">
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
        untrusted ? "border-untrusted text-approval-text" : "border-gray-6 text-muted-foreground",
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
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Switching files drops the unsaved draft of the previous one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on path change only
  useEffect(() => setDraft(null), [path]);
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
        <span className="text-mono text-gray-12">{path}</span>
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
        <p className="text-caption text-muted-foreground">{t("agent.memory.dreaming")}</p>
      ) : null}
      {slots.renderEditor ? (
        slots.renderEditor({ path, value, onChange: setDraft, budget })
      ) : (
        <Textarea
          aria-label={t("agent.memory.contents", { path })}
          className="field-sizing-fixed h-64 resize-y bg-gray-1 font-mono text-[13px] leading-5"
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
          <p className="text-sm text-muted-foreground">{t("agent.memory.noHits")}</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {hits.map((h) => (
              <li key={h.chunk.id} className="flex items-start gap-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{h.chunk.text}</span>
                  <span className="block font-mono text-xs text-muted-foreground">
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
  onStartIncognito,
  onImport,
  onExported,
}: {
  initialFile?: string;
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

  const notes = daily.data?.notes ?? [];

  return (
    <div className="flex flex-col gap-5 px-2">
      <section aria-label={t("agent.memory.files")} className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <SectionLabel as="h3" className="w-12 shrink-0">
            {t("agent.memory.files")}
          </SectionLabel>
          <Tabs value={path} onValueChange={(v) => setPath(String(v))} className="min-w-0 flex-1">
            <TabsList
              aria-label={t("agent.memory.files")}
              variant="line"
              className="h-8 w-full justify-start overflow-x-auto"
            >
              {PERSONA_FILES.map((f) => (
                <TabsTrigger key={f.path} value={f.path} className="flex-none font-mono text-xs">
                  {f.path}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t("agent.memory.search")}
            title={t("agent.memory.search")}
            aria-expanded={searching}
            onClick={() => setSearching((v) => !v)}
          >
            <Search aria-hidden="true" />
          </Button>
        </div>
        {searching ? <MemorySearch onClose={() => setSearching(false)} /> : null}
        <nav aria-label={t("agent.memory.dailyNotes")} className="flex items-center gap-3">
          <SectionLabel as="span" className="w-12 shrink-0">
            {t("agent.memory.daily")}
          </SectionLabel>
          {notes.length === 0 ? (
            <span className="text-caption text-muted-foreground">{t("agent.memory.noDaily")}</span>
          ) : (
            <span className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto pb-0.5">
              {notes.map((n) => (
                <button
                  key={n.path}
                  type="button"
                  onClick={() => setPath(n.path)}
                  aria-current={path === n.path ? "page" : undefined}
                  aria-label={n.date}
                  className={cn(
                    "flex shrink-0 flex-col items-center rounded-md border border-gray-6 px-2.5 py-1 leading-none hover:bg-gray-3",
                    path === n.path && "border-accent-8 bg-accent-3 text-accent-11",
                  )}
                >
                  <span className="text-[11px] text-muted-foreground">{dayName(n.date)}</span>
                  <span className="text-small font-medium tabular-nums">{shortDate(n.date)}</span>
                </button>
              ))}
            </span>
          )}
        </nav>
      </section>

      <MemoryFileEditor path={path} budget={fileBudget} />

      <section
        aria-label={t("agent.memory.controls")}
        className="flex flex-col divide-y divide-gray-5 rounded-lg border border-gray-6 bg-gray-2 text-small"
      >
        <div className="flex flex-wrap items-center gap-2 p-3">
          <span className="min-w-0 flex-1">
            {t("agent.memory.memory")}{" "}
            <Badge variant={paused ? "approval" : "success"}>
              {paused ? t("agent.memory.paused") : t("common.on")}
            </Badge>
          </span>
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
          {onStartIncognito ? (
            <Button size="sm" variant="ghost" onClick={onStartIncognito}>
              <EyeOff aria-hidden="true" /> {t("agent.memory.incognito")}
            </Button>
          ) : null}
        </div>
        <fieldset
          aria-label={t("agent.memory.importExport")}
          className="m-0 flex min-w-0 flex-wrap items-center gap-2 border-0 p-3"
        >
          {onImport ? (
            <Button size="sm" variant="ghost" onClick={onImport}>
              <Upload aria-hidden="true" /> {t("agent.memory.import")}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              const res = await call("memory.export", {});
              onExported?.({ filename: res.filename, data: res.data });
              setNotice(t("agent.memory.exported", { file: res.filename }));
            }}
          >
            <Download aria-hidden="true" /> {t("agent.memory.export")}
          </Button>
          <span className="ms-auto">
            <ResetDialog
              persona={persona.name}
              onReset={async () => {
                const res = await call("memory.reset", {});
                setNotice(
                  t("agent.memory.resetDone", { files: res.files.length, claims: res.claims }),
                );
              }}
            />
          </span>
        </fieldset>
      </section>
      {notice ? (
        <p className="text-small text-muted-foreground" role="status">
          {notice}
        </p>
      ) : null}
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
