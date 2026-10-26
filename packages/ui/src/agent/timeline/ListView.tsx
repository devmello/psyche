import { Search } from "lucide-react";
import type { ReactElement, RefObject } from "react";
import { StatusGlyph, stepStatusKind } from "../../components/status.tsx";
import { LiveDuration } from "../../components/steps/LiveDuration.tsx";
import { Input } from "../../components/ui/input.tsx";
import { t } from "../../i18n/core.ts";
import type { MessageId } from "../../i18n/index.ts";
import { formatTime } from "../../lib/format.ts";
import { cn } from "../../lib/utils.ts";
import type { TraceRow } from "./model.ts";

/**
 * The List view (docs/design/run-trace-2026.md §3.3): one scrolling log of every step with its
 * preview, folded ones included, so search finds text anywhere in the task. The search field is
 * what ⌘F focuses here.
 */

export interface ListViewProps {
  rows: readonly TraceRow[];
  query: string;
  onQueryChange: (q: string) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  searchRef: RefObject<HTMLInputElement | null>;
  now: number;
}

export function ListView({
  rows,
  query,
  onQueryChange,
  selectedId,
  onSelect,
  searchRef,
  now,
}: ListViewProps): ReactElement {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2" data-testid="timeline-list">
      <div className="relative">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute start-2 top-1/2 size-4 -translate-y-1/2 text-label-tertiary"
        />
        <Input
          ref={searchRef}
          type="search"
          aria-label={t("agent.timeline.list.search")}
          placeholder={t("agent.timeline.list.search")}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          className="ps-8"
        />
      </div>
      {rows.length === 0 ? (
        <p className="px-2 py-6 text-center text-body text-label-secondary">
          {t("agent.timeline.list.noMatches")}
        </p>
      ) : (
        <ul aria-label={t("agent.timeline.steps.label")} className="min-h-0 flex-1 overflow-y-auto">
          {rows.map((row) => {
            const s = row.step;
            const preview = s?.error?.message ?? s?.text?.summary ?? s?.preview?.output;
            const selected = row.id === selectedId;
            return (
              <li key={row.id}>
                <button
                  type="button"
                  aria-current={selected ? "true" : undefined}
                  onClick={() => onSelect(row.id)}
                  className={cn(
                    "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-start outline-none hover:bg-fill-quaternary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                    selected && "bg-accent-a4 hover:bg-accent-a4",
                  )}
                  style={{ paddingInlineStart: 8 + row.level * 14 }}
                >
                  <StatusGlyph
                    status={stepStatusKind(row.status)}
                    label={t(`agent.timeline.status.${row.status}` as MessageId)}
                    className="mt-0.5 size-3.5 shrink-0"
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex min-w-0 items-baseline gap-1.5">
                      <span
                        className={cn(
                          "min-w-0 truncate text-body",
                          row.status === "failed" && "text-danger-text",
                        )}
                      >
                        {row.label}
                      </span>
                      {s?.target ? (
                        <span className="min-w-0 truncate text-callout text-label-tertiary">
                          · {s.target}
                        </span>
                      ) : null}
                    </span>
                    {preview ? (
                      <span className="line-clamp-2 text-callout text-label-secondary">
                        {preview}
                      </span>
                    ) : null}
                  </span>
                  <span className="flex shrink-0 flex-col items-end text-callout text-label-tertiary tabular-nums">
                    <LiveDuration startedAt={row.start} endedAt={row.end ?? undefined} now={now} />
                    <time dateTime={new Date(row.start).toISOString()}>
                      {formatTime(new Date(row.start).toISOString())}
                    </time>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
