import type { AuditChange } from "@psyche/protocol";
import { ChevronDown, FilePen } from "lucide-react";
import { type ReactElement, useId, useState } from "react";
import { agentTimelineHref } from "../agent/AgentSheet.tsx";
import { useChangeDiff, useChanges } from "../data/changes.ts";
import { useStoreState } from "../data/provider.tsx";
import { t } from "../i18n/core.ts";
import { cn } from "../lib/utils.ts";
import { useSlots } from "../slots.tsx";

/** Last path segment or object name: what a chip names. */
export function changeName(c: AuditChange): string {
  const target = c.target.path ?? c.target.object ?? c.target.connector ?? c.tool;
  return target.split("/").filter(Boolean).at(-1) ?? target;
}

/** A unified diff, one coloured line each; `dir="ltr"` because code and paths read left to right. */
export function DiffText({ diff }: { diff: string }): ReactElement {
  return (
    <pre
      dir="ltr"
      className="max-h-72 overflow-auto rounded-md bg-fill-quaternary p-2 font-mono text-caption leading-snug"
    >
      {diff.split("\n").map((line, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional
          key={i}
          className={cn(
            "block whitespace-pre-wrap break-all",
            line.startsWith("+") && !line.startsWith("+++") && "text-grass-11",
            line.startsWith("-") && !line.startsWith("---") && "text-tomato-11",
            line.startsWith("@@") && "text-label-tertiary",
          )}
        >
          {line || " "}
        </span>
      ))}
    </pre>
  );
}

/** The stored diff of one change, loaded when shown. */
export function ChangeDiff({ change }: { change: AuditChange }): ReactElement | null {
  const { diff, loading } = useChangeDiff(change.seq, change.hasDiff);
  if (!change.hasDiff) {
    return change.bytes === undefined ? null : (
      <p className="text-caption text-label-secondary">
        {t("audit.chip.noDiff", { bytes: change.bytes })}
      </p>
    );
  }
  if (diff === undefined) {
    return loading ? (
      <p className="text-caption text-label-secondary">{t("audit.chip.loadingDiff")}</p>
    ) : null;
  }
  return (
    <div className="flex flex-col gap-1">
      <DiffText diff={diff} />
      {change.diffTruncated ? (
        <p className="text-caption text-label-secondary">{t("audit.chip.diffTruncated")}</p>
      ) : null}
    </div>
  );
}

/** An in-app link: the shell's navigation when there is one, the plain URL otherwise. */
function ChipLink({ href, children }: { href: string; children: string }): ReactElement {
  const slots = useSlots();
  return (
    <a
      href={href}
      onClick={(e) => {
        if (slots.navigate === undefined) return;
        e.preventDefault();
        slots.navigate(href);
      }}
      className="rounded-sm text-accent-11 underline outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </a>
  );
}

/** Whether `change` is a file the chat can open: a memory-workspace file. */
function openablePath(c: AuditChange): string | undefined {
  return c.category === "memory" && c.action !== "delete" ? c.target.path : undefined;
}

/**
 * "Changed 1 file · USER.md" under the answer of a turn that changed something (also its
 * post-turn pass, like profile learning). Read from the stored audit records, so it survives
 * reloads; it expands to each diff with "Open in Timeline" and "Open file".
 */
export function ChangeChip({
  threadId,
  runId,
  messageId,
}: {
  threadId: string;
  runId: string | null;
  /** The chip shows once per turn: under the turn's last agent message. */
  messageId: string;
}): ReactElement | null {
  const lastOfRun = useStoreState((s) => {
    const list = s.messages[threadId] ?? [];
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const m = list[i];
      if (m !== undefined && m.runId === runId && m.role === "agent") return m.id === messageId;
    }
    return false;
  });
  const { changes } = useChanges({ threadId }, { enabled: runId !== null && lastOfRun });
  const [open, setOpen] = useState(false);
  const regionId = useId();
  const mine = changes.filter(
    (c) => c.runId === runId && c.category !== "approval" && c.outcome === "ok",
  );
  if (runId === null || !lastOfRun || mine.length === 0) return null;
  const names = [...new Set(mine.map(changeName))];
  const filesOnly = mine.every((c) => c.category === "file" || c.category === "memory");
  const summary = t(filesOnly ? "audit.chip.files" : "audit.chip.items", { count: mine.length });
  const shown = names.slice(0, 3).join(", ") + (names.length > 3 ? ` +${names.length - 3}` : "");
  return (
    <div className="mt-2" data-testid="change-chip">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={regionId}
        aria-label={`${t("audit.chip.label", { summary, names: shown })}. ${t("audit.chip.toggle")}`}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex max-w-full items-center gap-1.5 rounded-full border-[0.5px] border-separator-strong px-2.5 py-1 text-callout text-label-secondary outline-none hover:bg-fill-quaternary focus-visible:ring-2 focus-visible:ring-ring"
      >
        <FilePen className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">{t("audit.chip.label", { summary, names: shown })}</span>
        <ChevronDown
          className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-180")}
          aria-hidden="true"
        />
      </button>
      {open ? (
        <div id={regionId} className="mt-2 flex flex-col gap-3">
          {mine.map((c) => {
            const path = openablePath(c);
            return (
              <div key={c.seq} className="flex flex-col gap-1.5">
                <p className="text-callout text-label-primary">
                  {t("audit.action", { action: c.action, target: c.target.path ?? changeName(c) })}
                </p>
                <ChangeDiff change={c} />
                <div className="flex gap-3 text-callout">
                  <ChipLink href={agentTimelineHref(c.runId ?? runId)}>
                    {t("audit.chip.openTimeline")}
                  </ChipLink>
                  {path !== undefined ? (
                    <ChipLink href={`/agent/soul?file=${encodeURIComponent(path)}`}>
                      {t("audit.chip.openFile")}
                    </ChipLink>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
