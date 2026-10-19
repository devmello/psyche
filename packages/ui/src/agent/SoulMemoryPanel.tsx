import type { MemoryHit, Provenance } from "@psyche/protocol";
import { EyeOff, Pause, Play, Search, ShieldAlert } from "lucide-react";
import { type ReactElement, useEffect, useState } from "react";
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
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs.tsx";
import { Textarea } from "../components/ui/textarea.tsx";
import { useCall, useGatewayQuery, useMemoryFile } from "../data/index.ts";
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
      <span
        className="h-1.5 w-20 overflow-hidden rounded-full bg-gray-4"
        role="meter"
        aria-label="File budget"
        aria-valuemin={0}
        aria-valuemax={budget}
        aria-valuenow={used}
        aria-valuetext={`${(used / 1000).toFixed(1)}k of ${budget / 1000}k characters`}
      >
        <span
          className={cn(
            "block h-full",
            over ? "bg-danger" : pct > 85 ? "bg-approval" : "bg-accent-9",
          )}
          style={{ width: `${pct}%` }}
        />
      </span>
      {(used / 1000).toFixed(1)}k / {budget / 1000}k
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
      {provenance}
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
  useEffect(() => setDraft(null), [path]);
  if (file === null) {
    return loading ? (
      <Skeleton className="h-48" />
    ) : (
      <p className="text-sm">
        Psyche couldn't open {path}
        {error ? ` (${error})` : ""}.
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
          ? `${path} changed since you opened it. Discard to load the new version.`
          : err instanceof Error
            ? err.message
            : String(err),
      );
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="font-mono text-sm">{path}</span>
        <BudgetMeter used={value.length} budget={budget} />
        <span className="ml-auto flex gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={!dirty || saving}
            onClick={() => setDraft(null)}
          >
            Discard
          </Button>
          <Button size="sm" disabled={!dirty || saving} onClick={() => void onSave()}>
            Save
          </Button>
        </span>
      </div>
      {path === "MEMORY.md" ? (
        <p className="text-xs text-muted-foreground">Dreaming rewrites this file every night.</p>
      ) : null}
      {slots.renderEditor ? (
        slots.renderEditor({ path, value, onChange: setDraft, budget })
      ) : (
        <Textarea
          aria-label={`${path} contents`}
          className="min-h-64 font-mono text-[13px]"
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

function MemorySearch(): ReactElement {
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
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <section aria-label="Search memory" className="flex flex-col gap-2">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <Input
          aria-label="Search memory"
          placeholder="Search memory"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Button type="submit" variant="outline" size="sm" aria-label="Search">
          <Search aria-hidden="true" />
        </Button>
      </form>
      {error ? <p className="text-sm text-danger-text">{error}</p> : null}
      {hits !== null ? (
        hits.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing in memory matches.</p>
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
  const phrase = `reset ${persona}`;
  return (
    <AlertDialog>
      <AlertDialogTrigger render={<Button size="sm" variant="destructive" />}>
        Reset {persona}…
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Reset {persona}?</AlertDialogTitle>
          <AlertDialogDescription>
            This deletes every workspace file, memory chunk and claim and re-creates the templates.
            Receipts and the audit log are kept. Type "{phrase}" to confirm.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Input aria-label="Confirmation" value={typed} onChange={(e) => setTyped(e.target.value)} />
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={typed.trim() !== phrase}
            onClick={() => void onReset()}
          >
            Reset
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
  const paused = status.data?.paused ?? false;
  const fileBudget = PERSONA_FILES.find((f) => f.path === path)?.budget ?? 20_000;

  return (
    <div className="flex flex-col gap-4">
      <Tabs value={path} onValueChange={(v) => setPath(String(v))}>
        <TabsList aria-label="Files">
          {PERSONA_FILES.map((f) => (
            <TabsTrigger key={f.path} value={f.path}>
              {f.path}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <nav aria-label="Daily notes" className="flex flex-wrap items-center gap-1.5 text-sm">
        <span className="text-label text-muted-foreground">Daily</span>
        {(daily.data?.notes ?? []).map((n) => (
          <button
            key={n.path}
            type="button"
            onClick={() => setPath(n.path)}
            aria-current={path === n.path ? "page" : undefined}
            className={cn(
              "rounded-md px-1.5 py-0.5 hover:bg-gray-3",
              path === n.path && "bg-accent-3 text-accent-11",
            )}
          >
            {n.date}
          </button>
        ))}
      </nav>
      <MemoryFileEditor path={path} budget={fileBudget} />
      <MemorySearch />
      <section aria-label="Memory controls" className="flex flex-wrap items-center gap-2 text-sm">
        <span>
          Memory: <strong>{paused ? "Paused" : "On"}</strong>
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
          {paused ? "Resume" : "Pause"}
        </Button>
        {onStartIncognito ? (
          <Button size="sm" variant="outline" onClick={onStartIncognito}>
            <EyeOff aria-hidden="true" /> Incognito side chat
          </Button>
        ) : null}
      </section>
      <section aria-label="Import, export and reset" className="flex flex-wrap gap-2">
        {onImport ? (
          <Button size="sm" variant="outline" onClick={onImport}>
            Import memory
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          onClick={async () => {
            const res = await call("memory.export", {});
            onExported?.({ filename: res.filename, data: res.data });
            setNotice(`Exported ${res.filename}.`);
          }}
        >
          Export everything
        </Button>
        <ResetDialog
          persona={persona.name}
          onReset={async () => {
            const res = await call("memory.reset", {});
            setNotice(`Reset ${res.files.length} files, ${res.claims} claims.`);
          }}
        />
      </section>
      {notice ? (
        <p className="text-sm text-muted-foreground" role="status">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
